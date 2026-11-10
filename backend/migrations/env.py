"""Alembic environment.

Migrations are written by hand (no autogenerate): row-level security policies, triggers and
grants are part of the schema and autogenerate does not see them.
"""

from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine, pool

config = context.config


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    url = config.get_main_option("sqlalchemy.url")
    assert url, "sqlalchemy.url is not set"
    engine = create_engine(url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
