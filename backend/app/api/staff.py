"""The business's employees and invitations, ``/api/v1/staff`` (T059, User Story 2).

Reading needs ``staff.view``; every change needs ``staff.manage`` (owners and managers). The
rules about owners and about acting on oneself live in ``app.services.staff``; this module
checks the shape of requests and turns the service's outcomes into responses:

* a user or invitation the business does not have (including another business's) is 404
  ``not_found``, identical to a made-up id, and recorded as ``access.denied_tenant``;
* a refusal by rule is a 403, recorded as ``access.denied_permission``.

One-time links appear only in the response that issues them.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Literal, cast

from flask import Blueprint, Response, jsonify
from flask.typing import ResponseReturnValue
from sqlalchemy.exc import IntegrityError

from app.api.common import (
    client_ip,
    identifier_field,
    json_body,
    jsonable,
    link_result,
    text_field,
    validation_failed,
)
from app.core.idempotency import idempotent
from app.core.identifiers import normalize_email, normalize_phone
from app.core.permissions import Role, require
from app.core.request_context import current_user, not_found_in_tenant, refuse, request_db
from app.services import staff
from app.services.common import IssuedLink, NotFound
from app.services.invitations import already_member_error

bp = Blueprint("staff", __name__, url_prefix="/api/v1")

ROLES = frozenset(role.value for role in Role)
STATUSES = ("active", "inactive")


def _actor() -> staff.Actor:
    user = current_user()
    return staff.Actor(
        user_id=user.user_id,
        tenant_id=user.tenant_id,
        manages_owners="staff.manage_owners" in user.access.permissions,
        ip=client_ip(),
    )


@contextmanager
def _outcomes() -> Iterator[None]:
    """Turn the service's "not found" and rule refusals into recorded responses."""
    try:
        yield
    except NotFound as missing:
        not_found_in_tenant(missing.target_type, missing.target_id)
    except staff.Refused as refusal:
        data = {"permission": refusal.permission} if refusal.permission else {}
        refuse(refusal.code, target_type=refusal.target_type, target_id=refusal.target_id, **data)


def _invite_result(invitation_id: uuid.UUID, link: IssuedLink) -> dict[str, Any]:
    invitation = jsonable(staff.invitation(request_db(), invitation_id))
    return {**link_result(link), "invitation": invitation}


# ---- reading ----------------------------------------------------------------------------------


@bp.get("/staff")
@require("staff.view")
def staff_list() -> ResponseReturnValue:
    return jsonify(jsonable(staff.staff_list(request_db())))


# ---- invitations ------------------------------------------------------------------------------


@bp.post("/staff/invitations")
@require("staff.manage")
def invite() -> ResponseReturnValue:
    new = _new_invitation(json_body())
    actor = _actor()

    def create() -> tuple[uuid.UUID, ResponseReturnValue]:
        invitation_id, link = staff.invite(request_db(), actor, new)
        return invitation_id, (jsonify(_invite_result(invitation_id, link)), 201)

    def replay(invitation_id: uuid.UUID) -> ResponseReturnValue:
        # The client never received the first link: the same invitation, a fresh link.
        link = staff.reissue_invitation_link(request_db(), actor, invitation_id)
        return jsonify(_invite_result(invitation_id, link)), 201

    try:
        with _outcomes():
            response = idempotent("invitation", create=create, replay=replay)
    except IntegrityError as exc:
        # The same person invited by a simultaneous request, which committed first.
        if getattr(exc.orig, "sqlstate", None) == "23505":
            raise already_member_error() from None
        raise
    return response


def _new_invitation(body: dict[str, Any]) -> staff.NewInvitation:
    errors: dict[str, str] = {}
    name = text_field(body, "name", 120, errors)
    phone = identifier_field(body, "phone", normalize_phone, errors)
    email = identifier_field(body, "email", normalize_email, errors)
    if phone is None and email is None and not {"phone", "email"} & errors.keys():
        errors["phone"] = "required"  # or email; one is needed
    roles = _roles(body, errors)
    all_stores = _flag(body, "all_stores", errors)
    store_ids = _store_ids(body, errors)
    if errors:
        raise validation_failed(errors)
    assert name is not None and roles is not None
    return staff.NewInvitation(
        name=name,
        phone=phone,
        email=email,
        roles=roles,
        all_stores=bool(all_stores),
        store_ids=store_ids or [],
    )


@bp.post("/staff/invitations/<uuid:invitation_id>/resend")
@require("staff.manage")
def resend(invitation_id: uuid.UUID) -> ResponseReturnValue:
    with _outcomes():
        new_id, link = staff.resend_invitation(request_db(), _actor(), invitation_id)
    return jsonify(_invite_result(new_id, link)), 201


@bp.delete("/staff/invitations/<uuid:invitation_id>")
@require("staff.manage")
def revoke(invitation_id: uuid.UUID) -> ResponseReturnValue:
    with _outcomes():
        staff.revoke_invitation(request_db(), _actor(), invitation_id)
    return Response(status=204)


# ---- employees --------------------------------------------------------------------------------


@bp.patch("/staff/<uuid:user_id>")
@require("staff.manage")
def update(user_id: uuid.UUID) -> ResponseReturnValue:
    # The employee is found in this business first: an invalid body must not tell a made-up
    # id from another business's (404 and a recorded refusal for both), only then the body.
    with _outcomes():
        staff.require_member(request_db(), user_id)
    body = json_body()
    errors: dict[str, str] = {}
    roles = _roles(body, errors) if "roles" in body else None
    all_stores = _flag(body, "all_stores", errors)
    store_ids = _store_ids(body, errors)
    status = body.get("status")
    if status is not None and status not in STATUSES:
        errors["status"] = "invalid"
    if errors:
        raise validation_failed(errors)
    change = staff.MemberChange(
        roles=roles,
        all_stores=all_stores,
        store_ids=store_ids,
        status=cast(Literal["active", "inactive"] | None, status),
    )
    with _outcomes():
        member = staff.update_member(request_db(), _actor(), user_id, change)
    return jsonify(member)


@bp.post("/staff/<uuid:user_id>/password-reset")
@require("staff.manage")
def password_reset(user_id: uuid.UUID) -> ResponseReturnValue:
    with _outcomes():
        link = staff.issue_password_reset(request_db(), _actor(), user_id)
    return jsonify(link_result(link)), 201


# ---- fields -----------------------------------------------------------------------------------


def _roles(body: dict[str, Any], errors: dict[str, str]) -> list[str] | None:
    value = body.get("roles")
    if value is None or value == []:
        errors["roles"] = "required"
        return None
    if (
        not isinstance(value, list)
        or not all(isinstance(role, str) for role in value)
        or not set(value) <= ROLES
    ):
        errors["roles"] = "invalid"
        return None
    return staff.canonical_roles(value)


def _flag(body: dict[str, Any], name: str, errors: dict[str, str]) -> bool | None:
    value = body.get(name)
    if value is None or isinstance(value, bool):
        return value
    errors[name] = "invalid"
    return None


def _store_ids(body: dict[str, Any], errors: dict[str, str]) -> list[uuid.UUID] | None:
    value = body.get("store_ids")
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        errors["store_ids"] = "invalid"
        return None
    try:
        return list(dict.fromkeys(uuid.UUID(item) for item in value))
    except ValueError:
        errors["store_ids"] = "invalid"
        return None
