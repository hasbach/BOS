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
    "invitation_codes": "tenant_id",
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
    "invitation_codes",
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


STAFF_ROLES = ("manager", "sales", "packing", "dispatch")


class World:
    """One tenant with a row in every tenant-owned table, created as the owner role.

    By default it has exactly one row per tenant-owned table; the isolation tests count on
    that. ``staffed=True`` adds, on top of that, a second store, one user per other role
    (``manager``, ``sales``, ``packing``, ``dispatch``, all with every store) and one
    ``sales_limited`` user who may use only the first store.
    """

    def __init__(
        self, conn: Connection, operator_id: uuid.UUID, label: str, *, staffed: bool = False
    ) -> None:
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
            "invitation_codes",
            id=uuid.uuid4(),
            tenant_id=self.tenant_id,
            invitation_id=self.invitation_id,
            code_hash=b"not a real code hash",
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

        # role name -> user id; "owner" always, the others only when staffed.
        self.users: dict[str, uuid.UUID] = {"owner": self.user_id}
        self._second_store_id: uuid.UUID | None = None
        if staffed:
            self._add_staff(conn)

    @property
    def second_store_id(self) -> uuid.UUID:
        assert self._second_store_id is not None, "create the World with staffed=True"
        return self._second_store_id

    def user(self, role: str) -> uuid.UUID:
        """Id of the user for a role, or ``sales_limited`` (staffed worlds only for those)."""
        assert role in self.users, f"no {role!r} user: create the World with staffed=True"
        return self.users[role]

    def _add_staff(self, conn: Connection) -> None:
        self._second_store_id = uuid.uuid4()
        insert(
            conn,
            "stores",
            id=self._second_store_id,
            tenant_id=self.tenant_id,
            name=f"Store {self.label} 2",
        )
        for role in (*STAFF_ROLES, "sales_limited"):
            user_id = uuid.uuid4()
            limited = role == "sales_limited"
            insert(
                conn,
                "users",
                id=user_id,
                tenant_id=self.tenant_id,
                name=f"{role} {self.label}",
                email=f"{role.replace('_', '-')}-{self.label}@example.test",
                password_hash="x",
                locale="ar" if limited else "en",
                roles=["sales"] if limited else [role],
                all_stores=not limited,
            )
            if limited:
                insert(
                    conn,
                    "user_stores",
                    tenant_id=self.tenant_id,
                    user_id=user_id,
                    store_id=self.store_id,
                )
            self.users[role] = user_id


def make_operator(conn: Connection, email: str | None = None) -> uuid.UUID:
    operator_id = uuid.uuid4()
    insert(
        conn,
        "operators",
        id=operator_id,
        email=email or f"ops-{operator_id.hex[:8]}@example.test",
        name="Operator",
        password_hash="x",
    )
    return operator_id


@dataclass(frozen=True)
class TwoTenants:
    a: World
    b: World
    operator_id: uuid.UUID
    operator_email: str


def make_two_tenants(owner: Engine, *, staffed: bool = False) -> TwoTenants:
    truncate_all(owner)
    email = f"ops-{uuid.uuid4().hex[:8]}@example.test"
    with owner.begin() as conn:
        operator_id = make_operator(conn, email)
        return TwoTenants(
            a=World(conn, operator_id, "a", staffed=staffed),
            b=World(conn, operator_id, "b", staffed=staffed),
            operator_id=operator_id,
            operator_email=email,
        )


# ---- sessions -------------------------------------------------------------------------------


def new_user_session(app: Engine, user_id: uuid.UUID, tenant_id: uuid.UUID) -> str:
    """Create (and commit) a session for a user; returns the raw cookie value."""
    from app.core import sessions
    from app.core.db import transaction

    with transaction(app) as db:
        token, _ = sessions.create_user_session(db, user_id=user_id, tenant_id=tenant_id)
    return token


def new_operator_session(app: Engine, operator_id: uuid.UUID) -> str:
    """Create (and commit) a session for an operator; returns the raw cookie value."""
    from app.core import sessions
    from app.core.db import transaction

    with transaction(app) as db:
        token, _ = sessions.create_operator_session(db, operator_id=operator_id)
    return token
