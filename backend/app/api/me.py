"""The signed-in user's own account: profile, password, devices (T049).

Every route here acts only on the caller's own user row and sessions. The one route that
takes an id (ending one session) finds it only among the caller's own sessions, so another
user's session is answered exactly like a made-up id.
"""

from __future__ import annotations

import uuid
from typing import Any

from flask import Blueprint, Response, jsonify
from flask.typing import ResponseReturnValue
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.api.common import (
    clear_cookie,
    client_ip,
    iso,
    json_body,
    text_field,
    validation_failed,
)
from app.core import audit, sessions, user_agent
from app.core.identifiers import InvalidIdentifier, normalize_email, normalize_phone
from app.core.permissions import authenticated
from app.core.request_context import current_user, not_found_in_tenant, request_db
from app.services import accounts
from app.services.common import lookup_identifier
from app.services.invitations import identifier_unavailable
from app.services.me import build_me

bp = Blueprint("me", __name__, url_prefix="/api/v1")

LOCALES = ("en", "ar")


@bp.get("/me")
@authenticated(self_only=True)
def get_me() -> ResponseReturnValue:
    user = current_user()
    return jsonify(build_me(request_db(), user.user_id, user.tenant_id))


@bp.patch("/me")
@authenticated(self_only=True)
def update_me() -> ResponseReturnValue:
    user = current_user()
    db = request_db()
    body = json_body()
    errors: dict[str, str] = {}
    changes: dict[str, Any] = {}
    if "name" in body:
        name = text_field(body, "name", 120, errors)
        if name is not None:
            changes["name"] = name
    if "locale" in body:
        if body["locale"] in LOCALES:
            changes["locale"] = body["locale"]
        else:
            errors["locale"] = "invalid"
    identifiers = _identifier_changes(body, errors)
    if errors:
        raise validation_failed(errors)

    current = db.execute(
        text("SELECT phone_e164, email FROM users WHERE id = :id FOR UPDATE"),
        {"id": user.user_id},
    ).one()
    before = {"phone": current.phone_e164, "email": current.email}
    identifiers = {k: v for k, v in identifiers.items() if v != before[k]}
    if "phone" in body or "email" in body:
        # Even an unchanged identifier must come with the right password.
        accounts.check_current_password(db, user.user_id, body.get("current_password"))
    after = {**before, **identifiers}
    if after["phone"] is None and after["email"] is None:
        raise validation_failed({"identifier": "required"})
    for kind, value in identifiers.items():
        if value is not None:
            owner = lookup_identifier(db, kind, value)
            if owner is not None and owner.user_id != user.user_id:
                raise identifier_unavailable()

    columns = {**changes}
    if "phone" in identifiers:
        columns["phone_e164"] = identifiers["phone"]
    if "email" in identifiers:
        columns["email"] = identifiers["email"]
    if columns:
        assignments = ", ".join(f"{column} = :{column}" for column in columns)
        try:
            with db.begin_nested():
                db.execute(
                    text(f"UPDATE users SET {assignments}, updated_at = now() WHERE id = :id"),  # noqa: S608
                    {**columns, "id": user.user_id},
                )
        except IntegrityError as exc:
            if getattr(exc.orig, "sqlstate", None) == "23505":
                raise identifier_unavailable() from None
            raise
    if identifiers:
        # Never the full phone number or address: the last digits and the domain only.
        hint = {"phone": audit.phone_hint, "email": audit.email_hint}
        audit.record(
            db,
            tenant_id=user.tenant_id,
            actor_type="user",
            actor_id=user.user_id,
            event="auth.identifier_changed",
            target_type="user",
            target_id=user.user_id,
            data={
                "before": {kind: hint[kind](before[kind]) for kind in identifiers},
                "after": {kind: hint[kind](value) for kind, value in identifiers.items()},
            },
            ip=client_ip(),
        )
    return jsonify(build_me(db, user.user_id, user.tenant_id))


def _identifier_changes(body: dict[str, Any], errors: dict[str, str]) -> dict[str, str | None]:
    """Normalized new phone and/or email (``None`` removes one), from the fields present."""
    found: dict[str, str | None] = {}
    for kind, normalize in (("phone", normalize_phone), ("email", normalize_email)):
        if kind not in body:
            continue
        value = body[kind]
        if value is None or (isinstance(value, str) and not value.strip()):
            found[kind] = None
        elif not isinstance(value, str):
            errors[kind] = f"invalid_{kind}"
        else:
            try:
                found[kind] = normalize(value)
            except InvalidIdentifier as exc:
                errors[kind] = exc.code
    return found


@bp.post("/me/password")
@authenticated(self_only=True)
def change_password() -> ResponseReturnValue:
    user = current_user()
    body = json_body()
    accounts.change_password(
        request_db(),
        tenant_id=user.tenant_id,
        user_id=user.user_id,
        session_id=user.session_id,
        current=body.get("current_password"),
        new=body.get("new_password"),
        ip=client_ip(),
    )
    return Response(status=204)


@bp.get("/me/sessions")
@authenticated(self_only=True)
def list_sessions() -> ResponseReturnValue:
    user = current_user()
    records = sessions.list_for_user(request_db(), user.user_id)
    return jsonify([_session_json(record, user.session_id) for record in records])


def _session_json(record: sessions.SessionRecord, current_id: uuid.UUID) -> dict[str, Any]:
    """Plain browser and system names only: the raw user agent is never returned."""
    device = user_agent.parse(record.user_agent)
    return {
        "id": str(record.id),
        "browser": device.browser,
        "os": device.os,
        "created_at": iso(record.created_at),
        "last_seen_at": iso(record.last_seen_at),
        "current": record.id == current_id,
    }


@bp.delete("/me/sessions")
@authenticated(self_only=True)
def end_other_sessions() -> ResponseReturnValue:
    user = current_user()
    db = request_db()
    ended = sessions.revoke_others_for_user(db, user.user_id, user.session_id)
    if ended:
        audit.record(
            db,
            tenant_id=user.tenant_id,
            actor_type="user",
            actor_id=user.user_id,
            event="auth.session_revoked",
            target_type="user",
            target_id=user.user_id,
            data={"ended": ended, "scope": "others"},
            ip=client_ip(),
        )
    return Response(status=204)


@bp.delete("/me/sessions/<uuid:session_id>")
@authenticated
def end_session(session_id: uuid.UUID) -> ResponseReturnValue:
    user = current_user()
    db = request_db()
    if not sessions.revoke(db, session_id, user_id=user.user_id):
        not_found_in_tenant("session", session_id)
    audit.record(
        db,
        tenant_id=user.tenant_id,
        actor_type="user",
        actor_id=user.user_id,
        event="auth.session_revoked",
        target_type="session",
        target_id=session_id,
        data={"scope": "one", "current": session_id == user.session_id},
        ip=client_ip(),
    )
    response = Response(status=204)
    if session_id == user.session_id:
        clear_cookie(response, operator=False)
    return response
