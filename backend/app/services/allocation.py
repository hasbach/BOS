"""Allocation: reserving stock all or nothing, releasing and consuming it (US3, R44, R45).

There is no HTTP route in M1; M2's order confirmation calls these functions inside its own
request transaction. Everything runs in the caller's transaction and tenant context.

* ``allocate(db, actor, request_key, lines)`` reserves every line or none. ``lines`` are
  ``(inventory_item_id, quantity)``: 1 to 100 of them, quantity 1 to 1,000,000, no item
  twice; the request key is 1 to 200 characters and never expires. The same key with the
  same contents (``request_hash``, SHA-256 of the lines sorted by item) returns the original
  allocation whatever its state, reserving nothing again; with other contents it is refused
  (``allocation_key_conflict``). The whole request is refused when an item is unknown in
  this business (``unknown_item``), belongs to an archived variant or product
  (``variant_archived``), or lacks available stock (``insufficient_stock``, listing every
  short line with its available number).
* ``release`` (``active`` -> ``released``) gives the quantities back to available;
  ``consume`` (``active`` -> ``consumed``) lowers on hand and allocated together and writes
  one ``allocation_consumed`` movement per line (source ``allocation``). Repeating the same
  transition returns the allocation unchanged; the other one is refused
  (``allocation_closed``). An unknown allocation raises ``NotFound``.

**Locks (R42).** Balances are locked with ``inventory.lock_balances`` (ascending item order)
before any number is read, and variant and product status are read only after that, so an
archive racing an allocation either sees the reservation (and is refused) or is seen by it.
``release`` and ``consume`` lock the allocation row, then the balances; nothing locks an
allocation row after a balance, so no cycle is possible.

**Races on the key (R44).** The allocation row is inserted under a savepoint before the
balances are locked. A second request with the same key waits on the unique index until
the first commits, then reads and returns the winner's allocation. Any refusal rolls the
savepoint back, so the caller's transaction holds nothing of a refused request.

Every change is recorded in history: ``stock.allocated``, ``stock.released``,
``stock.consumed`` with the request key and the lines (``sku``, ``inventory_item_id``,
``quantity``).
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import audit
from app.services import inventory
from app.services.common import NotFound
from app.services.inventory import LockedBalance, StockActor

MAX_LINES = 100
MAX_KEY_LENGTH = 200
MAX_QUANTITY = 1_000_000

Status = Literal["active", "released", "consumed"]


class AllocationRefused(Exception):
    """The request was refused; nothing of it was written.

    ``code`` is one of ``invalid`` (with ``field``: ``request_key``, ``lines``,
    ``lines.N.quantity`` or ``lines.N.inventory_item_id``), ``unknown_item``,
    ``variant_archived``, ``insufficient_stock``, ``allocation_key_conflict`` or
    ``allocation_closed``; ``lines`` names the items concerned (with ``requested`` and
    ``available`` for ``insufficient_stock``).
    """

    def __init__(
        self, code: str, *, lines: list[dict[str, Any]] | None = None, field: str | None = None
    ) -> None:
        super().__init__(code)
        self.code = code
        self.lines = lines or []
        self.field = field


@dataclass(frozen=True, order=True)
class Line:
    inventory_item_id: uuid.UUID
    quantity: int


@dataclass(frozen=True)
class Allocation:
    id: uuid.UUID
    request_key: str
    status: Status
    lines: tuple[Line, ...] = ()


# ---- allocate -----------------------------------------------------------------------------------


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _checked(request_key: str, lines: Sequence[tuple[uuid.UUID, int]]) -> tuple[Line, ...]:
    if not isinstance(request_key, str) or not 1 <= len(request_key) <= MAX_KEY_LENGTH:
        raise AllocationRefused("invalid", field="request_key")
    if not 1 <= len(lines) <= MAX_LINES:
        raise AllocationRefused("invalid", field="lines")
    seen: set[uuid.UUID] = set()
    for index, (item_id, quantity) in enumerate(lines):
        if not isinstance(item_id, uuid.UUID) or item_id in seen:
            raise AllocationRefused("invalid", field=f"lines.{index}.inventory_item_id")
        if not _is_int(quantity) or not 1 <= quantity <= MAX_QUANTITY:
            raise AllocationRefused("invalid", field=f"lines.{index}.quantity")
        seen.add(item_id)
    return tuple(sorted(Line(item_id, quantity) for item_id, quantity in lines))


def request_hash(lines: Sequence[Line]) -> bytes:
    """SHA-256 of the canonical list of ``(inventory_item_id, quantity)``, sorted by item."""
    canonical = "\n".join(f"{line.inventory_item_id}:{line.quantity}" for line in sorted(lines))
    return hashlib.sha256(canonical.encode()).digest()


_BY_KEY = text(
    "SELECT id, request_key, request_hash, status FROM allocations WHERE request_key = :key"
)


def _existing(db: Session, request_key: str, digest: bytes) -> Allocation | None:
    """The allocation already made with this key (refused if its contents differ)."""
    row = db.execute(_BY_KEY, {"key": request_key}).one_or_none()
    if row is None:
        return None
    if bytes(row.request_hash) != digest:
        raise AllocationRefused("allocation_key_conflict")
    return _read(db, row.id)


def allocate(
    db: Session, actor: StockActor, request_key: str, lines: Sequence[tuple[uuid.UUID, int]]
) -> Allocation:
    """Reserve every line or none; a repeated request key returns the first result."""
    wanted = _checked(request_key, lines)
    digest = request_hash(wanted)
    found = _existing(db, request_key, digest)
    if found is not None:
        return found

    allocation_id = uuid.uuid4()
    try:
        with db.begin_nested():
            db.execute(
                text(
                    "INSERT INTO allocations (id, tenant_id, request_key, request_hash, status, "
                    "actor_type, actor_id) VALUES (:id, :tenant_id, :key, :hash, 'active', "
                    ":actor_type, :actor_id)"
                ),
                {
                    "id": allocation_id,
                    "tenant_id": actor.tenant_id,
                    "key": request_key,
                    "hash": digest,
                    "actor_type": actor.actor_type,
                    "actor_id": actor.user_id,
                },
            )
            _reserve(db, actor, allocation_id, request_key, wanted)
    except IntegrityError as exc:
        # The same key committed by a request that raced this one: return the winner's.
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if constraint != "allocations_tenant_id_request_key_key":
            raise
        found = _existing(db, request_key, digest)
        if found is None:
            raise
        return found
    return Allocation(allocation_id, request_key, "active", wanted)


@dataclass(frozen=True)
class _Item:
    sku: str
    archived: bool


def _items(db: Session, item_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, _Item]:
    """The variant of each item, read after the balances are locked (status may have changed
    while this request waited for the locks)."""
    rows = db.execute(
        text(
            "SELECT v.inventory_item_id, v.sku, "
            "(v.status = 'archived' OR p.status = 'archived') AS archived "
            "FROM variants v JOIN products p ON p.id = v.product_id "
            "WHERE v.inventory_item_id = ANY(:items)"
        ),
        {"items": list(item_ids)},
    )
    return {row.inventory_item_id: _Item(row.sku, row.archived) for row in rows}


def _reserve(
    db: Session,
    actor: StockActor,
    allocation_id: uuid.UUID,
    request_key: str,
    wanted: tuple[Line, ...],
) -> None:
    item_ids = [line.inventory_item_id for line in wanted]
    locked = inventory.lock_balances(db, item_ids)
    items = _items(db, item_ids)
    unknown = [i for i in item_ids if i not in locked or i not in items]
    if unknown:
        raise AllocationRefused("unknown_item", lines=[{"inventory_item_id": i} for i in unknown])
    archived = [i for i in item_ids if items[i].archived]
    if archived:
        raise AllocationRefused(
            "variant_archived", lines=[{"inventory_item_id": i} for i in archived]
        )
    short = [line for line in wanted if locked[line.inventory_item_id].available < line.quantity]
    if short:
        raise AllocationRefused(
            "insufficient_stock",
            lines=[
                {
                    "inventory_item_id": line.inventory_item_id,
                    "requested": line.quantity,
                    "available": locked[line.inventory_item_id].available,
                }
                for line in short
            ],
        )
    for line in wanted:
        balance = locked[line.inventory_item_id]
        _change_balance(db, balance, allocated=line.quantity)
        db.execute(
            text(
                "INSERT INTO allocation_lines (id, tenant_id, allocation_id, warehouse_id, "
                "inventory_item_id, quantity) VALUES (:id, :tenant_id, :allocation_id, "
                ":warehouse, :item, :quantity)"
            ),
            {
                "id": uuid.uuid4(),
                "tenant_id": actor.tenant_id,
                "allocation_id": allocation_id,
                "warehouse": balance.warehouse_id,
                "item": line.inventory_item_id,
                "quantity": line.quantity,
            },
        )
    _record(db, actor, "stock.allocated", allocation_id, request_key, wanted, items)


def _change_balance(
    db: Session, balance: LockedBalance, *, allocated: int = 0, on_hand: int = 0
) -> int:
    """Change a locked balance by these amounts, ``version + 1``; returns the new on hand."""
    new_on_hand: int = db.execute(
        text(
            "UPDATE stock_balances SET allocated = allocated + :allocated, "
            "on_hand = on_hand + :on_hand, version = version + 1, updated_at = now() "
            "WHERE warehouse_id = :warehouse AND inventory_item_id = :item RETURNING on_hand"
        ),
        {
            "allocated": allocated,
            "on_hand": on_hand,
            "warehouse": balance.warehouse_id,
            "item": balance.inventory_item_id,
        },
    ).scalar_one()
    return new_on_hand


def _record(
    db: Session,
    actor: StockActor,
    event: str,
    allocation_id: uuid.UUID,
    request_key: str,
    lines: Sequence[Line],
    items: dict[uuid.UUID, _Item],
) -> None:
    audit.record(
        db,
        tenant_id=actor.tenant_id,
        actor_type=actor.actor_type,
        actor_id=actor.user_id,
        event=event,
        target_type="allocation",
        target_id=allocation_id,
        data={
            "request_key": request_key,
            "lines": [
                {
                    "sku": items[line.inventory_item_id].sku,
                    "inventory_item_id": str(line.inventory_item_id),
                    "quantity": line.quantity,
                }
                for line in sorted(lines)
            ],
        },
        ip=actor.ip,
    )


# ---- release and consume ------------------------------------------------------------------------


def _read(db: Session, allocation_id: uuid.UUID, *, lock: bool = False) -> Allocation:
    row = db.execute(
        text(
            "SELECT id, request_key, status FROM allocations WHERE id = :id"  # noqa: S608 (constant)
            + (" FOR UPDATE" if lock else "")
        ),
        {"id": allocation_id},
    ).one_or_none()
    if row is None:
        raise NotFound("allocation", allocation_id)
    lines = db.execute(
        text(
            "SELECT inventory_item_id, quantity FROM allocation_lines "
            "WHERE allocation_id = :id ORDER BY inventory_item_id"
        ),
        {"id": allocation_id},
    )
    return Allocation(
        row.id,
        row.request_key,
        row.status,
        tuple(Line(r.inventory_item_id, r.quantity) for r in lines),
    )


def _close(
    db: Session, actor: StockActor, allocation_id: uuid.UUID, to: Literal["released", "consumed"]
) -> Allocation:
    current = _read(db, allocation_id, lock=True)
    if current.status == to:
        return current
    if current.status != "active":
        raise AllocationRefused("allocation_closed")
    item_ids = [line.inventory_item_id for line in current.lines]
    locked = inventory.lock_balances(db, item_ids)
    for line in current.lines:
        balance = locked[line.inventory_item_id]
        if to == "released":
            _change_balance(db, balance, allocated=-line.quantity)
            continue
        on_hand_after = _change_balance(
            db, balance, allocated=-line.quantity, on_hand=-line.quantity
        )
        db.execute(
            inventory.INSERT_MOVEMENT,
            {
                "id": uuid.uuid4(),
                "tenant_id": actor.tenant_id,
                "warehouse": balance.warehouse_id,
                "item": line.inventory_item_id,
                "quantity": -line.quantity,
                "reason": "allocation_consumed",
                "counted": None,
                "after": on_hand_after,
                "allocation_id": allocation_id,
                "source": "allocation",
                "actor_type": actor.actor_type,
                "actor_id": actor.user_id,
                "note": None,
                "request_key": current.request_key,
            },
        )
    db.execute(
        text(
            "UPDATE allocations SET status = :to, "
            "released_at = CASE WHEN :to = 'released' THEN now() END, "
            "consumed_at = CASE WHEN :to = 'consumed' THEN now() END WHERE id = :id"
        ),
        {"to": to, "id": allocation_id},
    )
    event = "stock.released" if to == "released" else "stock.consumed"
    _record(
        db, actor, event, allocation_id, current.request_key, current.lines, _items(db, item_ids)
    )
    return Allocation(current.id, current.request_key, to, current.lines)


def release(db: Session, actor: StockActor, allocation_id: uuid.UUID) -> Allocation:
    """``active`` -> ``released``: the quantities return to available."""
    return _close(db, actor, allocation_id, "released")


def consume(db: Session, actor: StockActor, allocation_id: uuid.UUID) -> Allocation:
    """``active`` -> ``consumed``: on hand and allocated both go down, one movement per line."""
    return _close(db, actor, allocation_id, "consumed")
