"""Command-line commands: ``flask db ...`` (migrations) and ``flask bos ...`` (operations)."""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import click
from alembic import command
from alembic.config import Config as AlembicConfig
from flask import Flask, current_app
from flask.cli import AppGroup
from sqlalchemy import text

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

OPERATOR_PASSWORD_ENV = "BOS_OPERATOR_PASSWORD"  # noqa: S105 (a variable name)
DEMO_PASSWORD_ENV = "BOS_DEMO_PASSWORD"  # noqa: S105 (a variable name)
ALLOW_DEMO_SEED_ENV = "BOS_ALLOW_DEMO_SEED"


def _password_from_env(name: str) -> str:
    """A password from the environment, never from an argument (it would land in history)."""
    from app.core.security import WeakPassword, validate_password

    password = os.environ.get(name, "")
    if not password:
        raise click.ClickException(f"Set the password in the environment variable {name}.")
    try:
        validate_password(password)
    except WeakPassword:
        raise click.ClickException(
            f"The password in {name} is too weak: use at least 10 characters and avoid "
            "common passwords."
        ) from None
    return password


@bos_cli.command("create-operator")
@click.option("--email", required=True, help="Must be on BOS_OPERATOR_EMAILS.")
@click.option("--name", default=None, help="Display name (default: Operator).")
def create_operator(email: str, name: str | None) -> None:
    """Create a platform operator, or set a new password for an existing one.

    The password is read from BOS_OPERATOR_PASSWORD.
    """
    from app import get_config
    from app.core.db import get_engine, transaction
    from app.core.identifiers import InvalidIdentifier, normalize_email
    from app.core.security import hash_password

    try:
        address = normalize_email(email)
    except InvalidIdentifier:
        raise click.ClickException("That is not a valid email address.") from None
    if address not in get_config(current_app).operator_emails:
        raise click.ClickException(
            f"{address} is not on the operator allow-list (BOS_OPERATOR_EMAILS)."
        )
    if name is not None and not 1 <= len(name.strip()) <= 120:
        raise click.ClickException("The name must be 1 to 120 characters.")
    password_hash = hash_password(_password_from_env(OPERATOR_PASSWORD_ENV))

    with transaction(get_engine()) as db:
        row = db.execute(
            text(
                "INSERT INTO operators (id, email, name, password_hash) "
                "VALUES (:id, :email, :name, :hash) "
                "ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, "
                "name = COALESCE(:new_name, operators.name) "
                "RETURNING id, (xmax = 0) AS inserted"
            ),
            {
                "id": uuid.uuid4(),
                "email": address,
                "name": (name or "Operator").strip(),
                "new_name": name.strip() if name is not None else None,
                "hash": password_hash,
            },
        ).one()
    action = "created" if row.inserted else "updated (new password set)"
    click.echo(f"Operator {row.id} {action} for {address}.")


def maintenance_history(counts: dict[str, int]) -> dict[str, int]:
    """The counts as recorded in history.

    History refuses any key that mentions a password (``audit._check_no_secrets``), so the
    function's ``password_resets_deleted`` is recorded as ``resets_deleted``.
    """
    return {
        ("resets_deleted" if name == "password_resets_deleted" else name): count
        for name, count in counts.items()
    }


@bos_cli.command("maintenance")
def maintenance() -> None:
    """Expire old invitations; delete ended sessions, old sign-in attempts and old keys."""
    from app.core import audit
    from app.core.db import get_engine, transaction

    engine = get_engine()
    with transaction(engine) as db:
        counts = db.execute(text("SELECT platform_maintenance()")).scalar_one()
    audit.record_platform(
        engine, actor_type="system", event="maintenance.run", data=maintenance_history(counts)
    )
    for name, count in sorted(counts.items()):
        click.echo(f"{name}: {count}")


@bos_cli.command("seed-demo")
def seed_demo() -> None:
    """Create the demonstration businesses if absent (password from BOS_DEMO_PASSWORD).

    Refuses to run unless BOS_ALLOW_DEMO_SEED=true: the demo users are active and their
    sign-in details are known.
    """
    if os.environ.get(ALLOW_DEMO_SEED_ENV, "").strip().lower() != "true":
        raise click.ClickException(
            f"seed-demo creates active users with known sign-in details, so it only runs when "
            f"{ALLOW_DEMO_SEED_ENV}=true is set. Never set it in production."
        )
    from app.core.db import get_engine
    from app.services.seed import seed_demo as run_seed

    report = run_seed(get_engine(), _password_from_env(DEMO_PASSWORD_ENV))
    for demo in report.created:
        click.echo(f"Created demo business {demo.name!r} ({demo.edition}, id {demo.id})")
        for store in demo.stores:
            click.echo(f"  store {store.name}: WhatsApp {store.whatsapp}")
        for user in demo.users:
            limit = f", only {user.store}" if user.store else ""
            click.echo(f"  {user.role}{limit}: {user.email} / {user.phone} ({user.locale})")
    for demo in report.existing:
        click.echo(f"Demo business {demo.name!r} already exists; left unchanged.")
    if not report.changed:
        click.echo("Demo data already present; nothing changed.")
    else:
        click.echo(f"Every demo user's password is the one in {DEMO_PASSWORD_ENV}.")


def register_cli(app: Flask) -> None:
    app.cli.add_command(db_cli)
    app.cli.add_command(bos_cli)
