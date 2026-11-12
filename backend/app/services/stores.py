"""Stores of one business and their logos (User Story 3: FR-021, FR-022, FR-025).

Everything runs in the request's tenant transaction, so row-level security limits every
query to the caller's business; another business's store is simply "not found".

Rules:

* A store name (1 to 80 characters) is unique among the business's **active** stores, ignoring
  case; so is a WhatsApp number (E.164). An inactive store keeps its name and number, and
  both are checked again when it is reactivated (409 ``store_name_in_use`` /
  ``whatsapp_number_in_use``).
* The business keeps at least one active store (409 ``last_active_store``).
* Deactivating a store that is the only remaining active store of an active, store-limited
  employee, or of a pending store-limited invitation, needs ``confirm``; until then the answer
  is 409 ``confirmation_required`` listing them (kind, id, name and roles; never a phone
  number or email). Store assignments are kept, so reactivating the store gives everyone
  their access back; while it is inactive it simply no longer counts as one of their stores.
* Creating, editing, deactivating and reactivating stores take a lock on the tenant row
  first (``FOR NO KEY UPDATE``, as in ``app.services.staff``), so two simultaneous requests
  can neither both take the same name nor deactivate the last two active stores.

Who sees which stores: owners and managers see every store, inactive ones included; every
other user sees only the **active** stores they may work in (all active stores with
``all_stores``, else their assigned active stores), the same list as ``/me``.

Logos: the API writes the re-encoded file to storage first and hands its path here; the
change of ``stores.logo_file_id`` and the old ``files`` row's removal happen in the
transaction, and the old file is removed from storage only after the commit (see
``app.api.stores``).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core import audit
from app.core.permissions import Access
from app.core.storage import LOGO_MIME
from app.errors import ApiError
from app.services.common import NotFound
from app.services.me import store_json, visible_stores

_COLUMNS = "s.id, s.name, s.whatsapp_e164, s.logo_file_id, s.status"


@dataclass(frozen=True)
class Actor:
    """The signed-in owner or manager changing the business's stores."""

    user_id: uuid.UUID
    tenant_id: uuid.UUID
    ip: str | None = None


def _record(
    db: Session, actor: Actor, event: str, store_id: uuid.UUID, data: dict[str, Any]
) -> None:
    audit.record(
        db,
        tenant_id=actor.tenant_id,
        actor_type="user",
        actor_id=actor.user_id,
        event=event,
        target_type="store",
        target_id=store_id,
        data=data,
        ip=actor.ip,
    )


def _lock_tenant(db: Session, tenant_id: uuid.UUID) -> None:
    db.execute(text("SELECT id FROM tenants WHERE id = :id FOR NO KEY UPDATE"), {"id": tenant_id})


# ---- reading ----------------------------------------------------------------------------------


def list_stores(db: Session, user_id: uuid.UUID, access: Access) -> list[dict[str, Any]]:
    """The stores the user may see (see the module docstring)."""
    if "store.manage" not in access.permissions:  # only owners and managers see inactive ones
        return visible_stores(db, user_id, access)
    rows = db.execute(
        text(f"SELECT {_COLUMNS} FROM stores s ORDER BY s.created_at, s.name, s.id")  # noqa: S608
    ).all()
    return [store_json(row) for row in rows]


def get_store(db: Session, store_id: uuid.UUID, *, lock: bool = False) -> Any:
    row = db.execute(
        text(
            f"SELECT {_COLUMNS} FROM stores s WHERE s.id = :id"  # noqa: S608
            + (" FOR UPDATE" if lock else "")
        ),
        {"id": store_id},
    ).one_or_none()
    if row is None:
        raise NotFound("store", store_id)
    return row


def store(db: Session, store_id: uuid.UUID) -> dict[str, Any]:
    return store_json(get_store(db, store_id))


# ---- adding and editing -----------------------------------------------------------------------


def _check_unique(db: Session, store_id: uuid.UUID | None, name: str, whatsapp: str | None) -> None:
    """409 if another active store already has this name (any case) or number."""
    name_taken = db.execute(
        text(
            "SELECT EXISTS (SELECT 1 FROM stores WHERE status = 'active' "
            "AND lower(name) = lower(:name) AND id IS DISTINCT FROM :id)"
        ),
        {"name": name, "id": store_id},
    ).scalar_one()
    if name_taken:
        raise ApiError(409, "store_name_in_use", "Another active store has this name")
    if whatsapp is None:
        return
    number_taken = db.execute(
        text(
            "SELECT EXISTS (SELECT 1 FROM stores WHERE status = 'active' "
            "AND whatsapp_e164 = :number AND id IS DISTINCT FROM :id)"
        ),
        {"number": whatsapp, "id": store_id},
    ).scalar_one()
    if number_taken:
        raise ApiError(409, "whatsapp_number_in_use", "Another active store has this number")


def create_store(db: Session, actor: Actor, name: str, whatsapp: str | None) -> dict[str, Any]:
    _lock_tenant(db, actor.tenant_id)
    _check_unique(db, None, name, whatsapp)
    store_id = uuid.uuid4()
    db.execute(
        text(
            "INSERT INTO stores (id, tenant_id, name, whatsapp_e164) "
            "VALUES (:id, :tenant_id, :name, :whatsapp)"
        ),
        {"id": store_id, "tenant_id": actor.tenant_id, "name": name, "whatsapp": whatsapp},
    )
    _record(db, actor, "store.created", store_id, {"name": name, "whatsapp_number": whatsapp})
    return store(db, store_id)


@dataclass(frozen=True)
class StoreChange:
    """The fields present in the request; ``None`` / ``False`` leaves a field as it is."""

    name: str | None = None
    set_whatsapp: bool = False  # true when the request names the number, even as null
    whatsapp: str | None = None
    status: Literal["active", "inactive"] | None = None
    confirm: bool = False


def affected_by_deactivation(db: Session, store_id: uuid.UUID) -> list[dict[str, Any]]:
    """Who would be left with no active store: active employees and pending invitations."""
    employees = db.execute(
        text(
            "SELECT u.id, u.name, u.roles FROM users u "
            "JOIN user_stores us ON us.user_id = u.id AND us.store_id = :store "
            "WHERE u.status = 'active' AND NOT u.all_stores AND NOT EXISTS ("
            "  SELECT 1 FROM user_stores other JOIN stores s ON s.id = other.store_id "
            "  WHERE other.user_id = u.id AND other.store_id <> :store AND s.status = 'active'"
            ") ORDER BY u.created_at, u.name, u.id"
        ),
        {"store": store_id},
    ).all()
    invitations = db.execute(
        text(
            "SELECT i.id, i.invitee_name, i.roles FROM invitations i "
            "WHERE i.status = 'pending' AND i.expires_at > now() AND NOT i.all_stores "
            "AND :store = ANY(i.store_ids) AND NOT EXISTS ("
            "  SELECT 1 FROM stores s WHERE s.id = ANY(i.store_ids) AND s.id <> :store "
            "  AND s.status = 'active'"
            ") ORDER BY i.created_at, i.id"
        ),
        {"store": store_id},
    ).all()
    return [
        {"kind": "employee", "id": str(row.id), "name": row.name, "roles": list(row.roles)}
        for row in employees
    ] + [
        {
            "kind": "invitation",
            "id": str(row.id),
            "name": row.invitee_name,
            "roles": list(row.roles),
        }
        for row in invitations
    ]


def update_store(
    db: Session, actor: Actor, store_id: uuid.UUID, change: StoreChange
) -> dict[str, Any]:
    _lock_tenant(db, actor.tenant_id)
    current = get_store(db, store_id, lock=True)
    name = change.name if change.name is not None else current.name
    whatsapp = change.whatsapp if change.set_whatsapp else current.whatsapp_e164
    status = change.status or current.status

    if status == "active":
        _check_unique(db, store_id, name, whatsapp)
    affected: list[dict[str, Any]] = []
    if current.status == "active" and status == "inactive":
        others = db.execute(
            text("SELECT count(*) FROM stores WHERE status = 'active' AND id <> :id"),
            {"id": store_id},
        ).scalar_one()
        if others == 0:
            raise ApiError(409, "last_active_store", "The business must keep an active store")
        affected = affected_by_deactivation(db, store_id)
        if affected and not change.confirm:
            raise ApiError(
                409,
                "confirmation_required",
                "Deactivating this store leaves these people without a store",
                extra={"affected": affected},
            )

    db.execute(
        text(
            "UPDATE stores SET name = :name, whatsapp_e164 = :whatsapp, status = :status, "
            "updated_at = now() WHERE id = :id"
        ),
        {"name": name, "whatsapp": whatsapp, "status": status, "id": store_id},
    )

    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    if name != current.name:
        before["name"], after["name"] = current.name, name
    if whatsapp != current.whatsapp_e164:
        before["whatsapp_number"], after["whatsapp_number"] = current.whatsapp_e164, whatsapp
    if after:
        _record(db, actor, "store.updated", store_id, {"before": before, "after": after})
    if status != current.status:
        if status == "inactive":
            _record(
                db,
                actor,
                "store.deactivated",
                store_id,
                {
                    "before": current.status,
                    "after": status,
                    "affected": [{"kind": a["kind"], "id": a["id"]} for a in affected],
                },
            )
        else:
            _record(
                db,
                actor,
                "store.reactivated",
                store_id,
                {"before": current.status, "after": status},
            )
    return store(db, store_id)


# ---- logos ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Logo:
    store_status: str
    storage_path: str | None


def logo(db: Session, store_id: uuid.UUID) -> Logo:
    row = db.execute(
        text(
            "SELECT s.status, f.storage_path FROM stores s "
            "LEFT JOIN files f ON f.id = s.logo_file_id WHERE s.id = :id"
        ),
        {"id": store_id},
    ).one_or_none()
    if row is None:
        raise NotFound("store", store_id)
    return Logo(store_status=row.status, storage_path=row.storage_path)


def _locked_logo(db: Session, store_id: uuid.UUID) -> Any:
    row = db.execute(
        text(
            "SELECT s.logo_file_id, f.storage_path FROM stores s "
            "LEFT JOIN files f ON f.id = s.logo_file_id WHERE s.id = :id FOR UPDATE OF s"
        ),
        {"id": store_id},
    ).one_or_none()
    if row is None:
        raise NotFound("store", store_id)
    return row


def set_logo(
    db: Session, actor: Actor, store_id: uuid.UUID, storage_path: str, size_bytes: int
) -> str | None:
    """Make an already stored file the store's logo; returns the replaced file's path."""
    current = _locked_logo(db, store_id)
    file_id = uuid.uuid4()
    db.execute(
        text(
            "INSERT INTO files (id, tenant_id, kind, storage_path, mime, size_bytes, "
            "created_by_user_id) VALUES (:id, :tenant_id, 'store_logo', :path, :mime, :size, "
            ":user_id)"
        ),
        {
            "id": file_id,
            "tenant_id": actor.tenant_id,
            "path": storage_path,
            "mime": LOGO_MIME,
            "size": size_bytes,
            "user_id": actor.user_id,
        },
    )
    _replace_logo(db, actor, store_id, current.logo_file_id, file_id)
    return current.storage_path  # type: ignore[no-any-return]


def remove_logo(db: Session, actor: Actor, store_id: uuid.UUID) -> str | None:
    """Remove the store's logo; returns the removed file's path (None if there was none)."""
    current = _locked_logo(db, store_id)
    if current.logo_file_id is None:
        return None
    _replace_logo(db, actor, store_id, current.logo_file_id, None)
    return current.storage_path  # type: ignore[no-any-return]


def _replace_logo(
    db: Session,
    actor: Actor,
    store_id: uuid.UUID,
    old: uuid.UUID | None,
    new: uuid.UUID | None,
) -> None:
    db.execute(
        text("UPDATE stores SET logo_file_id = :new, updated_at = now() WHERE id = :id"),
        {"new": new, "id": store_id},
    )
    if old is not None:
        db.execute(text("DELETE FROM files WHERE id = :id"), {"id": old})
    _record(
        db,
        actor,
        "store.updated",
        store_id,
        {
            "before": {"logo_file_id": str(old) if old else None},
            "after": {"logo_file_id": str(new) if new else None},
        },
    )
