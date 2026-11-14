"""Employees and invitations of one business (User Story 2: FR-012 to FR-019a).

Everything runs in the request's tenant transaction, so row-level security limits every
query to the caller's business; a record of another business is simply "not found".

Rules the route's declared permission (``staff.view`` / ``staff.manage``) cannot express are
checked here and reported with ``Refused``, which the API turns into a recorded 403:

* nobody changes their own roles, stores or status, or issues a reset link for themselves
  (``cannot_modify_self``);
* only a holder of ``staff.manage_owners`` (an owner) may invite an owner, grant or remove
  ``owner``, or change, deactivate or reset an owner, or resend or revoke an invitation that
  carries ``owner`` (``forbidden``);
* the business always keeps at least one active owner (409 ``last_owner``), checked while
  holding a lock on the tenant row, so two owners removing each other at the same moment
  cannot both succeed. The lock is ``FOR NO KEY UPDATE``: the history insert's foreign-key
  check takes ``FOR KEY SHARE`` on the same row, which that mode does not block.

Owners and managers always have every store. A change takes effect on the employee's next
request (the request lifecycle re-reads the user each time); deactivation also ends all of
their sessions at once.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core import audit, sessions
from app.core.permissions import Role
from app.errors import ApiError
from app.services import accounts, invitations
from app.services.common import IssuedLink, NotFound
from app.services.invitations import MANAGEMENT_ROLES

MANAGE_OWNERS = "staff.manage_owners"
OWNER = Role.OWNER.value


@dataclass(frozen=True)
class Actor:
    """The signed-in owner or manager acting on their business's staff."""

    user_id: uuid.UUID
    tenant_id: uuid.UUID
    manages_owners: bool  # holds staff.manage_owners
    ip: str | None = None


class Refused(Exception):
    """A rule refuses the action on a visible record: 403 ``code``, recorded."""

    def __init__(
        self,
        code: Literal["forbidden", "cannot_modify_self"],
        *,
        target_type: str | None = None,
        target_id: uuid.UUID | None = None,
        permission: str | None = None,
    ) -> None:
        super().__init__(code)
        self.code: Literal["forbidden", "cannot_modify_self"] = code
        self.target_type = target_type
        self.target_id = target_id
        self.permission = permission


def _owner_rule(actor: Actor, target_type: str, target_id: uuid.UUID) -> None:
    if not actor.manages_owners:
        raise Refused(
            "forbidden", target_type=target_type, target_id=target_id, permission=MANAGE_OWNERS
        )


def canonical_roles(roles: Sequence[str]) -> list[str]:
    """Known roles, each once, in the fixed role order."""
    held = set(roles)
    return [role.value for role in Role if role.value in held]


# ---- reading ----------------------------------------------------------------------------------

_MEMBER_COLUMNS = "id, name, phone_e164, email, roles, all_stores, status"
_INVITATION_COLUMNS = (
    "id, invitee_name, invitee_phone_e164, invitee_email, roles, all_stores, store_ids, status, "
    "expires_at"
)


def _member_json(row: Any, store_ids: Sequence[uuid.UUID]) -> dict[str, Any]:
    return {
        "user_id": str(row.id),
        "name": row.name,
        "phone": row.phone_e164,
        "email": row.email,
        "roles": list(row.roles),
        "all_stores": row.all_stores,
        "store_ids": [] if row.all_stores else [str(s) for s in store_ids],
        "status": row.status,
    }


def _invitation_json(row: Any) -> dict[str, Any]:
    return {
        "invitation_id": str(row.id),
        "name": row.invitee_name,
        "phone": row.invitee_phone_e164,
        "email": row.invitee_email,
        "roles": list(row.roles),
        "all_stores": row.all_stores,
        "store_ids": [] if row.all_stores else [str(s) for s in row.store_ids],
        "status": row.status,
        "expires_at": row.expires_at,
    }


def _store_ids_of(db: Session, user_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        db.execute(
            text(
                "SELECT us.store_id FROM user_stores us JOIN stores s ON s.id = us.store_id "
                "WHERE us.user_id = :id ORDER BY s.created_at, s.name"
            ),
            {"id": user_id},
        ).scalars()
    )


def staff_list(db: Session) -> dict[str, Any]:
    """Every user of the business, and its employee invitations still pending or expired."""
    db.execute(  # lazy expiry, so the list tells the truth
        text(
            "UPDATE invitations SET status = 'expired' "
            "WHERE status = 'pending' AND expires_at <= now()"
        )
    )
    users = db.execute(
        text(f"SELECT {_MEMBER_COLUMNS} FROM users ORDER BY created_at, name, id")  # noqa: S608
    ).all()
    stores: dict[uuid.UUID, list[uuid.UUID]] = {}
    for user_id, store_id in db.execute(
        text(
            "SELECT us.user_id, us.store_id FROM user_stores us "
            "JOIN stores s ON s.id = us.store_id ORDER BY s.created_at, s.name"
        )
    ).all():
        stores.setdefault(user_id, []).append(store_id)
    pending = db.execute(
        text(
            f"SELECT {_INVITATION_COLUMNS} FROM invitations "  # noqa: S608
            "WHERE kind = 'employee' AND status IN ('pending', 'expired') "
            "ORDER BY created_at, id"
        )
    ).all()
    return {
        "members": [_member_json(row, stores.get(row.id, [])) for row in users],
        "invitations": [_invitation_json(row) for row in pending],
    }


def member(db: Session, user_id: uuid.UUID) -> dict[str, Any]:
    row = db.execute(
        text(f"SELECT {_MEMBER_COLUMNS} FROM users WHERE id = :id"),  # noqa: S608
        {"id": user_id},
    ).one_or_none()
    if row is None:
        raise NotFound("user", user_id)
    return _member_json(row, _store_ids_of(db, user_id))


def invitation(db: Session, invitation_id: uuid.UUID) -> dict[str, Any]:
    row = db.execute(
        text(f"SELECT {_INVITATION_COLUMNS} FROM invitations WHERE id = :id"),  # noqa: S608
        {"id": invitation_id},
    ).one_or_none()
    if row is None:
        raise NotFound("invitation", invitation_id)
    return _invitation_json(row)


# ---- invitations ------------------------------------------------------------------------------


@dataclass(frozen=True)
class NewInvitation:
    name: str
    phone: str | None  # normalized
    email: str | None  # normalized
    roles: list[str]
    all_stores: bool
    store_ids: list[uuid.UUID]


def invite(db: Session, actor: Actor, new: NewInvitation) -> tuple[uuid.UUID, IssuedLink]:
    """Invite a person. An identifier of another business is deliberately not reported."""
    if OWNER in new.roles and not actor.manages_owners:
        raise Refused("forbidden", permission=MANAGE_OWNERS)
    return invitations.create_employee_invitation(
        db,
        tenant_id=actor.tenant_id,
        created_by_user_id=actor.user_id,
        name=new.name,
        phone=new.phone,
        email=new.email,
        roles=canonical_roles(new.roles),
        all_stores=new.all_stores,
        store_ids=new.store_ids,
        ip=actor.ip,
    )


def _staff_invitation(db: Session, actor: Actor, invitation_id: uuid.UUID) -> None:
    """Lock an employee invitation of this business; refuse owner invitations to managers.

    Owner activation links belong to the operator, never to the staff screens.
    """
    row = db.execute(
        text("SELECT kind, roles FROM invitations WHERE id = :id FOR UPDATE"),
        {"id": invitation_id},
    ).one_or_none()
    if row is None or row.kind != "employee":
        raise NotFound("invitation", invitation_id)
    if OWNER in row.roles:
        _owner_rule(actor, "invitation", invitation_id)


def reissue_invitation_link(db: Session, actor: Actor, invitation_id: uuid.UUID) -> IssuedLink:
    """Idempotent repeat of an invitation: the same invitation with a fresh link."""
    _staff_invitation(db, actor, invitation_id)
    return invitations.reissue_link(
        db, actor.tenant_id, invitation_id, actor_type="user", actor_id=actor.user_id, ip=actor.ip
    )


def resend_invitation(
    db: Session, actor: Actor, invitation_id: uuid.UUID
) -> tuple[uuid.UUID, IssuedLink]:
    _staff_invitation(db, actor, invitation_id)
    return invitations.resend(
        db, actor.tenant_id, invitation_id, actor_type="user", actor_id=actor.user_id, ip=actor.ip
    )


def revoke_invitation(db: Session, actor: Actor, invitation_id: uuid.UUID) -> None:
    _staff_invitation(db, actor, invitation_id)
    invitations.revoke(
        db, actor.tenant_id, invitation_id, actor_type="user", actor_id=actor.user_id, ip=actor.ip
    )


# ---- changing an employee ---------------------------------------------------------------------


@dataclass(frozen=True)
class MemberChange:
    """The fields present in the request; ``None`` leaves a field as it is."""

    roles: list[str] | None = None
    all_stores: bool | None = None
    store_ids: list[uuid.UUID] | None = None
    status: Literal["active", "inactive"] | None = None


def require_member(db: Session, user_id: uuid.UUID) -> None:
    """NotFound unless this business has the user (row-level security hides all others).

    Routes call it before they look at the request body, so a made-up id and another
    business's id are answered, and recorded, the same way whatever the body says.
    """
    found = db.execute(text("SELECT 1 FROM users WHERE id = :id"), {"id": user_id}).first()
    if found is None:
        raise NotFound("user", user_id)


def _target(db: Session, actor: Actor, user_id: uuid.UUID) -> Any:
    """A user of this business other than the actor; owners only for owners."""
    row = db.execute(
        text(f"SELECT {_MEMBER_COLUMNS} FROM users WHERE id = :id"),  # noqa: S608
        {"id": user_id},
    ).one_or_none()
    if row is None:
        raise NotFound("user", user_id)
    if row.id == actor.user_id:
        raise Refused("cannot_modify_self", target_type="user", target_id=user_id)
    if OWNER in row.roles:
        _owner_rule(actor, "user", user_id)
    return row


def update_member(
    db: Session, actor: Actor, user_id: uuid.UUID, change: MemberChange
) -> dict[str, Any]:
    """Change an employee's roles, stores and/or status; returns the employee."""
    # Taken first, so everything below reads the staff as the last committed change left it.
    db.execute(
        text("SELECT id FROM tenants WHERE id = :id FOR NO KEY UPDATE"), {"id": actor.tenant_id}
    )
    current = _target(db, actor, user_id)

    roles = canonical_roles(change.roles) if change.roles is not None else list(current.roles)
    if OWNER in roles and OWNER not in current.roles:
        _owner_rule(actor, "user", user_id)
    status = change.status or current.status

    current_stores = _store_ids_of(db, user_id)
    all_stores, stores = _new_store_access(db, current, current_stores, roles, change)

    removes_an_owner = (
        current.status == "active"
        and OWNER in current.roles
        and (OWNER not in roles or status != "active")
    )
    if removes_an_owner and not _other_active_owner(db, user_id):
        raise ApiError(409, "last_owner", "The business must keep at least one active owner")

    db.execute(
        text(
            "UPDATE users SET roles = :roles, all_stores = :all_stores, status = :status, "
            "updated_at = now() WHERE id = :id"
        ),
        {"roles": roles, "all_stores": all_stores, "status": status, "id": user_id},
    )
    before_stores = [] if current.all_stores else current_stores
    stores_changed = (all_stores, stores) != (current.all_stores, before_stores)
    if stores_changed:
        db.execute(text("DELETE FROM user_stores WHERE user_id = :id"), {"id": user_id})
        for store_id in stores:
            db.execute(
                text(
                    "INSERT INTO user_stores (tenant_id, user_id, store_id) "
                    "VALUES (:tenant_id, :user_id, :store_id)"
                ),
                {"tenant_id": actor.tenant_id, "user_id": user_id, "store_id": store_id},
            )

    def record(event: str, data: dict[str, Any]) -> None:
        audit.record(
            db,
            tenant_id=actor.tenant_id,
            actor_type="user",
            actor_id=actor.user_id,
            event=event,
            target_type="user",
            target_id=user_id,
            data=data,
            ip=actor.ip,
        )

    if roles != list(current.roles):
        record("user.roles_changed", {"before": list(current.roles), "after": roles})
    if stores_changed:
        record(
            "user.stores_changed",
            {
                "before": {
                    "all_stores": current.all_stores,
                    "store_ids": [str(s) for s in before_stores],
                },
                "after": {"all_stores": all_stores, "store_ids": [str(s) for s in stores]},
            },
        )
    if status != current.status:
        if status == "inactive":
            ended = sessions.revoke_all_for_user(db, user_id)
            record(
                "user.deactivated",
                {"before": current.status, "after": status, "sessions_ended": ended},
            )
        else:
            record("user.reactivated", {"before": current.status, "after": status})
    return member(db, user_id)


def _new_store_access(
    db: Session,
    current: Any,
    current_stores: list[uuid.UUID],
    roles: list[str],
    change: MemberChange,
) -> tuple[bool, list[uuid.UUID]]:
    """(all_stores, store ids) after the change; 400 ``validation_failed`` on bad stores."""
    fields: dict[str, str] = {}
    given = invitations.checked_stores(db, change.store_ids or [], fields)
    if fields:
        raise ApiError(400, "validation_failed", "Some fields are not valid", fields=fields)
    if MANAGEMENT_ROLES & set(roles):
        return True, []  # owners and managers always have every store
    all_stores = current.all_stores if change.all_stores is None else change.all_stores
    if all_stores:
        return True, []
    stores = given if change.store_ids is not None else current_stores
    if not stores:
        raise ApiError(
            400, "validation_failed", "Some fields are not valid", fields={"store_ids": "required"}
        )
    return False, stores


def _other_active_owner(db: Session, user_id: uuid.UUID) -> bool:
    return bool(
        db.execute(
            text(
                "SELECT EXISTS (SELECT 1 FROM users WHERE id <> :id AND status = 'active' "
                "AND 'owner' = ANY(roles))"
            ),
            {"id": user_id},
        ).scalar_one()
    )


# ---- reset links ------------------------------------------------------------------------------


def issue_password_reset(db: Session, actor: Actor, user_id: uuid.UUID) -> IssuedLink:
    """A one-time reset link (1 hour) for an active employee; earlier unused links die."""
    target = _target(db, actor, user_id)
    if target.status != "active":
        raise ApiError(409, "user_inactive", "Reactivate this employee first")
    link = accounts.issue_password_reset(
        db, user_id=user_id, tenant_id=actor.tenant_id, issued_by_user_id=actor.user_id
    )
    audit.record(
        db,
        tenant_id=actor.tenant_id,
        actor_type="user",
        actor_id=actor.user_id,
        event="auth.password_reset_issued",
        target_type="user",
        target_id=user_id,
        data={"channel": "staff"},
        ip=actor.ip,
    )
    return link
