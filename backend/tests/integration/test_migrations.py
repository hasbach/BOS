"""Migration 0002 (invitation codes) rolls back and forward cleanly (constitution VIII).

The whole history is rolled back and reapplied at the start of every test session
(``owner_engine``); this checks the latest step on its own, with data in its table.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError

from app.cli import alembic_config
from app.config import Config
from tests.dbsupport import TwoTenants, make_two_tenants, truncate_all


@pytest.fixture()
def worlds(owner_engine: Engine) -> Iterator[TwoTenants]:
    yield make_two_tenants(owner_engine)
    truncate_all(owner_engine)


def _value(owner: Engine, sql: str) -> object:
    with owner.connect() as conn:
        return conn.execute(text(sql)).scalar()


def test_0002_downgrades_to_0001_and_upgrades_again(
    config: Config, owner_engine: Engine, worlds: TwoTenants
) -> None:
    alembic = alembic_config(config.migration_database_url)
    assert _value(owner_engine, "SELECT version_num FROM alembic_version") == "0002"
    assert _value(owner_engine, "SELECT count(*) FROM invitation_codes") == 2

    try:
        command.downgrade(alembic, "0001")
        assert _value(owner_engine, "SELECT version_num FROM alembic_version") == "0001"
        assert _value(owner_engine, "SELECT to_regclass('public.invitation_codes')") is None
        constraint = (
            "SELECT count(*) FROM pg_constraint WHERE conname = 'invitations_tenant_id_id_key'"
        )
        assert _value(owner_engine, constraint) == 0
        # Everything else is untouched.
        assert _value(owner_engine, "SELECT count(*) FROM invitations") == 2
    finally:
        command.upgrade(alembic, "head")

    assert _value(owner_engine, "SELECT version_num FROM alembic_version") == "0002"
    forced = _value(
        owner_engine,
        "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
        "WHERE relname = 'invitation_codes'",
    )
    assert forced is True
    insert = text(
        "INSERT INTO invitation_codes (id, tenant_id, invitation_id, code_hash) "
        "VALUES (:id, :t, :i, '\\x00')"
    )
    with owner_engine.begin() as conn:
        conn.execute(
            insert, {"id": uuid.uuid4(), "t": worlds.a.tenant_id, "i": worlds.a.invitation_id}
        )
    # A code always belongs to its invitation's business.
    with pytest.raises(IntegrityError), owner_engine.begin() as conn:
        conn.execute(
            insert, {"id": uuid.uuid4(), "t": worlds.a.tenant_id, "i": worlds.b.invitation_id}
        )
