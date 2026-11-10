"""T017, T018, T023 — transactions scoped to a tenant, and the append-only history writer."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from app.core import audit
from app.core.db import transaction
from app.core.tenancy import (
    enter_tenant_from_operator,
    operator_transaction,
    tenant_transaction,
)
from tests.dbsupport import TwoTenants


def _count(session, table: str) -> int:  # type: ignore[no-untyped-def]
    return session.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()  # noqa: S608


def _history(owner: Engine, tenant_id: uuid.UUID | None) -> list[tuple[str, str]]:
    with owner.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT event, actor_type FROM audit_entries "
                "WHERE tenant_id IS NOT DISTINCT FROM :t ORDER BY at, event"
            ),
            {"t": tenant_id},
        ).all()
    return [(r.event, r.actor_type) for r in rows]


# ---- transactions ---------------------------------------------------------------------------


def test_plain_transaction_has_no_tenant_and_sees_nothing(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with transaction(app_engine) as session:
        assert _count(session, "stores") == 0
        assert _count(session, "users") == 0


def test_tenant_transaction_sees_only_that_tenant(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with tenant_transaction(app_engine, fresh_tenants.a.tenant_id) as session:
        ids = session.execute(text("SELECT id FROM stores")).scalars().all()

    assert ids == [fresh_tenants.a.store_id]


def test_tenant_setting_does_not_leak_into_the_next_transaction(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    """Connections are pooled; the tenant must be forgotten when the transaction ends."""
    for _ in range(3):
        with tenant_transaction(app_engine, fresh_tenants.a.tenant_id) as session:
            assert _count(session, "stores") == 1
        with transaction(app_engine) as session:
            assert _count(session, "stores") == 0
            assert session.execute(text("SELECT app_tenant_id()")).scalar_one() is None


def test_transaction_commits_on_success_and_rolls_back_on_error(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    tenant = fresh_tenants.a.tenant_id
    with tenant_transaction(app_engine, tenant) as session:
        session.execute(
            text("INSERT INTO stores (id, tenant_id, name) VALUES (:id, :t, 'Kept')"),
            {"id": uuid.uuid4(), "t": tenant},
        )

    with pytest.raises(RuntimeError), tenant_transaction(app_engine, tenant) as session:
        session.execute(
            text("INSERT INTO stores (id, tenant_id, name) VALUES (:id, :t, 'Discarded')"),
            {"id": uuid.uuid4(), "t": tenant},
        )
        raise RuntimeError("boom")

    with tenant_transaction(app_engine, tenant) as session:
        names = set(session.execute(text("SELECT name FROM stores")).scalars())
    assert names == {"Store a", "Kept"}


def test_operator_transaction_sees_tenants_but_nothing_inside_them(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with operator_transaction(app_engine) as session:
        assert _count(session, "tenants") == 2
        assert _count(session, "stores") == 0
        assert _count(session, "users") == 0


def test_operator_setting_does_not_leak_into_the_next_transaction(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with operator_transaction(app_engine) as session:
        assert _count(session, "tenants") == 2
    with transaction(app_engine) as session:
        assert _count(session, "tenants") == 0


def test_operator_can_enter_one_tenant_to_set_it_up(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with operator_transaction(app_engine) as session:
        enter_tenant_from_operator(session, fresh_tenants.b.tenant_id)
        ids = session.execute(text("SELECT id FROM stores")).scalars().all()

    assert ids == [fresh_tenants.b.store_id]


# ---- history ----------------------------------------------------------------------------------


def test_record_writes_in_the_current_transaction(
    app_engine: Engine, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    a = fresh_tenants.a
    with tenant_transaction(app_engine, a.tenant_id) as session:
        audit.record(
            session,
            tenant_id=a.tenant_id,
            actor_type="user",
            actor_id=a.user_id,
            event="store.created",
            target_type="store",
            target_id=a.store_id,
            data={"name": "Main"},
        )

    assert ("store.created", "user") in _history(owner_engine, a.tenant_id)
    assert ("store.created", "user") not in _history(owner_engine, fresh_tenants.b.tenant_id)


def test_record_disappears_if_the_change_it_describes_is_rolled_back(
    app_engine: Engine, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    a = fresh_tenants.a
    with pytest.raises(RuntimeError), tenant_transaction(app_engine, a.tenant_id) as session:
        audit.record(
            session,
            tenant_id=a.tenant_id,
            actor_type="user",
            actor_id=a.user_id,
            event="store.updated",
        )
        raise RuntimeError("the change failed")

    assert ("store.updated", "user") not in _history(owner_engine, a.tenant_id)


def test_denied_access_is_recorded_even_though_the_request_is_rolled_back(
    app_engine: Engine, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    a = fresh_tenants.a
    with pytest.raises(RuntimeError), tenant_transaction(app_engine, a.tenant_id):
        audit.record_denied(
            app_engine,
            tenant_id=a.tenant_id,
            actor_id=a.user_id,
            event="access.denied_tenant",
            data={"path": "/api/v1/stores/x"},
        )
        raise RuntimeError("request refused")

    assert ("access.denied_tenant", "user") in _history(owner_engine, a.tenant_id)


def test_record_cannot_write_into_another_tenants_history(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with (
        pytest.raises(DBAPIError),
        tenant_transaction(app_engine, fresh_tenants.a.tenant_id) as session,
    ):
        audit.record(
            session,
            tenant_id=fresh_tenants.b.tenant_id,
            actor_type="user",
            actor_id=fresh_tenants.a.user_id,
            event="store.created",
        )


def test_platform_event_has_no_tenant(
    app_engine: Engine, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    audit.record_platform(app_engine, actor_type="anonymous", event="auth.sign_in_failed")

    assert _history(owner_engine, None) == [("auth.sign_in_failed", "anonymous")]


def test_unknown_event_name_is_rejected(app_engine: Engine, fresh_tenants: TwoTenants) -> None:
    a = fresh_tenants.a
    with pytest.raises(ValueError, match="unknown audit event"):
        with tenant_transaction(app_engine, a.tenant_id) as session:
            audit.record(
                session,
                tenant_id=a.tenant_id,
                actor_type="user",
                actor_id=a.user_id,
                event="made.up",
            )


@pytest.mark.parametrize(
    "key", ["password", "new_password", "token", "reset_link", "link", "token_hash"]
)
def test_secrets_are_never_written_to_history(
    app_engine: Engine, fresh_tenants: TwoTenants, key: str
) -> None:
    a = fresh_tenants.a
    with pytest.raises(ValueError, match="must not be stored"):
        with tenant_transaction(app_engine, a.tenant_id) as session:
            audit.record(
                session,
                tenant_id=a.tenant_id,
                actor_type="user",
                actor_id=a.user_id,
                event="auth.password_changed",
                data={"nested": {key: "secret"}},
            )


def test_event_list_matches_the_data_model_document() -> None:
    import re

    from tests.paths import FEATURE_DIR

    text_ = (FEATURE_DIR / "data-model.md").read_text(encoding="utf-8")
    section = text_.split("Events:", 1)[1].split("## State transitions", 1)[0]
    documented = set(re.findall(r"`([a-z_]+\.[a-z_]+)`", section))

    assert documented == set(audit.EVENTS)
