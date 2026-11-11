"""Run the backend tests on this computer against the Compose database.

Usage (from the ``backend`` folder, with ``python scripts/local_db.py start`` or
``docker compose up -d db`` running):

    uv run python scripts/local_tests.py [pytest arguments]

Reads ``../.env`` for the database roles and the local database port, so no password ever
appears on the command line. Inside the ``api`` container this script is not needed: run
``pytest`` directly.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        values[name.strip()] = value.strip()
    return values


def main() -> int:
    env = read_env_file(ROOT / ".env")
    # The private local PostgreSQL (scripts/local_db.py) if configured, else the Compose one.
    port = env.get("BOS_LOCAL_DB_PORT") or env.get("BOS_DB_PORT", "55432")
    host = f"127.0.0.1:{port}"
    test_db = env["BOS_TEST_DB"]
    os.environ.update(
        {
            "BOS_SECRET_KEY": env["BOS_SECRET_KEY"],
            "BOS_COOKIE_SECURE": "false",
            "BOS_APP_DB_USER": env["BOS_APP_DB_USER"],
            "BOS_TEST_DATABASE_URL": (
                f"postgresql+psycopg://{env['BOS_APP_DB_USER']}:{env['BOS_APP_DB_PASSWORD']}"
                f"@{host}/{test_db}"
            ),
            "BOS_TEST_MIGRATION_DATABASE_URL": (
                f"postgresql+psycopg://{env['POSTGRES_USER']}:{env['POSTGRES_PASSWORD']}"
                f"@{host}/{test_db}"
            ),
            "BOS_SPECS_DIR": str(ROOT / "specs"),
        }
    )
    os.chdir(ROOT / "backend")
    return int(pytest.main(sys.argv[1:]))


if __name__ == "__main__":
    raise SystemExit(main())
