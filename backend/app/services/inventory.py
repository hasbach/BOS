"""The inventory core shared by catalog, stock and allocation code (research R39-R42, R45).

* ``create_default_warehouse`` — every business has exactly one warehouse, created with the
  business (onboarding, demo seed; migration 0003 backfilled the existing ones).
* ``default_warehouse_id`` — the warehouse stock code works in. Fails closed: a business
  without one is a broken invariant, answered 500 and logged, never guessed around.
* ``lock_balances`` — the one way to lock balance rows before deciding on their numbers:
  ``SELECT ... FOR UPDATE`` in ascending ``inventory_item_id`` order, so two stock operations
  can never deadlock each other (R42).
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

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.errors import ApiError

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
