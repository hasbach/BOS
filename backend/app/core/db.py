"""Database engine and transactions.

The API connects as the application role: it owns no tables and cannot bypass row-level
security. Every piece of work happens inside one transaction; the tenant (or operator)
context is set *inside* that transaction, so it is forgotten the moment the transaction
ends and can never leak to the next request that reuses the pooled connection.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from flask import Flask, current_app
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

_EXTENSION_KEY = "bos_engine"

# psycopg prepares a statement on the server after five runs on one pooled connection, and
# with the default plan_cache_mode (auto) PostgreSQL may then reuse a generic plan for it.
# Row-level security reads the business from app.tenant_id when a plan is made, so a generic
# plan made while a small business was querying is wrong for a large one (a nested loop:
# seconds instead of milliseconds). Every query of the API is planned for the business it
# runs for.
CONNECTION_OPTIONS = (
    "-c statement_timeout=30000 -c lock_timeout=10000 -c plan_cache_mode=force_custom_plan"
)


def make_engine(database_url: str) -> Engine:
    return create_engine(
        database_url,
        pool_pre_ping=True,
        # Error messages (and so logged tracebacks) must not carry bound values: they include
        # password hashes, token hashes, phone numbers and emails.
        hide_parameters=True,
        connect_args={"options": CONNECTION_OPTIONS},
    )


def init_engine(app: Flask, database_url: str) -> Engine:
    engine = make_engine(database_url)
    app.extensions[_EXTENSION_KEY] = engine
    return engine


def engine_of(app: Flask) -> Engine:
    engine = app.extensions[_EXTENSION_KEY]
    assert isinstance(engine, Engine)
    return engine


def get_engine() -> Engine:
    return engine_of(current_app)


@contextmanager
def transaction(engine: Engine) -> Iterator[Session]:
    """One unit of work: commits if the block succeeds, rolls back if it raises.

    A transaction opened this way has no tenant and no operator context, so row-level
    security shows it nothing. Use ``tenancy.tenant_transaction`` for tenant work.
    """
    with Session(engine, expire_on_commit=False) as session, session.begin():
        yield session
