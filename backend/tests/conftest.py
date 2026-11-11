"""Shared pytest fixtures.

Database fixtures come in two kinds, and a test module must use only one kind:

* **shared** — ``two_tenants`` (or ``two_staffed_tenants``): two populated tenants shared by
  the whole module. Tests using it must do all their work inside transactions that are
  rolled back. The only rows they may commit are sign-in sessions made by ``user_client`` /
  ``operator_client``, and then only for read-only (GET) requests.
* **fresh** — ``fresh_tenants`` (or ``fresh_staffed_tenants``): two populated tenants created
  for one test and wiped afterwards. Use it when the code under test commits.

The plain variants have exactly one row per tenant-owned table per tenant (the isolation
tests count on this). The staffed variants add, per tenant, a second store, one user per
role and one store-limited sales user (see ``tests.dbsupport.World``).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator

import pytest
from alembic import command
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine, create_engine

from app import create_app
from app.cli import alembic_config
from app.config import Config
from app.core.db import engine_of
from app.core.sessions import OPERATOR_COOKIE, USER_COOKIE
from tests.dbsupport import (
    TwoTenants,
    make_two_tenants,
    new_operator_session,
    new_user_session,
    truncate_all,
)

# A test that leaves a transaction open must fail quickly, not hang the whole run.
_TIMEOUTS = {"options": "-c lock_timeout=5000 -c statement_timeout=30000"}


@pytest.fixture(scope="session")
def config() -> Config:
    return Config.from_env(testing=True)


@pytest.fixture()
def app(config: Config) -> Iterator[Flask]:
    application = create_app(config)
    yield application
    engine_of(application).dispose()


@pytest.fixture()
def client(app: Flask) -> FlaskClient:
    return app.test_client()


@pytest.fixture(scope="session")
def owner_engine(config: Config) -> Iterator[Engine]:
    """Owner role: runs migrations and arranges test data."""
    alembic = alembic_config(config.migration_database_url)
    command.downgrade(alembic, "base")
    command.upgrade(alembic, "head")
    engine = create_engine(config.migration_database_url, connect_args=_TIMEOUTS)
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def app_engine(config: Config, owner_engine: Engine) -> Iterator[Engine]:
    """Application role: what the running API connects as."""
    engine = create_engine(config.database_url, connect_args=_TIMEOUTS)
    yield engine
    engine.dispose()


@pytest.fixture(scope="module")
def two_tenants(owner_engine: Engine) -> Iterator[TwoTenants]:
    worlds = make_two_tenants(owner_engine)
    yield worlds
    truncate_all(owner_engine)


@pytest.fixture(scope="module")
def two_staffed_tenants(owner_engine: Engine) -> Iterator[TwoTenants]:
    worlds = make_two_tenants(owner_engine, staffed=True)
    yield worlds
    truncate_all(owner_engine)


@pytest.fixture()
def fresh_tenants(owner_engine: Engine) -> Iterator[TwoTenants]:
    worlds = make_two_tenants(owner_engine)
    yield worlds
    truncate_all(owner_engine)


@pytest.fixture()
def fresh_staffed_tenants(owner_engine: Engine) -> Iterator[TwoTenants]:
    worlds = make_two_tenants(owner_engine, staffed=True)
    yield worlds
    truncate_all(owner_engine)


# ---- signed-in test clients -------------------------------------------------------------------


@pytest.fixture()
def user_client(app: Flask, app_engine: Engine) -> Callable[[uuid.UUID, uuid.UUID], FlaskClient]:
    """``user_client(user_id, tenant_id)``: a test client signed in as that user."""

    def make(user_id: uuid.UUID, tenant_id: uuid.UUID) -> FlaskClient:
        signed_in = app.test_client()
        signed_in.set_cookie(USER_COOKIE, new_user_session(app_engine, user_id, tenant_id))
        return signed_in

    return make


@pytest.fixture()
def operator_client(app: Flask, app_engine: Engine) -> Callable[[uuid.UUID], FlaskClient]:
    """``operator_client(operator_id)``: a test client signed in as that operator.

    The operator's email must be in the app's ``operator_emails`` for requests to succeed.
    """

    def make(operator_id: uuid.UUID) -> FlaskClient:
        signed_in = app.test_client()
        signed_in.set_cookie(OPERATOR_COOKIE, new_operator_session(app_engine, operator_id))
        return signed_in

    return make
