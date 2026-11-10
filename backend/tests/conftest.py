"""Shared pytest fixtures.

Database fixtures come in two kinds, and a test module must use only one of them:

* ``two_tenants`` — two populated tenants shared by the whole module. Tests using it must do
  all their work inside transactions that are rolled back.
* ``fresh_tenants`` — two populated tenants created for one test and wiped afterwards. Use it
  when the code under test commits.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from alembic import command
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine, create_engine

from app import create_app
from app.cli import alembic_config
from app.config import Config
from tests.dbsupport import TwoTenants, make_two_tenants, truncate_all

# A test that leaves a transaction open must fail quickly, not hang the whole run.
_TIMEOUTS = {"options": "-c lock_timeout=5000 -c statement_timeout=30000"}


@pytest.fixture(scope="session")
def config() -> Config:
    return Config.from_env(testing=True)


@pytest.fixture()
def app(config: Config) -> Iterator[Flask]:
    yield create_app(config)


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


@pytest.fixture()
def fresh_tenants(owner_engine: Engine) -> Iterator[TwoTenants]:
    worlds = make_two_tenants(owner_engine)
    yield worlds
    truncate_all(owner_engine)
