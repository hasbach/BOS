"""What the web app needs to know about the signed-in user (the contract's ``Me``).

Always read inside the user's own tenant context, so row-level security limits it to their
business.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.permissions import Access, Role, start_tab_for, tabs_for

_STORE_COLUMNS = "s.id, s.name, s.whatsapp_e164, s.logo_file_id, s.status"


def store_json(row: Any) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "whatsapp_number": row.whatsapp_e164,
        "has_logo": row.logo_file_id is not None,
        "status": row.status,
    }


def visible_stores(db: Session, user_id: uuid.UUID, access: Access) -> list[dict[str, Any]]:
    """The active stores the user may work in."""
    if access.sees_all_stores:
        rows = db.execute(
            text(
                f"SELECT {_STORE_COLUMNS} FROM stores s WHERE s.status = 'active' "  # noqa: S608
                "ORDER BY s.created_at, s.name"
            )
        ).all()
    else:
        rows = db.execute(
            text(
                f"SELECT {_STORE_COLUMNS} FROM stores s "  # noqa: S608
                "JOIN user_stores us ON us.store_id = s.id AND us.user_id = :user_id "
                "WHERE s.status = 'active' ORDER BY s.created_at, s.name"
            ),
            {"user_id": user_id},
        ).all()
    return [store_json(row) for row in rows]


def build_me(db: Session, user_id: uuid.UUID, tenant_id: uuid.UUID) -> dict[str, Any]:
    user = db.execute(
        text(
            "SELECT id, name, phone_e164, email, locale, roles, all_stores FROM users "
            "WHERE id = :id AND tenant_id = :tenant_id"
        ),
        {"id": user_id, "tenant_id": tenant_id},
    ).one()
    business = db.execute(
        text("SELECT id, name, edition FROM tenants WHERE id = :id"), {"id": tenant_id}
    ).one()
    roles = [Role(role) for role in user.roles]
    access = Access(roles=frozenset(roles), all_stores=user.all_stores, store_ids=frozenset())
    return {
        "user": {
            "id": str(user.id),
            "name": user.name,
            "phone": user.phone_e164,
            "email": user.email,
            "locale": user.locale,
            "roles": [str(role) for role in roles],
        },
        "business": {"id": str(business.id), "name": business.name, "edition": business.edition},
        "permissions": sorted(access.permissions),
        "all_stores": access.sees_all_stores,
        "stores": visible_stores(db, user.id, access),
        "tabs": tabs_for(roles),
        "start_tab": start_tab_for(roles),
    }
