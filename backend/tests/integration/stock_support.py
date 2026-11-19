"""Helpers shared by the stock tests (M1 User Stories 2 and 3): calls, arranging, reading."""

from __future__ import annotations

import time
import uuid
from typing import Any

from flask.testing import FlaskClient
from sqlalchemy import Engine, text

from tests.dbsupport import Balance, CatalogProduct, insert_product, read_balance
from tests.integration.us1_support import CSRF, owner_rows

VARIANTS = "/api/v1/catalog/variants"
ADJUST_RULE = "/api/v1/catalog/variants/<uuid:variant_id>/adjustments"
MOVEMENTS_RULE = "/api/v1/catalog/variants/<uuid:variant_id>/movements"


def adjust_path(variant_id: Any) -> str:
    return f"{VARIANTS}/{variant_id}/adjustments"


def movements_path(variant_id: Any) -> str:
    return f"{VARIANTS}/{variant_id}/movements"


def adjust(
    client: FlaskClient, variant_id: Any, body: dict[str, Any], *, key: str | None = None
) -> Any:
    headers = dict(CSRF)
    if key is not None:
        headers["Idempotency-Key"] = key
    return client.post(adjust_path(variant_id), json=body, headers=headers)


def change(
    reason: str,
    quantity: int | None = None,
    *,
    version: int = 1,
    counted: int | None = None,
    direction: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """An adjustment body; keys left as None are not sent."""
    body: dict[str, Any] = {"reason": reason, "balance_version": version}
    if quantity is not None:
        body["quantity"] = quantity
    if counted is not None:
        body["counted_quantity"] = counted
    if direction is not None:
        body["direction"] = direction
    if note is not None:
        body["note"] = note
    return body


def arrange_product(
    owner: Engine,
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    on_hand: int | list[int] = 10,
    variants: int = 1,
    **extra: Any,
) -> CatalogProduct:
    with owner.begin() as conn:
        return insert_product(conn, tenant_id, user_id, variants=variants, on_hand=on_hand, **extra)


def balance(owner: Engine, item_id: uuid.UUID) -> Balance:
    with owner.connect() as conn:
        return read_balance(conn, item_id)


def item_movements(owner: Engine, item_id: uuid.UUID) -> list[Any]:
    """Every movement of one item, oldest first, with every column."""
    return owner_rows(
        owner,
        "SELECT id, seq, quantity, reason, counted_quantity, on_hand_after, allocation_id, "
        "import_batch_id, source, actor_type, actor_id, note, request_key, created_at "
        "FROM stock_movements WHERE inventory_item_id = :i ORDER BY seq",
        i=item_id,
    )


def wait_until_waiting_for_a_lock(owner: Engine, sessions: int = 1, timeout: float = 15) -> None:
    """Block until ``sessions`` database sessions are waiting for a lock (or fail)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with owner.connect() as conn:
            waiting = conn.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE wait_event_type = 'Lock' AND datname = current_database()"
                )
            ).scalar_one()
        if waiting >= sessions:
            return
        time.sleep(0.02)
    raise AssertionError(f"no {sessions} session(s) waiting for a lock after {timeout} s")
