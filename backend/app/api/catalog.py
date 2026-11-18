"""The catalog, ``/api/v1/catalog/products`` (M1 User Story 1, FR-001 to FR-009).

Reads need ``catalog.view`` and are store-filtered (``require(..., store_filtered=True)``):
the service limits every query to ``catalog.visible_products``, and a product of this
business outside the caller's stores is answered 404 exactly like a missing one, recorded as
``access.denied_store`` (``not_found_in_scope``). Every change needs ``catalog.manage``.

A view has exactly one policy, so the search's ``status=archived`` and ``no_photo`` filters,
which need ``catalog.manage``, are checked here and refused with ``refuse("forbidden")``
(recorded as ``access.denied_permission`` with ``catalog.manage``).

This module checks the shape of requests and answers with the contract's field codes; the
rules that need the database (stores, photos, combinations, SKUs, versions) are in
``app.services.catalog``. ``POST /catalog/products`` is idempotent (``core/idempotency``,
resource type ``product``, R44). A unique-index violation on a product code or SKU (two saves
racing) is answered with the same 409 as the service's own check.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal
from typing import Any, Literal, NoReturn, cast

from flask import Blueprint, Response, current_app, jsonify, request
from flask.typing import ResponseReturnValue
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.api.common import (
    client_ip,
    decode_cursor,
    encode_cursor,
    json_body,
    validation_failed,
)
from app.core.idempotency import HEADER, idempotent
from app.core.permissions import require
from app.core.request_context import (
    current_user,
    not_found_in_scope,
    not_found_in_store,
    not_found_in_tenant,
    on_commit,
    refuse,
    request_db,
)
from app.core.storage import storage_for
from app.errors import ApiError
from app.services import catalog, catalog_search, skus
from app.services.catalog import OptionIn, ProductIn, ValueIn, VariantIn
from app.services.common import NotFound

bp = Blueprint("catalog", __name__, url_prefix="/api/v1")

NAME_MAX = 120
DESCRIPTION_MAX = 2000
OPTION_NAME_MAX = 40
LABEL_MAX = 40
MAX_OPTIONS = 2
MAX_VALUES = 20
MAX_PHOTOS = 8
MAX_VARIANTS = catalog.MAX_VARIANTS
MAX_QUANTITY = 1_000_000
MAX_PRICE = Decimal("99999999999.99")
Q_MAX = 100
CURRENCIES = ("USD", "LBP")
_MONEY = re.compile(r"[0-9]{1,16}(\.[0-9]{1,2})?", re.ASCII)


def _actor() -> catalog.Actor:
    user = current_user()
    return catalog.Actor(user_id=user.user_id, tenant_id=user.tenant_id, ip=client_ip())


@contextmanager
def _outcomes() -> Iterator[None]:
    try:
        yield
    except NotFound as missing:
        not_found_in_tenant(missing.target_type, missing.target_id)
    except catalog.OutOfScope as outside:
        not_found_in_scope(outside.target_type, outside.target_id, "catalog.view")


def _unique_violation(exc: IntegrityError) -> NoReturn:
    """Two saves raced past the service's checks; the unique index decided (R46)."""
    constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
    if constraint == "products_code_key_uq":
        raise ApiError(
            409,
            "product_code_in_use",
            "This product code is already used",
            fields={"code": "in_use"},
        ) from None
    if constraint == "variants_sku_key_uq":
        raise ApiError(
            409, "sku_in_use", "A SKU is already used in this business", extra={"conflicts": []}
        ) from None
    raise exc


# ---- reading ------------------------------------------------------------------------------------


@bp.get("/catalog/products")
@require("catalog.view", store_filtered=True)
def list_products() -> ResponseReturnValue:
    user = current_user()
    args = request.args
    errors: dict[str, str] = {}
    q = args.get("q")
    if q is not None:
        q = q.strip() or None
        if q is not None and len(q) > Q_MAX:
            errors["q"] = "too_long"
    stock = args.get("stock")
    if stock is not None and stock not in ("in_stock", "low", "out"):
        errors["stock"] = "invalid"
    status = args.get("status", "active")
    if status not in ("active", "archived"):
        errors["status"] = "invalid"
    no_photo_raw = args.get("no_photo")
    if no_photo_raw is not None and no_photo_raw not in ("true", "false"):
        errors["no_photo"] = "invalid"
    no_photo = no_photo_raw == "true"
    after = None
    if args.get("cursor") is not None:
        after = decode_cursor(args["cursor"])
        if after is None:
            errors["cursor"] = "invalid"
    store_id = None
    if args.get("store_id") is not None:
        try:
            store_id = uuid.UUID(args["store_id"])
        except ValueError:
            errors["store_id"] = "invalid"
    if errors:
        raise validation_failed(errors)

    if (status == "archived" or no_photo) and not catalog.is_manager(user.access):
        refuse("forbidden", permission="catalog.manage")
    db = request_db()
    if store_id is not None:
        _check_store_filter(store_id)
    page = catalog_search.search(
        db,
        user.access,
        catalog_search.Query(
            q=q,
            store_id=store_id,
            stock=cast(catalog_search.Stock | None, stock),
            status=cast(Literal["active", "archived"], status),
            no_photo=no_photo,
            after=after,
        ),
    )
    cursor = page["next_cursor"]
    page["next_cursor"] = encode_cursor(*cursor) if cursor else None
    return jsonify(page)


def _check_store_filter(store_id: uuid.UUID) -> None:
    """``store_id`` must be one of the caller's stores (refused like M0's store check)."""
    access = current_user().access
    status = (
        request_db()
        .execute(text("SELECT status FROM stores WHERE id = :id"), {"id": store_id})
        .scalar_one_or_none()
    )
    if status is None:
        not_found_in_tenant("store", store_id)
    if catalog.is_manager(access):
        return
    if status != "active" or not access.can_see_store(store_id):
        not_found_in_store(store_id, "catalog.view")


@bp.get("/catalog/products/<uuid:product_id>")
@require("catalog.view", store_filtered=True)
def get_product(product_id: uuid.UUID) -> ResponseReturnValue:
    with _outcomes():
        return jsonify(catalog.get_product(request_db(), product_id, current_user().access))


# ---- changing -----------------------------------------------------------------------------------


@bp.post("/catalog/products")
@require("catalog.manage")
def create_product() -> ResponseReturnValue:
    data, _ = _product_input(json_body(), creating=True)
    db = request_db()
    actor = _actor()
    # Before the idempotency lookup: a duplicate sent at the same moment waits here until the
    # first commits, then finds its key and replays it (see app.services.catalog).
    catalog.lock_business(db, actor.tenant_id)

    def create() -> tuple[uuid.UUID, ResponseReturnValue]:
        saved = catalog.create_product(db, actor, data, request_key=request.headers.get(HEADER))
        return saved.product_id, (jsonify(catalog.manager_view(db, saved.product_id)), 201)

    def replay(product_id: uuid.UUID) -> ResponseReturnValue:
        with _outcomes():
            return jsonify(catalog.manager_view(db, product_id)), 201

    try:
        return idempotent("product", create=create, replay=replay)
    except IntegrityError as exc:
        _unique_violation(exc)


def _existing(product_id: uuid.UUID) -> None:
    """Found in this business first, so a bad body cannot tell a made-up id from a foreign one."""
    with _outcomes():
        catalog.manager_view(request_db(), product_id)


def _delete_files_after_commit(paths: list[str]) -> None:
    if not paths:
        return
    storage = storage_for(current_app)

    def delete() -> None:
        for path in paths:
            storage.delete(path)

    on_commit(delete)


@bp.put("/catalog/products/<uuid:product_id>")
@require("catalog.manage")
def update_product(product_id: uuid.UUID) -> ResponseReturnValue:
    _existing(product_id)
    data, version = _product_input(json_body(), creating=False)
    assert version is not None
    db = request_db()
    try:
        with db.begin_nested():
            saved = catalog.update_product(db, _actor(), product_id, version, data)
    except IntegrityError as exc:
        _unique_violation(exc)
    _delete_files_after_commit(saved.removed_photo_paths)
    return jsonify(catalog.manager_view(db, product_id))


@bp.delete("/catalog/products/<uuid:product_id>")
@require("catalog.manage")
def delete_product(product_id: uuid.UUID) -> ResponseReturnValue:
    _existing(product_id)
    raw = request.args.get("version")
    if raw is None:
        raise validation_failed({"version": "required"})
    if not raw.isascii() or not raw.isdigit() or int(raw) < 1:
        raise validation_failed({"version": "invalid"})
    paths = catalog.delete_product(request_db(), _actor(), product_id, int(raw))
    _delete_files_after_commit(paths)
    return Response(status=204)


def _status_change(
    product_id: uuid.UUID, status: Literal["active", "archived"]
) -> ResponseReturnValue:
    _existing(product_id)
    version = _version(json_body())
    db = request_db()
    catalog.set_status(db, _actor(), product_id, version, status)
    return jsonify(catalog.manager_view(db, product_id))


@bp.post("/catalog/products/<uuid:product_id>/archive")
@require("catalog.manage")
def archive_product(product_id: uuid.UUID) -> ResponseReturnValue:
    return _status_change(product_id, "archived")


@bp.post("/catalog/products/<uuid:product_id>/restore")
@require("catalog.manage")
def restore_product(product_id: uuid.UUID) -> ResponseReturnValue:
    return _status_change(product_id, "active")


# ---- request shapes -----------------------------------------------------------------------------


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _version(body: dict[str, Any]) -> int:
    value = body.get("version")
    if value is None:
        raise validation_failed({"version": "required"})
    if not _is_int(value) or value < 1:
        raise validation_failed({"version": "invalid"})
    return int(value)


def _optional_text(
    body: dict[str, Any], name: str, max_length: int, errors: dict[str, str], path: str
) -> str | None:
    value = body.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        errors[path] = "invalid"
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > max_length:
        errors[path] = "too_long"
        return None
    return value


def _required_text(
    body: dict[str, Any], name: str, max_length: int, errors: dict[str, str], path: str
) -> str:
    value = body.get(name)
    if value is not None and not isinstance(value, str):
        errors[path] = "invalid"
        return ""
    text_value = (value or "").strip()
    if not text_value:
        errors[path] = "required"
    elif len(text_value) > max_length:
        errors[path] = "too_long"
    return text_value


def _uuid(value: Any) -> uuid.UUID | None:
    if not isinstance(value, str):
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def _uuid_list(
    body: dict[str, Any], name: str, errors: dict[str, str], maximum: int | None
) -> list[uuid.UUID]:
    value = body.get(name)
    if value is None:
        return []
    if not isinstance(value, list):
        errors[name] = "invalid"
        return []
    if maximum is not None and len(value) > maximum:
        errors[name] = "too_many"
        return []
    ids = [_uuid(item) for item in value]
    if any(i is None for i in ids):
        errors[name] = "invalid"
        return []
    return list(dict.fromkeys(cast(list[uuid.UUID], ids)))


def _optional_id(
    item: dict[str, Any], creating: bool, errors: dict[str, str], path: str
) -> uuid.UUID | None:
    raw = item.get("id")
    if raw is None:
        return None
    parsed = _uuid(raw)
    if creating or parsed is None:
        errors[path] = "invalid"
    return parsed


def _options(body: dict[str, Any], creating: bool, errors: dict[str, str]) -> list[OptionIn]:
    raw = body.get("options")
    if raw is None:
        return []
    if not isinstance(raw, list):
        errors["options"] = "invalid"
        return []
    if len(raw) > MAX_OPTIONS:
        errors["options"] = "too_many"
        return []
    options = []
    for index, item in enumerate(raw):
        path = f"options.{index}"
        if not isinstance(item, dict):
            errors[path] = "invalid"
            continue
        option_id = _optional_id(item, creating, errors, f"{path}.id")
        name = _required_text(item, "name", OPTION_NAME_MAX, errors, f"{path}.name")
        values_raw = item.get("values")
        values: list[ValueIn] = []
        if not isinstance(values_raw, list):
            errors[f"{path}.values"] = "required" if values_raw is None else "invalid"
        elif not values_raw:
            errors[f"{path}.values"] = "required"
        elif len(values_raw) > MAX_VALUES:
            errors[f"{path}.values"] = "too_many"
        else:
            seen: set[str] = set()
            for position, value in enumerate(values_raw):
                value_path = f"{path}.values.{position}"
                if not isinstance(value, dict):
                    errors[value_path] = "invalid"
                    continue
                value_id = _optional_id(value, creating, errors, f"{value_path}.id")
                label = _required_text(value, "label", LABEL_MAX, errors, value_path)
                folded = catalog.ascii_lower(label)
                if label and folded in seen:
                    errors[f"{path}.values"] = "duplicate"
                seen.add(folded)
                values.append(ValueIn(value_id, label))
        options.append(OptionIn(option_id, name, values))
    return options


def _price(
    item: dict[str, Any], currency: str | None, errors: dict[str, str], path: str
) -> Decimal:
    value = item.get("price")
    if value is None or (isinstance(value, str) and not value.strip()):
        errors[path] = "required"
        return Decimal(0)
    if not isinstance(value, str) or not _MONEY.fullmatch(value.strip()):
        errors[path] = "invalid"
        return Decimal(0)
    amount = Decimal(value.strip())
    if amount > MAX_PRICE:
        errors[path] = "too_large"
    elif currency == "LBP" and amount != amount.to_integral_value():
        errors[path] = "not_whole"
    return amount


def _quantity(value: Any, errors: dict[str, str], path: str) -> int:
    if not _is_int(value) or value < 0:
        errors[path] = "invalid"
        return 0
    if value > MAX_QUANTITY:
        errors[path] = "too_large"
        return 0
    return int(value)


def _variant(item: Any, index: int, creating: bool, errors: dict[str, str]) -> VariantIn | None:
    path = f"variants.{index}"
    if not isinstance(item, dict):
        errors[path] = "invalid"
        return None
    variant_id = _optional_id(item, creating, errors, f"{path}.id")
    labels = item.get("option_values", [])
    if (
        not isinstance(labels, list)
        or len(labels) > MAX_OPTIONS
        or not all(isinstance(label, str) for label in labels)
    ):
        errors[f"{path}.option_values"] = "invalid"
        labels = []
    sku_raw = item.get("sku")
    sku: str | None = None
    if sku_raw is not None and not isinstance(sku_raw, str):
        errors[f"{path}.sku"] = "invalid"
    elif sku_raw and sku_raw.strip():
        try:
            sku = skus.check_sku(sku_raw)
        except skus.InvalidCode as bad:
            errors[f"{path}.sku"] = bad.code
    currency = item.get("currency")
    if currency is None:
        errors[f"{path}.currency"] = "required"
    elif currency not in CURRENCIES:
        errors[f"{path}.currency"] = "invalid"
        currency = None
    price = _price(item, currency, errors, f"{path}.price")
    level = item.get("low_stock_level")
    if level is not None:
        level = _quantity(level, errors, f"{path}.low_stock_level")
    photo_id = None
    if item.get("photo_id") is not None:
        photo_id = _uuid(item["photo_id"])
        if photo_id is None:
            errors[f"{path}.photo_id"] = "invalid"
    opening = item.get("opening_quantity")
    quantity = 0
    if creating:
        if opening is not None:
            quantity = _quantity(opening, errors, f"{path}.opening_quantity")
    elif opening is not None and opening != 0:
        errors[f"{path}.opening_quantity"] = "invalid"  # create only: use a stock adjustment
    status = item.get("status", "active")
    if status not in ("active", "archived") or (creating and status != "active"):
        errors[f"{path}.status"] = "invalid"
        status = "active"
    return VariantIn(
        id=variant_id,
        option_values=[label.strip() for label in labels],
        sku=sku,
        price=price,
        currency=str(currency or "USD"),
        low_stock_level=level,
        photo_id=photo_id,
        opening_quantity=quantity,
        status=status,
    )


def _product_input(body: dict[str, Any], *, creating: bool) -> tuple[ProductIn, int | None]:
    errors: dict[str, str] = {}
    version = None
    if not creating:
        raw_version = body.get("version")
        if raw_version is None:
            errors["version"] = "required"
        elif not _is_int(raw_version) or raw_version < 1:
            errors["version"] = "invalid"
        else:
            version = int(raw_version)
    code = ""
    raw_code = body.get("code")
    if raw_code is None:
        errors["code"] = "required"
    elif not isinstance(raw_code, str):
        errors["code"] = "invalid"
    else:
        try:
            code = skus.check_code(raw_code)
        except skus.InvalidCode as bad:
            errors["code"] = bad.code
    name_en = _optional_text(body, "name_en", NAME_MAX, errors, "name_en")
    name_ar = _optional_text(body, "name_ar", NAME_MAX, errors, "name_ar")
    if name_en is None and name_ar is None and "name_en" not in errors and "name_ar" not in errors:
        errors["name_en"] = "required"
    description_en = _optional_text(
        body, "description_en", DESCRIPTION_MAX, errors, "description_en"
    )
    description_ar = _optional_text(
        body, "description_ar", DESCRIPTION_MAX, errors, "description_ar"
    )
    store_ids = _uuid_list(body, "store_ids", errors, None)
    photo_ids = _uuid_list(body, "photo_ids", errors, MAX_PHOTOS)
    if isinstance(body.get("photo_ids"), list) and len(photo_ids) != len(body["photo_ids"]):
        errors.setdefault("photo_ids", "invalid")  # the same photo twice
    options = _options(body, creating, errors)
    variants: list[VariantIn] = []
    raw_variants = body.get("variants")
    if raw_variants is None or raw_variants == []:
        errors["variants"] = "required"
    elif not isinstance(raw_variants, list):
        errors["variants"] = "invalid"
    elif len(raw_variants) > MAX_VARIANTS:
        errors["variants"] = "too_many"
    else:
        for index, item in enumerate(raw_variants):
            parsed = _variant(item, index, creating, errors)
            if parsed is not None:
                variants.append(parsed)
    if errors:
        raise validation_failed(errors)
    return (
        ProductIn(
            code=code,
            name_en=name_en,
            name_ar=name_ar,
            description_en=description_en,
            description_ar=description_ar,
            store_ids=store_ids,
            photo_ids=photo_ids,
            options=options,
            variants=variants,
        ),
        version,
    )
