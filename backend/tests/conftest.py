"""Shared pytest fixtures.

Database fixtures come in two kinds, and a test module must use only one kind:

* **shared** — ``two_tenants`` (or ``two_staffed_tenants``): two populated tenants shared by
  the whole module. Tests using it must do all their work inside transactions that are
  rolled back. The only rows they may commit are sign-in sessions made by ``user_client`` /
  ``operator_client``, and then only for read-only (GET) requests.
* **fresh** — ``fresh_tenants`` (or ``fresh_staffed_tenants``): two populated tenants created
  for one test and wiped afterwards. Use it when the code under test commits.

The plain variants have exactly one row per M0 tenant-owned table per tenant, plus the
default warehouse (the isolation tests count on this). The staffed variants add, per tenant,
a second store, one user per role and one store-limited sales user; the catalog variants
(``two_catalog_tenants``, ``fresh_catalog_tenants``) add one row in every M1 catalog table
(see ``tests.dbsupport.World``). Catalog and stock rows for a test are written directly with
``tests.dbsupport.insert_product`` / ``insert_allocation`` / ``read_balance``.

Catalog, stock, allocation and import test modules enable the ``integrity_check`` fixture
for every test (``pytestmark = pytest.mark.usefixtures("integrity_check")``): after the
test, every business in the database must pass ``app.services.inventory.integrity_report``.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator

import pytest
from alembic import command
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine, create_engine, text

from app import create_app
from app.cli import alembic_config
from app.config import Config
from app.core.db import engine_of
from app.core.sessions import OPERATOR_COOKIE, USER_COOKIE
from app.core.tenancy import tenant_transaction
from app.services.inventory import integrity_report
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


@pytest.fixture(scope="module")
def two_catalog_tenants(owner_engine: Engine) -> Iterator[TwoTenants]:
    worlds = make_two_tenants(owner_engine, catalog=True)
    yield worlds
    truncate_all(owner_engine)


@pytest.fixture()
def fresh_catalog_tenants(owner_engine: Engine) -> Iterator[TwoTenants]:
    worlds = make_two_tenants(owner_engine, catalog=True)
    yield worlds
    truncate_all(owner_engine)


# ---- stock integrity after every catalog and stock test (FR-022, SC-003) ----------------------


@pytest.fixture()
def integrity_check(owner_engine: Engine, app_engine: Engine) -> Callable[[], None]:
    """Checks, right after the test body, that every business passes the integrity report.

    The check runs in ``pytest_runtest_call`` below, before any fixture is torn down (so
    before function-scoped data fixtures wipe the database). Businesses are listed by the
    owner role (test set-up) and each is checked as the application role in its own
    transaction, exactly as ``flask bos stock-check`` does.
    """

    def check() -> None:
        with owner_engine.connect() as conn:
            tenant_ids = list(conn.execute(text("SELECT id FROM tenants ORDER BY id")).scalars())
        problems: list[str] = []
        for tenant_id in tenant_ids:
            with tenant_transaction(app_engine, tenant_id) as db:
                problems.extend(f"business {tenant_id}: {p}" for p in integrity_report(db))
        if problems:
            pytest.fail("Stock integrity check failed:\n  " + "\n  ".join(problems))

    return check


@pytest.hookimpl(wrapper=True)
def pytest_runtest_call(item: pytest.Item) -> Iterator[None]:
    result = yield  # a failing test raises here and is reported as it is
    funcargs = getattr(item, "funcargs", {})
    check = funcargs.get("integrity_check")
    if callable(check):
        check()
    return result


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
