"""Sign-in, sign-out and passwords (FR-006 to FR-011, research R4, R6, R33).

Sign-in happens before any tenant is known: the identifier is looked up only through
``auth_lookup_identifier`` in a transaction with no tenant context, and only then does work
move into the user's own tenant. Every failure that is about the credentials (unknown
identifier, wrong password, inactive user, locked identifier) gets the same answer, and a
password is checked against a fixed dummy hash when there is no user, so neither the answer
nor its timing tells whether an account exists. Whether the business is suspended or not yet
active is said only after correct credentials.
"""

from __future__ import annotations

import functools
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from flask import current_app, render_template
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core import audit, sessions
from app.core.db import transaction
from app.core.identifiers import InvalidIdentifier, normalize_email, parse_identifier
from app.core.mailer import get_mailer
from app.core.rate_limit import RateLimiter
from app.core.security import (
    WeakPassword,
    hash_password,
    hash_token,
    new_token,
    password_needs_rehash,
    validate_password,
    verify_password,
)
from app.core.tenancy import enter_tenant, tenant_transaction
from app.errors import ApiError
from app.services.common import IssuedLink, lookup_identifier
from app.services.invitations import MAX_TOKEN_LENGTH, link_invalid
from app.services.me import build_me

log = logging.getLogger("bos.accounts")

RESET_SUBJECTS = {
    "en": "Reset your BOS password",
    "ar": "إعادة تعيين كلمة مرور BOS",
}


def invalid_credentials() -> ApiError:
    return ApiError(401, "invalid_credentials", "Invalid credentials")


def weak_password() -> ApiError:
    return ApiError(400, "weak_password", "Choose a stronger password")


def wrong_password() -> ApiError:
    return ApiError(400, "wrong_password", "The current password is not correct")


@functools.cache
def _dummy_hash() -> str:
    """Checked when there is no account, so a miss costs as much time as a wrong password."""
    return hash_password("bos-no-such-account-timing-equaliser")


def check_new_password(password: str) -> None:
    try:
        validate_password(password)
    except WeakPassword:
        raise weak_password() from None


# ---- business users ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SignedIn:
    session_token: str
    me: dict[str, Any]


def sign_in(
    engine: Engine, identifier: str, password: str, *, ip: str | None, user_agent: str
) -> SignedIn:
    limiter = RateLimiter.for_app(current_app)
    try:
        parsed = parse_identifier(identifier)
        kind: str | None = parsed.kind
        key = parsed.value
    except InvalidIdentifier:
        kind, key = None, identifier.strip().lower()  # answered exactly like an unknown account

    with transaction(engine) as db:
        blocked = limiter.sign_in_blocked(db, key, ip)
        owner = None if blocked or kind is None else lookup_identifier(db, kind, key)
    password_ok = verify_password(owner.password_hash if owner else _dummy_hash(), password)
    if blocked:
        # Not recorded again: the password was never really checked.
        log.info("sign-in refused: identifier temporarily blocked")
        raise invalid_credentials()

    credentials_ok = owner is not None and password_ok and owner.user_status == "active"
    with transaction(engine) as db:
        limiter.record_sign_in(db, key, ip, success=credentials_ok)
    if owner is None:
        audit.record_platform(engine, actor_type="anonymous", event="auth.sign_in_failed", ip=ip)
        raise invalid_credentials()
    if not credentials_ok:
        reason = "wrong_password" if not password_ok else "inactive_user"
        _record_failure(engine, owner.tenant_id, owner.user_id, reason, ip)
        raise invalid_credentials()
    if owner.tenant_status != "active":
        reason = f"business_{owner.tenant_status}"
        _record_failure(engine, owner.tenant_id, owner.user_id, reason, ip)
        if owner.tenant_status == "suspended":
            raise ApiError(403, "business_suspended", "This business is suspended")
        raise ApiError(403, "business_pending", "This business is not active yet")

    with tenant_transaction(engine, owner.tenant_id) as db:
        if password_needs_rehash(owner.password_hash):
            db.execute(
                text("UPDATE users SET password_hash = :hash WHERE id = :id"),
                {"hash": hash_password(password), "id": owner.user_id},
            )
        token, session = sessions.create_user_session(
            db, user_id=owner.user_id, tenant_id=owner.tenant_id, user_agent=user_agent, ip=ip
        )
        audit.record(
            db,
            tenant_id=owner.tenant_id,
            actor_type="user",
            actor_id=owner.user_id,
            event="auth.sign_in",
            target_type="user",
            target_id=owner.user_id,
            data={"session_id": str(session.id)},
            ip=ip,
        )
        me = build_me(db, owner.user_id, owner.tenant_id)
    return SignedIn(session_token=token, me=me)


def _record_failure(
    engine: Engine, tenant_id: uuid.UUID, user_id: uuid.UUID, reason: str, ip: str | None
) -> None:
    """A failed sign-in for a known user: that business's history, actor anonymous."""
    with tenant_transaction(engine, tenant_id) as db:
        audit.record(
            db,
            tenant_id=tenant_id,
            actor_type="anonymous",
            actor_id=None,
            event="auth.sign_in_failed",
            target_type="user",
            target_id=user_id,
            data={"reason": reason},
            ip=ip,
        )


def sign_out(engine: Engine, token: str | None, *, ip: str | None) -> None:
    """End the session a cookie names, if it is still live. Works for any business status."""
    if not token:
        return
    with transaction(engine) as db:
        record = sessions.lookup(db, token)
        if record is None or record.user_id is None or record.tenant_id is None:
            return
        sessions.revoke(db, record.id, user_id=record.user_id)
        enter_tenant(db, record.tenant_id)
        audit.record(
            db,
            tenant_id=record.tenant_id,
            actor_type="user",
            actor_id=record.user_id,
            event="auth.sign_out",
            target_type="session",
            target_id=record.id,
            ip=ip,
        )


# ---- operators --------------------------------------------------------------------------------


@dataclass(frozen=True)
class OperatorSignedIn:
    session_token: str
    operator: dict[str, str]


def operator_sign_in(
    engine: Engine, email: str, password: str, *, ip: str | None, user_agent: str
) -> OperatorSignedIn:
    from app import get_config

    limiter = RateLimiter.for_app(current_app)
    try:
        address: str | None = normalize_email(email)
    except InvalidIdentifier:
        address = None
    key = f"operator:{address or email.strip().lower()}"

    with transaction(engine) as db:
        blocked = limiter.sign_in_blocked(db, key, ip)
        row = None
        if not blocked and address is not None:
            row = db.execute(
                text(
                    "SELECT id, name, email, password_hash, is_active FROM operators "
                    "WHERE email = :email"
                ),
                {"email": address},
            ).one_or_none()
    password_ok = verify_password(row.password_hash if row else _dummy_hash(), password)
    if blocked:
        raise invalid_credentials()
    allowed = get_config(current_app).operator_emails
    success = row is not None and password_ok and row.is_active and row.email in allowed
    with transaction(engine) as db:
        limiter.record_sign_in(db, key, ip, success=success)
    if not success or row is None:
        audit.record_platform(
            engine, actor_type="anonymous", event="auth.sign_in_failed", data={"area": "ops"}, ip=ip
        )
        raise invalid_credentials()

    with transaction(engine) as db:
        if password_needs_rehash(row.password_hash):
            db.execute(
                text("UPDATE operators SET password_hash = :hash WHERE id = :id"),
                {"hash": hash_password(password), "id": row.id},
            )
        token, _ = sessions.create_operator_session(
            db, operator_id=row.id, user_agent=user_agent, ip=ip
        )
    audit.record_platform(
        engine, actor_type="operator", actor_id=row.id, event="operator.sign_in", ip=ip
    )
    return OperatorSignedIn(
        session_token=token,
        operator={"id": str(row.id), "name": row.name, "email": row.email},
    )


def operator_sign_out(engine: Engine, token: str | None) -> None:
    if not token:
        return
    with transaction(engine) as db:
        record = sessions.lookup(db, token)
        if record is not None and record.operator_id is not None:
            sessions.revoke(db, record.id, operator_id=record.operator_id)


# ---- passwords --------------------------------------------------------------------------------


def issue_password_reset(
    db: Session,
    *,
    user_id: uuid.UUID,
    tenant_id: uuid.UUID,
    issued_by_user_id: uuid.UUID | None = None,
    issued_by_operator_id: uuid.UUID | None = None,
) -> IssuedLink:
    """Store a single-use reset link (1-hour expiry) in the tenant's context.

    Any earlier unused link of the same user stops working (it is marked used). The caller
    writes the history entry.
    """
    db.execute(
        text("UPDATE password_resets SET used_at = now() WHERE user_id = :u AND used_at IS NULL"),
        {"u": user_id},
    )
    token, token_hash = new_token()
    expires_at = db.execute(
        text(
            "INSERT INTO password_resets (id, tenant_id, user_id, token_hash, issued_by_user_id, "
            "issued_by_operator_id) VALUES (:id, :tenant_id, :user_id, :hash, :by_user, "
            ":by_operator) RETURNING expires_at"
        ),
        {
            "id": uuid.uuid4(),
            "tenant_id": tenant_id,
            "user_id": user_id,
            "hash": token_hash,
            "by_user": issued_by_user_id,
            "by_operator": issued_by_operator_id,
        },
    ).scalar_one()
    return IssuedLink(token=token, expires_at=expires_at, page="reset")


def request_password_reset(engine: Engine, email: str, *, ip: str | None) -> None:
    """Email a reset link if an active user of an active business has this email.

    Says nothing either way. Limited to 3 requests per address per hour. The email is sent
    only after the reset row is committed.
    """
    try:
        address = normalize_email(email)
    except InvalidIdentifier:
        return
    limiter = RateLimiter.for_app(current_app)
    with transaction(engine) as db:
        if not limiter.take_reset_email(db, address, ip):
            log.info("password reset email refused: limit reached")
            return
        owner = lookup_identifier(db, "email", address)
    if owner is None or owner.user_status != "active" or owner.tenant_status != "active":
        return

    with tenant_transaction(engine, owner.tenant_id) as db:
        link = issue_password_reset(db, user_id=owner.user_id, tenant_id=owner.tenant_id)
        user = db.execute(
            text("SELECT name, locale FROM users WHERE id = :id"), {"id": owner.user_id}
        ).one()
        audit.record(
            db,
            tenant_id=owner.tenant_id,
            actor_type="anonymous",
            actor_id=None,
            event="auth.password_reset_issued",
            target_type="user",
            target_id=owner.user_id,
            data={"channel": "email"},
            ip=ip,
        )
    # Committed: now the email may go out.
    locale = user.locale if user.locale in RESET_SUBJECTS else "en"
    body = render_template(
        f"email/password_reset.{locale}.txt", name=user.name, link=link.url, minutes=60
    )
    get_mailer(current_app).send(
        address, RESET_SUBJECTS[locale], body, tenant_id=owner.tenant_id, purpose="password_reset"
    )


def complete_password_reset(
    engine: Engine, token: object, new_password: object, *, ip: str | None
) -> None:
    """Set a new password with a reset link; every session of the user ends."""
    if not isinstance(token, str) or not 1 <= len(token) <= MAX_TOKEN_LENGTH:
        raise link_invalid()
    with transaction(engine) as db:
        found = db.execute(
            text("SELECT tenant_id, row_id FROM auth_lookup_token('password_reset', :hash)"),
            {"hash": hash_token(token)},
        ).one_or_none()
    if found is None:
        raise link_invalid()
    with tenant_transaction(engine, found.tenant_id) as db:
        reset = db.execute(
            text(
                "SELECT r.id, r.user_id, r.used_at IS NOT NULL AS used, "
                "r.expires_at <= now() AS expired, u.status AS user_status "
                "FROM password_resets r JOIN users u ON u.id = r.user_id "
                "WHERE r.id = :id FOR UPDATE OF r"
            ),
            {"id": found.row_id},
        ).one()
        if reset.used or reset.expired or reset.user_status != "active":
            raise link_invalid()
        if not isinstance(new_password, str):
            raise weak_password()
        check_new_password(new_password)
        db.execute(
            text("UPDATE users SET password_hash = :hash, updated_at = now() WHERE id = :id"),
            {"hash": hash_password(new_password), "id": reset.user_id},
        )
        db.execute(
            text("UPDATE password_resets SET used_at = now() WHERE id = :id"), {"id": reset.id}
        )
        ended = sessions.revoke_all_for_user(db, reset.user_id)
        audit.record(
            db,
            tenant_id=found.tenant_id,
            actor_type="user",
            actor_id=reset.user_id,
            event="auth.password_changed",
            target_type="user",
            target_id=reset.user_id,
            data={"via": "reset_link", "sessions_ended": ended},
            ip=ip,
        )


def change_password(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    current: object,
    new: object,
    ip: str | None,
) -> None:
    """Change one's own password (request transaction); every other session ends."""
    check_current_password(db, user_id, current)
    if not isinstance(new, str):
        raise weak_password()
    check_new_password(new)
    db.execute(
        text("UPDATE users SET password_hash = :hash, updated_at = now() WHERE id = :id"),
        {"hash": hash_password(new), "id": user_id},
    )
    ended = sessions.revoke_others_for_user(db, user_id, session_id)
    audit.record(
        db,
        tenant_id=tenant_id,
        actor_type="user",
        actor_id=user_id,
        event="auth.password_changed",
        target_type="user",
        target_id=user_id,
        data={"via": "self", "sessions_ended": ended},
        ip=ip,
    )


def check_current_password(db: Session, user_id: uuid.UUID, current: object) -> None:
    stored = db.execute(
        text("SELECT password_hash FROM users WHERE id = :id"), {"id": user_id}
    ).scalar_one()
    if not isinstance(current, str) or not verify_password(stored, current):
        raise wrong_password()
