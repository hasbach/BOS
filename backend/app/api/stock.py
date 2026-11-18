"""Stock changes and stock history, ``/api/v1/catalog/variants/{variantId}/...`` (User Story 2).

Both routes need ``stock.adjust`` (owners and managers; held only by roles that always have
every store, so no store scope applies). A variant of another business is answered 404 like
a made-up one (``access.denied_tenant``). Archived variants can still be adjusted.

``POST .../adjustments`` is idempotent (M0's ``core/idempotency``, resource type
``stock_movement``, R44): a repeat returns the first movement and the balance as it is now.
The balance row is locked *before* the key is looked up, so a duplicate sent at the same
moment waits for the first to commit and then replays it instead of being refused as stale.
The rules that need the balance (version, limits) are in ``app.services.inventory.adjust``.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from typing import Any, cast

from flask import Blueprint, jsonify, request
from flask.typing import ResponseReturnValue

from app.api.common import client_ip, json_body, validation_failed
from app.core.idempotency import HEADER, idempotent
from app.core.permissions import require
from app.core.request_context import current_user, not_found_in_tenant, request_db
from app.services import inventory
from app.services.common import NotFound

bp = Blueprint("stock", __name__, url_prefix="/api/v1")

MAX_QUANTITY = 1_000_000
NOTE_MAX = 500


def _variant(variant_id: uuid.UUID) -> inventory.StockVariant:
    try:
        return inventory.find_variant(request_db(), variant_id)
    except NotFound as missing:
        not_found_in_tenant(missing.target_type, missing.target_id)


@bp.post("/catalog/variants/<uuid:variant_id>/adjustments")
@require("stock.adjust")
def adjust_stock(variant_id: uuid.UUID) -> ResponseReturnValue:
    variant = _variant(variant_id)  # before the body, so a bad body tells nothing about the id
    data = _adjustment_input(json_body())
    db = request_db()
    user = current_user()
    actor = inventory.StockActor(tenant_id=user.tenant_id, user_id=user.user_id, ip=client_ip())
    inventory.lock_balance(db, variant.inventory_item_id)

    def create() -> tuple[uuid.UUID, ResponseReturnValue]:
        movement_id = inventory.adjust(
            db, actor, variant, data, request_key=request.headers.get(HEADER)
        )
        return movement_id, (_result(movement_id), 201)

    def replay(movement_id: uuid.UUID) -> ResponseReturnValue:
        return _result(movement_id), 201

    return idempotent("stock_movement", create=create, replay=replay)


def _result(movement_id: uuid.UUID) -> Any:
    db = request_db()
    movement, item_id = inventory.read_movement(db, movement_id)
    return jsonify({"movement": movement, "balance": inventory.current_numbers(db, item_id)})


@bp.get("/catalog/variants/<uuid:variant_id>/movements")
@require("stock.adjust")
def list_movements(variant_id: uuid.UUID) -> ResponseReturnValue:
    variant = _variant(variant_id)
    before = None
    if "cursor" in request.args:
        before = decode_seq(request.args["cursor"])
        if before is None:
            raise validation_failed({"cursor": "invalid"})
    page = inventory.movements_page(request_db(), variant, before)
    return jsonify(
        {
            "items": page.items,
            "next_cursor": encode_seq(page.next_seq) if page.next_seq is not None else None,
        }
    )


# ---- cursor -------------------------------------------------------------------------------------


def encode_seq(seq: int) -> str:
    """An opaque keyset position in a variant's ledger (the movement's ``seq``)."""
    return base64.urlsafe_b64encode(json.dumps({"seq": seq}).encode()).decode().rstrip("=")


def decode_seq(raw: str) -> int | None:
    try:
        decoded = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except (ValueError, TypeError, binascii.Error):
        return None
    seq = decoded.get("seq") if isinstance(decoded, dict) else None
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
        return None
    return seq


# ---- request shape ------------------------------------------------------------------------------


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _count(body: dict[str, Any], name: str, minimum: int, errors: dict[str, str]) -> int | None:
    """A JSON integer from ``minimum`` to 1,000,000 (strings, decimals, booleans refused)."""
    value = body.get(name)
    if value is None:
        errors[name] = "required"
        return None
    if not _is_int(value) or value < minimum:
        errors[name] = "invalid"
        return None
    if value > MAX_QUANTITY:
        errors[name] = "too_large"
        return None
    return int(value)


def _adjustment_input(body: dict[str, Any]) -> inventory.AdjustmentIn:
    errors: dict[str, str] = {}
    reason = body.get("reason")
    if reason is None:
        errors["reason"] = "required"
    elif reason not in inventory.REASONS:
        errors["reason"] = "invalid"

    quantity = counted = None
    if reason == "count_correction":
        counted = _count(body, "counted_quantity", 0, errors)
    elif reason in inventory.REASONS:
        quantity = _count(body, "quantity", 1, errors)

    direction = None
    if reason == "other":  # ignored for every other reason: each has a fixed sign
        direction = body.get("direction")
        if direction is None:
            errors["direction"] = "required"
        elif direction not in ("in", "out"):
            errors["direction"] = "invalid"

    note = body.get("note")
    if note is not None and not isinstance(note, str):
        errors["note"] = "invalid"
        note = None
    note = (note or "").strip() or None
    if note is not None and len(note) > NOTE_MAX:
        errors["note"] = "too_long"
    elif note is None and reason == "other" and "note" not in errors:
        errors["note"] = "required"

    version = body.get("balance_version")
    if version is None:
        errors["balance_version"] = "required"
    elif not _is_int(version) or version < 1:
        errors["balance_version"] = "invalid"

    if errors:
        raise validation_failed(errors)
    return inventory.AdjustmentIn(
        reason=cast(inventory.Reason, reason),
        balance_version=cast(int, version),
        quantity=quantity,
        counted_quantity=counted,
        direction=direction,
        note=note,
    )
