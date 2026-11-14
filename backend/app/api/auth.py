"""Signed-out endpoints: sign-in, sign-out, password reset, invitation links (T048).

All are ``@public``: they work without a session (sign-out ends the session its cookie
names, if any, whatever the state of the business). Link tokens travel only in request
bodies (research R26).
"""

from __future__ import annotations

import functools

from flask import Blueprint, Response, current_app, jsonify, request
from flask.typing import ResponseReturnValue

from app.api.common import (
    clear_cookie,
    client_ip,
    json_body,
    jsonable,
    set_cookie,
    user_agent,
    validation_failed,
)
from app.core.db import get_engine
from app.core.permissions import public
from app.core.sessions import USER_COOKIE
from app.services import accounts, invitations

bp = Blueprint("auth", __name__, url_prefix="/api/v1")

LOCALES = ("en", "ar")


def _signed_in(me: dict[str, object], token: str) -> Response:
    response = jsonify(jsonable(me))
    set_cookie(response, token, operator=False)
    return response


@bp.post("/auth/sign-in")
@public
def sign_in() -> ResponseReturnValue:
    body = json_body()
    identifier, password = body.get("identifier"), body.get("password")
    errors = {
        name: "required"
        for name, value in (("identifier", identifier), ("password", password))
        if not isinstance(value, str) or not value
    }
    if errors:
        raise validation_failed(errors)
    assert isinstance(identifier, str) and isinstance(password, str)
    result = accounts.sign_in(
        get_engine(), identifier, password, ip=client_ip(), user_agent=user_agent()
    )
    return _signed_in(result.me, result.session_token)


@bp.post("/auth/sign-out")
@public
def sign_out() -> ResponseReturnValue:
    accounts.sign_out(get_engine(), request.cookies.get(USER_COOKIE), ip=client_ip())
    response = Response(status=204)
    clear_cookie(response, operator=False)
    return response


@bp.post("/auth/password-reset/request")
@public
def password_reset_request() -> ResponseReturnValue:
    email = json_body().get("email")
    response = Response(status=204)
    if not isinstance(email, str):
        return response
    pending = accounts.request_password_reset(get_engine(), email, ip=client_ip())
    if pending is not None:
        # Looking the address up, issuing the link and sending the email happen once the
        # answer has been written to the client (the WSGI server closes the response after
        # sending it), so a registered address is not answered more slowly than an unknown
        # one (security.md F-04). Only the limits above are done before answering.
        app = current_app._get_current_object()  # type: ignore[attr-defined]
        response.call_on_close(functools.partial(accounts.send_password_reset, app, pending))
    return response


@bp.post("/auth/password-reset/complete")
@public
def password_reset_complete() -> ResponseReturnValue:
    body = json_body()
    accounts.complete_password_reset(
        get_engine(), body.get("token"), body.get("new_password"), ip=client_ip()
    )
    return Response(status=204)


@bp.post("/invitations/preview")
@public
def invitation_preview() -> ResponseReturnValue:
    return jsonify(jsonable(invitations.preview(get_engine(), json_body().get("token"))))


@bp.post("/invitations/send-code")
@public
def invitation_send_code() -> ResponseReturnValue:
    body = json_body()
    locale = body.get("locale", "en")
    if locale not in LOCALES:
        raise validation_failed({"locale": "invalid"})
    pending = invitations.request_code(
        get_engine(), body.get("token"), locale=str(locale), ip=client_ip()
    )
    response = Response(status=204)
    # The code is stored before answering; the email goes out once the answer has been
    # written, as for password resets (security.md F-04), so the answer never waits for the
    # mail server. Nothing in either step depends on whether the address is used elsewhere.
    app = current_app._get_current_object()  # type: ignore[attr-defined]
    response.call_on_close(functools.partial(invitations.send_code, app, pending))
    return response


@bp.post("/invitations/accept")
@public
def invitation_accept() -> ResponseReturnValue:
    body = json_body()
    locale = body.get("locale", "en")
    if locale not in LOCALES:
        raise validation_failed({"locale": "invalid"})
    password = body.get("password")
    if not isinstance(password, str):
        password = ""  # refused as a weak password once the link is known to be usable
    result = invitations.accept(
        get_engine(),
        body.get("token"),
        password=password,
        locale=str(locale),
        ip=client_ip(),
        user_agent=user_agent(),
        code=body.get("code"),
    )
    return _signed_in(result.me, result.session_token)
