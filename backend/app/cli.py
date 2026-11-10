"""Command-line commands: ``flask db ...`` (migrations) and ``flask bos ...`` (operations)."""

from __future__ import annotations

from pathlib import Path

import click
from alembic import command
from alembic.config import Config as AlembicConfig
from flask import Flask, current_app
from flask.cli import AppGroup

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def alembic_config(database_url: str) -> AlembicConfig:
    """Alembic settings built in code, so there is no second config file to keep in sync."""
    cfg = AlembicConfig()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    # '%' must be doubled for configparser interpolation.
    cfg.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    return cfg


def _migration_config() -> AlembicConfig:
    from app import get_config

    # Migrations run as the owner role, never as the application role.
    return alembic_config(get_config(current_app).migration_database_url)


db_cli = AppGroup("db", help="Database migrations (run as the owner role).")


@db_cli.command("upgrade")
@click.argument("revision", default="head")
def db_upgrade(revision: str) -> None:
    """Apply migrations up to REVISION (default: head)."""
    command.upgrade(_migration_config(), revision)


@db_cli.command("downgrade")
@click.argument("revision")
def db_downgrade(revision: str) -> None:
    """Roll back to REVISION (for example -1 or base)."""
    command.downgrade(_migration_config(), revision)


@db_cli.command("current")
def db_current() -> None:
    """Show the revision the database is at."""
    command.current(_migration_config(), verbose=True)


@db_cli.command("history")
def db_history() -> None:
    """List migrations."""
    command.history(_migration_config())


@db_cli.command("revision")
@click.option("-m", "--message", required=True)
def db_revision(message: str) -> None:
    """Create an empty migration file to be written by hand."""
    command.revision(_migration_config(), message=message)


bos_cli = AppGroup("bos", help="BOS operational commands.")


def register_cli(app: Flask) -> None:
    app.cli.add_command(db_cli)
    app.cli.add_command(bos_cli)
