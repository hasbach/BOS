"""Products, options, variants and their store listings (User Story 1, FR-001 to FR-008).

Everything runs in the request's tenant transaction, so row-level security limits every
query to the caller's business.

**Who sees what (R52).** ``visible_products(access)`` is the one SQL predicate every catalog
read uses: owners and managers (``catalog.manage``) see every product; everyone else sees
only *active* products listed in at least one *active* store they may work in. A product
outside it is answered like a missing one (``OutOfScope`` -> 404, ``access.denied_store``).

**Saving (create and edit).** The request is the whole product as the form shows it.
Options, values and variants with an ``id`` are existing ones; anything without is new.

* The active variants must be exactly the combinations of the active option values (one
  variant for a product without options), at most 100. An existing variant keeps its own
  option values (renaming a value renames it for its variants), so renaming options, values,
  SKUs and prices never changes a variant's inventory item (FR-004).
* A variant left out of the request is archived if it has history (a movement or an
  allocation line), deleted with its inventory item and balance otherwise; ``status:
  archived`` archives it explicitly. A removed value is archived while a remaining variant
  still uses it, deleted otherwise.
* Restoring a variant reactivates its archived option value: refused with
  ``value_in_use`` when an active value of the same option now has that label (ASCII case
  ignored), and with ``combination_in_use`` when an active variant has the same options.
* The number of option types (or which options exist) cannot change once any variant has
  history (``options_locked``).
* Archiving a variant, or a product, is refused while it has reserved stock
  (``variant_has_allocations``), checked under the balance locks.
* Empty SKUs are suggested (``app.services.skus``). Product codes and SKUs are checked first
  to answer 409 with the conflicting product; the unique indexes decide races (the API turns
  their violation into the same 409).

**Locks (R42).** Create and edit lock the tenant row first (``FOR NO KEY UPDATE``), which
serialises catalog saves within one business so code and SKU checks cannot race, then the
product row, then the balances in ascending item order. Archive, restore and delete lock the
product row, then balances. Stock operations lock balances only, so no cycle is possible.

Every operation records one history entry: ``product.created``, ``product.updated``,
``product.archived``, ``product.restored`` or ``product.deleted`` (R54).
"""

from __future__ import annotations

import itertools
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core import audit
from app.core.permissions import Access
from app.errors import ApiError
from app.services import inventory, photos, skus
from app.services.common import NotFound
from app.services.settings import money

MAX_VARIANTS = 100


@dataclass(frozen=True)
class Actor:
    user_id: uuid.UUID
    tenant_id: uuid.UUID
    ip: str | None = None


class OutOfScope(LookupError):
    """A record of this business outside the caller's stores (R52)."""

    def __init__(self, target_type: str, target_id: uuid.UUID) -> None:
        super().__init__(target_type)
        self.target_type = target_type
        self.target_id = target_id


# ---- input (shape already checked by the API) ---------------------------------------------------


@dataclass(frozen=True)
class ValueIn:
    id: uuid.UUID | None
    label: str


@dataclass(frozen=True)
class OptionIn:
    id: uuid.UUID | None
    name: str
    values: list[ValueIn]


@dataclass(frozen=True)
class VariantIn:
    id: uuid.UUID | None
    option_values: list[str]
    sku: str | None
    price: Decimal
    currency: str
    low_stock_level: int | None
    photo_id: uuid.UUID | None
    opening_quantity: int = 0
    status: Literal["active", "archived"] = "active"


@dataclass(frozen=True)
class ProductIn:
    code: str
    name_en: str | None
    name_ar: str | None
    description_en: str | None
    description_ar: str | None
    store_ids: list[uuid.UUID]
    photo_ids: list[uuid.UUID]
    options: list[OptionIn]
    variants: list[VariantIn]


def iso(moment: datetime) -> str:
    """ISO 8601 in UTC, as the contract requires."""
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def ascii_lower(value: str) -> str:
    """Lower-case ASCII letters only, as the database's ``lower()`` does in the C locale."""
    return value.translate(_ASCII_LOWER)


_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


# ---- scope -------------------------------------------------------------------------------------


def is_manager(access: Access) -> bool:
    return "catalog.manage" in access.permissions


def visible_products(access: Access, alias: str = "p") -> tuple[str, dict[str, Any]]:
    """The SQL condition (on products ``alias``) for the products ``access`` may see (R52)."""
    if is_manager(access):
        return "true", {}
    return (
        f"{alias}.status = 'active' AND EXISTS ("  # noqa: S608 (alias is ours, never input)
        "SELECT 1 FROM product_stores vps JOIN stores vs ON vs.id = vps.store_id "
        f"AND vs.status = 'active' WHERE vps.product_id = {alias}.id "
        "AND (CAST(:scope_all AS boolean) "
        "OR vps.store_id = ANY(CAST(:scope_stores AS uuid[]))))",
        {"scope_all": access.sees_all_stores, "scope_stores": sorted(access.store_ids)},
    )


def visible_stores_condition(access: Access, alias: str = "s") -> tuple[str, dict[str, Any]]:
    """The stores of a product the caller is shown (staff: their active stores only)."""
    if is_manager(access):
        return "true", {}
    return (
        f"{alias}.status = 'active' AND (CAST(:scope_all AS boolean) "
        f"OR {alias}.id = ANY(CAST(:scope_stores AS uuid[])))",
        {"scope_all": access.sees_all_stores, "scope_stores": sorted(access.store_ids)},
    )


def low_stock_default(db: Session) -> int:
    return int(db.execute(text("SELECT low_stock_default FROM tenants")).scalar_one())


def stock_state(available: int, level: int) -> str:
    if available <= 0:
        return "out"
    if level > 0 and available <= level:
        return "low"
    return "ok"


# ---- reading -----------------------------------------------------------------------------------

_PRODUCT_COLUMNS = (
    "p.id, p.code, p.name_en, p.name_ar, p.description_en, p.description_ar, p.status, "
    "p.version, p.created_at, p.updated_at"
)

_VARIANTS = text(
    "SELECT v.id, v.inventory_item_id, v.sku, v.option1_value_id, v.option2_value_id, v.price, "
    "v.currency, v.low_stock_level, v.photo_id, v.position, v.status, "
    "b.on_hand, b.allocated, b.version AS balance_version, "
    "(EXISTS (SELECT 1 FROM stock_movements m WHERE m.inventory_item_id = v.inventory_item_id) "
    " OR EXISTS (SELECT 1 FROM allocation_lines l "
    "            WHERE l.inventory_item_id = v.inventory_item_id)) AS has_history "
    "FROM variants v JOIN stock_balances b ON b.inventory_item_id = v.inventory_item_id "
    "WHERE v.product_id = :p ORDER BY v.position, v.created_at, v.id"
)


def _product_row(db: Session, product_id: uuid.UUID, *, lock: bool = False) -> Any:
    row = db.execute(
        text(
            f"SELECT {_PRODUCT_COLUMNS} FROM products p WHERE p.id = :id"  # noqa: S608
            + (" FOR UPDATE" if lock else "")
        ),
        {"id": product_id},
    ).one_or_none()
    if row is None:
        raise NotFound("product", product_id)
    return row


def check_visible(db: Session, product_id: uuid.UUID, access: Access) -> None:
    condition, params = visible_products(access)
    visible = db.execute(
        text(f"SELECT EXISTS (SELECT 1 FROM products p WHERE p.id = :id AND {condition})"),  # noqa: S608
        {"id": product_id, **params},
    ).scalar_one()
    if not visible:
        raise OutOfScope("product", product_id)


def get_product(db: Session, product_id: uuid.UUID, access: Access) -> dict[str, Any]:
    """One product as the contract's ``Product``; ``NotFound`` / ``OutOfScope`` otherwise."""
    row = _product_row(db, product_id)
    check_visible(db, product_id, access)
    return product_json(db, row, access)


def product_json(db: Session, row: Any, access: Access | None) -> dict[str, Any]:
    """``access`` None means a manager's view (every variant and store)."""
    manager = access is None or is_manager(access)
    default_level = low_stock_default(db)
    options = db.execute(
        text("SELECT id, name FROM product_options WHERE product_id = :p ORDER BY position"),
        {"p": row.id},
    ).all()
    values = db.execute(
        text(
            "SELECT id, option_id, label, status FROM option_values WHERE product_id = :p "
            "ORDER BY position, id"
        ),
        {"p": row.id},
    ).all()
    labels = {value.id: value.label for value in values}
    variants = db.execute(_VARIANTS, {"p": row.id}).all()
    if access is None:
        store_condition, store_params = "true", dict[str, Any]()
    else:
        store_condition, store_params = visible_stores_condition(access)
    store_ids = db.execute(
        text(
            "SELECT ps.store_id FROM product_stores ps JOIN stores s ON s.id = ps.store_id "  # noqa: S608
            f"WHERE ps.product_id = :p AND {store_condition} ORDER BY ps.store_id"
        ),
        {"p": row.id, **store_params},
    ).scalars()
    photo_rows = db.execute(
        text(
            "SELECT id, width, height FROM product_photos WHERE product_id = :p ORDER BY position"
        ),
        {"p": row.id},
    ).all()
    return {
        "id": str(row.id),
        "code": row.code,
        "name_en": row.name_en,
        "name_ar": row.name_ar,
        "description_en": row.description_en,
        "description_ar": row.description_ar,
        "status": row.status,
        "version": row.version,
        "store_ids": [str(s) for s in store_ids],
        "photos": [{"id": str(p.id), "width": p.width, "height": p.height} for p in photo_rows],
        "options": [
            {
                "id": str(option.id),
                "name": option.name,
                "values": [
                    {"id": str(v.id), "label": v.label}
                    for v in values
                    if v.option_id == option.id and v.status == "active"
                ],
            }
            for option in options
        ],
        "variants": [
            _variant_json(v, labels, default_level)
            for v in variants
            if manager or v.status == "active"
        ],
        "has_history": any(v.has_history for v in variants),
        "created_at": iso(row.created_at),
        "updated_at": iso(row.updated_at),
    }


def _variant_json(row: Any, labels: dict[uuid.UUID, str], default_level: int) -> dict[str, Any]:
    level = row.low_stock_level if row.low_stock_level is not None else default_level
    available = row.on_hand - row.allocated
    return {
        "id": str(row.id),
        "inventory_item_id": str(row.inventory_item_id),
        "sku": row.sku,
        "option_values": [
            labels[value] for value in (row.option1_value_id, row.option2_value_id) if value
        ],
        "price": money(row.price),
        "currency": row.currency,
        "low_stock_level": row.low_stock_level,
        "effective_low_stock_level": level,
        "photo_id": str(row.photo_id) if row.photo_id else None,
        "status": row.status,
        "has_history": row.has_history,
        "stock": {
            "on_hand": row.on_hand,
            "allocated": row.allocated,
            "available": available,
            "version": row.balance_version,
        },
        "stock_state": stock_state(available, level),
    }


def manager_view(db: Session, product_id: uuid.UUID) -> dict[str, Any]:
    return product_json(db, _product_row(db, product_id), None)


# ---- saving ------------------------------------------------------------------------------------


def lock_business(db: Session, tenant_id: uuid.UUID) -> None:
    """Serialise catalog saves of one business (see the module docstring)."""
    db.execute(text("SELECT id FROM tenants WHERE id = :id FOR NO KEY UPDATE"), {"id": tenant_id})


def _invalid(fields: dict[str, str]) -> ApiError:
    return ApiError(400, "validation_failed", "Some fields are not valid", fields=fields)


def _conflict(code: str, message: str, **extra: Any) -> ApiError:
    fields = extra.pop("fields", None)
    return ApiError(409, code, message, fields=fields, extra=extra or None)


@dataclass
class _Existing:
    """A product's current options, values and variants (empty when creating)."""

    options: list[Any] = field(default_factory=list)  # by position
    values: dict[uuid.UUID, Any] = field(default_factory=dict)
    variants: dict[uuid.UUID, Any] = field(default_factory=dict)
    store_ids: set[uuid.UUID] = field(default_factory=set)
    photo_count: int = 0


def _load(db: Session, product_id: uuid.UUID) -> _Existing:
    return _Existing(
        options=list(
            db.execute(
                text(
                    "SELECT id, name, position FROM product_options WHERE product_id = :p "
                    "ORDER BY position"
                ),
                {"p": product_id},
            ).all()
        ),
        values={
            row.id: row
            for row in db.execute(
                text(
                    "SELECT v.id, v.option_id, v.label, v.position, v.status, o.position AS "
                    "option_position FROM option_values v JOIN product_options o "
                    "ON o.id = v.option_id WHERE v.product_id = :p ORDER BY v.position"
                ),
                {"p": product_id},
            )
        },
        variants={row.id: row for row in db.execute(_VARIANTS, {"p": product_id})},
        store_ids=set(
            db.execute(
                text("SELECT store_id FROM product_stores WHERE product_id = :p"),
                {"p": product_id},
            ).scalars()
        ),
        photo_count=int(
            db.execute(
                text("SELECT count(*) FROM product_photos WHERE product_id = :p"),
                {"p": product_id},
            ).scalar_one()
        ),
    )


@dataclass
class _Value:
    id: uuid.UUID
    label: str
    existing: bool


@dataclass
class _Plan:
    """What a save will write, worked out completely before anything is written."""

    values: list[list[_Value]]  # per option position, desired active values in order
    combos: list[tuple[uuid.UUID | None, uuid.UUID | None]]  # per request variant
    skus: list[str]  # per request variant
    archive: list[uuid.UUID]  # existing variants going active -> archived
    restore: list[uuid.UUID]  # existing variants going archived -> active
    delete: list[uuid.UUID]  # existing variants deleted (no history)


def _check_references(
    db: Session, data: ProductIn, product_id: uuid.UUID | None, existing: _Existing
) -> None:
    """400s that need the database: stores, photos, ids of options, values and variants."""
    errors: dict[str, str] = {}
    if data.store_ids:
        active = set(
            db.execute(
                text("SELECT id FROM stores WHERE id = ANY(:ids) AND status = 'active'"),
                {"ids": data.store_ids},
            ).scalars()
        )
        if any(s not in active and s not in existing.store_ids for s in data.store_ids):
            errors["store_ids"] = "invalid"
    if not photos.usable(db, product_id, data.photo_ids):
        errors["photo_ids"] = "invalid"
    for index, item in enumerate(data.variants):
        if item.photo_id is not None and item.photo_id not in data.photo_ids:
            errors[f"variants.{index}.photo_id"] = "invalid"
    option_ids = {o.id for o in existing.options}
    for index, option in enumerate(data.options):
        if option.id is not None and option.id not in option_ids:
            errors[f"options.{index}.id"] = "invalid"
        for position, value in enumerate(option.values):
            if value.id is None:
                continue
            found = existing.values.get(value.id)
            if found is None or found.option_id != option.id:
                errors[f"options.{index}.values.{position}.id"] = "invalid"
    for index, item in enumerate(data.variants):
        if item.id is not None and item.id not in existing.variants:
            errors[f"variants.{index}.id"] = "invalid"
        if item.id is None and item.status == "archived":
            errors[f"variants.{index}.status"] = "invalid"
    if errors:
        raise _invalid(errors)


def _plan(db: Session, data: ProductIn, existing: _Existing, product_id: uuid.UUID | None) -> _Plan:
    # Which options exist must not change once anything has history (R47).
    requested_options = [o.id for o in data.options]
    current_options = [o.id for o in existing.options]
    if requested_options != current_options:
        if any(v.has_history for v in existing.variants.values()):
            raise _conflict(
                "options_locked", "The option types cannot change once a variant has history"
            )
        if any(o in current_options for o in requested_options if o is not None):
            # An existing option moved to another position: variants cannot follow it.
            raise _invalid({"options": "invalid"})

    values: list[list[_Value]] = [
        [_Value(v.id or uuid.uuid4(), v.label, v.id is not None) for v in option.values]
        for option in data.options
    ]

    # Restored variants bring their archived values back (R47), checked before writing.
    restore = [
        item.id
        for item in data.variants
        if item.id is not None
        and item.status == "active"
        and existing.variants[item.id].status == "archived"
    ]
    for variant_id in restore:
        row = existing.variants[variant_id]
        for position, value_id in enumerate((row.option1_value_id, row.option2_value_id)):
            if value_id is None or position >= len(values):
                continue
            if any(v.id == value_id for v in values[position]):
                continue
            stored = existing.values[value_id]
            if stored.status != "archived":
                continue  # an active value being removed: the combination check refuses it
            taken = {ascii_lower(v.label) for v in values[position]}
            if ascii_lower(stored.label) in taken:
                raise _conflict(
                    "value_in_use",
                    "Restoring this variant would bring back an option value whose name is "
                    "now used",
                )
            values[position].append(_Value(value_id, stored.label, True))

    # Every combination of the active values has exactly one active variant.
    by_label = [{ascii_lower(v.label): v.id for v in option} for option in values]
    combos: list[tuple[uuid.UUID | None, uuid.UUID | None]] = []
    invalid = False
    for item in data.variants:
        if item.id is not None:
            row = existing.variants[item.id]
            combos.append((row.option1_value_id, row.option2_value_id))
            continue
        if len(item.option_values) != len(values):
            invalid = True
            combos.append((None, None))
            continue
        ids = [
            by_label[k].get(ascii_lower(label.strip()))
            for k, label in enumerate(item.option_values)
        ]
        if any(i is None for i in ids):
            invalid = True
        padded = [*ids, None, None]
        combos.append((padded[0], padded[1]))
    if invalid:
        raise _invalid({"variants": "invalid"})
    expected = {
        (*combo, None, None)[:2]
        for combo in itertools.product(*[[v.id for v in o] for o in values])
    }
    if len(expected) > MAX_VARIANTS:
        raise _invalid({"variants": "too_many"})
    active = [
        (combos[i], data.variants[i])
        for i in range(len(combos))
        if data.variants[i].status == "active"
    ]
    seen: dict[Any, list[VariantIn]] = {}
    for combo, item in active:
        seen.setdefault(combo, []).append(item)
    for items in seen.values():
        if len(items) > 1:
            if any(item.id in restore for item in items):
                raise _conflict(
                    "combination_in_use", "An active variant already has these option values"
                )
            raise _invalid({"variants": "invalid"})
    if set(seen) != expected:
        raise _invalid({"variants": "invalid"})

    listed = {item.id for item in data.variants if item.id is not None}
    archive: list[uuid.UUID] = []
    delete: list[uuid.UUID] = []
    for variant_id, row in existing.variants.items():
        if variant_id in listed:
            wanted = next(i for i in data.variants if i.id == variant_id)
            if wanted.status == "archived" and row.status == "active":
                archive.append(variant_id)
        elif row.has_history:
            if row.status == "active":
                archive.append(variant_id)
        else:
            delete.append(variant_id)

    plan = _Plan(values, combos, [], archive, restore, delete)
    plan.skus = _skus(db, data, existing, plan, product_id)
    return plan


def _skus(
    db: Session, data: ProductIn, existing: _Existing, plan: _Plan, product_id: uuid.UUID | None
) -> list[str]:
    """Final SKU of every request variant: typed, kept, or suggested (R46)."""
    freed = {item.id for item in data.variants if item.id is not None} | set(plan.delete)
    chosen: list[str | None] = []
    for item in data.variants:
        if item.sku:
            chosen.append(item.sku)
        elif item.id is not None:
            chosen.append(existing.variants[item.id].sku)
        else:
            chosen.append(None)

    duplicates: dict[str, str] = {}
    keys: set[str] = set()
    for index, sku in enumerate(chosen):
        if sku is None:
            continue
        if skus.key(sku) in keys:
            duplicates[f"variants.{index}.sku"] = "duplicate"
        keys.add(skus.key(sku))
    if duplicates:
        raise _invalid(duplicates)

    rows = db.execute(
        text(
            "SELECT v.id, v.sku, v.sku_key, p.id AS product_id, "
            "COALESCE(p.name_en, p.name_ar) AS product_name "
            "FROM variants v JOIN products p ON p.id = v.product_id "
            "WHERE NOT (v.id = ANY(CAST(:freed AS uuid[])))"
        ),
        {"freed": list(freed)},
    ).all()
    taken = {row.sku_key: row for row in rows}
    conflicts = [
        (index, taken[skus.key(sku)])
        for index, sku in enumerate(chosen)
        if sku is not None and skus.key(sku) in taken
    ]
    if conflicts:
        raise _conflict(
            "sku_in_use",
            "A SKU is already used in this business",
            fields={f"variants.{index}.sku": "in_use" for index, _ in conflicts},
            conflicts=[
                {
                    "sku": row.sku,
                    "product_id": str(row.product_id),
                    "product_name": row.product_name,
                }
                for _, row in conflicts
            ],
        )

    used = set(taken) | keys
    final: list[str] = []
    for index, sku in enumerate(chosen):
        if sku is None:
            combo = plan.combos[index]
            parts = []
            for position, value_id in enumerate(combo):
                if value_id is None:
                    continue
                option = plan.values[position]
                spot = next(i for i, v in enumerate(option) if v.id == value_id)
                parts.append((option[spot].label, spot + 1))
            sku = skus.suggest(data.code, parts, used)
            used.add(skus.key(sku))
        final.append(sku)
    return final


def _check_code(db: Session, code: str, product_id: uuid.UUID | None) -> None:
    taken = db.execute(
        text(
            "SELECT EXISTS (SELECT 1 FROM products WHERE code_key = :key "
            "AND id IS DISTINCT FROM :id)"
        ),
        {"key": skus.key(code), "id": product_id},
    ).scalar_one()
    if taken:
        raise _conflict(
            "product_code_in_use", "This product code is already used", fields={"code": "in_use"}
        )


def _lock_archived_balances(
    db: Session, existing: _Existing, variant_ids: Sequence[uuid.UUID]
) -> None:
    items = [existing.variants[v].inventory_item_id for v in variant_ids]
    locked = inventory.lock_balances(db, items)
    if any(balance.allocated > 0 for balance in locked.values()):
        raise _conflict(
            "variant_has_allocations", "A variant to archive or remove has reserved stock"
        )


def _record(
    db: Session, actor: Actor, event: str, product_id: uuid.UUID, data: dict[str, Any]
) -> None:
    audit.record(
        db,
        tenant_id=actor.tenant_id,
        actor_type="user",
        actor_id=actor.user_id,
        event=event,
        target_type="product",
        target_id=product_id,
        data=data,
        ip=actor.ip,
    )


@dataclass(frozen=True)
class Saved:
    product_id: uuid.UUID
    removed_photo_paths: list[str]


def create_product(
    db: Session,
    actor: Actor,
    data: ProductIn,
    *,
    request_key: str | None = None,
    import_batch_id: uuid.UUID | None = None,
) -> Saved:
    """Create a product with its options, variants, items, balances and opening stock."""
    lock_business(db, actor.tenant_id)
    existing = _Existing()
    _check_references(db, data, None, existing)
    _check_code(db, data.code, None)
    plan = _plan(db, data, existing, None)

    product_id = uuid.uuid4()
    db.execute(
        text(
            "INSERT INTO products (id, tenant_id, code, name_en, name_ar, description_en, "
            "description_ar, created_by_user_id, import_batch_id) VALUES "
            "(:id, :tenant_id, :code, :name_en, :name_ar, :description_en, :description_ar, "
            ":user_id, :batch)"
        ),
        {
            "id": product_id,
            "tenant_id": actor.tenant_id,
            "user_id": actor.user_id,
            "batch": import_batch_id,
            **_fields(data),
        },
    )
    _write(
        db,
        actor,
        product_id,
        data,
        existing,
        plan,
        request_key=request_key,
        import_batch_id=import_batch_id,
    )
    if import_batch_id is not None:
        # The whole import emits a single audit entry, not one per product.
        return Saved(product_id, [])
    _record(
        db,
        actor,
        "product.created",
        product_id,
        {
            "code": data.code,
            "name_en": data.name_en,
            "name_ar": data.name_ar,
            "variants": len(data.variants),
            "store_ids": sorted(str(s) for s in set(data.store_ids)),
            "opening_units": sum(v.opening_quantity for v in data.variants),
        },
    )
    return Saved(product_id, [])


def _fields(data: ProductIn) -> dict[str, Any]:
    return {
        "code": data.code,
        "name_en": data.name_en,
        "name_ar": data.name_ar,
        "description_en": data.description_en,
        "description_ar": data.description_ar,
    }


def _locked_for_change(db: Session, product_id: uuid.UUID, version: int) -> Any:
    row = _product_row(db, product_id, lock=True)
    if row.version != version:
        raise _conflict(
            "product_changed",
            "The product changed since it was opened",
            current=product_json(db, row, None),
        )
    return row


def update_product(
    db: Session, actor: Actor, product_id: uuid.UUID, version: int, data: ProductIn
) -> Saved:
    """Replace a product's editable fields, options and variants (see the module docstring)."""
    lock_business(db, actor.tenant_id)
    row = _locked_for_change(db, product_id, version)
    if row.status == "archived":
        raise _conflict("product_archived", "Restore the product before editing it")
    existing = _load(db, product_id)
    _check_references(db, data, product_id, existing)
    _check_code(db, data.code, product_id)
    plan = _plan(db, data, existing, product_id)
    _lock_archived_balances(db, existing, plan.archive)

    db.execute(
        text(
            "UPDATE products SET code = :code, name_en = :name_en, name_ar = :name_ar, "
            "description_en = :description_en, description_ar = :description_ar, "
            "version = version + 1, updated_at = now() WHERE id = :id"
        ),
        {"id": product_id, **_fields(data)},
    )
    before_options = _options_summary(db, product_id)
    paths, variant_changes = _write(db, actor, product_id, data, existing, plan, request_key=None)

    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    for name, value in _fields(data).items():
        if getattr(row, name) != value:
            before[name], after[name] = getattr(row, name), value
    stores_before = sorted(str(s) for s in existing.store_ids)
    stores_after = sorted(str(s) for s in set(data.store_ids))
    if stores_before != stores_after:
        before["store_ids"], after["store_ids"] = stores_before, stores_after
    if existing.photo_count != len(data.photo_ids):
        before["photos"], after["photos"] = existing.photo_count, len(data.photo_ids)
    options_after = _options_summary(db, product_id)
    if before_options != options_after:
        before["options"], after["options"] = before_options, options_after
    _record(
        db,
        actor,
        "product.updated",
        product_id,
        {"before": before, "after": after, **variant_changes},
    )
    return Saved(product_id, paths)


def _options_summary(db: Session, product_id: uuid.UUID) -> list[dict[str, Any]]:
    options = db.execute(
        text(
            "SELECT o.id, o.name, COALESCE(array_agg(v.label ORDER BY v.position) FILTER "
            "(WHERE v.status = 'active'), '{}') AS labels FROM product_options o "
            "LEFT JOIN option_values v ON v.option_id = o.id WHERE o.product_id = :p "
            "GROUP BY o.id, o.name, o.position ORDER BY o.position"
        ),
        {"p": product_id},
    ).all()
    return [{"name": o.name, "values": list(o.labels)} for o in options]


def _write(
    db: Session,
    actor: Actor,
    product_id: uuid.UUID,
    data: ProductIn,
    existing: _Existing,
    plan: _Plan,
    *,
    request_key: str | None,
    import_batch_id: uuid.UUID | None = None,
) -> tuple[list[str], dict[str, Any]]:
    """Write a checked plan; returns removed photo paths and the variant changes for history."""
    # Store listings.
    wanted_stores = set(data.store_ids)
    for store_id in existing.store_ids - wanted_stores:
        db.execute(
            text("DELETE FROM product_stores WHERE product_id = :p AND store_id = :s"),
            {"p": product_id, "s": store_id},
        )
    for store_id in sorted(wanted_stores - existing.store_ids):
        db.execute(
            text(
                "INSERT INTO product_stores (tenant_id, product_id, store_id) VALUES (:t, :p, :s)"
            ),
            {"t": actor.tenant_id, "p": product_id, "s": store_id},
        )

    paths = photos.attach(db, product_id, data.photo_ids)

    # Variants without history that leave, with their items and balances.
    deleted_skus = [existing.variants[v].sku for v in plan.delete]
    if plan.delete:
        db.execute(text("DELETE FROM variants WHERE id = ANY(:ids)"), {"ids": plan.delete})
        inventory.delete_items(db, [existing.variants[v].inventory_item_id for v in plan.delete])

    # Options and values.
    requested_options = {o.id for o in data.options if o.id is not None}
    for option in existing.options:
        if option.id not in requested_options:
            db.execute(text("DELETE FROM option_values WHERE option_id = :o"), {"o": option.id})
            db.execute(text("DELETE FROM product_options WHERE id = :o"), {"o": option.id})
    db.execute(
        text("UPDATE option_values SET status = 'archived' WHERE product_id = :p"),
        {"p": product_id},
    )
    for position, option in enumerate(data.options, start=1):
        option_id = option.id or uuid.uuid4()
        if option.id is None:
            db.execute(
                text(
                    "INSERT INTO product_options (id, tenant_id, product_id, position, name) "
                    "VALUES (:id, :t, :p, :position, :name)"
                ),
                {
                    "id": option_id,
                    "t": actor.tenant_id,
                    "p": product_id,
                    "position": position,
                    "name": option.name,
                },
            )
        else:
            db.execute(
                text("UPDATE product_options SET name = :name WHERE id = :id"),
                {"id": option_id, "name": option.name},
            )
        for value_position, value in enumerate(plan.values[position - 1], start=1):
            if value.existing:
                db.execute(
                    text(
                        "UPDATE option_values SET label = :label, position = :position, "
                        "status = 'active' WHERE id = :id"
                    ),
                    {"id": value.id, "label": value.label, "position": value_position},
                )
            else:
                db.execute(
                    text(
                        "INSERT INTO option_values (id, tenant_id, product_id, option_id, "
                        "position, label) VALUES (:id, :t, :p, :o, :position, :label)"
                    ),
                    {
                        "id": value.id,
                        "t": actor.tenant_id,
                        "p": product_id,
                        "o": option_id,
                        "position": value_position,
                        "label": value.label,
                    },
                )
    # Removed values: deleted unless a remaining (archived) variant still uses them.
    db.execute(
        text(
            "DELETE FROM option_values ov WHERE ov.product_id = :p AND ov.status = 'archived' "
            "AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = :p "
            "AND ov.id IN (v.option1_value_id, v.option2_value_id))"
        ),
        {"p": product_id},
    )

    # Variants: archive first (frees combinations), then park changed SKUs, then the rest.
    if plan.archive:
        db.execute(
            text(
                "UPDATE variants SET status = 'archived', archived_at = now(), updated_at = now() "
                "WHERE id = ANY(:ids)"
            ),
            {"ids": plan.archive},
        )
    changed_sku = [
        item.id
        for item, sku in zip(data.variants, plan.skus, strict=True)
        if item.id is not None and existing.variants[item.id].sku != sku
    ]
    if changed_sku:
        db.execute(
            text(
                "UPDATE variants SET sku = 'tmp-' || replace(CAST(id AS text), '-', '') "
                "WHERE id = ANY(:ids)"
            ),
            {"ids": changed_sku},
        )

    warehouse_id = inventory.default_warehouse_id(db)
    added: list[str] = []
    changed: list[dict[str, Any]] = []
    for position, (item, combo, sku) in enumerate(
        zip(data.variants, plan.combos, plan.skus, strict=True)
    ):
        values = {
            "sku": sku,
            "price": item.price,
            "currency": item.currency,
            "low_stock_level": item.low_stock_level,
            "photo_id": item.photo_id,
            "position": position,
        }
        if item.id is None:
            item_id = inventory.create_item(
                db,
                tenant_id=actor.tenant_id,
                warehouse_id=warehouse_id,
                opening_quantity=item.opening_quantity,
                source="import" if import_batch_id is not None else "product_form",
                actor_id=actor.user_id,
                import_batch_id=import_batch_id,
                request_key=request_key,
            )
            db.execute(
                text(
                    "INSERT INTO variants (id, tenant_id, product_id, inventory_item_id, sku, "
                    "option1_value_id, option2_value_id, price, currency, low_stock_level, "
                    "photo_id, position) VALUES (:id, :t, :p, :item, :sku, :o1, :o2, :price, "
                    ":currency, :low_stock_level, :photo_id, :position)"
                ),
                {
                    "id": uuid.uuid4(),
                    "t": actor.tenant_id,
                    "p": product_id,
                    "item": item_id,
                    "o1": combo[0],
                    "o2": combo[1],
                    **values,
                },
            )
            added.append(sku)
            continue
        current = existing.variants[item.id]
        restoring = item.id in plan.restore
        db.execute(
            text(
                "UPDATE variants SET sku = :sku, price = :price, currency = :currency, "
                "low_stock_level = :low_stock_level, photo_id = :photo_id, position = :position, "
                "status = CASE WHEN :restore THEN 'active' ELSE status END, "
                "archived_at = CASE WHEN :restore THEN NULL ELSE archived_at END, "
                "updated_at = now() WHERE id = :id"
            ),
            {"id": item.id, "restore": restoring, **values},
        )
        old = {
            "sku": current.sku,
            "price": money(current.price),
            "currency": current.currency,
            "low_stock_level": current.low_stock_level,
            "photo": str(current.photo_id) if current.photo_id else None,
        }
        new = {
            "sku": sku,
            "price": money(item.price),
            "currency": item.currency,
            "low_stock_level": item.low_stock_level,
            "photo": str(item.photo_id) if item.photo_id else None,
        }
        diff = [name for name in old if old[name] != new[name]]
        if diff:
            changed.append(
                {
                    "sku": sku,
                    "before": {name: old[name] for name in diff},
                    "after": {name: new[name] for name in diff},
                }
            )

    final_sku = {item.id: sku for item, sku in zip(data.variants, plan.skus, strict=True)}
    return paths, {
        "variants_added": added,
        "variants_archived": [final_sku.get(v) or existing.variants[v].sku for v in plan.archive],
        "variants_restored": [final_sku[v] for v in plan.restore],
        "variants_deleted": deleted_skus,
        "variants_changed": changed,
    }


# ---- archive, restore, delete -------------------------------------------------------------------


def set_status(
    db: Session,
    actor: Actor,
    product_id: uuid.UUID,
    version: int,
    status: Literal["active", "archived"],
) -> None:
    """Archive or restore; repeating it on a product already in that state changes nothing."""
    row = _product_row(db, product_id, lock=True)
    if row.status == status:
        return
    _locked_for_change(db, product_id, version)
    if status == "archived":
        items = db.execute(
            text("SELECT inventory_item_id FROM variants WHERE product_id = :p"),
            {"p": product_id},
        ).scalars()
        locked = inventory.lock_balances(db, items)
        if any(balance.allocated > 0 for balance in locked.values()):
            raise _conflict(
                "variant_has_allocations", "A variant of this product has reserved stock"
            )
    db.execute(
        text(
            "UPDATE products SET status = :status, version = version + 1, updated_at = now(), "
            "archived_at = CASE WHEN :status = 'archived' THEN now() END WHERE id = :id"
        ),
        {"status": status, "id": product_id},
    )
    _record(
        db,
        actor,
        "product.archived" if status == "archived" else "product.restored",
        product_id,
        {"before": row.status, "after": status},
    )


def delete_product(db: Session, actor: Actor, product_id: uuid.UUID, version: int) -> list[str]:
    """Delete a product that never had history; returns its photo files' paths."""
    row = _locked_for_change(db, product_id, version)
    variants = db.execute(_VARIANTS, {"p": product_id}).all()
    if any(v.has_history for v in variants):
        raise _conflict("has_history", "The product has stock history; archive it instead")
    paths = photos.remove_all(db, product_id)
    db.execute(text("DELETE FROM variants WHERE product_id = :p"), {"p": product_id})
    inventory.delete_items(db, [v.inventory_item_id for v in variants])
    db.execute(text("DELETE FROM option_values WHERE product_id = :p"), {"p": product_id})
    db.execute(text("DELETE FROM product_options WHERE product_id = :p"), {"p": product_id})
    db.execute(text("DELETE FROM product_stores WHERE product_id = :p"), {"p": product_id})
    db.execute(text("DELETE FROM products WHERE id = :p"), {"p": product_id})
    _record(
        db,
        actor,
        "product.deleted",
        product_id,
        {"code": row.code, "name_en": row.name_en, "name_ar": row.name_ar},
    )
    return paths
