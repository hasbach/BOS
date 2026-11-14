"""Append-only history (FR-032 to FR-034, constitution Principle VI).

Entries are written in the same transaction as the change they describe, so there is never
a change without its history. Refusals are written in their own transaction, because the
refused request is rolled back. The database rejects any update or delete of an entry.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from typing import Any, Literal

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.db import transaction
from app.core.tenancy import tenant_transaction

ActorType = Literal["user", "operator", "system", "anonymous"]

# Must equal the list in specs/001-platform-foundation/data-model.md (a test checks this).
EVENTS: frozenset[str] = frozenset(
    {
        "auth.sign_in",
        "auth.sign_in_failed",
        "auth.sign_out",
        "auth.session_revoked",
        "auth.password_changed",
        "auth.password_reset_issued",
        "auth.identifier_changed",
        "tenant.created",
        "tenant.suspended",
        "tenant.reactivated",
        "tenant.settings_changed",
        "invitation.created",
        "invitation.accepted",
        "invitation.revoked",
        "invitation.resent",
        "invitation.code_sent",
        "invitation.code_failed",
        "user.roles_changed",
        "user.stores_changed",
        "user.deactivated",
        "user.reactivated",
        "store.created",
        "store.updated",
        "store.deactivated",
        "store.reactivated",
        "access.denied_permission",
        "access.denied_tenant",
        "access.denied_store",
        "email.sent",
        "email.failed",
        "operator.sign_in",
        "maintenance.run",
    }
)

_FORBIDDEN_KEY_PARTS = ("password", "token", "link", "secret")

_INSERT = text(
    "INSERT INTO audit_entries "
    "(id, tenant_id, actor_type, actor_id, event, target_type, target_id, data, ip) "
    "VALUES (:id, :tenant_id, :actor_type, :actor_id, :event, :target_type, :target_id, "
    "CAST(:data AS jsonb), CAST(:ip AS inet))"
)
_PLATFORM = text(
    "SELECT audit_platform_event("
    ":actor_type, :actor_id, :event, CAST(:data AS jsonb), CAST(:ip AS inet))"
)


MASK = "••"


def phone_hint(phone: str | None) -> str | None:
    """A phone number as history may hold it: only its last two digits ("••56")."""
    if phone is None:
        return None
    return MASK + phone[-2:]


def email_hint(email: str | None) -> str | None:
    """An email address as history may hold it: only its domain ("••@example.com")."""
    if email is None:
        return None
    return MASK + "@" + email.rpartition("@")[2]


def _check_event(event: str) -> None:
    if event not in EVENTS:
        raise ValueError(f"unknown audit event: {event}")


def _check_no_secrets(data: Any, path: str = "data") -> None:
    """History is readable by owners and kept forever: no passwords, tokens or links in it."""
    if isinstance(data, Mapping):
        for key, value in data.items():
            if any(part in str(key).lower() for part in _FORBIDDEN_KEY_PARTS):
                raise ValueError(f"{path}.{key} must not be stored in audit history")
            _check_no_secrets(value, f"{path}.{key}")
    elif isinstance(data, list | tuple):
        for index, value in enumerate(data):
            _check_no_secrets(value, f"{path}[{index}]")


def _serialise(data: Mapping[str, Any] | None) -> str:
    payload = dict(data or {})
    _check_no_secrets(payload)
    return json.dumps(payload, default=str, ensure_ascii=False)


def record(
    session: Session,
    *,
    tenant_id: uuid.UUID,
    actor_type: ActorType,
    actor_id: uuid.UUID | None,
    event: str,
    target_type: str | None = None,
    target_id: uuid.UUID | None = None,
    data: Mapping[str, Any] | None = None,
    ip: str | None = None,
) -> uuid.UUID:
    """Add an entry to a tenant's history inside the current transaction."""
    _check_event(event)
    entry_id = uuid.uuid4()
    session.execute(
        _INSERT,
        {
            "id": entry_id,
            "tenant_id": tenant_id,
            "actor_type": actor_type,
            "actor_id": actor_id,
            "event": event,
            "target_type": target_type,
            "target_id": target_id,
            "data": _serialise(data),
            "ip": ip,
        },
    )
    return entry_id


def record_denied(
    engine: Engine,
    *,
    tenant_id: uuid.UUID,
    actor_id: uuid.UUID | None,
    event: Literal["access.denied_permission", "access.denied_tenant", "access.denied_store"],
    data: Mapping[str, Any] | None = None,
    ip: str | None = None,
    target_type: str | None = None,
    target_id: uuid.UUID | None = None,
) -> uuid.UUID:
    """Record a refused request in its own transaction, so it survives the refusal's rollback."""
    with tenant_transaction(engine, tenant_id) as session:
        return record(
            session,
            tenant_id=tenant_id,
            actor_type="user",
            actor_id=actor_id,
            event=event,
            target_type=target_type,
            target_id=target_id,
            data=data,
            ip=ip,
        )


def record_platform(
    engine: Engine,
    *,
    actor_type: ActorType,
    event: str,
    actor_id: uuid.UUID | None = None,
    data: Mapping[str, Any] | None = None,
    ip: str | None = None,
) -> uuid.UUID:
    """Record an event that belongs to no tenant (not readable through the product)."""
    _check_event(event)
    with transaction(engine) as session:
        entry_id = session.execute(
            _PLATFORM,
            {
                "actor_type": actor_type,
                "actor_id": actor_id,
                "event": event,
                "data": _serialise(data),
                "ip": ip,
            },
        ).scalar_one()
    assert isinstance(entry_id, uuid.UUID)
    return entry_id
