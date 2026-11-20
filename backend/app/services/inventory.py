"""The inventory core shared by catalog, stock and allocation code (research R39-R42, R45).

* ``create_default_warehouse`` — every business has exactly one warehouse, created with the
  business (onboarding, demo seed; migration 0003 backfilled the existing ones).
* ``default_warehouse_id`` — the warehouse stock code works in. Fails closed: a business
  without one is a broken invariant, answered 500 and logged, never guessed around.
* ``create_item`` / ``delete_items`` — a variant's stable inventory item and its balance (with
  the ``opening`` movement of its opening quantity), and removing history-less ones (R38).
* ``lock_balances`` — the one way to lock balance rows before deciding on their numbers:
  ``SELECT ... FOR UPDATE`` in ascending ``inventory_item_id`` order, so two stock operations
  can never deadlock each other (R42).
* ``adjust`` / ``movements_page`` — a person's stock change (one ``manual`` movement and its
  balance, under the balance lock, refused when stale or impossible) and a variant's stock
  history, newest first (User Story 2, FR-012 to FR-017, R41 to R43).
* ``integrity_report`` — data-model.md "Integrity rules" for the business of the current
  transaction; an empty list means consistent (FR-022).

Everything runs inside the caller's transaction, in the tenant context the caller entered;
row-level security limits every query to that one business.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import audit
from app.errors import ApiError
from app.services.common import NotFound

log = logging.getLogger("bos.inventory")

DEFAULT_WAREHOUSE_NAME = "Main"


def create_default_warehouse(db: Session, tenant_id: uuid.UUID) -> uuid.UUID:
    """The business's one warehouse; call it in the transaction that creates the business."""
    warehouse_id = uuid.uuid4()
    db.execute(
        text(
            "INSERT INTO warehouses (id, tenant_id, name, is_default) "
            "VALUES (:id, :tenant_id, :name, true)"
        ),
        {"id": warehouse_id, "tenant_id": tenant_id, "name": DEFAULT_WAREHOUSE_NAME},
    )
    return warehouse_id


def default_warehouse_id(db: Session) -> uuid.UUID:
    found = db.execute(text("SELECT id FROM warehouses WHERE is_default")).scalar_one_or_none()
    if not isinstance(found, uuid.UUID):
        log.error("business has no default warehouse; refusing the stock operation")
        raise ApiError(500, "internal_error", "Internal error")
    return found


MovementSource = Literal["product_form", "import"]


def create_item(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    warehouse_id: uuid.UUID,
    opening_quantity: int,
    source: MovementSource,
    actor_id: uuid.UUID,
    request_key: str | None = None,
    import_batch_id: uuid.UUID | None = None,
) -> uuid.UUID:
    """A new inventory item with its balance, and its ``opening`` movement if quantity > 0.

    The stable inventory identity of a new variant (R38): insert the variant after this, in
    the same transaction. ``source`` is ``product_form`` for the product form and ``import``
    (with ``import_batch_id``) for a CSV import. An opening quantity of 0 writes no movement.
    """
    item_id = uuid.uuid4()
    db.execute(
        text("INSERT INTO inventory_items (id, tenant_id) VALUES (:id, :tenant_id)"),
        {"id": item_id, "tenant_id": tenant_id},
    )
    db.execute(
        text(
            "INSERT INTO stock_balances (tenant_id, warehouse_id, inventory_item_id, on_hand) "
            "VALUES (:tenant_id, :warehouse_id, :item_id, :on_hand)"
        ),
        {
            "tenant_id": tenant_id,
            "warehouse_id": warehouse_id,
            "item_id": item_id,
            "on_hand": opening_quantity,
        },
    )
    if opening_quantity > 0:
        db.execute(
            text(
                "INSERT INTO stock_movements (id, tenant_id, warehouse_id, inventory_item_id, "
                "quantity, reason, on_hand_after, import_batch_id, source, actor_type, actor_id, "
                "request_key) VALUES (:id, :tenant_id, :warehouse_id, :item_id, :quantity, "
                "'opening', :quantity, :batch, :source, 'user', :actor_id, :request_key)"
            ),
            {
                "id": uuid.uuid4(),
                "tenant_id": tenant_id,
                "warehouse_id": warehouse_id,
                "item_id": item_id,
                "quantity": opening_quantity,
                "batch": import_batch_id,
                "source": source,
                "actor_id": actor_id,
                "request_key": request_key,
            },
        )
    return item_id


def delete_items(db: Session, item_ids: Iterable[uuid.UUID]) -> None:
    """Remove inventory items that never had history, with their balances.

    Delete their variants first. The database refuses an item with movements or allocation
    lines (no ``ON DELETE`` on those references), so history can never be lost here.
    """
    items = list(item_ids)
    if not items:
        return
    db.execute(
        text("DELETE FROM stock_balances WHERE inventory_item_id = ANY(:items)"), {"items": items}
    )
    db.execute(text("DELETE FROM inventory_items WHERE id = ANY(:items)"), {"items": items})


@dataclass(frozen=True)
class LockedBalance:
    inventory_item_id: uuid.UUID
    warehouse_id: uuid.UUID
    on_hand: int
    allocated: int
    version: int

    @property
    def available(self) -> int:
        return self.on_hand - self.allocated


def lock_balances(db: Session, item_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, LockedBalance]:
    """Lock the default-warehouse balances of these items, in ascending item order (R42).

    Returns the locked rows by inventory item id; an item without a balance (unknown, or of
    another business) is simply absent, and the caller decides how to refuse it. The rows are
    sorted before they are locked (``FOR UPDATE`` applies to the sorted output), so locks are
    taken in ascending ``inventory_item_id`` order, the single global order every stock
    operation uses.
    """
    ordered = sorted(set(item_ids))
    if not ordered:
        return {}
    rows = db.execute(
        text(
            "SELECT inventory_item_id, warehouse_id, on_hand, allocated, version "
            "FROM stock_balances "
            "WHERE warehouse_id = :warehouse AND inventory_item_id = ANY(:items) "
            "ORDER BY inventory_item_id FOR UPDATE"
        ),
        {"warehouse": default_warehouse_id(db), "items": ordered},
    )
    return {
        row.inventory_item_id: LockedBalance(
            row.inventory_item_id, row.warehouse_id, row.on_hand, row.allocated, row.version
        )
        for row in rows
    }


# ---- who changes stock --------------------------------------------------------------------------


@dataclass(frozen=True)
class StockActor:
    """Who changes stock: a user, or a system process (``user_id`` None)."""

    tenant_id: uuid.UUID
    user_id: uuid.UUID | None = None
    ip: str | None = None

    @property
    def actor_type(self) -> Literal["user", "system"]:
        return "user" if self.user_id is not None else "system"


def stock_numbers(balance: LockedBalance) -> dict[str, int]:
    """The contract's ``StockNumbers`` of a balance."""
    return {
        "on_hand": balance.on_hand,
        "allocated": balance.allocated,
        "available": balance.available,
        "version": balance.version,
    }


def current_numbers(db: Session, item_id: uuid.UUID) -> dict[str, int]:
    """The ``StockNumbers`` of an item's default-warehouse balance as they are now."""
    row = db.execute(
        text(
            "SELECT b.inventory_item_id, b.warehouse_id, b.on_hand, b.allocated, b.version "
            "FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id AND w.is_default "
            "WHERE b.inventory_item_id = :item"
        ),
        {"item": item_id},
    ).one()
    return stock_numbers(
        LockedBalance(
            row.inventory_item_id, row.warehouse_id, row.on_hand, row.allocated, row.version
        )
    )


# ---- adjustments (User Story 2, FR-012 to FR-017, R41 to R43) ----------------------------------

MAX_ON_HAND = 1_000_000

Reason = Literal["opening", "received", "found", "damaged", "lost", "count_correction", "other"]
REASONS: tuple[str, ...] = (
    "opening",
    "received",
    "found",
    "damaged",
    "lost",
    "count_correction",
    "other",
)
_INCREASING = frozenset({"opening", "received", "found"})
_DECREASING = frozenset({"damaged", "lost"})


@dataclass(frozen=True)
class AdjustmentIn:
    """A stock change whose shape the API checked (the contract's ``AdjustmentInput``).

    ``quantity`` is set for every reason but ``count_correction``, which has
    ``counted_quantity`` instead; ``direction`` only for ``other``, where it sets the sign.
    """

    reason: Reason
    balance_version: int
    quantity: int | None = None
    counted_quantity: int | None = None
    direction: Literal["in", "out"] | None = None
    note: str | None = None


@dataclass(frozen=True)
class StockVariant:
    variant_id: uuid.UUID
    inventory_item_id: uuid.UUID
    sku: str


def find_variant(db: Session, variant_id: uuid.UUID) -> StockVariant:
    """A variant of this business, whatever its status (``NotFound`` otherwise)."""
    row = db.execute(
        text("SELECT id, inventory_item_id, sku FROM variants WHERE id = :id"), {"id": variant_id}
    ).one_or_none()
    if row is None:
        raise NotFound("variant", variant_id)
    return StockVariant(row.id, row.inventory_item_id, row.sku)


def lock_balance(db: Session, item_id: uuid.UUID) -> LockedBalance:
    """Lock one item's balance; an item without one is a broken invariant (500, logged)."""
    found = lock_balances(db, [item_id]).get(item_id)
    if found is None:
        log.error("inventory item %s has no balance; refusing the stock operation", item_id)
        raise ApiError(500, "internal_error", "Internal error")
    return found


def _stock_conflict(code: str, message: str, balance: LockedBalance) -> ApiError:
    return ApiError(409, code, message, extra={"balance": stock_numbers(balance)})


def _too_large() -> ApiError:
    return ApiError(
        400,
        "validation_failed",
        "On hand would be above 1000000",
        fields={"quantity": "too_large"},
    )


def _not_enough(balance: LockedBalance) -> ApiError:
    return _stock_conflict(
        "not_enough_stock", "On hand may not go below zero or below the reserved quantity", balance
    )


def check_adjustment_limits(balance: LockedBalance, on_hand_after: int) -> None:
    """0 <= on hand after <= 1,000,000 and on hand after >= allocated (FR-015, R40).

    The balance CHECKs repeat this rule and are answered the same way, by constraint name
    (``adjust``), so a code path that forgets the rule still never answers 500.
    """
    if on_hand_after < 0 or on_hand_after < balance.allocated:
        raise _not_enough(balance)
    if on_hand_after > MAX_ON_HAND:
        raise _too_large()


def signed_quantity(data: AdjustmentIn, on_hand: int) -> int:
    """The movement's quantity: signed by reason (by ``direction`` for ``other``), or, for a
    count correction, the difference between the counted number and the current on hand."""
    if data.reason == "count_correction":
        assert data.counted_quantity is not None
        return data.counted_quantity - on_hand
    assert data.quantity is not None
    if data.reason in _INCREASING:
        return data.quantity
    if data.reason in _DECREASING:
        return -data.quantity
    assert data.direction is not None  # "other"
    return data.quantity if data.direction == "in" else -data.quantity


UPDATE_ON_HAND = text(
    "UPDATE stock_balances SET on_hand = on_hand + :delta, version = version + 1, "
    "updated_at = now() WHERE warehouse_id = :warehouse AND inventory_item_id = :item "
    "RETURNING on_hand"
)

INSERT_MOVEMENT = text(
    "INSERT INTO stock_movements (id, tenant_id, warehouse_id, inventory_item_id, quantity, "
    "reason, counted_quantity, on_hand_after, allocation_id, source, actor_type, actor_id, "
    "note, request_key) VALUES (:id, :tenant_id, :warehouse, :item, :quantity, :reason, "
    ":counted, :after, :allocation_id, :source, :actor_type, :actor_id, :note, :request_key)"
)


def adjust(
    db: Session,
    actor: StockActor,
    variant: StockVariant,
    data: AdjustmentIn,
    *,
    request_key: str | None = None,
) -> uuid.UUID:
    """Record a person's stock change; returns the new movement's id.

    Locks the balance, refuses a different ``balance_version`` (409 ``stock_changed``) and an
    impossible result (409 ``not_enough_stock``, 400 ``quantity: too_large``), then updates
    the balance (``version + 1``), writes one ``manual`` movement with its ``on_hand_after``
    and records ``stock.adjusted``. Allowed on archived variants. Refused: nothing written.
    """
    balance = lock_balance(db, variant.inventory_item_id)
    if balance.version != data.balance_version:
        raise _stock_conflict("stock_changed", "The stock changed since it was loaded", balance)
    quantity = signed_quantity(data, balance.on_hand)
    check_adjustment_limits(balance, balance.on_hand + quantity)

    movement_id = uuid.uuid4()
    try:
        with db.begin_nested():
            # The balance first: a negative result then fails stock_balances_not_oversold
            # (not_enough_stock) before the movement's on_hand_after range is checked.
            after = db.execute(
                UPDATE_ON_HAND,
                {
                    "delta": quantity,
                    "warehouse": balance.warehouse_id,
                    "item": variant.inventory_item_id,
                },
            ).scalar_one()
            counted = data.counted_quantity if data.reason == "count_correction" else None
            db.execute(
                INSERT_MOVEMENT,
                {
                    "id": movement_id,
                    "tenant_id": actor.tenant_id,
                    "warehouse": balance.warehouse_id,
                    "item": variant.inventory_item_id,
                    "quantity": quantity,
                    "reason": data.reason,
                    "counted": counted,
                    "after": after,
                    "allocation_id": None,
                    "source": "manual",
                    "actor_type": actor.actor_type,
                    "actor_id": actor.user_id,
                    "note": data.note,
                    "request_key": request_key,
                },
            )
    except IntegrityError as exc:
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if constraint == "stock_balances_not_oversold":
            raise _not_enough(balance) from None
        if constraint in ("stock_balances_on_hand_range", "stock_movements_on_hand_after_range"):
            raise _too_large() from None
        raise

    details: dict[str, Any] = {"sku": variant.sku, "reason": data.reason, "quantity": quantity}
    if data.reason == "count_correction":
        details["counted_quantity"] = data.counted_quantity
    details.update({"on_hand_before": balance.on_hand, "on_hand_after": after, "note": data.note})
    audit.record(
        db,
        tenant_id=actor.tenant_id,
        actor_type=actor.actor_type,
        actor_id=actor.user_id,
        event="stock.adjusted",
        target_type="variant",
        target_id=variant.variant_id,
        data=details,
        ip=actor.ip,
    )
    return movement_id


# ---- stock history (FR-017) ---------------------------------------------------------------------

MOVEMENTS_PER_PAGE = 50

_MOVEMENT_COLUMNS = (
    "m.id, m.seq, m.inventory_item_id, m.created_at, m.reason, m.quantity, m.counted_quantity, "
    "m.on_hand_after, m.actor_type, u.name AS actor_name, m.note, m.source"
)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def movement_json(row: Any) -> dict[str, Any]:
    """The contract's ``Movement``, with the actor's current name (none for the system)."""
    return {
        "id": str(row.id),
        "at": _iso(row.created_at),
        "reason": row.reason,
        "quantity": row.quantity,
        "counted_quantity": row.counted_quantity,
        "on_hand_after": row.on_hand_after,
        "actor_type": row.actor_type,
        "actor_name": row.actor_name if row.actor_type == "user" else None,
        "note": row.note,
        "source": row.source,
    }


def read_movement(db: Session, movement_id: uuid.UUID) -> tuple[dict[str, Any], uuid.UUID]:
    """One movement as ``Movement``, and its inventory item."""
    row = db.execute(
        text(
            f"SELECT {_MOVEMENT_COLUMNS} FROM stock_movements m "  # noqa: S608 (constant)
            "LEFT JOIN users u ON u.id = m.actor_id WHERE m.id = :id"
        ),
        {"id": movement_id},
    ).one()
    return movement_json(row), row.inventory_item_id


@dataclass(frozen=True)
class MovementPage:
    items: list[dict[str, Any]]
    next_seq: int | None


def movements_page(db: Session, variant: StockVariant, before_seq: int | None) -> MovementPage:
    """A variant's movements, newest first, 50 per page; ``before_seq`` is the keyset cursor.

    Ordered by the ledger's identity ``seq``, so a movement recorded while someone pages
    never shifts the next page.
    """
    rows = db.execute(
        text(
            f"SELECT {_MOVEMENT_COLUMNS} FROM stock_movements m "  # noqa: S608 (constant)
            "LEFT JOIN users u ON u.id = m.actor_id "
            "WHERE m.inventory_item_id = :item "
            "AND (CAST(:before AS bigint) IS NULL OR m.seq < CAST(:before AS bigint)) "
            "ORDER BY m.seq DESC LIMIT :limit"
        ),
        {"item": variant.inventory_item_id, "before": before_seq, "limit": MOVEMENTS_PER_PAGE + 1},
    ).all()
    more = len(rows) > MOVEMENTS_PER_PAGE
    rows = rows[:MOVEMENTS_PER_PAGE]
    return MovementPage([movement_json(row) for row in rows], rows[-1].seq if more else None)


# ---- low stock (FR-023, FR-024) ----------------------------------------------------------------


LOW_STOCK_PER_PAGE = 20
LowStockCursor = tuple[int, str]


@dataclass(frozen=True)
class LowStockPage:
    items: list[dict[str, Any]]
    next_cursor: LowStockCursor | None
    total: int | None


def low_stock_page(
    db: Session, store_id: uuid.UUID | None, cursor: LowStockCursor | None
) -> LowStockPage:
    """Read live availability and thresholds in the caller's tenant transaction."""
    params: dict[str, Any] = {"limit": LOW_STOCK_PER_PAGE + 1}
    clauses = ["v.status = 'active'", "p.status = 'active'", "level > 0", "available <= level"]
    if store_id is not None:
        clauses.append(
            "EXISTS (SELECT 1 FROM product_stores ps WHERE ps.product_id = p.id "
            "AND ps.store_id = :store_id)"
        )
        params["store_id"] = store_id
    if cursor is not None:
        clauses.append("(available, v.sku) > (:after_available, :after_sku)")
        params.update(after_available=cursor[0], after_sku=cursor[1])
    count_column = ", count(*) OVER () AS total" if cursor is None else ""
    rows = db.execute(
        text(
            "SELECT p.id AS product_id, p.name_en, p.name_ar, v.id AS variant_id, v.sku, "  # noqa: S608
            "  array_remove(ARRAY[o1.label, o2.label], NULL) AS option_values, "
            "  (SELECT ph.id FROM product_photos ph WHERE ph.product_id = p.id "
            "   ORDER BY ph.position LIMIT 1) AS main_photo_id, "
            f"  b.on_hand, b.allocated, available, level{count_column} "
            "FROM variants v JOIN products p ON p.id = v.product_id "
            "JOIN stock_balances b ON b.inventory_item_id = v.inventory_item_id "
            "JOIN tenants t ON t.id = v.tenant_id "
            "LEFT JOIN option_values o1 ON o1.id = v.option1_value_id "
            "LEFT JOIN option_values o2 ON o2.id = v.option2_value_id "
            "CROSS JOIN LATERAL (SELECT b.on_hand - b.allocated AS available, "
            "  COALESCE(v.low_stock_level, t.low_stock_default) AS level) stock "
            f"WHERE {' AND '.join(clauses)} ORDER BY available, v.sku LIMIT :limit"
        ),
        params,
    ).all()
    page = rows[:LOW_STOCK_PER_PAGE]
    # A SKU is unique within the tenant; no extra tiebreaker is needed.
    next_cursor = (page[-1].available, page[-1].sku) if len(rows) > len(page) else None
    total = (rows[0].total if rows else 0) if cursor is None else None
    return LowStockPage(
        items=[
            {
                "product_id": str(row.product_id),
                "product_name_en": row.name_en,
                "product_name_ar": row.name_ar,
                "variant_id": str(row.variant_id),
                "sku": row.sku,
                "option_values": row.option_values,
                "main_photo_id": str(row.main_photo_id) if row.main_photo_id else None,
                "on_hand": row.on_hand,
                "allocated": row.allocated,
                "available": row.available,
                "level": row.level,
                "stock_state": "out" if row.available == 0 else "low",
            }
            for row in page
        ],
        next_cursor=next_cursor,
        total=total,
    )


# ---- integrity (FR-013, FR-018, FR-022) --------------------------------------------------------


@dataclass(frozen=True)
class IntegrityProblem:
    """One broken rule: which rule, for which item (None for business-wide) and the numbers."""

    rule: int
    description: str
    inventory_item_id: uuid.UUID | None
    expected: int
    actual: int

    def __str__(self) -> str:
        where = f"item {self.inventory_item_id}" if self.inventory_item_id else "business"
        return (
            f"rule {self.rule} ({self.description}) broken for {where}: "
            f"expected {self.expected}, found {self.actual}"
        )


# Rule 1: every variant's item has exactly one balance in the default warehouse, and every
# item is used by exactly one variant.
_ITEMS = text(
    "SELECT i.id, "
    "  (SELECT count(*) FROM variants v WHERE v.inventory_item_id = i.id) AS variants, "
    "  (SELECT count(*) FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id "
    "     AND w.is_default WHERE b.inventory_item_id = i.id) AS balances "
    "FROM inventory_items i ORDER BY i.id"
)

# Rules 2-5, per balance.
_BALANCES = text(
    "SELECT b.inventory_item_id, b.on_hand, b.allocated, "
    "  (SELECT COALESCE(sum(m.quantity), 0) FROM stock_movements m "
    "     WHERE m.inventory_item_id = b.inventory_item_id "
    "       AND m.warehouse_id = b.warehouse_id) AS ledger, "
    "  (SELECT m.on_hand_after FROM stock_movements m "
    "     WHERE m.inventory_item_id = b.inventory_item_id AND m.warehouse_id = b.warehouse_id "
    "     ORDER BY m.seq DESC LIMIT 1) AS latest_after, "
    "  (SELECT COALESCE(sum(l.quantity), 0) FROM allocation_lines l "
    "     JOIN allocations a ON a.id = l.allocation_id AND a.status = 'active' "
    "     WHERE l.inventory_item_id = b.inventory_item_id "
    "       AND l.warehouse_id = b.warehouse_id) AS active_lines "
    "FROM stock_balances b ORDER BY b.inventory_item_id"
)

_WAREHOUSES = text(
    "SELECT count(*) AS total, count(*) FILTER (WHERE is_default) AS defaults FROM warehouses"
)


def integrity_report(db: Session) -> list[IntegrityProblem]:
    """Every difference from data-model.md "Integrity rules" in the current business."""
    problems: list[IntegrityProblem] = []

    for item in db.execute(_ITEMS):
        if item.variants != 1:
            problems.append(
                IntegrityProblem(1, "inventory item used by one variant", item.id, 1, item.variants)
            )
        if item.balances != 1:
            problems.append(
                IntegrityProblem(
                    1, "one balance in the default warehouse", item.id, 1, item.balances
                )
            )

    for balance in db.execute(_BALANCES):
        item_id = balance.inventory_item_id
        if balance.on_hand != balance.ledger:
            problems.append(
                IntegrityProblem(
                    2,
                    "on hand equals the sum of movements",
                    item_id,
                    balance.ledger,
                    balance.on_hand,
                )
            )
        if balance.latest_after is not None and balance.on_hand != balance.latest_after:
            problems.append(
                IntegrityProblem(
                    3,
                    "on hand equals the latest movement's on hand after",
                    item_id,
                    balance.latest_after,
                    balance.on_hand,
                )
            )
        if balance.allocated != balance.active_lines:
            problems.append(
                IntegrityProblem(
                    4,
                    "allocated equals the active allocation lines",
                    item_id,
                    balance.active_lines,
                    balance.allocated,
                )
            )
        if balance.on_hand - balance.allocated < 0:
            problems.append(
                IntegrityProblem(
                    5, "available is not negative", item_id, 0, balance.on_hand - balance.allocated
                )
            )

    warehouses = db.execute(_WAREHOUSES).one()
    if warehouses.defaults != 1:
        problems.append(IntegrityProblem(6, "one default warehouse", None, 1, warehouses.defaults))
    if warehouses.total != 1:
        problems.append(IntegrityProblem(6, "exactly one warehouse", None, 1, warehouses.total))
    return problems
