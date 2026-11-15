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
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Connection, Engine, text

# Every M0 table protected by row-level security, with the column that holds the tenant, and
# the default warehouse every business has (M1). A plain ``World`` has exactly one row in each.
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
    "warehouses": "tenant_id",
}

# The thirteen tables added by migration 0003 (M1 catalog and inventory), in dependency order.
CATALOG_TABLES = [
    "warehouses",
    "import_batches",
    "products",
    "product_stores",
    "product_options",
    "option_values",
    "product_photos",
    "inventory_items",
    "variants",
    "stock_balances",
    "allocations",
    "allocation_lines",
    "stock_movements",
]

ALL_TABLES = [
    *reversed(CATALOG_TABLES),
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
_NOW = datetime(2026, 11, 15, tzinfo=UTC)


class World:
    """One tenant with a row in every M0 tenant-owned table, created as the owner role.

    By default it has exactly one row per M0 tenant-owned table plus its default warehouse
    (every business has one, research R39); the isolation tests count on that.
    ``staffed=True`` adds, on top of that, a second store, one user per other role
    (``manager``, ``sales``, ``packing``, ``dispatch``, all with every store) and one
    ``sales_limited`` user who may use only the first store. ``catalog=True`` adds exactly one
    row in each other M1 catalog table (``self.catalog``), consistent with the integrity
    rules: a product listed in the first store, imported with opening stock 5, one unit of
    which is held by an active allocation. ``warehouse=False`` is only for a database still
    at migration 0002 (no warehouses table).
    """

    def __init__(
        self,
        conn: Connection,
        operator_id: uuid.UUID,
        label: str,
        *,
        staffed: bool = False,
        catalog: bool = False,
        warehouse: bool = True,
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
        self._warehouse_id: uuid.UUID | None = None
        self._catalog: CatalogRows | None = None
        if warehouse:
            self._warehouse_id = insert_default_warehouse(conn, self.tenant_id)
        if staffed:
            self._add_staff(conn)
        if catalog:
            self._catalog = insert_catalog_rows(conn, self)

    @property
    def warehouse_id(self) -> uuid.UUID:
        assert self._warehouse_id is not None, "this World was created without a warehouse"
        return self._warehouse_id

    @property
    def catalog(self) -> CatalogRows:
        assert self._catalog is not None, "create the World with catalog=True"
        return self._catalog

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


def make_two_tenants(owner: Engine, *, staffed: bool = False, catalog: bool = False) -> TwoTenants:
    truncate_all(owner)
    email = f"ops-{uuid.uuid4().hex[:8]}@example.test"
    with owner.begin() as conn:
        operator_id = make_operator(conn, email)
        return TwoTenants(
            a=World(conn, operator_id, "a", staffed=staffed, catalog=catalog),
            b=World(conn, operator_id, "b", staffed=staffed, catalog=catalog),
            operator_id=operator_id,
            operator_email=email,
        )


# ---- catalog and stock rows written directly (no service involved) ----------------------------
#
# US2 and US3 tests can arrange products, balances and allocations with these before the
# catalog service exists. Rows are written as the given connection's role; as the owner role
# only the database's own constraints apply, so keep the rows consistent with data-model.md
# "Integrity rules" unless a test breaks one on purpose.


def insert_default_warehouse(conn: Connection, tenant_id: uuid.UUID) -> uuid.UUID:
    warehouse_id = uuid.uuid4()
    insert(conn, "warehouses", id=warehouse_id, tenant_id=tenant_id, name="Main", is_default=True)
    return warehouse_id


def default_warehouse(conn: Connection, tenant_id: uuid.UUID) -> uuid.UUID:
    found = conn.execute(
        text("SELECT id FROM warehouses WHERE tenant_id = :t AND is_default"), {"t": tenant_id}
    ).scalar_one()
    assert isinstance(found, uuid.UUID)
    return found


@dataclass(frozen=True)
class CatalogProduct:
    product_id: uuid.UUID
    code: str
    option_id: uuid.UUID | None
    value_ids: list[uuid.UUID]
    variant_ids: list[uuid.UUID]
    item_ids: list[uuid.UUID]
    skus: list[str]


def insert_product(
    conn: Connection,
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    variants: int = 1,
    on_hand: int | list[int] = 0,
    code: str | None = None,
    price: str = "10.00",
    currency: str = "USD",
    low_stock_level: int | None = None,
    store_ids: tuple[uuid.UUID, ...] = (),
    status: str = "active",
    name_en: str | None = "Product",
    name_ar: str | None = None,
    import_batch_id: uuid.UUID | None = None,
) -> CatalogProduct:
    """A product with ``variants`` variants, each with its inventory item and balance.

    One variant: no options (both value ids null). More: one option "Size" with one value per
    variant (labels ``S1``, ``S2``...). A positive opening quantity also writes its ``opening``
    movement (source ``product_form``, or ``import`` with ``import_batch_id``), so the ledger
    agrees with the balance.
    """
    quantities = [on_hand] * variants if isinstance(on_hand, int) else list(on_hand)
    assert len(quantities) == variants
    warehouse_id = default_warehouse(conn, tenant_id)
    product_id = uuid.uuid4()
    code = code or f"P-{product_id.hex[:10]}"
    conn.execute(
        text(
            "INSERT INTO products (id, tenant_id, code, name_en, name_ar, status, archived_at, "
            "import_batch_id, created_by_user_id) VALUES (:id, :t, :code, :en, :ar, :status, "
            "CASE WHEN :archived THEN now() END, :batch, :user)"
        ),
        {
            "id": product_id,
            "t": tenant_id,
            "code": code,
            "en": name_en,
            "ar": name_ar,
            "status": status,
            "archived": status == "archived",
            "batch": import_batch_id,
            "user": user_id,
        },
    )
    for store_id in store_ids:
        insert(
            conn, "product_stores", tenant_id=tenant_id, product_id=product_id, store_id=store_id
        )
    option_id: uuid.UUID | None = None
    value_ids: list[uuid.UUID] = []
    if variants > 1:
        option_id = uuid.uuid4()
        insert(
            conn,
            "product_options",
            id=option_id,
            tenant_id=tenant_id,
            product_id=product_id,
            position=1,
            name="Size",
        )
        for position in range(1, variants + 1):
            value_id = uuid.uuid4()
            insert(
                conn,
                "option_values",
                id=value_id,
                tenant_id=tenant_id,
                product_id=product_id,
                option_id=option_id,
                position=position,
                label=f"S{position}",
            )
            value_ids.append(value_id)
    variant_ids: list[uuid.UUID] = []
    item_ids: list[uuid.UUID] = []
    skus: list[str] = []
    for index, quantity in enumerate(quantities):
        item_id = uuid.uuid4()
        variant_id = uuid.uuid4()
        sku = f"{code}-{index + 1}" if variants > 1 else code
        insert(conn, "inventory_items", id=item_id, tenant_id=tenant_id)
        insert(
            conn,
            "variants",
            id=variant_id,
            tenant_id=tenant_id,
            product_id=product_id,
            inventory_item_id=item_id,
            sku=sku,
            option1_value_id=value_ids[index] if value_ids else None,
            price=price,
            currency=currency,
            low_stock_level=low_stock_level,
            position=index,
        )
        insert(
            conn,
            "stock_balances",
            tenant_id=tenant_id,
            warehouse_id=warehouse_id,
            inventory_item_id=item_id,
            on_hand=quantity,
            allocated=0,
        )
        if quantity > 0:
            insert(
                conn,
                "stock_movements",
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                warehouse_id=warehouse_id,
                inventory_item_id=item_id,
                quantity=quantity,
                reason="opening",
                on_hand_after=quantity,
                import_batch_id=import_batch_id,
                source="import" if import_batch_id else "product_form",
                actor_type="user",
                actor_id=user_id,
            )
        variant_ids.append(variant_id)
        item_ids.append(item_id)
        skus.append(sku)
    return CatalogProduct(product_id, code, option_id, value_ids, variant_ids, item_ids, skus)


def insert_allocation(
    conn: Connection,
    tenant_id: uuid.UUID,
    lines: list[tuple[uuid.UUID, int]],
    *,
    request_key: str | None = None,
    user_id: uuid.UUID | None = None,
) -> uuid.UUID:
    """An active allocation of ``(inventory_item_id, quantity)`` lines; balances follow."""
    warehouse_id = default_warehouse(conn, tenant_id)
    allocation_id = uuid.uuid4()
    insert(
        conn,
        "allocations",
        id=allocation_id,
        tenant_id=tenant_id,
        request_key=request_key or f"alloc-{allocation_id.hex}",
        request_hash=bytes(32),
        status="active",
        actor_type="user" if user_id else "system",
        actor_id=user_id,
    )
    for item_id, quantity in lines:
        insert(
            conn,
            "allocation_lines",
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            allocation_id=allocation_id,
            warehouse_id=warehouse_id,
            inventory_item_id=item_id,
            quantity=quantity,
        )
        conn.execute(
            text(
                "UPDATE stock_balances SET allocated = allocated + :q, version = version + 1, "
                "updated_at = now() WHERE tenant_id = :t AND inventory_item_id = :item"
            ),
            {"q": quantity, "t": tenant_id, "item": item_id},
        )
    return allocation_id


@dataclass(frozen=True)
class Balance:
    on_hand: int
    allocated: int
    version: int

    @property
    def available(self) -> int:
        return self.on_hand - self.allocated


def read_balance(conn: Connection, item_id: uuid.UUID) -> Balance:
    row = conn.execute(
        text("SELECT on_hand, allocated, version FROM stock_balances WHERE inventory_item_id = :i"),
        {"i": item_id},
    ).one()
    return Balance(row.on_hand, row.allocated, row.version)


@dataclass(frozen=True)
class CatalogRows:
    """The one row in each M1 catalog table of a ``World(catalog=True)``."""

    import_batch_id: uuid.UUID
    product_id: uuid.UUID
    code: str
    option_id: uuid.UUID
    value_id: uuid.UUID
    photo_id: uuid.UUID
    thumb_file_id: uuid.UUID
    large_file_id: uuid.UUID
    item_id: uuid.UUID
    variant_id: uuid.UUID
    sku: str
    allocation_id: uuid.UUID


def insert_catalog_rows(conn: Connection, world: World) -> CatalogRows:
    tenant_id, user_id = world.tenant_id, world.user_id
    batch_id = uuid.uuid4()
    insert(
        conn,
        "import_batches",
        id=batch_id,
        tenant_id=tenant_id,
        created_by_user_id=user_id,
        status="committed",
        file_name=f"catalog-{world.label}.csv",
        file_sha256=bytes(32),
        row_count=1,
        product_count=1,
        variant_count=1,
        opening_units=5,
        committed_at=_NOW,
        committed_by_user_id=user_id,
    )
    product = insert_product(
        conn,
        tenant_id,
        user_id,
        on_hand=5,
        code=f"P-{world.label.upper()}",
        name_en=f"Product {world.label}",
        store_ids=(world.store_id,),
        import_batch_id=batch_id,
    )
    option_id, value_id = uuid.uuid4(), uuid.uuid4()
    insert(
        conn,
        "product_options",
        id=option_id,
        tenant_id=tenant_id,
        product_id=product.product_id,
        position=1,
        name="Size",
    )
    insert(
        conn,
        "option_values",
        id=value_id,
        tenant_id=tenant_id,
        product_id=product.product_id,
        option_id=option_id,
        position=1,
        label="M",
    )
    thumb_id, large_id, photo_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    for file_id in (thumb_id, large_id):
        insert(
            conn,
            "files",
            id=file_id,
            tenant_id=tenant_id,
            kind="product_photo",
            storage_path=f"tenant/{tenant_id}/{file_id.hex}.webp",
            mime="image/webp",
            size_bytes=10,
            created_by_user_id=user_id,
        )
    insert(
        conn,
        "product_photos",
        id=photo_id,
        tenant_id=tenant_id,
        product_id=product.product_id,
        position=0,
        thumb_file_id=thumb_id,
        large_file_id=large_id,
        width=1080,
        height=1080,
        created_by_user_id=user_id,
    )
    conn.execute(
        text("UPDATE variants SET option1_value_id = :v, photo_id = :p WHERE id = :id"),
        {"v": value_id, "p": photo_id, "id": product.variant_ids[0]},
    )
    allocation_id = insert_allocation(
        conn, tenant_id, [(product.item_ids[0], 1)], request_key=f"order-{world.label}"
    )
    return CatalogRows(
        import_batch_id=batch_id,
        product_id=product.product_id,
        code=product.code,
        option_id=option_id,
        value_id=value_id,
        photo_id=photo_id,
        thumb_file_id=thumb_id,
        large_file_id=large_id,
        item_id=product.item_ids[0],
        variant_id=product.variant_ids[0],
        sku=product.skus[0],
        allocation_id=allocation_id,
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
