"""T079 — live low-stock warnings, catalog states and the manager's list (R49)."""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine, event, text

from app.config import Config
from app.core.db import engine_of
from tests.dbsupport import CatalogProduct, TwoTenants, insert_allocation, insert_product
from tests.integration.catalog_support import PRODUCTS
from tests.integration.stock_support import adjust, arrange_product, change
from tests.integration.us1_support import CSRF, app_for, ok, refused, shared_app_fixture
from tests.integration.us3_support import BUSINESS

pytestmark = pytest.mark.usefixtures("integrity_check")
LOW_STOCK = "/api/v1/catalog/low-stock"
UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


@pytest.fixture()
def owner(user_client: UserClient, worlds: TwoTenants) -> FlaskClient:
    return user_client(worlds.a.user_id, worlds.a.tenant_id)


def _list(client: FlaskClient, **params: Any) -> Any:
    return ok(client.get(LOW_STOCK, query_string=params))


def _variant(client: FlaskClient, product_id: uuid.UUID) -> Any:
    [variant] = ok(client.get(f"{PRODUCTS}/{product_id}"))["variants"]
    return variant


def test_list_and_sales_catalog_use_effective_threshold_and_available_stock(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, user_client: UserClient
) -> None:
    a = worlds.a
    with owner_engine.begin() as conn:

        def product(code: str, on_hand: int | list[int], **values: Any) -> CatalogProduct:
            return insert_product(
                conn,
                a.tenant_id,
                a.user_id,
                code=code,
                on_hand=on_hand,
                store_ids=(a.store_id,),
                **values,
            )

        inherited = product("INHERITED", 5)
        insert_allocation(conn, a.tenant_id, [(inherited.item_ids[0], 3)])
        override = product("OVERRIDE", 3, low_stock_level=3)
        disabled = product("DISABLED", 0, low_stock_level=0)
        out = product("OUT", 0)
        ok_stock = product("OK", 3)
        product("ARCHIVED-PRODUCT", 0, status="archived")
        archived = product("ARCHIVED-VARIANT", [0, 5], variants=2)
        conn.execute(
            text("UPDATE variants SET status = 'archived', archived_at = now() WHERE id = :id"),
            {"id": archived.variant_ids[0]},
        )

    sales = user_client(a.user("sales_limited"), a.tenant_id)
    for item, level, state in (
        (inherited, 2, "low"),
        (override, 3, "low"),
        (disabled, 0, "out"),
        (out, 2, "out"),
        (ok_stock, 2, "ok"),
    ):
        variant = _variant(sales, item.product_id)
        assert (variant["effective_low_stock_level"], variant["stock_state"]) == (level, state)

    page = _list(owner)
    assert page["total"] == 3
    assert [item["sku"] for item in page["items"]] == [
        out.skus[0],
        inherited.skus[0],
        override.skus[0],
    ]
    assert page["items"][1] == {
        "product_id": str(inherited.product_id),
        "product_name_en": "Product",
        "product_name_ar": None,
        "variant_id": str(inherited.variant_ids[0]),
        "sku": inherited.skus[0],
        "option_values": [],
        "main_photo_id": None,
        "on_hand": 5,
        "allocated": 3,
        "available": 2,
        "level": 2,
        "stock_state": "low",
    }
    assert page["items"][0]["stock_state"] == "out"
    search = ok(sales.get(PRODUCTS, query_string={"stock": "low"}))
    assert {item["id"] for item in search["items"]} == {
        str(item.product_id) for item in (out, inherited, override)
    }

    ok(owner.patch(BUSINESS, json={"low_stock_default": 0}, headers=CSRF))
    assert _variant(sales, out.product_id)["stock_state"] == "out"
    assert [item["sku"] for item in _list(owner)["items"]] == override.skus
    search = ok(sales.get(PRODUCTS, query_string={"stock": "low"}))
    assert [item["id"] for item in search["items"]] == [str(override.product_id)]


def test_list_is_paged_by_availability_and_sku_and_can_filter_by_store(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    with owner_engine.begin() as conn:
        main = insert_product(
            conn,
            a.tenant_id,
            a.user_id,
            code="MAIN",
            variants=20,
            on_hand=1,
            store_ids=(a.store_id,),
        )
        second = insert_product(
            conn,
            a.tenant_id,
            a.user_id,
            code="SECOND",
            variants=3,
            on_hand=[0, 1, 2],
            store_ids=(a.second_store_id,),
        )
    expected = [second.skus[0], *sorted([*main.skus, second.skus[1]]), second.skus[2]]
    first = _list(owner)
    assert [it["sku"] for it in first["items"]] == expected[:20]
    assert first["total"] == 23
    assert first["next_cursor"]
    rest = _list(owner, cursor=first["next_cursor"])
    assert [it["sku"] for it in rest["items"]] == expected[20:]
    assert "total" not in rest
    assert rest["next_cursor"] is None
    filtered = _list(owner, store_id=a.second_store_id)
    assert filtered["total"] == 3
    assert filtered["next_cursor"] is None
    assert [it["sku"] for it in filtered["items"]] == second.skus
    assert [it["option_values"] for it in filtered["items"]] == [["S1"], ["S2"], ["S3"]]


def test_recording_stock_changes_moves_a_variant_into_and_out_of_the_list(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=5, low_stock_level=3)
    variant_id = product.variant_ids[0]
    assert _list(owner)["total"] == 0
    damaged = adjust(owner, variant_id, change("damaged", 2))
    assert damaged.status_code == 201, damaged.get_data(as_text=True)
    assert _variant(owner, product.product_id)["stock_state"] == "low"
    [item] = _list(owner)["items"]
    assert item["variant_id"] == str(variant_id)
    assert (item["available"], item["level"]) == (3, 3)
    received = adjust(owner, variant_id, change("received", 4, version=2))
    assert received.status_code == 201, received.get_data(as_text=True)
    assert _list(owner)["total"] == 0
    assert _variant(owner, product.product_id)["stock_state"] == "ok"


@pytest.mark.parametrize("field", ["cursor", "store_id"])
def test_list_refuses_malformed_query_parameters(owner: FlaskClient, field: str) -> None:
    response = owner.get(LOW_STOCK, query_string={field: "invalid!"})
    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == {field: "invalid"}


@pytest.mark.parametrize("position", [[1, "not a SKU"], [True, "SKU"], [-1, "SKU"]])
def test_list_refuses_an_invalid_keyset_position(owner: FlaskClient, position: list[Any]) -> None:
    cursor = base64.urlsafe_b64encode(json.dumps(position).encode()).decode().rstrip("=")
    response = owner.get(LOW_STOCK, query_string={"cursor": cursor})
    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == {"cursor": "invalid"}


# ---- plans (T107, SC-006) ------------------------------------------------------------------------


def test_list_is_planned_for_the_current_business_every_time(
    app: Flask, user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    """Like the catalog search (``test_catalog_search``): the list is a prepared statement
    on a pooled connection, and row-level security reads the business when a plan is made.
    Run alternately for a small and a larger business more than five times on the same
    connection, it must never use a generic plan and must show each business its own list."""
    a, b = worlds.a, worlds.b
    with owner_engine.begin() as conn:
        small_low = insert_product(conn, a.tenant_id, a.user_id, code="SMALL-LOW", on_hand=1)
        large_low = [
            insert_product(conn, b.tenant_id, b.user_id, code=f"LARGE-{n}", variants=2, on_hand=n)
            for n in range(12)
        ]
    small_skus = [small_low.skus[0]]
    # Level 2 (the business default): variants with 0, 1 or 2 available are listed.
    large_skus = sorted(sku for product in large_low[:3] for sku in product.skus)
    small = user_client(a.user_id, a.tenant_id)
    large = user_client(b.user_id, b.tenant_id)
    plans: list[tuple[int, int]] = []
    modes: list[str] = []
    marker = "SELECT p.id AS product_id, p.name_en"

    def inspect(_conn: Any, cursor: Any, statement: str, *_: Any) -> None:
        if statement.startswith(marker):
            plans.extend(
                cursor.connection.execute(
                    "SELECT generic_plans, custom_plans FROM pg_prepared_statements "
                    "WHERE starts_with(statement, %s)",
                    (marker,),
                ).fetchall()
            )
            modes.append(
                cursor.connection.execute("SELECT current_setting('plan_cache_mode')").fetchone()[0]
            )

    engine = engine_of(app)
    event.listen(engine, "after_cursor_execute", inspect)
    try:
        for _ in range(12):
            assert [item["sku"] for item in _list(small)["items"]] == small_skus
            page = _list(large)
            assert page["total"] == len(large_skus)
            assert sorted(item["sku"] for item in page["items"]) == large_skus
    finally:
        event.remove(engine, "after_cursor_execute", inspect)

    assert max(generic + custom for generic, custom in plans) > 5
    assert all(generic == 0 for generic, _ in plans)
    assert modes and set(modes) == {"force_custom_plan"}
