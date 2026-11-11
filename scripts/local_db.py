"""A private PostgreSQL for BOS development on this computer, without Docker.

It uses the PostgreSQL binaries already installed on Windows but its own data folder and its
own port, so it never touches any other PostgreSQL data or service on the machine. It runs
as an ordinary process of the current user (not a Windows service), so start it again after
a reboot.

    python scripts/local_db.py init     # once: create the data folder, roles and databases
    python scripts/local_db.py start
    python scripts/local_db.py stop
    python scripts/local_db.py status

Settings come from ``.env``: the same role names and passwords the Docker database uses,
plus ``BOS_LOCAL_DB_PORT`` (default 55433) and optionally ``BOS_LOCAL_PG_BIN`` and
``BOS_LOCAL_PG_DATA``. Passwords are passed through a temporary file and the environment,
never on a command line.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = "55433"
DEFAULT_BIN_DIRS = [
    Path(r"C:\Program Files\PostgreSQL\17\bin"),
    Path(r"C:\Program Files\PostgreSQL\16\bin"),
]


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        values[name.strip()] = value.strip()
    return values


ENV = read_env_file(ROOT / ".env")
PORT = ENV.get("BOS_LOCAL_DB_PORT", DEFAULT_PORT)
DATA = Path(
    ENV.get("BOS_LOCAL_PG_DATA")
    or Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "bos-dev" / "pgdata"
)
LOG = DATA.parent / "postgres.log"


def bin_dir() -> Path:
    configured = ENV.get("BOS_LOCAL_PG_BIN")
    candidates = [Path(configured)] if configured else DEFAULT_BIN_DIRS
    for candidate in candidates:
        if (candidate / "pg_ctl.exe").exists() or (candidate / "pg_ctl").exists():
            return candidate
    raise SystemExit("PostgreSQL binaries not found; set BOS_LOCAL_PG_BIN in .env")


def run(tool: str, *args: str, env: dict[str, str] | None = None, check: bool = True) -> int:
    completed = subprocess.run(
        [str(bin_dir() / tool), *args], env={**os.environ, **(env or {})}, check=False
    )
    if check and completed.returncode != 0:
        raise SystemExit(f"{tool} failed with exit code {completed.returncode}")
    return completed.returncode


def psql(sql: str, *, database: str = "postgres") -> None:
    run(
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        "127.0.0.1",
        "-p",
        PORT,
        "-U",
        ENV["POSTGRES_USER"],
        "-d",
        database,
        "-q",
        "-c",
        sql,
        env={"PGPASSWORD": ENV["POSTGRES_PASSWORD"]},
    )


def is_running() -> bool:
    return DATA.exists() and run("pg_ctl", "-D", str(DATA), "status", check=False) == 0


def start() -> None:
    if is_running():
        print(f"already running on 127.0.0.1:{PORT}")
        return
    options = f"-p {PORT} -c listen_addresses=127.0.0.1"
    # Detached, with no inherited output handles: otherwise the server keeps this script's
    # output pipe open and whatever launched the script waits forever.
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(
        subprocess, "CREATE_NEW_PROCESS_GROUP", 0
    )
    completed = subprocess.run(
        [
            str(bin_dir() / "pg_ctl"),
            "-D",
            str(DATA),
            "-l",
            str(LOG),
            "-o",
            options,
            "-w",
            "-t",
            "600",
            "start",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=flags,
        check=False,
    )
    if completed.returncode != 0:
        raise SystemExit(f"pg_ctl start failed; see {LOG}")
    print(f"started on 127.0.0.1:{PORT} (log: {LOG})")


def stop() -> None:
    if is_running():
        run("pg_ctl", "-D", str(DATA), "-m", "fast", "-w", "stop")
    print("stopped")


def init() -> None:
    if (DATA / "PG_VERSION").exists():
        print(f"data folder already exists: {DATA}")
    else:
        DATA.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", suffix=".pw", delete=False, encoding="utf-8"
        ) as handle:
            handle.write(ENV["POSTGRES_PASSWORD"])
            password_file = handle.name
        try:
            run(
                "initdb",
                "-D",
                str(DATA),
                "-U",
                ENV["POSTGRES_USER"],
                "--pwfile",
                password_file,
                "--auth=scram-sha-256",
                "--encoding=UTF8",
                "--locale=C",
            )
        finally:
            os.unlink(password_file)
    start()
    _dev_settings()

    app_role = ENV["BOS_APP_DB_USER"]
    app_password = ENV["BOS_APP_DB_PASSWORD"].replace("'", "''")
    psql(
        f"""DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{app_role}') THEN
                CREATE ROLE "{app_role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
            END IF;
        END $$;"""
    )
    # The password is sent over the local connection, not placed on the command line.
    subprocess.run(
        [
            str(bin_dir() / "psql"),
            "-v",
            "ON_ERROR_STOP=1",
            "-h",
            "127.0.0.1",
            "-p",
            PORT,
            "-U",
            ENV["POSTGRES_USER"],
            "-d",
            "postgres",
            "-q",
        ],
        input=f"ALTER ROLE \"{app_role}\" PASSWORD '{app_password}';\n",
        text=True,
        env={**os.environ, "PGPASSWORD": ENV["POSTGRES_PASSWORD"]},
        check=True,
    )
    for database in (ENV["POSTGRES_DB"], ENV["BOS_TEST_DB"]):
        exists = subprocess.run(
            [
                str(bin_dir() / "psql"),
                "-h",
                "127.0.0.1",
                "-p",
                PORT,
                "-U",
                ENV["POSTGRES_USER"],
                "-d",
                "postgres",
                "-Atc",
                f"SELECT 1 FROM pg_database WHERE datname = '{database}'",
            ],
            capture_output=True,
            text=True,
            env={**os.environ, "PGPASSWORD": ENV["POSTGRES_PASSWORD"]},
            check=True,
        ).stdout.strip()
        if not exists:
            psql(f'CREATE DATABASE "{database}" OWNER "{ENV["POSTGRES_USER"]}"')
        psql(f'GRANT CONNECT ON DATABASE "{database}" TO "{app_role}"')
    print(f"ready: databases {ENV['POSTGRES_DB']} and {ENV['BOS_TEST_DB']} on 127.0.0.1:{PORT}")


def _dev_settings() -> None:
    """Throwaway development settings: no forced disk flushes.

    This computer's disk takes tens of seconds to flush a few hundred files, which made
    PostgreSQL crawl and repeatedly fail. With flushing off, a crash or power cut can lose or
    corrupt this database's data; that is acceptable only because it holds nothing but
    development and test data. Never use these settings for real data.
    """
    for setting in ("fsync = off", "synchronous_commit = off", "full_page_writes = off"):
        psql(f"ALTER SYSTEM SET {setting}")
    psql("SELECT pg_reload_conf()")


def status() -> None:
    print(f"data folder: {DATA}")
    print(f"port: {PORT}")
    print("running" if is_running() else "not running")


COMMANDS = {"init": init, "start": start, "stop": stop, "status": status}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        raise SystemExit(__doc__)
    COMMANDS[sys.argv[1]]()
