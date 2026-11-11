"""The business's history, ``GET /audit`` (T049, FR-033): owners only, newest first.

Row-level security limits the query to the caller's business; platform entries (no business)
are never visible. Pages are cut with an opaque cursor (the position of the last entry
shown), so new entries arriving between pages never shift or repeat what was already shown.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, request
from flask.typing import ResponseReturnValue
from sqlalchemy import text

from app.api.common import iso, validation_failed
from app.core.permissions import require
from app.core.request_context import current_user, request_db

bp = Blueprint("audit", __name__, url_prefix="/api/v1")

PAGE_SIZE = 50
OPERATOR_NAME = "BOS support"  # operators are never named to merchants

_QUERY = text(
    "SELECT e.id, e.at, e.event, e.actor_type, e.actor_id, e.target_type, e.target_id, e.data, "
    "u.name AS user_name "
    "FROM audit_entries e "
    "LEFT JOIN users u ON e.actor_type = 'user' AND u.id = e.actor_id "
    "WHERE e.tenant_id = :tenant_id "
    "AND (CAST(:event AS text) IS NULL OR e.event = CAST(:event AS text)) "
    "AND (CAST(:actor_id AS uuid) IS NULL OR e.actor_id = CAST(:actor_id AS uuid)) "
    "AND (CAST(:at AS timestamptz) IS NULL "
    "     OR (e.at, e.id) < (CAST(:at AS timestamptz), CAST(:id AS uuid))) "
    "ORDER BY e.at DESC, e.id DESC LIMIT :limit"
)


@bp.get("/audit")
@require("audit.view")
def history() -> ResponseReturnValue:
    user = current_user()
    errors: dict[str, str] = {}
    actor_id = _actor(request.args.get("actor_id"), errors)
    position = _position(request.args.get("cursor"), errors)
    if errors:
        raise validation_failed(errors)
    rows = (
        request_db()
        .execute(
            _QUERY,
            {
                "tenant_id": user.tenant_id,
                "event": request.args.get("event") or None,
                "actor_id": actor_id,
                "at": position[0] if position else None,
                "id": position[1] if position else None,
                "limit": PAGE_SIZE + 1,
            },
        )
        .all()
    )
    more = len(rows) > PAGE_SIZE
    rows = rows[:PAGE_SIZE]
    return jsonify(
        {
            "items": [_item(row) for row in rows],
            "next_cursor": _cursor(rows[-1].at, rows[-1].id) if more else None,
        }
    )


def _item(row: Any) -> dict[str, Any]:
    if row.actor_type == "user":
        actor_name = row.user_name
    elif row.actor_type == "operator":
        actor_name = OPERATOR_NAME
    else:
        actor_name = None
    target = None
    if row.target_type is not None:
        target = row.target_type if row.target_id is None else f"{row.target_type}:{row.target_id}"
    return {
        "id": str(row.id),
        "at": iso(row.at),
        "event": row.event,
        "actor_type": row.actor_type,
        "actor_name": actor_name,
        "target": target,
        "data": row.data,
    }


def _actor(raw: str | None, errors: dict[str, str]) -> uuid.UUID | None:
    if raw is None:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        errors["actor_id"] = "invalid"
        return None


def _cursor(at: datetime, entry_id: uuid.UUID) -> str:
    raw = json.dumps([at.isoformat(), str(entry_id)]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _position(raw: str | None, errors: dict[str, str]) -> tuple[datetime, uuid.UUID] | None:
    if raw is None:
        return None
    try:
        decoded = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        at, entry_id = decoded
        position = (datetime.fromisoformat(at), uuid.UUID(entry_id))
    except (ValueError, TypeError, binascii.Error):
        errors["cursor"] = "invalid"
        return None
    if position[0].tzinfo is None:
        errors["cursor"] = "invalid"
        return None
    return position
