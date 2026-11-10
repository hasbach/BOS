"""Database helpers for tests that talk to PostgreSQL directly.

Two connections are used on purpose:

* the **owner** role arranges data (it owns the tables and is not subject to row-level
  security), and
* the **application** role is what the running API uses, so every assertion about isolation
  is made through it.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, Engine, text

# Every table protected by row-level security, with the column that holds the tenant.
RLS_TABLES: dict[str, str] = {
    "tenants": "id",
    "stores": "tenant_id",
    "users": "tenant_id",
    "user_stores": "tenant_id",
    "invitations": "tenant_id",
    "password_resets": "tenant_id",
    "idempotency_keys": "tenant_id",
    "files": "tenant_id",
    "audit_entries": "tenant_id",
}

ALL_TABLES = [
    "audit_entries",
    "idempotency_keys",
    "login_attempts",
    "sessions",
    "password_resets",
    "invitations",
    "user_stores",
    "users",
    "stores",
    "files",
    "tenants",
    "operators",
]


def truncate_all(owner: Engine) -> None:
    """Empty every table between tests.

    Uses DELETE rather than TRUNCATE: TRUNCATE rewrites every table and index file, which is
    very slow on some development disks, while these tables hold a handful of rows. The
    owner role switches off triggers and foreign-key checks for this one transaction so the
    append-only history table can be emptied too. Only tests do this.
    """
    with owner.begin() as conn:
        conn.execute(text("SET LOCAL session_replication_role = replica"))
        conn.execute(text("SET LOCAL synchronous_commit = off"))
        for table in ALL_TABLES:
            conn.execute(text(f"DELETE FROM {table}"))  # noqa: S608


@contextmanager
def as_tenant(app: Engine, tenant_id: uuid.UUID | None) -> Iterator[Connection]:
    """A transaction as the application role, scoped to one tenant (or to none)."""
    with app.connect() as conn:
        trans = conn.begin()
        try:
            if tenant_id is not None:
                conn.execute(
                    text("SELECT set_config('app.tenant_id', :tid, true)"), {"tid": str(tenant_id)}
                )
            yield conn
        finally:
            trans.rollback()


@contextmanager
def as_operator(app: Engine) -> Iterator[Connection]:
    """A transaction as the application role in operator context."""
    with app.connect() as conn:
        trans = conn.begin()
        try:
            conn.execute(text("SELECT set_config('app.operator', 'on', true)"))
            yield conn
        finally:
            trans.rollback()


def insert(conn: Connection, table: str, **values: Any) -> None:
    columns = ", ".join(values)
    params = ", ".join(f":{name}" for name in values)
    conn.execute(text(f"INSERT INTO {table} ({columns}) VALUES ({params})"), values)  # noqa: S608


class World:
    """One tenant with a row in every tenant-owned table, created as the owner role."""

    def __init__(self, conn: Connection, operator_id: uuid.UUID, label: str) -> None:
        self.label = label
        self.tenant_id = uuid.uuid4()
        self.store_id = uuid.uuid4()
        self.user_id = uuid.uuid4()
        self.file_id = uuid.uuid4()
        self.invitation_id = uuid.uuid4()
        self.reset_id = uuid.uuid4()
        self.audit_id = uuid.uuid4()
        self.invitation_token_hash = uuid.uuid4().bytes + uuid.uuid4().bytes
        self.reset_token_hash = uuid.uuid4().bytes + uuid.uuid4().bytes
        self.phone = f"+9617{uuid.uuid4().int % 10_000_000:07d}"
        self.email = f"owner-{label}@example.test"

        insert(
            conn,
            "tenants",
            id=self.tenant_id,
            name=f"Tenant {label}",
            edition="social",
            status="active",
            usd_lbp_rate="89500.00",
            created_by_operator_id=operator_id,
        )
        insert(
            conn,
            "stores",
            id=self.store_id,
            tenant_id=self.tenant_id,
            name=f"Store {label}",
            whatsapp_e164=self.phone,
        )
        insert(
            conn,
            "users",
            id=self.user_id,
            tenant_id=self.tenant_id,
            name=f"Owner {label}",
            phone_e164=self.phone,
            email=self.email,
            password_hash="x",
            locale="en",
            roles=["owner"],
            all_stores=True,
        )
        insert(
            conn,
            "user_stores",
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            store_id=self.store_id,
        )
        insert(
            conn,
            "files",
            id=self.file_id,
            tenant_id=self.tenant_id,
            kind="store_logo",
            storage_path=f"tenant/{self.tenant_id}/logo.webp",
            mime="image/webp",
            size_bytes=10,
            created_by_user_id=self.user_id,
        )
        insert(
            conn,
            "invitations",
            id=self.invitation_id,
            tenant_id=self.tenant_id,
            kind="employee",
            invitee_name=f"Invitee {label}",
            invitee_email=f"invitee-{label}@example.test",
            roles=["sales"],
            all_stores=True,
            token_hash=self.invitation_token_hash,
            created_by_user_id=self.user_id,
        )
        insert(
            conn,
            "password_resets",
            id=self.reset_id,
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            token_hash=self.reset_token_hash,
        )
        insert(
            conn,
            "idempotency_keys",
            key=f"key-{label}",
            scope="staff.invite",
            actor_id=self.user_id,
            tenant_id=self.tenant_id,
            request_hash=b"h",
            resource_type="invitation",
            resource_id=self.invitation_id,
        )
        insert(
            conn,
            "audit_entries",
            id=self.audit_id,
            tenant_id=self.tenant_id,
            actor_type="user",
            actor_id=self.user_id,
            event="auth.sign_in",
        )


def make_operator(conn: Connection) -> uuid.UUID:
    operator_id = uuid.uuid4()
    insert(
        conn,
        "operators",
        id=operator_id,
        email=f"ops-{operator_id.hex[:8]}@example.test",
        name="Operator",
        password_hash="x",
    )
    return operator_id


@dataclass(frozen=True)
class TwoTenants:
    a: World
    b: World


def make_two_tenants(owner: Engine) -> TwoTenants:
    truncate_all(owner)
    with owner.begin() as conn:
        operator_id = make_operator(conn)
        return TwoTenants(a=World(conn, operator_id, "a"), b=World(conn, operator_id, "b"))
