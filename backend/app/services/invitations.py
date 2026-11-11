"""Invitations and owner activation links (FR-005a, FR-012 to FR-015, research R7, R22, R25).

One mechanism for both: an invitation row holds everything the inviter entered, and a link
whose token is shown once (only its SHA-256 hash is stored). The user row is created only
when the link is accepted, so an unaccepted invitation never reserves an identifier.

Status: ``pending`` -> ``accepted`` | ``revoked`` | ``expired``. A pending invitation past its
expiry is marked ``expired`` the moment anything looks at it ("lazy expiry"), as well as by
the maintenance command.

Links arrive before any tenant is known: ``auth_lookup_token`` gives the tenant and row id
of a token hash, and everything after that happens inside that tenant's own context.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import audit, sessions
from app.core.audit import ActorType
from app.core.db import transaction
from app.core.permissions import Role
from app.core.security import WeakPassword, hash_password, hash_token, new_token, validate_password
from app.core.tenancy import tenant_transaction
from app.errors import ApiError
from app.services.common import IssuedLink, NotFound, lookup_identifier
from app.services.me import build_me

MAX_TOKEN_LENGTH = 200
MANAGEMENT_ROLES = frozenset({Role.OWNER.value, Role.MANAGER.value})

Kind = Literal["owner_activation", "employee"]

_COLUMNS = (
    "id, tenant_id, kind, invitee_name, invitee_phone_e164, invitee_email, roles, all_stores, "
    "store_ids, status, expires_at, expires_at <= now() AS past_expiry, created_by_user_id, "
    "created_by_operator_id"
)


def link_invalid() -> ApiError:
    return ApiError(410, "link_invalid", "This link is no longer valid")


def link_already_used() -> ApiError:
    return ApiError(410, "link_already_used", "This link was already used")


def identifier_unavailable() -> ApiError:
    return ApiError(
        409,
        "identifier_unavailable",
        "This phone number or email cannot be used; ask to be invited with a different one",
    )


# ---- creating ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Invitee:
    name: str
    phone: str | None
    email: str | None
    roles: Sequence[str]
    all_stores: bool
    store_ids: Sequence[uuid.UUID]


def insert_invitation(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    kind: Kind,
    invitee: Invitee,
    created_by_user_id: uuid.UUID | None = None,
    created_by_operator_id: uuid.UUID | None = None,
) -> tuple[uuid.UUID, IssuedLink]:
    """Store a pending invitation (7-day expiry). The caller writes the history entry."""
    management = bool(MANAGEMENT_ROLES & set(invitee.roles))
    token, token_hash = new_token()
    invitation_id = uuid.uuid4()
    expires_at = db.execute(
        text(
            "INSERT INTO invitations (id, tenant_id, kind, invitee_name, invitee_phone_e164, "
            "invitee_email, roles, all_stores, store_ids, token_hash, created_by_user_id, "
            "created_by_operator_id) VALUES (:id, :tenant_id, :kind, :name, :phone, :email, "
            ":roles, :all_stores, :store_ids, :token_hash, :by_user, :by_operator) "
            "RETURNING expires_at"
        ),
        {
            "id": invitation_id,
            "tenant_id": tenant_id,
            "kind": kind,
            "name": invitee.name,
            "phone": invitee.phone,
            "email": invitee.email,
            "roles": list(invitee.roles),
            # Owners and managers always have every store.
            "all_stores": invitee.all_stores or management,
            "store_ids": [] if invitee.all_stores or management else list(invitee.store_ids),
            "token_hash": token_hash,
            "by_user": created_by_user_id,
            "by_operator": created_by_operator_id,
        },
    ).scalar_one()
    return invitation_id, IssuedLink(token=token, expires_at=expires_at, page="activate")


def create_employee_invitation(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    created_by_user_id: uuid.UUID,
    name: str,
    phone: str | None,
    email: str | None,
    roles: Sequence[str],
    all_stores: bool,
    store_ids: Sequence[uuid.UUID],
    ip: str | None = None,
) -> tuple[uuid.UUID, IssuedLink]:
    """Invite a person to the caller's business (used by the staff API, User Story 2).

    ``phone`` and ``email`` must already be normalized. Runs in the tenant's context. An
    identifier used in *another* business is deliberately not checked here (FR-012a): the
    invitation is created normally and acceptance is refused neutrally.
    """
    fields: dict[str, str] = {}
    if not 1 <= len(name) <= 120:
        fields["name"] = "required" if not name else "too_long"
    if not roles or not set(roles) <= {role.value for role in Role}:
        fields["roles"] = "invalid"
    if phone is None and email is None:
        fields["identifier"] = "required"
    management = bool(MANAGEMENT_ROLES & set(roles))
    stores: list[uuid.UUID] = []
    if not (all_stores or management):
        stores = _active_stores(db, store_ids)
        if not stores:
            fields["stores"] = "required"
    if fields:
        raise ApiError(400, "validation_failed", "Invalid invitation", fields=fields)
    if _already_member(db, phone, email):
        raise ApiError(
            409, "already_member", "This person already belongs to or is invited to this business"
        )
    invitation_id, link = insert_invitation(
        db,
        tenant_id=tenant_id,
        kind="employee",
        invitee=Invitee(name, phone, email, list(roles), all_stores, stores),
        created_by_user_id=created_by_user_id,
    )
    audit.record(
        db,
        tenant_id=tenant_id,
        actor_type="user",
        actor_id=created_by_user_id,
        event="invitation.created",
        target_type="invitation",
        target_id=invitation_id,
        data={"kind": "employee", "name": name, "roles": list(roles)},
        ip=ip,
    )
    return invitation_id, link


def _active_stores(db: Session, store_ids: Sequence[uuid.UUID]) -> list[uuid.UUID]:
    """The given stores that exist in this business and are active (others are dropped)."""
    if not store_ids:
        return []
    found = set(
        db.execute(
            text("SELECT id FROM stores WHERE id = ANY(:ids) AND status = 'active'"),
            {"ids": list(store_ids)},
        ).scalars()
    )
    return [store_id for store_id in dict.fromkeys(store_ids) if store_id in found]


def _already_member(db: Session, phone: str | None, email: str | None) -> bool:
    """A user, or a live pending invitation, of this business has the phone or email."""
    params = {"phone": phone, "email": email}
    match_invitation = (
        "((CAST(:phone AS text) IS NOT NULL AND invitee_phone_e164 = :phone) "
        "OR (CAST(:email AS text) IS NOT NULL AND invitee_email = :email))"
    )
    db.execute(
        text(  # lazy expiry, so an invitation that has run out does not block a new one
            "UPDATE invitations SET status = 'expired' "  # noqa: S608
            f"WHERE status = 'pending' AND expires_at <= now() AND {match_invitation}"
        ),
        params,
    )
    found = db.execute(
        text(
            "SELECT EXISTS (SELECT 1 FROM users WHERE "  # noqa: S608
            "(CAST(:phone AS text) IS NOT NULL AND phone_e164 = :phone) "
            "OR (CAST(:email AS text) IS NOT NULL AND email = :email)) "
            "OR EXISTS (SELECT 1 FROM invitations WHERE status = 'pending' "
            f"AND {match_invitation})"
        ),
        params,
    ).scalar_one()
    return bool(found)


# ---- resend and revoke ------------------------------------------------------------------------


def _locked(db: Session, invitation_id: uuid.UUID) -> Any:
    row = db.execute(
        text(f"SELECT {_COLUMNS} FROM invitations WHERE id = :id FOR UPDATE"),  # noqa: S608
        {"id": invitation_id},
    ).one_or_none()
    if row is None:
        raise NotFound("invitation", invitation_id)
    return row


def _expire_if_due(db: Session, row: Any) -> str:
    """The invitation's real status, marking it ``expired`` if it ran out."""
    if row.status == "pending" and row.past_expiry:
        db.execute(text("UPDATE invitations SET status = 'expired' WHERE id = :id"), {"id": row.id})
        return "expired"
    return str(row.status)


def _invitation_closed() -> ApiError:
    return ApiError(409, "invitation_closed", "This invitation was already accepted or revoked")


def resend(
    db: Session,
    tenant_id: uuid.UUID,
    invitation_id: uuid.UUID,
    *,
    actor_type: ActorType,
    actor_id: uuid.UUID,
    ip: str | None = None,
) -> tuple[uuid.UUID, IssuedLink]:
    """Issue a new link for a pending or expired invitation; the old link stops working.

    Raises ``NotFound`` or 409 ``invitation_closed`` (accepted or revoked).
    """
    old = _locked(db, invitation_id)
    status = _expire_if_due(db, old)
    if status not in ("pending", "expired"):
        raise _invitation_closed()
    if status == "pending":
        db.execute(text("UPDATE invitations SET status = 'revoked' WHERE id = :id"), {"id": old.id})
    new_id, link = insert_invitation(
        db,
        tenant_id=tenant_id,
        kind=old.kind,
        invitee=Invitee(
            old.invitee_name,
            old.invitee_phone_e164,
            old.invitee_email,
            list(old.roles),
            old.all_stores,
            list(old.store_ids),
        ),
        created_by_user_id=actor_id if actor_type == "user" else None,
        created_by_operator_id=actor_id if actor_type == "operator" else None,
    )
    audit.record(
        db,
        tenant_id=tenant_id,
        actor_type=actor_type,
        actor_id=actor_id,
        event="invitation.resent",
        target_type="invitation",
        target_id=new_id,
        data={"kind": old.kind, "previous_invitation_id": str(old.id)},
        ip=ip,
    )
    return new_id, link


def revoke(
    db: Session,
    tenant_id: uuid.UUID,
    invitation_id: uuid.UUID,
    *,
    actor_type: ActorType,
    actor_id: uuid.UUID,
    ip: str | None = None,
) -> None:
    """Revoke a pending invitation. Raises ``NotFound`` or 409 ``invitation_closed``."""
    row = _locked(db, invitation_id)
    if _expire_if_due(db, row) != "pending":
        raise ApiError(
            409, "invitation_closed", "This invitation was already accepted, revoked or expired"
        )
    db.execute(text("UPDATE invitations SET status = 'revoked' WHERE id = :id"), {"id": row.id})
    audit.record(
        db,
        tenant_id=tenant_id,
        actor_type=actor_type,
        actor_id=actor_id,
        event="invitation.revoked",
        target_type="invitation",
        target_id=row.id,
        data={"kind": row.kind},
        ip=ip,
    )


# ---- preview and accept (public: the link is the only credential) ------------------------------


def _find_token(engine: Engine, token: object) -> tuple[uuid.UUID, uuid.UUID] | None:
    """(tenant id, invitation id) for a link token, through ``auth_lookup_token``."""
    if not isinstance(token, str) or not 1 <= len(token) <= MAX_TOKEN_LENGTH:
        return None
    with transaction(engine) as db:
        row = db.execute(
            text("SELECT tenant_id, row_id FROM auth_lookup_token('invitation', :hash)"),
            {"hash": hash_token(token)},
        ).one_or_none()
    return None if row is None else (row.tenant_id, row.row_id)


def _refusal(status: str) -> ApiError | None:
    if status == "accepted":
        return link_already_used()
    if status != "pending":
        return link_invalid()
    return None


def preview(engine: Engine, token: object) -> dict[str, Any]:
    """What the link offers: only what the inviter entered, plus the business name."""
    found = _find_token(engine, token)
    if found is None:
        raise link_invalid()
    tenant_id, invitation_id = found
    with tenant_transaction(engine, tenant_id) as db:
        row = db.execute(
            text(f"SELECT {_COLUMNS} FROM invitations WHERE id = :id"),  # noqa: S608
            {"id": invitation_id},
        ).one()
        refusal = _refusal(_expire_if_due(db, row))
        business_name = db.execute(
            text("SELECT name FROM tenants WHERE id = :id"), {"id": tenant_id}
        ).scalar_one()
    if refusal is not None:
        raise refusal  # raised after the block, so a lazy expiry is saved
    return {
        "kind": row.kind,
        "business_name": business_name,
        "invitee_name": row.invitee_name,
        "roles": list(row.roles),
        "expires_at": row.expires_at,
    }


@dataclass(frozen=True)
class Accepted:
    session_token: str
    me: dict[str, Any]


def accept(
    engine: Engine,
    token: object,
    *,
    password: str,
    locale: str,
    ip: str | None,
    user_agent: str,
) -> Accepted:
    """Create the invited user, sign them in, and (for an owner) activate the business.

    One transaction, holding a lock on the invitation row, so a second submission (or a
    simultaneous revoke) waits and then finds the invitation no longer pending.
    """
    found = _find_token(engine, token)
    if found is None:
        raise link_invalid()
    tenant_id, invitation_id = found
    refusal: ApiError | None = None
    with tenant_transaction(engine, tenant_id) as db:
        row = _locked(db, invitation_id)
        refusal = _refusal(_expire_if_due(db, row))
        if refusal is None:
            return _create_user(db, row, password=password, locale=locale, ip=ip, ua=user_agent)
    raise refusal  # after the block, so a lazy expiry is saved


def _create_user(
    db: Session, invitation: Any, *, password: str, locale: str, ip: str | None, ua: str
) -> Accepted:
    tenant_id: uuid.UUID = invitation.tenant_id
    tenant_status = db.execute(
        text("SELECT status FROM tenants WHERE id = :id FOR UPDATE"), {"id": tenant_id}
    ).scalar_one()
    if tenant_status == "suspended":
        raise ApiError(403, "business_suspended", "This business is suspended")
    try:
        validate_password(password)
    except WeakPassword:
        raise ApiError(400, "weak_password", "Choose a stronger password") from None

    management = bool(MANAGEMENT_ROLES & set(invitation.roles))
    all_stores = invitation.all_stores or management
    stores: list[uuid.UUID] = []
    if not all_stores:
        stores = _active_stores(db, list(invitation.store_ids))
        if not stores:
            # Every store the person was invited to is gone: the inviter must invite again.
            raise link_invalid()

    for kind, value in (
        ("phone", invitation.invitee_phone_e164),
        ("email", invitation.invitee_email),
    ):
        if value is not None and lookup_identifier(db, kind, value) is not None:
            raise identifier_unavailable()

    user_id = uuid.uuid4()
    try:
        with db.begin_nested():
            db.execute(
                text(
                    "INSERT INTO users (id, tenant_id, name, phone_e164, email, password_hash, "
                    "locale, roles, all_stores) VALUES (:id, :tenant_id, :name, :phone, :email, "
                    ":hash, :locale, :roles, :all_stores)"
                ),
                {
                    "id": user_id,
                    "tenant_id": tenant_id,
                    "name": invitation.invitee_name,
                    "phone": invitation.invitee_phone_e164,
                    "email": invitation.invitee_email,
                    "hash": hash_password(password),
                    "locale": locale,
                    "roles": list(invitation.roles),
                    "all_stores": all_stores,
                },
            )
    except IntegrityError as exc:
        # Someone took the identifier between the check and the insert.
        if getattr(exc.orig, "sqlstate", None) == "23505":
            raise identifier_unavailable() from None
        raise
    for store_id in stores:
        db.execute(
            text(
                "INSERT INTO user_stores (tenant_id, user_id, store_id) "
                "VALUES (:tenant_id, :user_id, :store_id)"
            ),
            {"tenant_id": tenant_id, "user_id": user_id, "store_id": store_id},
        )
    db.execute(
        text(
            "UPDATE invitations SET status = 'accepted', accepted_user_id = :user_id, "
            "accepted_at = now() WHERE id = :id"
        ),
        {"user_id": user_id, "id": invitation.id},
    )
    if invitation.kind == "owner_activation" and tenant_status == "pending":
        db.execute(
            text("UPDATE tenants SET status = 'active', updated_at = now() WHERE id = :id"),
            {"id": tenant_id},
        )
    audit.record(
        db,
        tenant_id=tenant_id,
        actor_type="user",
        actor_id=user_id,
        event="invitation.accepted",
        target_type="invitation",
        target_id=invitation.id,
        data={"kind": invitation.kind, "roles": list(invitation.roles)},
        ip=ip,
    )
    session_token, session = sessions.create_user_session(
        db, user_id=user_id, tenant_id=tenant_id, user_agent=ua, ip=ip
    )
    audit.record(
        db,
        tenant_id=tenant_id,
        actor_type="user",
        actor_id=user_id,
        event="auth.sign_in",
        target_type="user",
        target_id=user_id,
        data={"via": "invitation", "session_id": str(session.id)},
        ip=ip,
    )
    return Accepted(session_token=session_token, me=build_me(db, user_id, tenant_id))
