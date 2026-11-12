"""Operator API under ``/api/v1/ops/`` (T047). Operators see account-level information only.

Sign-in and sign-out are ``@public`` (sign-out ends the session its cookie names, if any);
everything else is ``@operator_only`` and runs in the request's operator-context transaction.
"""

from __future__ import annotations

import re
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, cast

from flask import Blueprint, Response, jsonify, request
from flask.typing import ResponseReturnValue

from app.api.common import (
    clear_cookie,
    client_ip,
    identifier_field,
    json_body,
    jsonable,
    link_result,
    set_cookie,
    text_field,
    user_agent,
    validation_failed,
)
from app.core.db import get_engine
from app.core.idempotency import idempotent
from app.core.identifiers import normalize_email, normalize_phone
from app.core.permissions import operator_only, public
from app.core.request_context import current_operator, not_found_in_tenant, request_db
from app.core.sessions import OPERATOR_COOKIE
from app.errors import ApiError
from app.services import accounts, onboarding
from app.services.common import NotFound

bp = Blueprint("ops", __name__, url_prefix="/api/v1/ops")

_MONEY = re.compile(r"^\d{1,16}(\.\d{1,2})?$")  # numeric(18, 2)


@bp.post("/auth/sign-in")
@public
def sign_in() -> ResponseReturnValue:
    body = json_body()
    email, password = body.get("email"), body.get("password")
    errors = {
        name: "required"
        for name, value in (("email", email), ("password", password))
        if not isinstance(value, str) or not value
    }
    if errors:
        raise validation_failed(errors)
    assert isinstance(email, str) and isinstance(password, str)
    result = accounts.operator_sign_in(
        get_engine(), email, password, ip=client_ip(), user_agent=user_agent()
    )
    response = jsonify(result.operator)
    set_cookie(response, result.session_token, operator=True)
    return response


@bp.post("/auth/sign-out")
@public
def sign_out() -> ResponseReturnValue:
    accounts.operator_sign_out(get_engine(), request.cookies.get(OPERATOR_COOKIE))
    response = Response(status=204)
    clear_cookie(response, operator=True)
    return response


@bp.get("/me")
@operator_only
def me() -> ResponseReturnValue:
    operator = current_operator()
    return jsonify(id=str(operator.operator_id), name=operator.name, email=operator.email)


@bp.get("/businesses")
@operator_only
def businesses() -> ResponseReturnValue:
    return jsonify(jsonable(onboarding.business_overview(request_db())))


def _business(tenant_id: uuid.UUID) -> dict[str, Any]:
    [business] = onboarding.business_overview(request_db(), tenant_id)
    return business


@bp.post("/businesses")
@operator_only
def create_business() -> ResponseReturnValue:
    new = _new_business(json_body())
    operator = current_operator()

    def create() -> tuple[uuid.UUID, ResponseReturnValue]:
        tenant_id, link = onboarding.create_business(
            request_db(), operator_id=operator.operator_id, new=new, ip=client_ip()
        )
        body = {**link_result(link), "business": _business(tenant_id)}
        return tenant_id, (jsonify(jsonable(body)), 201)

    def replay(tenant_id: uuid.UUID) -> ResponseReturnValue:
        # The client never received the first link: issue a fresh one, the old one stops
        # working. Once the owner has activated there is no link to give.
        link = onboarding.reissue_owner_activation(
            request_db(), tenant_id=tenant_id, operator_id=operator.operator_id, ip=client_ip()
        )
        body: dict[str, Any] = {"business": _business(tenant_id)}
        if link is not None:
            body.update(link_result(link))
        return jsonify(jsonable(body)), 201

    return idempotent("tenant", create=create, replay=replay)


def _new_business(body: dict[str, Any]) -> onboarding.NewBusiness:
    errors: dict[str, str] = {}
    business_name = text_field(body, "business_name", 120, errors)
    store_name = text_field(body, "store_name", 80, errors)
    owner_name = text_field(body, "owner_name", 120, errors)
    edition = body.get("edition")
    if edition not in ("social", "commerce"):
        errors["edition"] = "required" if edition is None else "invalid"
    currency = body.get("default_currency", "USD")
    if currency not in ("USD", "LBP"):
        errors["default_currency"] = "invalid"
    rate = _rate(body.get("usd_lbp_rate"), errors)
    phone = identifier_field(body, "owner_phone", normalize_phone, errors)
    email = identifier_field(body, "owner_email", normalize_email, errors)
    if phone is None and email is None and not {"owner_phone", "owner_email"} & errors.keys():
        errors["owner_phone"] = "required"  # or owner_email; one is needed
    if errors:
        raise validation_failed(errors)
    assert business_name and store_name and owner_name and rate is not None
    return onboarding.NewBusiness(
        business_name=business_name,
        store_name=store_name,
        edition=cast(Literal["social", "commerce"], edition),
        default_currency=cast(Literal["USD", "LBP"], currency),
        usd_lbp_rate=rate,
        owner_name=owner_name,
        owner_phone=phone,
        owner_email=email,
    )


def _rate(value: object, errors: dict[str, str]) -> Decimal | None:
    if value is None:
        errors["usd_lbp_rate"] = "required"
        return None
    text = str(value) if isinstance(value, int) and not isinstance(value, bool) else value
    if not isinstance(text, str) or not _MONEY.match(text.strip()):
        errors["usd_lbp_rate"] = "invalid"
        return None
    try:
        rate = Decimal(text.strip())
    except InvalidOperation:
        errors["usd_lbp_rate"] = "invalid"
        return None
    if rate <= 0:
        errors["usd_lbp_rate"] = "invalid"
        return None
    return rate


@bp.patch("/businesses/<uuid:business_id>")
@operator_only
def set_status(business_id: uuid.UUID) -> ResponseReturnValue:
    status = json_body().get("status")
    if status not in ("active", "suspended"):
        raise validation_failed({"status": "invalid"})
    try:
        onboarding.set_business_status(
            request_db(),
            tenant_id=business_id,
            status=cast(Literal["active", "suspended"], status),
            operator_id=current_operator().operator_id,
            ip=client_ip(),
        )
    except NotFound:
        not_found_in_tenant()
    return jsonify(jsonable(_business(business_id)))


@bp.post("/businesses/<uuid:business_id>/owner-activation")
@operator_only
def resend_owner_activation(business_id: uuid.UUID) -> ResponseReturnValue:
    try:
        link = onboarding.reissue_owner_activation(
            request_db(),
            tenant_id=business_id,
            operator_id=current_operator().operator_id,
            ip=client_ip(),
        )
    except NotFound:
        not_found_in_tenant()
    if link is None:
        raise ApiError(409, "invitation_closed", "The owner has already activated their account")
    return jsonify(link_result(link)), 201


@bp.post("/businesses/<uuid:business_id>/owner-password-reset")
@operator_only
def owner_password_reset(business_id: uuid.UUID) -> ResponseReturnValue:
    raw = json_body().get("owner_user_id")
    try:
        owner_user_id = uuid.UUID(str(raw))
    except ValueError:
        not_found_in_tenant()
    try:
        link = onboarding.issue_owner_password_reset(
            request_db(),
            tenant_id=business_id,
            owner_user_id=owner_user_id,
            operator_id=current_operator().operator_id,
            ip=client_ip(),
        )
    except NotFound:
        not_found_in_tenant()
    return jsonify(link_result(link)), 201
