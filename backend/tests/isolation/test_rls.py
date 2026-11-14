"""T009 — the database itself refuses cross-tenant access (constitution Principle I).

Every assertion is made as the application role. If application code ever forgets a tenant
filter, these are the guarantees that still hold.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from tests.dbsupport import RLS_TABLES, TwoTenants, World, as_tenant, insert

TABLES = sorted(RLS_TABLES)


def _count(conn, table: str, where: str = "true", **params) -> int:  # type: ignore[no-untyped-def]
    return conn.execute(text(f"SELECT count(*) FROM {table} WHERE {where}"), params).scalar_one()  # noqa: S608


def test_application_role_cannot_bypass_row_level_security(app_engine: Engine) -> None:
    with app_engine.connect() as conn:
        row = conn.execute(
            text("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
        ).one()
    assert row.rolsuper is False
    assert row.rolbypassrls is False


def test_application_role_owns_no_tables(app_engine: Engine) -> None:
    with app_engine.connect() as conn:
        owned = conn.execute(
            text(
                "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user"
            )
        ).scalar_one()
    assert owned == 0


@pytest.mark.parametrize("table", TABLES)
def test_row_level_security_is_enabled_and_forced(app_engine: Engine, table: str) -> None:
    with app_engine.connect() as conn:
        row = conn.execute(
            text("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = :t"),
            {"t": table},
        ).one()
    assert row.relrowsecurity is True
    assert row.relforcerowsecurity is True


@pytest.mark.parametrize("table", TABLES)
def test_tenant_sees_only_its_own_rows(
    app_engine: Engine, two_tenants: TwoTenants, table: str
) -> None:
    column = RLS_TABLES[table]
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn:
        own = _count(conn, table, f"{column} = :tid", tid=two_tenants.a.tenant_id)
        foreign = _count(conn, table, f"{column} = :tid", tid=two_tenants.b.tenant_id)
        total = _count(conn, table)

    assert own == 1
    assert foreign == 0
    assert total == 1


@pytest.mark.parametrize("table", TABLES)
def test_no_tenant_context_sees_nothing(
    app_engine: Engine, two_tenants: TwoTenants, table: str
) -> None:
    with as_tenant(app_engine, None) as conn:
        assert _count(conn, table) == 0


@pytest.mark.parametrize("table", TABLES)
def test_made_up_tenant_sees_nothing(
    app_engine: Engine, two_tenants: TwoTenants, table: str
) -> None:
    with as_tenant(app_engine, uuid.uuid4()) as conn:
        assert _count(conn, table) == 0


# A harmless column to try to change in each table.
UPDATABLE = {
    "tenants": ("name", "'hacked'"),
    "stores": ("name", "'hacked'"),
    "users": ("name", "'hacked'"),
    "invitations": ("invitee_name", "'hacked'"),
    "invitation_codes": ("failed_attempts", "5"),
    "password_resets": ("used_at", "now()"),
    "idempotency_keys": ("resource_type", "'hacked'"),
    "files": ("mime", "'text/plain'"),
}


@pytest.mark.parametrize("table", sorted(UPDATABLE))
def test_tenant_cannot_update_another_tenants_rows(
    app_engine: Engine, owner_engine: Engine, two_tenants: TwoTenants, table: str
) -> None:
    column = RLS_TABLES[table]
    field, value = UPDATABLE[table]
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn:
        try:
            result = conn.execute(
                text(f"UPDATE {table} SET {field} = {value} WHERE {column} = :tid"),  # noqa: S608
                {"tid": two_tenants.b.tenant_id},
            )
            affected = result.rowcount
        except DBAPIError:
            affected = 0  # no UPDATE privilege at all is also a refusal
    assert affected == 0


DELETABLE = [
    "user_stores",
    "invitations",
    "invitation_codes",
    "password_resets",
    "idempotency_keys",
    "files",
]


@pytest.mark.parametrize("table", DELETABLE)
def test_tenant_cannot_delete_another_tenants_rows(
    app_engine: Engine, two_tenants: TwoTenants, table: str
) -> None:
    column = RLS_TABLES[table]
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn:
        try:
            affected = conn.execute(
                text(f"DELETE FROM {table} WHERE {column} = :tid"),  # noqa: S608
                {"tid": two_tenants.b.tenant_id},
            ).rowcount
        except DBAPIError:
            affected = 0
    assert affected == 0


def _insert_store_for(conn, world: World) -> None:  # type: ignore[no-untyped-def]
    insert(conn, "stores", id=uuid.uuid4(), tenant_id=world.tenant_id, name="Planted store")


def test_tenant_can_insert_into_its_own_tenant(app_engine: Engine, two_tenants: TwoTenants) -> None:
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn:
        _insert_store_for(conn, two_tenants.a)
        assert _count(conn, "stores") == 2


def test_tenant_cannot_insert_a_row_into_another_tenant(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn, pytest.raises(DBAPIError):
        _insert_store_for(conn, two_tenants.b)


def test_insert_without_tenant_context_is_refused(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_tenant(app_engine, None) as conn, pytest.raises(DBAPIError):
        _insert_store_for(conn, two_tenants.a)


def test_tenant_cannot_move_its_row_into_another_tenant(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn, pytest.raises(DBAPIError):
        conn.execute(
            text("UPDATE stores SET tenant_id = :other WHERE id = :id"),
            {"other": two_tenants.b.tenant_id, "id": two_tenants.a.store_id},
        )


def test_row_cannot_reference_a_parent_in_another_tenant(
    owner_engine: Engine, two_tenants: TwoTenants
) -> None:
    """Composite foreign keys: even the owner role cannot link A's user to B's store."""
    with owner_engine.connect() as conn, conn.begin() as trans, pytest.raises(DBAPIError):
        try:
            insert(
                conn,
                "user_stores",
                tenant_id=two_tenants.a.tenant_id,
                user_id=two_tenants.a.user_id,
                store_id=two_tenants.b.store_id,
            )
        finally:
            trans.rollback()


def test_store_logo_cannot_point_at_another_tenants_file(
    owner_engine: Engine, two_tenants: TwoTenants
) -> None:
    with owner_engine.connect() as conn, conn.begin() as trans, pytest.raises(DBAPIError):
        try:
            conn.execute(
                text("UPDATE stores SET logo_file_id = :file WHERE id = :id"),
                {"file": two_tenants.b.file_id, "id": two_tenants.a.store_id},
            )
        finally:
            trans.rollback()


# ---- audit history is append-only -------------------------------------------------------


def test_application_role_can_add_history_for_its_tenant(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn:
        insert(
            conn,
            "audit_entries",
            id=uuid.uuid4(),
            tenant_id=two_tenants.a.tenant_id,
            actor_type="system",
            event="maintenance.run",
        )
        assert _count(conn, "audit_entries") == 2


def test_application_role_cannot_insert_platform_level_history_directly(
    app_engine: Engine, two_tenants: TwoTenants
) -> None:
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn, pytest.raises(DBAPIError):
        insert(
            conn, "audit_entries", id=uuid.uuid4(), tenant_id=None, actor_type="system", event="x"
        )


@pytest.mark.parametrize(
    "statement", ["UPDATE audit_entries SET event = 'changed'", "DELETE FROM audit_entries"]
)
def test_history_cannot_be_changed_or_deleted_by_the_application(
    app_engine: Engine, two_tenants: TwoTenants, statement: str
) -> None:
    with as_tenant(app_engine, two_tenants.a.tenant_id) as conn, pytest.raises(DBAPIError):
        conn.execute(text(statement))


@pytest.mark.parametrize(
    "statement", ["UPDATE audit_entries SET event = 'changed'", "DELETE FROM audit_entries"]
)
def test_history_cannot_be_changed_or_deleted_even_by_the_owner_role(
    owner_engine: Engine, two_tenants: TwoTenants, statement: str
) -> None:
    with owner_engine.connect() as conn, conn.begin() as trans, pytest.raises(DBAPIError):
        try:
            conn.execute(text(statement))
        finally:
            trans.rollback()


# ---- identifiers are unique across the whole platform -----------------------------------


@pytest.mark.parametrize("field", ["phone_e164", "email"])
def test_identifier_is_unique_across_tenants(
    owner_engine: Engine, two_tenants: TwoTenants, field: str
) -> None:
    taken = getattr(two_tenants.a, "phone" if field == "phone_e164" else "email")
    with owner_engine.connect() as conn, conn.begin() as trans, pytest.raises(DBAPIError):
        try:
            insert(
                conn,
                "users",
                id=uuid.uuid4(),
                tenant_id=two_tenants.b.tenant_id,
                name="Second person",
                password_hash="x",
                locale="en",
                roles=["sales"],
                all_stores=True,
                **{field: taken},
            )
        finally:
            trans.rollback()


def test_email_uniqueness_ignores_case(owner_engine: Engine, two_tenants: TwoTenants) -> None:
    with owner_engine.connect() as conn, conn.begin() as trans, pytest.raises(DBAPIError):
        try:
            insert(
                conn,
                "users",
                id=uuid.uuid4(),
                tenant_id=two_tenants.b.tenant_id,
                name="Second person",
                email=two_tenants.a.email.upper(),
                password_hash="x",
                locale="en",
                roles=["sales"],
                all_stores=True,
            )
        finally:
            trans.rollback()


def test_user_needs_a_phone_or_an_email(owner_engine: Engine, two_tenants: TwoTenants) -> None:
    with owner_engine.connect() as conn, conn.begin() as trans, pytest.raises(DBAPIError):
        try:
            insert(
                conn,
                "users",
                id=uuid.uuid4(),
                tenant_id=two_tenants.a.tenant_id,
                name="Nobody",
                password_hash="x",
                locale="en",
                roles=["sales"],
                all_stores=True,
            )
        finally:
            trans.rollback()
