"""Business-wide settings on the tenant row (User Story 3: FR-023, FR-024).

Money is ``Decimal`` from the request to the database and back as a decimal string; it never
passes through a float. Changing a setting only changes the tenant row: nothing recorded
earlier refers to these columns, and later records (orders in M2) copy the values they use
when they are created, so a change never rewrites history. Every change is recorded as
``tenant.settings_changed`` with the old and new value of each field that changed.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core import audit

TIMEZONE = "Asia/Beirut"
CENT = Decimal("0.01")
SETTINGS = (
    "name",
    "default_currency",
    "usd_lbp_rate",
    "default_delivery_fee",
    "default_delivery_fee_currency",
    "low_stock_default",
)
_COLUMNS = "id, edition, " + ", ".join(SETTINGS)


def money(value: Decimal) -> str:
    """A decimal string with exactly two decimals, as the contract's ``Money``."""
    return format(value.quantize(CENT), "f")


def _shown(field: str, value: Any) -> Any:
    return money(value) if isinstance(value, Decimal) else value


def _row(db: Session, tenant_id: uuid.UUID, *, lock: bool = False) -> Any:
    return db.execute(
        text(
            f"SELECT {_COLUMNS} FROM tenants WHERE id = :id"  # noqa: S608
            + (" FOR NO KEY UPDATE" if lock else "")
        ),
        {"id": tenant_id},
    ).one()


def business(db: Session, tenant_id: uuid.UUID) -> dict[str, Any]:
    row = _row(db, tenant_id)
    return {
        "id": str(row.id),
        "name": row.name,
        "edition": row.edition,
        "default_currency": row.default_currency,
        "usd_lbp_rate": money(row.usd_lbp_rate),
        "default_delivery_fee": money(row.default_delivery_fee),
        "default_delivery_fee_currency": row.default_delivery_fee_currency,
        "low_stock_default": row.low_stock_default,
        "timezone": TIMEZONE,
    }


def update(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    changes: dict[str, Any],
    ip: str | None = None,
) -> dict[str, Any]:
    """Apply already validated ``changes`` (setting name -> value); returns the business."""
    unknown = changes.keys() - set(SETTINGS)
    if unknown:
        raise ValueError(f"not a business setting: {sorted(unknown)}")
    current = _row(db, tenant_id, lock=True)
    changed = {field: value for field, value in changes.items() if getattr(current, field) != value}
    if changed:
        assignments = ", ".join(f"{field} = :{field}" for field in changed)
        db.execute(
            text(f"UPDATE tenants SET {assignments}, updated_at = now() WHERE id = :id"),  # noqa: S608
            {**changed, "id": tenant_id},
        )
        audit.record(
            db,
            tenant_id=tenant_id,
            actor_type="user",
            actor_id=user_id,
            event="tenant.settings_changed",
            target_type="tenant",
            target_id=tenant_id,
            data={
                "before": {f: _shown(f, getattr(current, f)) for f in changed},
                "after": {f: _shown(f, v) for f, v in changed.items()},
            },
            ip=ip,
        )
    return business(db, tenant_id)
