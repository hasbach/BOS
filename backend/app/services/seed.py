"""Demonstration data for ``flask bos seed-demo`` (FR-035, research R20 + R30).

Creates, if absent:

* **Demo Denim House Group** — edition ``commerce``, active, ``usd_lbp_rate`` 89500, stores
  "Store A" and "Store B", one active user per role (owner, manager, sales, packing,
  dispatch, each with every store) and one sales user limited to Store A.
  Its catalog starts with eight products listed across Store A and Store B.
* **Demo Second Shop** — edition ``social``, active, rate 89500, one store "Main Store" and
  one owner.
* Each business's one default warehouse ("Main", research R39), as for every business.
* The **seed operator** ``demo-seed@bos.invalid``: the recorded creator of both businesses.
  It is inactive, has a password hash that matches no password, and is not on the operator
  allow-list, so it can never sign in.

Every identifier is fixed and obviously fake: emails under ``demo.bos.test`` (a reserved
test domain) and Lebanese mobile numbers ``+961 70 000 0xx`` / ``+961 70 000 1xx``. Record
ids are fixed too, which is what makes the command safe to run twice: a business that
already exists is left exactly as it is. Every user gets the same password, given by the
caller (``BOS_DEMO_PASSWORD``).

Each business is written in one transaction: the tenant row in operator context, then the
rest inside that tenant's own context (the operator-to-tenant path of research R24), with
``tenant.created`` and ``store.created`` in the business's history, attributed to
``system``. User rows have no creation event in the data-model list, so none is written.
The catalog uses the normal product creation path as the demo owner.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core import audit
from app.core.db import transaction
from app.core.security import hash_password, validate_password
from app.core.tenancy import enter_operator, enter_tenant_from_operator, tenant_transaction
from app.services import catalog, inventory

SEED_OPERATOR_EMAIL = "demo-seed@bos.invalid"
SEED_OPERATOR_NAME = "BOS demo seed (system)"
# Not an Argon2 hash, so verify_password() is always False for it.
UNUSABLE_PASSWORD_HASH = "!no-sign-in"  # noqa: S105 (matches no password)
USD_LBP_RATE = "89500"

_NS = uuid.UUID("6f6b0c1e-4b8e-4a43-9a51-0d3c2a7e5b10")


def _id(name: str) -> uuid.UUID:
    return uuid.uuid5(_NS, name)


@dataclass(frozen=True)
class DemoStore:
    name: str
    whatsapp: str
    id: uuid.UUID


@dataclass(frozen=True)
class DemoUser:
    name: str
    email: str
    phone: str
    role: str
    locale: str
    id: uuid.UUID
    store: str | None = None  # limited to this store; None = every store


@dataclass(frozen=True)
class DemoTenant:
    name: str
    edition: str
    id: uuid.UUID
    stores: tuple[DemoStore, ...]
    users: tuple[DemoUser, ...]


def _store(slug: str, name: str, whatsapp: str) -> DemoStore:
    return DemoStore(name=name, whatsapp=whatsapp, id=_id(f"store:{slug}"))


def _user(
    slug: str, name: str, email: str, phone: str, role: str, locale: str, store: str | None = None
) -> DemoUser:
    return DemoUser(
        name=name,
        email=email,
        phone=phone,
        role=role,
        locale=locale,
        store=store,
        id=_id(f"user:{slug}"),
    )


DEMO_TENANTS: tuple[DemoTenant, ...] = (
    DemoTenant(
        name="Demo Denim House Group",
        edition="commerce",
        id=_id("tenant:denim"),
        stores=(
            _store("denim-a", "Store A", "+96170000101"),
            _store("denim-b", "Store B", "+96170000102"),
        ),
        users=(
            _user(
                "denim-owner", "Demo Owner", "owner@demo.bos.test", "+96170000001", "owner", "en"
            ),
            _user(
                "denim-manager",
                "Demo Manager",
                "manager@demo.bos.test",
                "+96170000002",
                "manager",
                "ar",
            ),
            _user(
                "denim-sales", "Demo Sales", "sales@demo.bos.test", "+96170000003", "sales", "en"
            ),
            _user(
                "denim-packing",
                "Demo Packing",
                "packing@demo.bos.test",
                "+96170000004",
                "packing",
                "ar",
            ),
            _user(
                "denim-dispatch",
                "Demo Dispatch",
                "dispatch@demo.bos.test",
                "+96170000005",
                "dispatch",
                "en",
            ),
            _user(
                "denim-sales-a",
                "Demo Sales (Store A)",
                "sales-store-a@demo.bos.test",
                "+96170000006",
                "sales",
                "ar",
                store="Store A",
            ),
        ),
    ),
    DemoTenant(
        name="Demo Second Shop",
        edition="social",
        id=_id("tenant:second"),
        stores=(_store("second-main", "Main Store", "+96170000111"),),
        users=(
            _user(
                "second-owner",
                "Second Shop Owner",
                "owner@second.demo.bos.test",
                "+96170000011",
                "owner",
                "en",
            ),
        ),
    ),
)


_DEMO_PRODUCTS = (
    ("DEMO-STRAIGHT", "Straight Jeans", "جينز مستقيم", 12),
    ("DEMO-SLIM", "Slim Jeans", "جينز ضيق", 1),
    ("DEMO-WIDE", "Wide Leg Jeans", "جينز واسع", 0),
    ("DEMO-TRUCKER", "Trucker Jacket", "سترة جينز", 8),
    ("DEMO-SHIRT", "Denim Shirt", "قميص جينز", 15),
    ("DEMO-SKIRT", "Denim Skirt", "تنورة جينز", 6),
    ("DEMO-CAP", "Denim Cap", "قبعة جينز", 20),
    ("DEMO-TOTE", "Denim Tote", "حقيبة جينز", 10),
)


def _create_demo_catalog(db: Session, demo: DemoTenant) -> None:
    owner = next(user for user in demo.users if user.role == "owner")
    actor = catalog.Actor(owner.id, demo.id)
    for index, (code, name_en, name_ar, units) in enumerate(_DEMO_PRODUCTS):
        store = demo.stores[index % len(demo.stores)]
        _create_seed_product(db, actor, [store.id], code, name_en, units, name_ar=name_ar)


def _create_seed_product(
    db: Session,
    actor: catalog.Actor,
    store_ids: list[uuid.UUID],
    code: str,
    name_en: str,
    units: int,
    *,
    name_ar: str,
) -> None:
    # Use the regular catalog write path so stock, history and store listings agree.
    catalog.create_product(
        db,
        actor,
        catalog.ProductIn(
            code=code,
            name_en=name_en,
            name_ar=name_ar,
            description_en=None,
            description_ar=None,
            store_ids=store_ids,
            photo_ids=[],
            options=[],
            variants=[
                catalog.VariantIn(
                    id=None,
                    option_values=[],
                    sku=code,
                    price=Decimal("25.00"),
                    currency="USD",
                    low_stock_level=None,
                    photo_id=None,
                    opening_quantity=units,
                )
            ],
        ),
    )


class CatalogSeedError(ValueError):
    """An invalid target or size for the development catalog seed."""


_PERF_SIZES = ("XS", "S", "M", "L", "XL")

# Use set-based inserts for the load dataset: the interactive product writer scans existing
# SKUs for every product, which makes seeding thousands of variants unnecessarily slow.
# Both the balance and the opening movement derive from the same generated item and quantity.
_PERF_INSERT = text("""
    WITH seed_products AS MATERIALIZED (
        SELECT gen_random_uuid() AS id, gen_random_uuid() AS option_id, n,
               :prefix || '-' || n AS code, 'Performance Denim ' || n AS name
        FROM generate_series(1, :products) AS n
    ), seed_variants AS MATERIALIZED (
        SELECT p.id AS product_id, p.option_id, gen_random_uuid() AS value_id,
               gen_random_uuid() AS item_id, s.position, s.size, p.code || '-' || s.size AS sku
        FROM seed_products p CROSS JOIN
             unnest(CAST(:sizes AS text[])) WITH ORDINALITY AS s(size, position)
        WHERE (p.n - 1) * cardinality(CAST(:sizes AS text[])) + s.position <= :variants
    ), products_written AS (
        INSERT INTO products (id, tenant_id, code, name_en, created_by_user_id)
        SELECT id, :tenant, code, name, :owner FROM seed_products
    ), stores_written AS (
        INSERT INTO product_stores (tenant_id, product_id, store_id)
        SELECT :tenant, id, store_id FROM seed_products
        CROSS JOIN unnest(CAST(:stores AS uuid[])) AS store_id
    ), options_written AS (
        INSERT INTO product_options (id, tenant_id, product_id, position, name)
        SELECT option_id, :tenant, id, 1, 'Size' FROM seed_products
    ), values_written AS (
        INSERT INTO option_values (id, tenant_id, product_id, option_id, position, label)
        SELECT value_id, :tenant, product_id, option_id, position, size FROM seed_variants
    ), items_written AS (
        INSERT INTO inventory_items (id, tenant_id)
        SELECT item_id, :tenant FROM seed_variants
    ), variants_written AS (
        INSERT INTO variants (id, tenant_id, product_id, inventory_item_id, sku, option1_value_id,
                              price, currency, position)
        SELECT gen_random_uuid(), :tenant, product_id, item_id, sku, value_id, 25, 'USD', position
        FROM seed_variants
    ), balances_written AS (
        INSERT INTO stock_balances (tenant_id, warehouse_id, inventory_item_id, on_hand)
        SELECT :tenant, :warehouse, item_id, :units FROM seed_variants
    ), movements_written AS (
        INSERT INTO stock_movements (id, tenant_id, warehouse_id, inventory_item_id, quantity,
                                     reason, on_hand_after, source, actor_type)
        SELECT gen_random_uuid(), :tenant, :warehouse, item_id, :units,
               'opening', :units, 'product_form', 'system' FROM seed_variants
    )
    INSERT INTO audit_entries (id, tenant_id, actor_type, event, target_type, target_id, data)
    SELECT gen_random_uuid(), :tenant, 'system', 'product.created', 'product', p.id,
           jsonb_build_object('code', p.code, 'name_en', p.name, 'source', 'seed-catalog',
                              'variants', count(*), 'store_ids', CAST(:stores AS uuid[]),
                              'opening_units', count(*) * CAST(:units AS integer))
    FROM seed_products p JOIN seed_variants v ON v.product_id = p.id
    GROUP BY p.id, p.code, p.name
""")


def seed_catalog(engine: Engine, tenant_id: uuid.UUID, variants: int) -> int:
    """Append exactly `variants` synthetic variants in one demo tenant transaction."""
    if variants < 1:
        raise CatalogSeedError("The number of variants must be positive.")
    # Separate invocations add separate datasets without changing previously seeded products.
    prefix = f"PERF-{uuid.uuid4().hex[:16]}"
    per_product = len(_PERF_SIZES)
    products = (variants + per_product - 1) // per_product
    with tenant_transaction(engine, tenant_id) as db:
        is_demo = db.execute(
            text("SELECT is_demo FROM tenants WHERE id = :t"), {"t": tenant_id}
        ).scalar_one_or_none()
        if not is_demo:
            raise CatalogSeedError(f"No demo business has the id {tenant_id}.")
        store_ids = list(
            db.execute(text("SELECT id FROM stores WHERE status = 'active'")).scalars()
        )
        owner = db.execute(
            text(
                "SELECT id FROM users WHERE status = 'active' AND 'owner' = ANY(roles) "
                "ORDER BY id LIMIT 1"
            )
        ).scalar_one_or_none()
        if not store_ids or owner is None:
            raise CatalogSeedError("The demo business needs an active store and an active owner.")
        catalog.lock_business(db, tenant_id)
        db.execute(
            _PERF_INSERT,
            {
                "prefix": prefix,
                "products": products,
                "variants": variants,
                "sizes": list(_PERF_SIZES),
                "tenant": tenant_id,
                "owner": owner,
                "stores": store_ids,
                "warehouse": inventory.default_warehouse_id(db),
                "units": 10,
            },
        )
    return products


@dataclass
class SeedReport:
    operator_created: bool = False
    created: list[DemoTenant] = field(default_factory=list)
    existing: list[DemoTenant] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return self.operator_created or bool(self.created)


def seed_demo(engine: Engine, password: str) -> SeedReport:
    """Create whatever demo data is missing. Raises ``WeakPassword`` before writing anything."""
    validate_password(password)
    report = SeedReport()
    operator_id, report.operator_created = _seed_operator(engine)
    for demo in DEMO_TENANTS:
        with transaction(engine) as db:
            enter_operator(db)
            exists = db.execute(
                text("SELECT 1 FROM tenants WHERE id = :id"), {"id": demo.id}
            ).first()
            if exists is not None:
                report.existing.append(demo)
                continue
            _create_tenant(db, demo, operator_id, password)
        report.created.append(demo)
    return report


def _seed_operator(engine: Engine) -> tuple[uuid.UUID, bool]:
    with transaction(engine) as db:
        created = db.execute(
            text(
                "INSERT INTO operators (id, email, name, password_hash, is_active) "
                "VALUES (:id, :email, :name, :hash, false) "
                "ON CONFLICT (email) DO NOTHING RETURNING id"
            ),
            {
                "id": uuid.uuid4(),
                "email": SEED_OPERATOR_EMAIL,
                "name": SEED_OPERATOR_NAME,
                "hash": UNUSABLE_PASSWORD_HASH,
            },
        ).scalar_one_or_none()
        if created is not None:
            return created, True
        existing = db.execute(
            text("SELECT id FROM operators WHERE email = :email"), {"email": SEED_OPERATOR_EMAIL}
        ).scalar_one()
        return existing, False


def _create_tenant(db: Session, demo: DemoTenant, operator_id: uuid.UUID, password: str) -> None:
    db.execute(
        text(
            "INSERT INTO tenants (id, name, edition, status, is_demo, usd_lbp_rate, "
            "created_by_operator_id) "
            "VALUES (:id, :name, :edition, 'active', true, :rate, :operator_id)"
        ),
        {
            "id": demo.id,
            "name": demo.name,
            "edition": demo.edition,
            "rate": USD_LBP_RATE,
            "operator_id": operator_id,
        },
    )
    enter_tenant_from_operator(db, demo.id)
    inventory.create_default_warehouse(db, demo.id)
    audit.record(
        db,
        tenant_id=demo.id,
        actor_type="system",
        actor_id=None,
        event="tenant.created",
        target_type="tenant",
        target_id=demo.id,
        data={"name": demo.name, "edition": demo.edition, "is_demo": True, "source": "seed-demo"},
    )
    store_ids: dict[str, uuid.UUID] = {}
    for store in demo.stores:
        db.execute(
            text(
                "INSERT INTO stores (id, tenant_id, name, whatsapp_e164) "
                "VALUES (:id, :tenant_id, :name, :whatsapp)"
            ),
            {"id": store.id, "tenant_id": demo.id, "name": store.name, "whatsapp": store.whatsapp},
        )
        store_ids[store.name] = store.id
        audit.record(
            db,
            tenant_id=demo.id,
            actor_type="system",
            actor_id=None,
            event="store.created",
            target_type="store",
            target_id=store.id,
            data={"name": store.name, "whatsapp_number": store.whatsapp, "source": "seed-demo"},
        )
    for user in demo.users:
        db.execute(
            text(
                "INSERT INTO users (id, tenant_id, name, phone_e164, email, password_hash, locale, "
                "roles, all_stores) VALUES (:id, :tenant_id, :name, :phone, :email, :hash, "
                ":locale, :roles, :all_stores)"
            ),
            {
                "id": user.id,
                "tenant_id": demo.id,
                "name": user.name,
                "phone": user.phone,
                "email": user.email,
                "hash": hash_password(password),
                "locale": user.locale,
                "roles": [user.role],
                "all_stores": user.store is None,
            },
        )
        if user.store is not None:
            db.execute(
                text(
                    "INSERT INTO user_stores (tenant_id, user_id, store_id) "
                    "VALUES (:tenant_id, :user_id, :store_id)"
                ),
                {"tenant_id": demo.id, "user_id": user.id, "store_id": store_ids[user.store]},
            )
    if demo.id == DEMO_TENANTS[0].id:
        _create_demo_catalog(db, demo)
