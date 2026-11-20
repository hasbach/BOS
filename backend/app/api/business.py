"""The caller's business and its settings, ``/api/v1/business`` (T069, User Story 3).

Reading needs ``business.view`` (everyone); changing needs ``settings.manage`` (owners and
managers). The business is always the caller's own: no route takes a business id.

Money fields are decimal strings (the contract's ``Money``): ASCII digits with at most two
decimals, no sign, exponent, thousands separator or surrounding text. A JSON number is
refused with ``invalid`` even when it looks right, because it may already have passed through
a binary float on the way. The exchange rate must be above 0 and at most 10,000,000 LBP per
USD; the delivery fee may be 0 and at most 100,000,000. Values out of range are ``invalid``.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from flask import Blueprint, jsonify
from flask.typing import ResponseReturnValue

from app.api.common import client_ip, json_body, text_field, validation_failed
from app.core.permissions import require
from app.core.request_context import current_user, request_db
from app.services import settings

bp = Blueprint("business", __name__, url_prefix="/api/v1")

CURRENCIES = ("USD", "LBP")
MAX_RATE = Decimal("10000000")
MAX_FEE = Decimal("100000000")
MAX_LOW_STOCK_DEFAULT = 1_000_000
_MONEY = re.compile(r"[0-9]{1,16}(\.[0-9]{1,2})?", re.ASCII)


@bp.get("/business")
@require("business.view")
def get_business() -> ResponseReturnValue:
    return jsonify(settings.business(request_db(), current_user().tenant_id))


@bp.patch("/business")
@require("settings.manage")
def update_business() -> ResponseReturnValue:
    body = json_body()
    errors: dict[str, str] = {}
    changes: dict[str, Any] = {}
    if "name" in body:
        changes["name"] = text_field(body, "name", 120, errors)
    for field in ("default_currency", "default_delivery_fee_currency"):
        if field in body:
            changes[field] = _currency(body, field, errors)
    if "usd_lbp_rate" in body:
        changes["usd_lbp_rate"] = _money(
            body, "usd_lbp_rate", errors, positive=True, maximum=MAX_RATE
        )
    if "default_delivery_fee" in body:
        changes["default_delivery_fee"] = _money(
            body, "default_delivery_fee", errors, positive=False, maximum=MAX_FEE
        )
    if "low_stock_default" in body:
        level = body["low_stock_default"]
        if type(level) is not int or level < 0:
            errors["low_stock_default"] = "invalid"
        elif level > MAX_LOW_STOCK_DEFAULT:
            errors["low_stock_default"] = "too_large"
        else:
            changes["low_stock_default"] = level
    if errors:
        raise validation_failed(errors)
    user = current_user()
    return jsonify(
        settings.update(
            request_db(),
            tenant_id=user.tenant_id,
            user_id=user.user_id,
            changes=changes,
            ip=client_ip(),
        )
    )


def _currency(body: dict[str, Any], name: str, errors: dict[str, str]) -> str | None:
    value = body.get(name)
    if value is None:
        errors[name] = "required"
        return None
    if value not in CURRENCIES:
        errors[name] = "invalid"
        return None
    return str(value)


def _money(
    body: dict[str, Any],
    name: str,
    errors: dict[str, str],
    *,
    positive: bool,
    maximum: Decimal,
) -> Decimal | None:
    value = body.get(name)
    if value is None or (isinstance(value, str) and not value.strip()):
        errors[name] = "required"
        return None
    if not isinstance(value, str) or not _MONEY.fullmatch(value.strip()):
        errors[name] = "invalid"
        return None
    amount = Decimal(value.strip())
    if (positive and amount <= 0) or amount > maximum:
        errors[name] = "invalid"
        return None
    return amount.quantize(settings.CENT)
