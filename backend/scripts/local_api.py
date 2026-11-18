"""Run the BOS API on this computer against the development database.

Usage (from the ``backend`` folder, with the private PostgreSQL running: ``python
../scripts/local_db.py start``):

    uv run python scripts/local_api.py migrate     # apply migrations (as the owner role)
    uv run python scripts/local_api.py bootstrap   # create the operator; seed the demo data
    uv run python scripts/local_api.py serve       # the API on http://127.0.0.1:5100
    uv run python scripts/local_api.py purge-test-businesses [--yes]
                                                   # remove "E2E Business ..." test businesses
    uv run python scripts/local_api.py stock-check [--tenant ID]
                                                   # stock integrity of every business

Options for any subcommand: ``--public-base-url URL`` (the web origin the API puts in
activation and reset links; default http://127.0.0.1:3100, the development web server) and,
for ``serve``, ``--port N`` (default 5100; never 8000, which belongs to other software).

Reads ``../.env`` for the database roles, the secret key and the operator and demo
passwords, so no password ever appears on the command line or in the output. The development
database is ``POSTGRES_DB``; the test database (``BOS_TEST_DB``) is refused. There is no mail
server on this computer: email (reset links, invitation codes) is written as JSON files to
``BOS_MAIL_OUTBOX_DIR`` from .env, by default the ``bos-dev/outbox`` folder under
``%LOCALAPPDATA%``.

``purge-test-businesses`` removes the non-demo businesses the end-to-end tests leave behind
(named ``E2E Business ...``) with all their rows, their history and their uploaded files:
every table with a ``tenant_id`` column (so M1's catalog, stock ledger and allocations too)
and the whole ``tenant/<id>/`` upload folder (store logos and product photos).
Without ``--yes`` it only lists what it would remove. It works only on ``POSTGRES_DB`` on
127.0.0.1, built from ``.env`` (never from environment variables), and refuses the test
database.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
            # The development database on this computer (F-11): allows the mail outbox.
            "BOS_ENVIRONMENT": "development",
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


def cmd_stock_check(environment: dict[str, str], args: argparse.Namespace) -> int:
    """``flask bos stock-check`` on the development database (read-only)."""
    tenant = ["--tenant", args.tenant] if args.tenant else []
    return flask(["bos", "stock-check", *tenant], environment)


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


# --- purge-test-businesses ---------------------------------------------------------------

# Names given by the end-to-end tests (frontend/e2e/fixtures.ts). Nothing else is selected.
TEST_BUSINESS_PREFIX = "E2E Business "
DEVELOPMENT_HOST = "127.0.0.1"
_TABLE_NAME = re.compile(r"[a-z_][a-z0-9_]{0,62}")


@dataclass(frozen=True)
class Business:
    id: uuid.UUID
    name: str


def is_test_business(name: str, is_demo: bool) -> bool:
    """A business left by the end-to-end tests: never a demo one, always the test name."""
    return (
        not is_demo
        and name.startswith(TEST_BUSINESS_PREFIX)
        and name.strip() != TEST_BUSINESS_PREFIX.strip()
    )


def purge_database_url(env: dict[str, str]) -> str:
    """The development database as the owner role, from the .env values only."""
    from sqlalchemy import URL

    port = env.get("BOS_LOCAL_DB_PORT") or env.get("BOS_DB_PORT", "55432")
    url = URL.create(
        "postgresql+psycopg",
        username=env["POSTGRES_USER"],
        password=env["POSTGRES_PASSWORD"],
        host=DEVELOPMENT_HOST,
        port=int(port),
        database=env["POSTGRES_DB"],
    )
    return url.render_as_string(hide_password=False)


def check_purge_target(url: str, env: dict[str, str]) -> None:
    """Refuse anything but the development database on this computer, as the owner role.

    The messages never show the URL, which holds the owner's password.
    """
    from sqlalchemy.engine import make_url

    target = make_url(url)
    database = env.get("POSTGRES_DB", "")
    problems = []
    if target.drivername != "postgresql+psycopg":
        problems.append("it is not PostgreSQL")
    if target.host != DEVELOPMENT_HOST or target.query:
        problems.append(f"it is not on {DEVELOPMENT_HOST}")
    if not database or target.database != database:
        problems.append("it is not the development database (POSTGRES_DB)")
    if target.database == env.get("BOS_TEST_DB") or database == env.get("BOS_TEST_DB"):
        problems.append("it is the test database")
    if target.username != env.get("POSTGRES_USER"):
        problems.append("it does not connect as the owner role")
    if problems:
        raise SystemExit("Refusing to purge this database: " + "; ".join(problems) + ".")


@contextmanager
def owner_transaction(url: str) -> Iterator[Any]:
    """One transaction as the owner role; committed when the block ends without an error."""
    from sqlalchemy import create_engine
    from sqlalchemy.pool import NullPool

    engine = create_engine(url, poolclass=NullPool)
    try:
        with engine.begin() as conn:
            yield conn
    finally:
        engine.dispose()


def select_test_businesses(conn: Any) -> list[Business]:
    from sqlalchemy import text

    rows = conn.execute(
        text(
            "SELECT id, name, is_demo FROM tenants WHERE name LIKE :pattern "
            "ORDER BY created_at, name"
        ),
        {"pattern": TEST_BUSINESS_PREFIX + "%"},
    ).all()
    return [
        Business(uuid.UUID(str(row[0])), row[1]) for row in rows if is_test_business(row[1], row[2])
    ]


def tenant_tables(conn: Any) -> list[str]:
    """Every table with a tenant_id column, so tables added by later milestones are included."""
    from sqlalchemy import text

    rows = conn.execute(
        text(
            "SELECT c.table_name FROM information_schema.columns c "
            "JOIN information_schema.tables t "
            "ON t.table_schema = c.table_schema AND t.table_name = c.table_name "
            "WHERE c.table_schema = current_schema() AND c.column_name = 'tenant_id' "
            "AND t.table_type = 'BASE TABLE' AND c.table_name <> 'tenants' "
            "ORDER BY c.table_name"
        )
    ).all()
    tables = [str(row[0]) for row in rows]
    for table in tables:
        if not _TABLE_NAME.fullmatch(table):
            raise SystemExit(f"Unexpected table name {table!r}; nothing removed.")
    return tables


def purge_statements(tables: list[str]) -> list[tuple[str, str]]:
    """(label, DELETE statement) in order; every statement takes the business ids as :ids."""
    statements = [
        (table, f"DELETE FROM {table} WHERE tenant_id = ANY(:ids)")  # noqa: S608
        for table in tables
    ]
    # The operator's "create business" request is remembered without a tenant_id.
    statements.append(
        (
            "idempotency_keys (operator)",
            "DELETE FROM idempotency_keys WHERE resource_type = 'tenant' "
            "AND resource_id = ANY(:ids)",
        )
    )
    statements.append(("tenants", "DELETE FROM tenants WHERE id = ANY(:ids)"))
    return statements


def tenant_folder(upload_dir: Path, tenant_id: uuid.UUID) -> Path:
    """``<upload dir>/tenant/<id>``, refusing anything that would land elsewhere."""
    base = (upload_dir / "tenant").resolve()
    folder = (base / str(uuid.UUID(str(tenant_id)))).resolve()
    if folder.parent != base:
        raise SystemExit("Unexpected upload folder; nothing removed.")
    return folder


def cmd_purge_test_businesses(environment: dict[str, str], args: argparse.Namespace) -> int:
    from sqlalchemy import text

    env: dict[str, str] = args.dotenv
    url = purge_database_url(env)
    check_purge_target(url, env)
    upload_dir = Path(environment["BOS_UPLOAD_DIR"])
    removed: dict[str, int] = {}
    with owner_transaction(url) as conn:
        businesses = select_test_businesses(conn)
        if not businesses:
            print("No test businesses (non-demo 'E2E Business ...') in the development database.")
            return 0
        ids = [business.id for business in businesses]
        action = "Removing" if args.yes else "Would remove"
        print(f"{action} {len(businesses)} test business(es) from the development database:")
        for business in businesses:
            files = (
                " (with uploaded files)" if tenant_folder(upload_dir, business.id).is_dir() else ""
            )
            print(f"  {business.name}  [{business.id}]{files}")
        tables = tenant_tables(conn)
        if not args.yes:
            for table in tables:
                rows = conn.execute(
                    text(f"SELECT count(*) FROM {table} WHERE tenant_id = ANY(:ids)"),  # noqa: S608
                    {"ids": ids},
                ).all()
                if rows and rows[0][0]:
                    print(f"  {table}: {rows[0][0]} row(s)")
            print("Dry run: nothing removed. Run again with --yes to remove them.")
            return 0
        # History rows are append-only (a trigger refuses DELETE) and the tables refer to
        # each other: as in tests/dbsupport.py truncate_all, the owner switches triggers and
        # foreign-key checks off for this one transaction. Development database only; this
        # is the only code that removes history rows.
        conn.execute(text("SET LOCAL session_replication_role = replica"))
        for label, statement in purge_statements(tables):
            result = conn.execute(text(statement), {"ids": ids})
            if result.rowcount:
                removed[label] = removed.get(label, 0) + result.rowcount
    # Files go only after the rows are committed, so a failed purge leaves both in place.
    folders = 0
    for business in businesses:
        folder = tenant_folder(upload_dir, business.id)
        if folder.is_dir():
            shutil.rmtree(folder)
            folders += 1
    print(f"Removed {len(businesses)} test business(es):")
    for label, count in removed.items():
        print(f"  {label}: {count} row(s)")
    print(f"  upload folders: {folders}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "command",
        choices=["migrate", "bootstrap", "serve", "purge-test-businesses", "stock-check"],
    )
    parser.add_argument("--public-base-url", default=DEFAULT_PUBLIC_BASE_URL)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="purge-test-businesses: really remove them (without it, only list)",
    )
    parser.add_argument("--tenant", default=None, help="stock-check: check only this business")
    args = parser.parse_args(argv)
    dotenv = read_env_file(ROOT / ".env")
    # The purge builds its own database address from .env and checks it again.
    args.dotenv = dotenv
    environment = build_environment(dotenv, args.public_base_url)
    handlers = {
        "migrate": cmd_migrate,
        "bootstrap": cmd_bootstrap,
        "serve": cmd_serve,
        "purge-test-businesses": cmd_purge_test_businesses,
        "stock-check": cmd_stock_check,
    }
    return handlers[args.command](environment, args)


if __name__ == "__main__":
    raise SystemExit(main())
