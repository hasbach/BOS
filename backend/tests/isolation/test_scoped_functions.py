"""T010 — the only ways to reach data before a tenant is known (data-model.md, research R23).

Each function must return the minimum it is documented to return, from every context.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from tests.dbsupport import TwoTenants, as_operator, as_tenant, insert

# ---- auth_lookup_identifier ---------------------------------------------------------------


def _lookup(conn, kind: str, value: str):  # type: ignore[no-untyped-def]
    return conn.execute(
        text("SELECT * FROM auth_lookup_identifier(:kind, :value)"), {"kind": kind, "value": value}
    ).all()


def test_identifier_lookup_works_without_any_tenant_context(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_tenant(app_engine, None) as conn:
        rows = _lookup(conn, "phone", two_tenants.a.phone)

    assert len(rows) == 1
    row = rows[0]._mapping
    assert set(row) == {"user_id", "tenant_id", "password_hash", "user_status", "tenant_status"}
    assert row["user_id"] == two_tenants.a.user_id
    assert row["tenant_id"] == two_tenants.a.tenant_id
    assert row["user_status"] == "active"
    assert row["tenant_status"] == "active"


def test_identifier_lookup_by_email(app_engine: Engine, two_tenants: TwoTenants) -> None:
    with as_tenant(app_engine, None) as conn:
        rows = _lookup(conn, "email", two_tenants.b.email)

    assert [r._mapping["tenant_id"] for r in rows] == [two_tenants.b.tenant_id]


@pytest.mark.parametrize("value", ["+9617", "+961", "%", "", "owner-a@", "example.test"])
def test_identifier_lookup_needs_an_exact_match(
    app_engine: Engine, two_tenants: TwoTenants, value: str
) -> None:
    with as_tenant(app_engine, None) as conn:
        assert _lookup(conn, "phone", value) == []
        assert _lookup(conn, "email", value) == []


def test_identifier_lookup_does_not_mix_kinds(app_engine: Engine, two_tenants: TwoTenants) -> None:
    with as_tenant(app_engine, None) as conn:
        assert _lookup(conn, "email", two_tenants.a.phone) == []
        assert _lookup(conn, "phone", two_tenants.a.email) == []
        assert _lookup(conn, "anything", two_tenants.a.phone) == []


# ---- auth_lookup_token ----------------------------------------------------------------------


def _token(conn, kind: str, token_hash: bytes):  # type: ignore[no-untyped-def]
    return conn.execute(
        text("SELECT * FROM auth_lookup_token(:kind, :hash)"), {"kind": kind, "hash": token_hash}
    ).all()


def test_token_lookup_returns_only_tenant_and_row_id(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_tenant(app_engine, None) as conn:
        invitation = _token(conn, "invitation", two_tenants.a.invitation_token_hash)
        reset = _token(conn, "password_reset", two_tenants.b.reset_token_hash)

    assert [tuple(r) for r in invitation] == [
        (two_tenants.a.tenant_id, two_tenants.a.invitation_id)
    ]
    assert [tuple(r) for r in reset] == [(two_tenants.b.tenant_id, two_tenants.b.reset_id)]
    assert set(invitation[0]._mapping) == {"tenant_id", "row_id"}


def test_token_lookup_does_not_mix_kinds_or_guess(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_tenant(app_engine, None) as conn:
        assert _token(conn, "password_reset", two_tenants.a.invitation_token_hash) == []
        assert _token(conn, "invitation", two_tenants.a.reset_token_hash) == []
        assert _token(conn, "invitation", b"\x00" * 32) == []
        assert _token(conn, "invitation", two_tenants.a.invitation_token_hash[:16]) == []


# ---- operator context -------------------------------------------------------------------------

OVERVIEW_COLUMNS = {
    "id",
    "name",
    "edition",
    "status",
    "is_demo",
    "created_at",
    "store_count",
    "user_count",
    "owners",
    "pending_owner_contact",
}


def test_overview_is_refused_in_tenant_context(app_engine: Engine, two_tenants: TwoTenants) -> None:
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn, pytest.raises(DBAPIError):
        conn.execute(text("SELECT * FROM ops_business_overview()")).all()


def test_overview_is_refused_with_no_context(app_engine: Engine, two_tenants: TwoTenants) -> None:
    with as_tenant(app_engine, None) as conn, pytest.raises(DBAPIError):
        conn.execute(text("SELECT * FROM ops_business_overview()")).all()


def test_overview_returns_account_level_columns_only(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_operator(app_engine) as conn:
        rows = conn.execute(text("SELECT * FROM ops_business_overview()")).all()

    assert len(rows) == 2
    by_id = {r._mapping["id"]: r._mapping for r in rows}
    row = by_id[two_tenants.a.tenant_id]
    assert set(row) == OVERVIEW_COLUMNS
    assert row["store_count"] == 1
    assert row["user_count"] == 1
    assert row["owners"] == [
        {
            "user_id": str(two_tenants.a.user_id),
            "name": "Owner a",
            "contact": two_tenants.a.phone,
            "has_email": True,
        }
    ]
    assert row["pending_owner_contact"] is None


@pytest.mark.parametrize(
    "table",
    ["stores", "users", "user_stores", "invitations", "password_resets", "files", "audit_entries"],
)
def test_operator_context_cannot_read_inside_any_business(
    app_engine: Engine, two_tenants: TwoTenants, table: str
) -> None:
    with as_operator(app_engine) as conn:
        assert conn.execute(text(f"SELECT count(*) FROM {table}")).scalar_one() == 0  # noqa: S608


def test_operator_context_can_list_and_create_tenants(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_operator(app_engine) as conn:
        operator_id = conn.execute(text("SELECT id FROM operators LIMIT 1")).scalar_one()
        assert conn.execute(text("SELECT count(*) FROM tenants")).scalar_one() == 2
        insert(
            conn,
            "tenants",
            id=uuid.uuid4(),
            name="New merchant",
            edition="social",
            usd_lbp_rate="89500",
            created_by_operator_id=operator_id,
        )
        assert conn.execute(text("SELECT count(*) FROM tenants")).scalar_one() == 3


def test_tenant_context_cannot_create_a_tenant(app_engine: Engine, two_tenants: TwoTenants) -> None:
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn:
        operator_id = conn.execute(text("SELECT id FROM operators LIMIT 1")).scalar_one()
        with pytest.raises(DBAPIError):
            insert(
                conn,
                "tenants",
                id=uuid.uuid4(),
                name="Self-made",
                edition="social",
                usd_lbp_rate="1",
                created_by_operator_id=operator_id,
            )


def test_operator_can_write_inside_a_tenant_only_after_entering_its_context(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    """Research R24: setup inserts the tenant as operator, then enters that tenant's context."""
    with as_operator(app_engine) as conn:
        operator_id = conn.execute(text("SELECT id FROM operators LIMIT 1")).scalar_one()
        tenant_id = uuid.uuid4()
        insert(
            conn,
            "tenants",
            id=tenant_id,
            name="Fresh merchant",
            edition="commerce",
            usd_lbp_rate="89500",
            created_by_operator_id=operator_id,
        )
        savepoint = conn.begin_nested()
        with pytest.raises(DBAPIError):
            insert(conn, "stores", id=uuid.uuid4(), tenant_id=tenant_id, name="Main")
        savepoint.rollback()

        conn.execute(
            text("SELECT set_config('app.tenant_id', :tid, true)"), {"tid": str(tenant_id)}
        )
        insert(conn, "stores", id=uuid.uuid4(), tenant_id=tenant_id, name="Main")
        assert conn.execute(text("SELECT count(*) FROM stores")).scalar_one() == 1


# ---- audit_platform_event ---------------------------------------------------------------------


def test_platform_event_is_recorded_without_a_tenant_and_is_not_readable_by_tenants(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn:
        before = conn.execute(text("SELECT count(*) FROM audit_entries")).scalar_one()
        new_id = conn.execute(
            text(
                "SELECT audit_platform_event('anonymous', NULL, 'auth.sign_in_failed', '{}'::jsonb, NULL)"
            )
        ).scalar_one()
        after = conn.execute(text("SELECT count(*) FROM audit_entries")).scalar_one()

    assert isinstance(new_id, uuid.UUID)
    assert after == before


def test_platform_event_row_has_no_tenant(owner_engine: Engine, two_tenants: TwoTenants) -> None:
    with owner_engine.connect() as conn:
        trans = conn.begin()
        try:
            new_id = conn.execute(
                text(
                    "SELECT audit_platform_event('system', NULL, 'maintenance.run', "
                    "'{\"sessions_deleted\": 0}'::jsonb, NULL)"
                )
            ).scalar_one()
            row = conn.execute(
                text("SELECT tenant_id, actor_type, event, data FROM audit_entries WHERE id = :id"),
                {"id": new_id},
            ).one()
        finally:
            trans.rollback()

    assert row.tenant_id is None
    assert (row.actor_type, row.event) == ("system", "maintenance.run")
    assert row.data == {"sessions_deleted": 0}


# ---- platform_maintenance ---------------------------------------------------------------------


def test_application_role_may_run_maintenance(app_engine: Engine, two_tenants: TwoTenants) -> None:
    with as_tenant(app_engine, None) as conn:
        result = conn.execute(text("SELECT platform_maintenance()")).scalar_one()

    assert set(result) == {
        "invitations_expired",
        "sessions_deleted",
        "login_attempts_deleted",
        "idempotency_keys_deleted",
        "password_resets_deleted",
    }


def test_maintenance_touches_only_expired_housekeeping_rows(
    owner_engine: Engine, two_tenants: TwoTenants
) -> None:
    a = two_tenants.a
    with owner_engine.connect() as conn:
        trans = conn.begin()
        try:
            expired_invitation, old_session, live_session = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
            insert(
                conn,
                "invitations",
                id=expired_invitation,
                tenant_id=a.tenant_id,
                kind="employee",
                invitee_name="Late",
                invitee_email="late@example.test",
                roles=["packing"],
                all_stores=True,
                token_hash=uuid.uuid4().bytes,
                created_by_user_id=a.user_id,
                expires_at="2020-01-01T00:00:00Z",
            )
            for session_id, idle in (
                (old_session, "2020-01-01T00:00:00Z"),
                (live_session, "2999-01-01T00:00:00Z"),
            ):
                insert(
                    conn,
                    "sessions",
                    id=session_id,
                    user_id=a.user_id,
                    tenant_id=a.tenant_id,
                    token_hash=uuid.uuid4().bytes,
                    idle_expires_at=idle,
                    absolute_expires_at="2999-01-01T00:00:00Z",
                )
            insert(
                conn,
                "login_attempts",
                identifier_hash=b"old",
                success=False,
                at="2020-01-01T00:00:00Z",
            )
            insert(conn, "login_attempts", identifier_hash=b"new", success=False)
            conn.execute(
                text("UPDATE idempotency_keys SET created_at = '2020-01-01' WHERE tenant_id = :t"),
                {"t": a.tenant_id},
            )
            business_before = conn.execute(
                text(
                    "SELECT (SELECT count(*) FROM stores), (SELECT count(*) FROM users), "
                    "(SELECT count(*) FROM files), (SELECT count(*) FROM tenants), "
                    "(SELECT count(*) FROM audit_entries), (SELECT count(*) FROM user_stores)"
                )
            ).one()

            result = conn.execute(text("SELECT platform_maintenance()")).scalar_one()

            statuses = dict(
                conn.execute(
                    text("SELECT id, status FROM invitations WHERE tenant_id = :t"),
                    {"t": a.tenant_id},
                ).all()
            )
            sessions = {r[0] for r in conn.execute(text("SELECT id FROM sessions")).all()}
            attempts = {
                bytes(r[0])
                for r in conn.execute(text("SELECT identifier_hash FROM login_attempts")).all()
            }
            keys = conn.execute(text("SELECT count(*) FROM idempotency_keys")).scalar_one()
            business_after = conn.execute(
                text(
                    "SELECT (SELECT count(*) FROM stores), (SELECT count(*) FROM users), "
                    "(SELECT count(*) FROM files), (SELECT count(*) FROM tenants), "
                    "(SELECT count(*) FROM audit_entries), (SELECT count(*) FROM user_stores)"
                )
            ).one()
        finally:
            trans.rollback()

    assert statuses[expired_invitation] == "expired"
    assert statuses[a.invitation_id] == "pending"  # not yet due: untouched
    assert sessions == {live_session}
    assert attempts == {b"new"}
    assert keys == 1  # tenant B's fresh key remains
    assert tuple(business_after) == tuple(business_before)
    assert result["invitations_expired"] == 1
    assert result["sessions_deleted"] == 1
    assert result["login_attempts_deleted"] == 1
    assert result["idempotency_keys_deleted"] == 1
