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


def make_engine(database_url: str) -> Engine:
    return create_engine(
        database_url,
        pool_pre_ping=True,
        connect_args={"options": "-c statement_timeout=30000 -c lock_timeout=10000"},
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
