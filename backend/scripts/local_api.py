"""Run the BOS API on this computer against the development database.

Usage (from the ``backend`` folder, with the private PostgreSQL running: ``python
../scripts/local_db.py start``):

    uv run python scripts/local_api.py migrate     # apply migrations (as the owner role)
    uv run python scripts/local_api.py bootstrap   # create the operator; seed the demo data
    uv run python scripts/local_api.py serve       # the API on http://127.0.0.1:5100

Options for any subcommand: ``--public-base-url URL`` (the web origin the API puts in
activation and reset links; default http://127.0.0.1:3100, the development web server) and,
for ``serve``, ``--port N`` (default 5100; never 8000, which belongs to other software).

Reads ``../.env`` for the database roles, the secret key and the operator and demo
passwords, so no password ever appears on the command line or in the output. The development
database is ``POSTGRES_DB``; the test database (``BOS_TEST_DB``) is refused. There is no mail
server on this computer: email (reset links, invitation codes) is written as JSON files to
``BOS_MAIL_OUTBOX_DIR`` from .env, by default the ``bos-dev/outbox`` folder under
``%LOCALAPPDATA%``.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
DEFAULT_PORT = 5100
DEFAULT_PUBLIC_BASE_URL = "http://127.0.0.1:3100"
FORBIDDEN_PORTS = {8000}

# Passed through to the API and its commands unchanged.
PASS_THROUGH = (
    "BOS_SECRET_KEY",
    "BOS_OPERATOR_EMAILS",
    "BOS_OPERATOR_PASSWORD",
    "BOS_DEMO_PASSWORD",
    "BOS_ALLOW_DEMO_SEED",
    "BOS_SMTP_HOST",
    "BOS_SMTP_PORT",
    "BOS_SMTP_USER",
    "BOS_SMTP_PASSWORD",
    "BOS_SMTP_FROM",
)


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        values[name.strip()] = value.strip()
    return values


def build_environment(env: dict[str, str], public_base_url: str) -> dict[str, str]:
    """The environment the API needs, derived from the .env values."""
    port = env.get("BOS_LOCAL_DB_PORT") or env.get("BOS_DB_PORT", "55432")
    host = f"127.0.0.1:{port}"
    database = env["POSTGRES_DB"]
    if database == env.get("BOS_TEST_DB"):
        raise SystemExit("Refusing to run against the test database.")
    result = {name: env[name] for name in PASS_THROUGH if env.get(name)}
    local = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "bos-dev"
    result.update(
        {
            "BOS_MAIL_OUTBOX_DIR": env.get("BOS_MAIL_OUTBOX_DIR") or str(local / "outbox"),
            "BOS_COOKIE_SECURE": "false",
            "BOS_PUBLIC_BASE_URL": public_base_url.rstrip("/"),
            "BOS_UPLOAD_DIR": str(
                Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "bos-dev" / "uploads"
            ),
            "BOS_DATABASE_URL": (
                f"postgresql+psycopg://{env['BOS_APP_DB_USER']}:{env['BOS_APP_DB_PASSWORD']}"
                f"@{host}/{database}"
            ),
            "BOS_MIGRATION_DATABASE_URL": (
                f"postgresql+psycopg://{env['POSTGRES_USER']}:{env['POSTGRES_PASSWORD']}"
                f"@{host}/{database}"
            ),
        }
    )
    return result


def flask(args: list[str], environment: dict[str, str]) -> int:
    command = [sys.executable, "-m", "flask", "--app", "app:create_app", *args]
    # Fixed command (this interpreter running Flask); only the environment varies.
    return subprocess.call(command, cwd=BACKEND, env={**os.environ, **environment})  # noqa: S603


def first_operator_email(environment: dict[str, str]) -> str:
    emails = [e.strip() for e in environment.get("BOS_OPERATOR_EMAILS", "").split(",") if e.strip()]
    if not emails:
        raise SystemExit("BOS_OPERATOR_EMAILS in .env has no address.")
    return emails[0]


def cmd_migrate(environment: dict[str, str], _args: argparse.Namespace) -> int:
    return flask(["db", "upgrade"], environment)


def cmd_bootstrap(environment: dict[str, str], _args: argparse.Namespace) -> int:
    if not environment.get("BOS_OPERATOR_PASSWORD"):
        raise SystemExit("BOS_OPERATOR_PASSWORD in .env is empty.")
    code = flask(
        ["bos", "create-operator", "--email", first_operator_email(environment)], environment
    )
    if code != 0:
        return code
    if environment.get("BOS_ALLOW_DEMO_SEED", "").lower() == "true":
        return flask(["bos", "seed-demo"], environment)
    print("BOS_ALLOW_DEMO_SEED is not true in .env: demo data not created.")
    return 0


def cmd_serve(environment: dict[str, str], args: argparse.Namespace) -> int:
    if args.port in FORBIDDEN_PORTS:
        raise SystemExit(f"Port {args.port} belongs to other software on this computer.")
    os.environ.update(environment)
    os.chdir(BACKEND)
    sys.path.insert(0, str(BACKEND))
    Path(environment["BOS_UPLOAD_DIR"]).mkdir(parents=True, exist_ok=True)
    from app import create_app

    app = create_app()
    print(
        f"BOS API on http://127.0.0.1:{args.port} (links point to {args.public_base_url})",
        flush=True,
    )
    app.run(host="127.0.0.1", port=args.port, threaded=True, use_reloader=False, debug=False)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("command", choices=["migrate", "bootstrap", "serve"])
    parser.add_argument("--public-base-url", default=DEFAULT_PUBLIC_BASE_URL)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)
    environment = build_environment(read_env_file(ROOT / ".env"), args.public_base_url)
    handlers = {"migrate": cmd_migrate, "bootstrap": cmd_bootstrap, "serve": cmd_serve}
    return handlers[args.command](environment, args)


if __name__ == "__main__":
    raise SystemExit(main())
