"""Server-side sign-in sessions (research R4, data-model ``sessions``).

The browser holds only an opaque random token; the database stores its SHA-256 hash. The
``sessions`` table is not under row-level security, so every query here is narrowed either
by the token hash or by the id of the user (or operator) the session belongs to. Nothing
here lists or changes sessions by session id alone.

Timeouts: business users 30 days without activity and 90 days at most; operators 12 hours
and 7 days. ``last_seen_at`` is written at most once every five minutes per session, so an
active user does not cause a write on every request.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from flask import Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import Config
from app.core.security import hash_token, new_token

USER_IDLE = timedelta(days=30)
USER_ABSOLUTE = timedelta(days=90)
OPERATOR_IDLE = timedelta(hours=12)
OPERATOR_ABSOLUTE = timedelta(days=7)
TOUCH_INTERVAL = timedelta(minutes=5)

USER_COOKIE = "bos_session"
OPERATOR_COOKIE = "bos_ops_session"

MAX_USER_AGENT = 255

_COLUMNS = (
    "id, user_id, tenant_id, operator_id, created_at, last_seen_at, idle_expires_at, "
    "absolute_expires_at, user_agent, host(ip) AS ip"
)
_LIVE = "revoked_at IS NULL AND idle_expires_at > :now AND absolute_expires_at > :now"


@dataclass(frozen=True)
class SessionRecord:
    id: uuid.UUID
    user_id: uuid.UUID | None
    tenant_id: uuid.UUID | None
    operator_id: uuid.UUID | None
    created_at: datetime
    last_seen_at: datetime
    idle_expires_at: datetime
    absolute_expires_at: datetime
    user_agent: str
    ip: str | None

    @property
    def is_operator(self) -> bool:
        return self.operator_id is not None


def _record(row: Any) -> SessionRecord:
    return SessionRecord(
        id=row.id,
        user_id=row.user_id,
        tenant_id=row.tenant_id,
        operator_id=row.operator_id,
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        idle_expires_at=row.idle_expires_at,
        absolute_expires_at=row.absolute_expires_at,
        user_agent=row.user_agent,
        ip=row.ip,
    )


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(UTC)


def _idle(operator: bool) -> timedelta:
    return OPERATOR_IDLE if operator else USER_IDLE


def _create(
    db: Session,
    *,
    user_id: uuid.UUID | None,
    tenant_id: uuid.UUID | None,
    operator_id: uuid.UUID | None,
    user_agent: str,
    ip: str | None,
    now: datetime | None,
) -> tuple[str, SessionRecord]:
    operator = operator_id is not None
    at = _now(now)
    token, token_hash = new_token()
    row = db.execute(
        text(  # _COLUMNS is a constant; every value is a bound parameter
            "INSERT INTO sessions (id, user_id, tenant_id, operator_id, token_hash, created_at, "  # noqa: S608
            "last_seen_at, idle_expires_at, absolute_expires_at, user_agent, ip) "
            "VALUES (:id, :user_id, :tenant_id, :operator_id, :token_hash, :now, :now, :idle, "
            f":absolute, :user_agent, CAST(:ip AS inet)) RETURNING {_COLUMNS}"
        ),
        {
            "id": uuid.uuid4(),
            "user_id": user_id,
            "tenant_id": tenant_id,
            "operator_id": operator_id,
            "token_hash": token_hash,
            "now": at,
            "idle": at + _idle(operator),
            "absolute": at + (OPERATOR_ABSOLUTE if operator else USER_ABSOLUTE),
            "user_agent": (user_agent or "")[:MAX_USER_AGENT],
            "ip": ip,
        },
    ).one()
    return token, _record(row)


def create_user_session(
    db: Session,
    *,
    user_id: uuid.UUID,
    tenant_id: uuid.UUID,
    user_agent: str = "",
    ip: str | None = None,
    now: datetime | None = None,
) -> tuple[str, SessionRecord]:
    """Start a session for a business user. Returns the raw token (for the cookie, once)."""
    return _create(
        db,
        user_id=user_id,
        tenant_id=tenant_id,
        operator_id=None,
        user_agent=user_agent,
        ip=ip,
        now=now,
    )


def create_operator_session(
    db: Session,
    *,
    operator_id: uuid.UUID,
    user_agent: str = "",
    ip: str | None = None,
    now: datetime | None = None,
) -> tuple[str, SessionRecord]:
    """Start a session for a platform operator. Returns the raw token (for the cookie, once)."""
    return _create(
        db,
        user_id=None,
        tenant_id=None,
        operator_id=operator_id,
        user_agent=user_agent,
        ip=ip,
        now=now,
    )


def lookup(db: Session, token: str, *, now: datetime | None = None) -> SessionRecord | None:
    """The live session for a raw token, or None if unknown, revoked or expired.

    Slides the idle expiry, writing only when ``last_seen_at`` is over five minutes old.
    """
    if not token:
        return None
    at = _now(now)
    row = db.execute(
        text(f"SELECT {_COLUMNS} FROM sessions WHERE token_hash = :hash AND {_LIVE}"),  # noqa: S608
        {"hash": hash_token(token), "now": at},
    ).one_or_none()
    if row is None:
        return None
    record = _record(row)
    if at - record.last_seen_at <= TOUCH_INTERVAL:
        return record
    row = db.execute(
        text(
            "UPDATE sessions SET last_seen_at = :now, idle_expires_at = :idle "  # noqa: S608
            f"WHERE id = :id AND token_hash = :hash RETURNING {_COLUMNS}"
        ),
        {
            "id": record.id,
            "hash": hash_token(token),
            "now": at,
            "idle": at + _idle(record.is_operator),
        },
    ).one()
    return _record(row)


def revoke(
    db: Session,
    session_id: uuid.UUID,
    *,
    user_id: uuid.UUID | None = None,
    operator_id: uuid.UUID | None = None,
) -> bool:
    """End one session of the given user or operator. False if there was none to end."""
    if (user_id is None) == (operator_id is None):
        raise ValueError("give exactly one of user_id or operator_id")
    owner_column = "user_id" if user_id is not None else "operator_id"
    result = db.execute(
        text(
            f"UPDATE sessions SET revoked_at = :now WHERE id = :id AND {owner_column} = :owner "  # noqa: S608
            "AND revoked_at IS NULL RETURNING id"
        ),
        {"id": session_id, "owner": user_id or operator_id, "now": datetime.now(UTC)},
    )
    return result.first() is not None


def revoke_all_for_user(db: Session, user_id: uuid.UUID) -> int:
    """End every session of a user (deactivation, password reset). Returns how many."""
    rows = db.execute(
        text(
            "UPDATE sessions SET revoked_at = :now "
            "WHERE user_id = :user_id AND revoked_at IS NULL RETURNING id"
        ),
        {"user_id": user_id, "now": datetime.now(UTC)},
    ).all()
    return len(rows)


def revoke_others_for_user(db: Session, user_id: uuid.UUID, keep_session_id: uuid.UUID) -> int:
    """End every session of a user except the current one. Returns how many."""
    rows = db.execute(
        text(
            "UPDATE sessions SET revoked_at = :now "
            "WHERE user_id = :user_id AND id <> :keep AND revoked_at IS NULL RETURNING id"
        ),
        {"user_id": user_id, "keep": keep_session_id, "now": datetime.now(UTC)},
    ).all()
    return len(rows)


def list_for_user(
    db: Session, user_id: uuid.UUID, *, now: datetime | None = None
) -> list[SessionRecord]:
    """A user's live sessions ("your devices"), most recently used first."""
    rows = db.execute(
        text(
            f"SELECT {_COLUMNS} FROM sessions WHERE user_id = :user_id AND {_LIVE} "  # noqa: S608
            "ORDER BY last_seen_at DESC, created_at DESC"
        ),
        {"user_id": user_id, "now": _now(now)},
    ).all()
    return [_record(row) for row in rows]


# ---- cookies --------------------------------------------------------------------------------


def cookie_name(*, operator: bool) -> str:
    return OPERATOR_COOKIE if operator else USER_COOKIE


def set_session_cookie(response: Response, token: str, *, operator: bool, config: Config) -> None:
    lifetime = OPERATOR_ABSOLUTE if operator else USER_ABSOLUTE
    response.set_cookie(
        cookie_name(operator=operator),
        token,
        max_age=int(lifetime.total_seconds()),
        path="/",
        secure=config.cookie_secure,
        httponly=True,
        samesite="Lax",
    )


def clear_session_cookie(response: Response, *, operator: bool, config: Config) -> None:
    response.delete_cookie(
        cookie_name(operator=operator),
        path="/",
        secure=config.cookie_secure,
        httponly=True,
        samesite="Lax",
    )
