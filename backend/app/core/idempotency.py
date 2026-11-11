"""Idempotent creation (research R10 + R25, data-model ``idempotency_keys``, Principle II).

An endpoint that creates something wraps its work in ``idempotent``::

    @bp.post("/staff/invitations")
    @require("staff.manage")
    def invite() -> ResponseReturnValue:
        body = request.get_json()
        return idempotent(
            "invitation",
            create=lambda: _create_invitation(body),  # -> (invitation_id, response)
            replay=_reissue_invitation,  # (invitation_id) -> response
        )

* Without an ``Idempotency-Key`` header the request is not idempotent: ``create`` runs.
* The first request with a key runs ``create`` and, in the same request transaction, stores
  the key, the endpoint (scope), the actor, the actor's business, a hash of the request and
  a reference to what was created. Never the response: one-time links are not stored.
* A repeat with the same body does not run ``create``. ``replay`` is called with the id of
  the record the first request created and answers for it; where the first answer held a
  one-time link, ``replay`` issues a fresh one and revokes the earlier one.
* The same key with a different body (or a different URL) is refused with 409
  ``idempotency_conflict``.
* Keys are scoped by endpoint and actor; a business only ever sees its own keys (row-level
  security), operators only theirs. Keys older than 24 hours are ignored and later deleted by
  ``platform_maintenance()``.
* Two identical requests at the same moment cannot both create: ``create`` and the key
  insert run under a savepoint, and whichever request loses the race on the primary key (or
  on any unique constraint ``create`` hits first) rolls back its own work and replays the
  winner's record.

``create`` must do all its work in the request transaction (``request_db()``) and must not
have effects outside the database (such as sending an email) before the request commits,
because a losing duplicate's work is rolled back.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass

from flask import request
from flask.typing import ResponseReturnValue
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.request_context import OperatorPrincipal, current_principal, request_db
from app.errors import ApiError

HEADER = "Idempotency-Key"
MAX_KEY_LENGTH = 200

_LOOKUP = text(
    "SELECT request_hash, resource_type, resource_id, "
    "created_at > now() - interval '24 hours' AS live "
    "FROM idempotency_keys WHERE key = :key AND scope = :scope AND actor_id = :actor_id"
)
_DELETE_EXPIRED = text(
    "DELETE FROM idempotency_keys WHERE key = :key AND scope = :scope AND actor_id = :actor_id "
    "AND created_at <= now() - interval '24 hours'"
)
_INSERT = text(
    "INSERT INTO idempotency_keys "
    "(key, scope, actor_id, tenant_id, request_hash, resource_type, resource_id) "
    "VALUES (:key, :scope, :actor_id, :tenant_id, :request_hash, :resource_type, :resource_id)"
)

Create = Callable[[], tuple[uuid.UUID, ResponseReturnValue]]
Replay = Callable[[uuid.UUID], ResponseReturnValue]


@dataclass(frozen=True)
class _Key:
    key: str
    scope: str
    actor_id: uuid.UUID
    tenant_id: uuid.UUID | None

    def params(self) -> dict[str, object]:
        return {"key": self.key, "scope": self.scope, "actor_id": self.actor_id}


def idempotent(resource_type: str, *, create: Create, replay: Replay) -> ResponseReturnValue:
    """Run ``create`` once per ``Idempotency-Key``; answer repeats with ``replay``."""
    raw_key = request.headers.get(HEADER)
    if raw_key is None:
        _, response = create()
        return response
    if not 1 <= len(raw_key) <= MAX_KEY_LENGTH:
        raise ApiError(
            400,
            "invalid_idempotency_key",
            f"{HEADER} must be 1 to {MAX_KEY_LENGTH} characters",
        )

    db = request_db()
    key = _key_for(raw_key)
    fingerprint = request_hash()

    found = _lookup(db, key)
    if found is not None:
        return _repeat(found, fingerprint, resource_type, replay)
    # An expired key is ignored: forget it, so this request can take its place.
    db.execute(_DELETE_EXPIRED, key.params())

    try:
        with db.begin_nested():
            resource_id, response = create()
            db.execute(
                _INSERT,
                {
                    **key.params(),
                    "tenant_id": key.tenant_id,
                    "request_hash": fingerprint,
                    "resource_type": resource_type,
                    "resource_id": resource_id,
                },
            )
    except IntegrityError:
        # Either a duplicate of this very request committed first (on the key itself, or on
        # a unique constraint ``create`` ran into), or this is an unrelated conflict.
        found = _lookup(db, key)
        if found is None:
            raise
        return _repeat(found, fingerprint, resource_type, replay)
    return response


def request_hash() -> bytes:
    """SHA-256 of the method, the path and the request body (JSON canonicalised)."""
    raw = request.get_data(cache=True)
    canonical = raw
    if request.is_json and raw:
        try:
            canonical = json.dumps(
                json.loads(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
        except ValueError:
            canonical = raw
    digest = hashlib.sha256()
    for part in (request.method.encode(), request.path.encode(), canonical):
        digest.update(len(part).to_bytes(8, "big"))
        digest.update(part)
    return digest.digest()


@dataclass(frozen=True)
class _Found:
    request_hash: bytes
    resource_type: str
    resource_id: uuid.UUID


def _key_for(raw_key: str) -> _Key:
    principal = current_principal()
    if principal is None:
        raise RuntimeError("idempotent() needs a signed-in user or operator")
    scope = request.endpoint
    if not scope:
        raise RuntimeError("idempotent() must be called from a view")
    if isinstance(principal, OperatorPrincipal):
        return _Key(raw_key, scope, principal.operator_id, None)
    return _Key(raw_key, scope, principal.user_id, principal.tenant_id)


def _lookup(db: Session, key: _Key) -> _Found | None:
    row = db.execute(_LOOKUP, key.params()).one_or_none()
    if row is None or not row.live:
        return None
    return _Found(bytes(row.request_hash), row.resource_type, row.resource_id)


def _repeat(
    found: _Found, fingerprint: bytes, resource_type: str, replay: Replay
) -> ResponseReturnValue:
    if found.request_hash != fingerprint:
        raise ApiError(
            409,
            "idempotency_conflict",
            f"This {HEADER} was already used for a different request",
        )
    if found.resource_type != resource_type:
        raise RuntimeError(
            f"idempotency key of {request.endpoint} refers to {found.resource_type}, "
            f"not {resource_type}"
        )
    return replay(found.resource_id)
