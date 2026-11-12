"""What platform operators do to businesses (FR-001, FR-002, FR-005 to FR-005c, research R24).

Operators work in operator context, which shows them the ``tenants`` table and the
``ops_business_overview()`` function and nothing inside a business. The functions here are
the only code that enters a business's own context from an operator transaction
(``enter_tenant_from_operator``): to set up the business, to issue its owner activation link
and to issue a password-reset link for an owner without email. Each of them records what the
operator did in that business's own history, where its owners can see it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core import audit
from app.core.tenancy import enter_tenant_from_operator
from app.errors import ApiError
from app.services import invitations
from app.services.accounts import issue_password_reset
from app.services.common import IssuedLink, NotFound, lookup_identifier


@dataclass(frozen=True)
class NewBusiness:
    business_name: str
    store_name: str
    edition: Literal["social", "commerce"]
    default_currency: Literal["USD", "LBP"]
    usd_lbp_rate: Decimal
    owner_name: str
    owner_phone: str | None
    owner_email: str | None


def business_overview(db: Session, tenant_id: uuid.UUID | None = None) -> list[dict[str, Any]]:
    """Account-level information only, through ``ops_business_overview()``."""
    rows = db.execute(
        text(
            "SELECT id, name, edition, status, is_demo, owners, pending_owner_contact, "
            "store_count, user_count, created_at FROM ops_business_overview() "
            "WHERE CAST(:id AS uuid) IS NULL OR id = CAST(:id AS uuid)"
        ),
        {"id": tenant_id},
    ).all()
    return [
        {
            "id": str(row.id),
            "name": row.name,
            "edition": row.edition,
            "status": row.status,
            "is_demo": row.is_demo,
            "owners": row.owners,
            "pending_owner_contact": row.pending_owner_contact,
            "store_count": row.store_count,
            "user_count": row.user_count,
            "created_at": row.created_at,
        }
        for row in rows
    ]


def create_business(
    db: Session, *, operator_id: uuid.UUID, new: NewBusiness, ip: str | None
) -> tuple[uuid.UUID, IssuedLink]:
    """The business (pending), its first store and the owner's activation link: one transaction.

    Raises 409 ``identifier_unavailable`` if the owner's phone or email already belongs to a
    BOS user (a user belongs to exactly one business).
    """
    for kind, value in (("phone", new.owner_phone), ("email", new.owner_email)):
        if value is not None and lookup_identifier(db, kind, value) is not None:
            raise ApiError(
                409,
                "identifier_unavailable",
                "The owner's phone number or email already belongs to a BOS user",
            )
    tenant_id = uuid.uuid4()
    db.execute(
        text(
            "INSERT INTO tenants (id, name, edition, status, default_currency, usd_lbp_rate, "
            "created_by_operator_id) VALUES (:id, :name, :edition, 'pending', :currency, :rate, "
            ":operator_id)"
        ),
        {
            "id": tenant_id,
            "name": new.business_name,
            "edition": new.edition,
            "currency": new.default_currency,
            "rate": new.usd_lbp_rate,
            "operator_id": operator_id,
        },
    )
    enter_tenant_from_operator(db, tenant_id)
    store_id = uuid.uuid4()
    db.execute(
        text("INSERT INTO stores (id, tenant_id, name) VALUES (:id, :tenant_id, :name)"),
        {"id": store_id, "tenant_id": tenant_id, "name": new.store_name},
    )
    invitation_id, link = invitations.insert_invitation(
        db,
        tenant_id=tenant_id,
        kind="owner_activation",
        invitee=invitations.Invitee(
            new.owner_name, new.owner_phone, new.owner_email, ["owner"], True, []
        ),
        created_by_operator_id=operator_id,
    )
    record = _recorder(db, tenant_id, operator_id, ip)
    record(
        "tenant.created",
        "tenant",
        tenant_id,
        {
            "name": new.business_name,
            "edition": new.edition,
            "default_currency": new.default_currency,
            "usd_lbp_rate": str(new.usd_lbp_rate),
        },
    )
    record("store.created", "store", store_id, {"name": new.store_name})
    record("invitation.created", "invitation", invitation_id, {"kind": "owner_activation"})
    return tenant_id, link


def reissue_owner_activation(
    db: Session, *, tenant_id: uuid.UUID, operator_id: uuid.UUID, ip: str | None
) -> IssuedLink | None:
    """A new owner activation link (the previous one stops working).

    ``None`` when there is nothing to reissue: the owner already activated. Raises
    ``NotFound`` for an unknown business.
    """
    status = db.execute(
        text("SELECT status FROM tenants WHERE id = :id FOR NO KEY UPDATE"), {"id": tenant_id}
    ).scalar_one_or_none()
    if status is None:
        raise NotFound("tenant", tenant_id)
    if status != "pending":
        return None
    enter_tenant_from_operator(db, tenant_id)
    latest = db.execute(
        text(
            "SELECT id FROM invitations WHERE kind = 'owner_activation' "
            "AND status IN ('pending', 'expired') ORDER BY created_at DESC LIMIT 1"
        )
    ).scalar_one_or_none()
    if latest is None:
        return None
    _, link = invitations.resend(
        db, tenant_id, latest, actor_type="operator", actor_id=operator_id, ip=ip
    )
    return link


def set_business_status(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    status: Literal["active", "suspended"],
    operator_id: uuid.UUID,
    ip: str | None,
) -> None:
    """Suspend or reactivate. A pending business can be neither (409 ``business_pending``)."""
    current = db.execute(
        text("SELECT status FROM tenants WHERE id = :id FOR NO KEY UPDATE"), {"id": tenant_id}
    ).scalar_one_or_none()
    if current is None:
        raise NotFound("tenant", tenant_id)
    if current == "pending":
        raise ApiError(
            409, "business_pending", "This business's owner has not activated their account yet"
        )
    if current == status:
        return
    db.execute(
        text("UPDATE tenants SET status = :status, updated_at = now() WHERE id = :id"),
        {"status": status, "id": tenant_id},
    )
    enter_tenant_from_operator(db, tenant_id)
    event = "tenant.suspended" if status == "suspended" else "tenant.reactivated"
    _recorder(db, tenant_id, operator_id, ip)(
        event, "tenant", tenant_id, {"from": current, "to": status}
    )


def issue_owner_password_reset(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    owner_user_id: uuid.UUID,
    operator_id: uuid.UUID,
    ip: str | None,
) -> IssuedLink:
    """A reset link for an active owner of this business who has no email (FR-009).

    Raises ``NotFound`` unless the user is an active owner of this business, and 409
    ``owner_has_email`` if they can use the email reset instead.
    """
    exists = db.execute(
        text("SELECT 1 FROM tenants WHERE id = :id"), {"id": tenant_id}
    ).scalar_one_or_none()
    if exists is None:
        raise NotFound("tenant", tenant_id)
    enter_tenant_from_operator(db, tenant_id)
    owner = db.execute(
        text("SELECT id, email, roles, status FROM users WHERE id = :id FOR UPDATE"),
        {"id": owner_user_id},
    ).one_or_none()
    if owner is None or owner.status != "active" or "owner" not in owner.roles:
        raise NotFound("user", owner_user_id)
    if owner.email is not None:
        raise ApiError(409, "owner_has_email", "This owner can reset their password by email")
    link = issue_password_reset(
        db, user_id=owner.id, tenant_id=tenant_id, issued_by_operator_id=operator_id
    )
    _recorder(db, tenant_id, operator_id, ip)(
        "auth.password_reset_issued", "user", owner.id, {"channel": "operator"}
    )
    return link


def _recorder(db: Session, tenant_id: uuid.UUID, operator_id: uuid.UUID, ip: str | None) -> Any:
    def record(event: str, target_type: str, target_id: uuid.UUID, data: dict[str, Any]) -> None:
        audit.record(
            db,
            tenant_id=tenant_id,
            actor_type="operator",
            actor_id=operator_id,
            event=event,
            target_type=target_type,
            target_id=target_id,
            data=data,
            ip=ip,
        )

    return record
