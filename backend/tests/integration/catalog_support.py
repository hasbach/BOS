"""Helpers shared by the catalog tests (M1 User Story 1): request bodies and calls."""

from __future__ import annotations

import io
import uuid
from typing import Any

from flask.testing import FlaskClient
from sqlalchemy import Engine

from tests.integration.us1_support import CSRF, owner_rows, owner_value

PRODUCTS = "/api/v1/catalog/products"
PHOTOS = "/api/v1/catalog/photos"

PRODUCTS_RULE = "/api/v1/catalog/products"
PRODUCT_RULE = "/api/v1/catalog/products/<uuid:product_id>"
PHOTOS_RULE = "/api/v1/catalog/photos"
PHOTO_RULE = "/api/v1/catalog/photos/<uuid:photo_id>/<size>"


def variant(
    *labels: str,
    sku: str | None = None,
    price: str = "25.00",
    currency: str = "USD",
    opening: int | None = None,
    **extra: Any,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "option_values": list(labels),
        "sku": sku,
        "price": price,
        "currency": currency,
    }
    if opening is not None:
        body["opening_quantity"] = opening
    body.update(extra)
    return body


def jeans(
    code: str = "JN-SLIM",
    *,
    store_ids: list[Any] | None = None,
    sizes: tuple[str, ...] = ("30", "32", "34"),
    colours: tuple[str, ...] = ("Blue", "Black"),
    opening: int = 0,
    **extra: Any,
) -> dict[str, Any]:
    """A product with two options (sizes x colours), every variant at 25.00 USD."""
    body: dict[str, Any] = {
        "code": code,
        "name_en": "Slim jeans",
        "name_ar": "جينز ضيق",
        "store_ids": [str(s) for s in (store_ids or [])],
        "options": [
            {"name": "Size", "values": [{"label": s} for s in sizes]},
            {"name": "Colour", "values": [{"label": c} for c in colours]},
        ],
        "variants": [variant(s, c, opening=opening) for s in sizes for c in colours],
    }
    body.update(extra)
    return body


def simple(
    code: str = "TEE-1", *, store_ids: list[Any] | None = None, **extra: Any
) -> dict[str, Any]:
    """A product without options: exactly one variant."""
    body: dict[str, Any] = {
        "code": code,
        "name_en": f"Product {code}",
        "store_ids": [str(s) for s in (store_ids or [])],
        "variants": [variant()],
    }
    body.update(extra)
    return body


def create(client: FlaskClient, body: dict[str, Any], *, key: str | None = None) -> Any:
    headers = dict(CSRF)
    if key is not None:
        headers["Idempotency-Key"] = key
    return client.post(PRODUCTS, json=body, headers=headers)


def created(client: FlaskClient, body: dict[str, Any]) -> dict[str, Any]:
    response = create(client, body)
    assert response.status_code == 201, response.get_data(as_text=True)
    result: dict[str, Any] = response.get_json()
    return result


def as_update(product: dict[str, Any]) -> dict[str, Any]:
    """A PUT body that leaves the product exactly as it is (what the form sends back)."""
    return {
        "version": product["version"],
        "code": product["code"],
        "name_en": product["name_en"],
        "name_ar": product["name_ar"],
        "description_en": product["description_en"],
        "description_ar": product["description_ar"],
        "store_ids": list(product["store_ids"]),
        "photo_ids": [p["id"] for p in product["photos"]],
        "options": [
            {
                "id": o["id"],
                "name": o["name"],
                "values": [{"id": v["id"], "label": v["label"]} for v in o["values"]],
            }
            for o in product["options"]
        ],
        "variants": [
            {
                "id": v["id"],
                "option_values": list(v["option_values"]),
                "sku": v["sku"],
                "price": v["price"],
                "currency": v["currency"],
                "low_stock_level": v["low_stock_level"],
                "photo_id": v["photo_id"],
                "status": v["status"],
            }
            for v in product["variants"]
        ],
    }


def put(client: FlaskClient, product_id: Any, body: dict[str, Any]) -> Any:
    return client.put(f"{PRODUCTS}/{product_id}", json=body, headers=CSRF)


def action(client: FlaskClient, product_id: Any, name: str, version: int) -> Any:
    return client.post(f"{PRODUCTS}/{product_id}/{name}", json={"version": version}, headers=CSRF)


def delete(client: FlaskClient, product_id: Any, version: Any) -> Any:
    return client.delete(f"{PRODUCTS}/{product_id}?version={version}", headers=CSRF)


def upload_photo(
    client: FlaskClient,
    data: bytes,
    *,
    filename: str = "photo.png",
    content_type: str = "image/png",
) -> Any:
    return client.post(
        PHOTOS,
        data={"file": (io.BytesIO(data), filename, content_type)},
        content_type="multipart/form-data",
        headers=CSRF,
    )


def by_options(product: dict[str, Any]) -> dict[tuple[str, ...], dict[str, Any]]:
    return {tuple(v["option_values"]): v for v in product["variants"]}


# ---- database ---------------------------------------------------------------------------------


def count(
    owner: Engine, table: str, tenant_id: uuid.UUID, where: str = "true", **params: Any
) -> int:
    return int(
        owner_value(
            owner,
            f"SELECT count(*) FROM {table} WHERE tenant_id = :t AND {where}",  # noqa: S608
            t=tenant_id,
            **params,
        )
    )


def movements(owner: Engine, tenant_id: uuid.UUID) -> list[Any]:
    return owner_rows(
        owner,
        "SELECT inventory_item_id, quantity, reason, source, on_hand_after, actor_type, actor_id, "
        "request_key FROM stock_movements WHERE tenant_id = :t ORDER BY seq",
        t=tenant_id,
    )


def catalog_snapshot(owner: Engine, tenant_id: uuid.UUID) -> list[Any]:
    """Every catalog row of one business (to prove a refused request changed nothing)."""
    tables = [
        ("products", "id, code, name_en, status, version"),
        ("product_stores", "product_id, store_id"),
        ("product_options", "id, name, position"),
        ("option_values", "id, label, status"),
        ("product_photos", "id, product_id, position"),
        ("variants", "id, sku, price, currency, status, photo_id"),
        ("inventory_items", "id"),
        ("stock_balances", "inventory_item_id, on_hand, allocated, version"),
        ("stock_movements", "id"),
        ("files", "id"),
    ]
    return [
        sorted(
            tuple(map(str, row))
            for row in owner_rows(
                owner,
                f"SELECT {columns} FROM {table} WHERE tenant_id = :t",  # noqa: S608
                t=tenant_id,
            )
        )
        for table, columns in tables
    ]
