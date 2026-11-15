"""Demonstration data for ``flask bos seed-demo`` (FR-035, research R20 + R30).

Creates, if absent:

* **Demo Denim House Group** — edition ``commerce``, active, ``usd_lbp_rate`` 89500, stores
  "Store A" and "Store B", one active user per role (owner, manager, sales, packing,
  dispatch, each with every store) and one sales user limited to Store A.
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
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core import audit
from app.core.db import transaction
from app.core.security import hash_password, validate_password
from app.core.tenancy import enter_operator, enter_tenant_from_operator
from app.services import inventory

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
