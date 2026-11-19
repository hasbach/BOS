"""T040 — catalog search, filters, paging and store scope (FR-009, FR-029, FR-030, R49, R51, R52).

``GET /api/v1/catalog/products``. Products are arranged directly in the database
(``tests.dbsupport.insert_product``) so each test reads exactly the catalog it describes.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from tests.dbsupport import CatalogProduct, TwoTenants, insert_product
from tests.integration.catalog_support import PRODUCTS
from tests.integration.us1_support import (
    app_for,
    history,
    ok,
    owner_sql,
    refused,
    shared_app_fixture,
)

pytestmark = pytest.mark.usefixtures("integrity_check")

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


@dataclass(frozen=True)
class Catalog:
    jeans: CatalogProduct  # store A, two variants: 5 and 0 available (in stock and low)
    tee: CatalogProduct  # second store, out of stock (so also "low": level 2 > 0)
    hoodie: CatalogProduct  # no store, low (1 available, level 2)
    old: CatalogProduct  # store A, archived
    sale: CatalogProduct  # store A, name with % and _, has a photo-less LBP + USD price


def _arrange(owner: Engine, worlds: TwoTenants) -> Catalog:
    a = worlds.a
    with owner.begin() as conn:
        jeans = insert_product(
            conn,
            a.tenant_id,
            a.user_id,
            variants=2,
            on_hand=[5, 0],
            code="JN-SLIM",
            name_en="Slim Jeans",
            name_ar="جينز ضيق",
            store_ids=(a.store_id,),
            price="25.00",
        )
        tee = insert_product(
            conn,
            a.tenant_id,
            a.user_id,
            code="TEE-100",
            name_en="Cotton tee",
            store_ids=(a.second_store_id,),
        )
        hoodie = insert_product(
            conn, a.tenant_id, a.user_id, code="HD-1", name_en="Hoodie", on_hand=1
        )
        old = insert_product(
            conn,
            a.tenant_id,
            a.user_id,
            code="OLD-1",
            name_en="Old jeans",
            status="archived",
            store_ids=(a.store_id,),
            on_hand=3,
        )
        sale = insert_product(
            conn,
            a.tenant_id,
            a.user_id,
            variants=3,
            on_hand=4,
            code="SALE_1",
            name_en="50% off_bundle",
            store_ids=(a.store_id,),
            price="10.00",
        )
    # Distinct creation times, oldest first in the order above.
    for minutes, product in enumerate((jeans, tee, hoodie, old, sale)):
        owner_sql(
            owner,
            "UPDATE products SET created_at = now() - make_interval(mins => :m) WHERE id = :p",
            m=60 - minutes,
            p=product.product_id,
        )
    owner_sql(
        owner,
        "UPDATE variants SET price = 89500000, currency = 'LBP' WHERE id = :v",
        v=sale.variant_ids[2],
    )
    owner_sql(owner, "UPDATE variants SET price = 7.5 WHERE id = :v", v=sale.variant_ids[1])
    return Catalog(jeans, tee, hoodie, old, sale)


def _codes(body: Any) -> list[str]:
    return [item["code"] for item in body["items"]]


def _search(client: FlaskClient, **params: Any) -> Any:
    return client.get(PRODUCTS, query_string=params)


@pytest.fixture()
def catalog(owner_engine: Engine, worlds: TwoTenants) -> Catalog:
    return _arrange(owner_engine, worlds)


@pytest.fixture()
def owner(user_client: UserClient, worlds: TwoTenants) -> FlaskClient:
    return user_client(worlds.a.user_id, worlds.a.tenant_id)


# ---- matching ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("q", "codes"),
    [
        ("slim", ["JN-SLIM"]),
        ("JEANS", ["JN-SLIM"]),
        ("ضيق", ["JN-SLIM"]),
        ("tee-1", ["TEE-100"]),
        ("jn-slim-2", ["JN-SLIM"]),
        ("hd", ["HD-1"]),
        ("  Hoodie  ", ["HD-1"]),
        ("nothing-like-it", []),
    ],
)
def test_q_matches_names_codes_and_skus_partially_ignoring_case(
    owner: FlaskClient, catalog: Catalog, q: str, codes: list[str]
) -> None:
    assert _codes(ok(_search(owner, q=q))) == codes


@pytest.mark.parametrize(("q", "codes"), [("%", ["SALE_1"]), ("_", ["SALE_1"]), ("\\", [])])
def test_wildcards_in_q_are_literal(
    owner: FlaskClient, catalog: Catalog, q: str, codes: list[str]
) -> None:
    assert _codes(ok(_search(owner, q=q))) == codes


def test_q_longer_than_100_characters_is_refused(owner: FlaskClient, catalog: Catalog) -> None:
    body = refused(_search(owner, q="x" * 101), 400, "validation_failed")
    assert body["error"]["fields"] == {"q": "too_long"}


@pytest.mark.parametrize(
    ("params", "field"),
    [
        ({"stock": "some"}, "stock"),
        ({"status": "gone"}, "status"),
        ({"no_photo": "maybe"}, "no_photo"),
        ({"cursor": "@@not-a-cursor"}, "cursor"),
        ({"store_id": "store-1"}, "store_id"),
    ],
)
def test_malformed_parameters_are_refused(
    owner: FlaskClient, catalog: Catalog, params: dict[str, str], field: str
) -> None:
    body = refused(_search(owner, **params), 400, "validation_failed")
    assert body["error"]["fields"] == {field: "invalid"}


# ---- filters -------------------------------------------------------------------------------------


def test_owners_see_every_active_product_newest_first(owner: FlaskClient, catalog: Catalog) -> None:
    body = ok(_search(owner))

    assert _codes(body) == ["SALE_1", "HD-1", "TEE-100", "JN-SLIM"]
    assert body["counts"] == {"all": 4, "in_stock": 3, "low": 3, "out": 1}
    assert body["next_cursor"] is None


@pytest.mark.parametrize(
    ("stock", "codes"),
    [
        ("in_stock", ["SALE_1", "HD-1", "JN-SLIM"]),
        ("low", ["HD-1", "TEE-100", "JN-SLIM"]),
        ("out", ["TEE-100"]),
    ],
)
def test_stock_filters_work_on_products(
    owner: FlaskClient, catalog: Catalog, stock: str, codes: list[str]
) -> None:
    assert _codes(ok(_search(owner, stock=stock))) == codes


def test_hd_is_low_and_in_stock(owner: FlaskClient, catalog: Catalog) -> None:
    [hoodie] = ok(_search(owner, q="HD-1"))["items"]
    assert (hoodie["stock_state"], hoodie["available_total"]) == ("low", 1)


def test_store_filter(owner: FlaskClient, catalog: Catalog, worlds: TwoTenants) -> None:
    body = ok(_search(owner, store_id=str(worlds.a.store_id)))

    assert _codes(body) == ["SALE_1", "JN-SLIM"]
    assert body["counts"]["all"] == 2


def test_archived_and_no_photo_filters_for_owners(
    owner: FlaskClient, owner_engine: Engine, catalog: Catalog
) -> None:
    assert _codes(ok(_search(owner, status="archived"))) == ["OLD-1"]
    assert _codes(ok(_search(owner, no_photo="true"))) == ["SALE_1", "HD-1", "TEE-100", "JN-SLIM"]


@pytest.mark.parametrize("params", [{"status": "archived"}, {"no_photo": "true"}])
@pytest.mark.parametrize("role", ["sales", "packing", "dispatch"])
def test_archived_and_no_photo_need_catalog_manage(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    catalog: Catalog,
    role: str,
    params: dict[str, str],
) -> None:
    a = worlds.a

    refused(_search(user_client(a.user(role), a.tenant_id), **params), 403, "forbidden")

    [entry] = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert entry.data["permission"] == "catalog.manage"
    assert entry.actor_id == a.user(role)


def test_a_store_outside_the_callers_stores_is_not_found_and_recorded(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, catalog: Catalog
) -> None:
    a = worlds.a
    limited = user_client(a.user("sales_limited"), a.tenant_id)

    other = _search(limited, store_id=str(a.second_store_id))
    made_up = _search(limited, store_id=str(uuid.uuid4()))
    foreign = _search(limited, store_id=str(worlds.b.store_id))

    assert other.status_code == made_up.status_code == foreign.status_code == 404
    assert other.get_data() == made_up.get_data() == foreign.get_data()
    [denied] = history(owner_engine, a.tenant_id, "access.denied_store")
    assert denied.data["store_id"] == str(a.second_store_id)
    assert denied.data["permission"] == "catalog.view"
    assert ok(_search(limited, store_id=str(a.store_id)))["items"]


# ---- paging --------------------------------------------------------------------------------------


def test_twenty_per_page_with_a_stable_cursor_while_products_are_added(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    with owner_engine.begin() as conn:
        made = [
            insert_product(conn, a.tenant_id, a.user_id, code=f"P-{n:02d}", name_en=f"Item {n}")
            for n in range(23)
        ]
    for n, product in enumerate(made):
        owner_sql(
            owner_engine,
            "UPDATE products SET created_at = now() - make_interval(mins => :m) WHERE id = :p",
            m=100 - n,
            p=product.product_id,
        )

    first = ok(_search(owner))
    with owner_engine.begin() as conn:
        insert_product(conn, a.tenant_id, a.user_id, code="P-NEW", name_en="Newest")
    second = ok(_search(owner, cursor=first["next_cursor"]))

    assert _codes(first) == [f"P-{n:02d}" for n in range(22, 2, -1)]
    assert first["counts"]["all"] == 23
    assert _codes(second) == ["P-02", "P-01", "P-00"]
    assert second["counts"] is None
    assert second["next_cursor"] is None


# ---- summaries -----------------------------------------------------------------------------------


def test_summary_prices_give_min_and_max_per_currency(owner: FlaskClient, catalog: Catalog) -> None:
    [sale] = ok(_search(owner, q="SALE"))["items"]

    assert sale["prices"] == [
        {"currency": "USD", "min": "7.50", "max": "10.00"},
        {"currency": "LBP", "min": "89500000.00", "max": "89500000.00"},
    ]
    assert sale["variant_count"] == 3
    assert sale["available_total"] == 12
    assert sale["main_photo_id"] is None
    assert sale["stock_state"] == "ok"


# ---- who sees what (R52) --------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["sales", "packing", "dispatch"])
def test_staff_see_only_active_products_listed_in_an_active_store_of_theirs(
    user_client: UserClient, worlds: TwoTenants, catalog: Catalog, role: str
) -> None:
    a = worlds.a

    body = ok(_search(user_client(a.user(role), a.tenant_id)))

    assert _codes(body) == ["SALE_1", "TEE-100", "JN-SLIM"]
    assert body["counts"]["all"] == 3


def test_a_store_limited_agent_sees_only_their_store(
    user_client: UserClient, worlds: TwoTenants, catalog: Catalog
) -> None:
    a = worlds.a
    body = ok(_search(user_client(a.user("sales_limited"), a.tenant_id)))

    assert _codes(body) == ["SALE_1", "JN-SLIM"]
    assert all(item["store_ids"] == [str(a.store_id)] for item in body["items"])


def test_products_of_an_inactive_store_return_when_it_is_reactivated(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, catalog: Catalog
) -> None:
    a = worlds.a
    limited = user_client(a.user("sales_limited"), a.tenant_id)
    owner = user_client(a.user_id, a.tenant_id)
    owner_sql(owner_engine, "UPDATE stores SET status = 'inactive' WHERE id = :s", s=a.store_id)

    hidden = ok(_search(limited))
    for_owner = ok(_search(owner))
    owner_sql(owner_engine, "UPDATE stores SET status = 'active' WHERE id = :s", s=a.store_id)
    back = ok(_search(limited))

    assert _codes(hidden) == []
    assert "JN-SLIM" in _codes(for_owner)
    assert _codes(back) == ["SALE_1", "JN-SLIM"]


@pytest.mark.parametrize("which", ["hoodie", "old", "tee"])
def test_products_out_of_scope_are_not_found_for_staff_but_readable_by_managers(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    catalog: Catalog,
    which: str,
) -> None:
    a = worlds.a
    product = getattr(catalog, which)
    path = f"{PRODUCTS}/{product.product_id}"
    limited = user_client(a.user("sales_limited"), a.tenant_id)

    refused(limited.get(path), 404, "not_found")
    assert ok(user_client(a.user("manager"), a.tenant_id).get(path))["id"] == str(
        product.product_id
    )
    [denied] = history(owner_engine, a.tenant_id, "access.denied_store")
    assert (denied.target_type, denied.target_id) == ("product", product.product_id)
    assert denied.data["permission"] == "catalog.view"


def test_staff_see_active_variants_and_only_their_stores(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, catalog: Catalog
) -> None:
    a = worlds.a
    owner_sql(
        owner_engine,
        "INSERT INTO product_stores (tenant_id, product_id, store_id) VALUES (:t, :p, :s)",
        t=a.tenant_id,
        p=catalog.jeans.product_id,
        s=a.second_store_id,
    )
    owner_sql(
        owner_engine,
        "UPDATE variants SET status = 'archived', archived_at = now() WHERE id = :v",
        v=catalog.jeans.variant_ids[1],
    )
    path = f"{PRODUCTS}/{catalog.jeans.product_id}"

    staff = ok(user_client(a.user("sales_limited"), a.tenant_id).get(path))
    manager = ok(user_client(a.user("manager"), a.tenant_id).get(path))

    assert [v["id"] for v in staff["variants"]] == [str(catalog.jeans.variant_ids[0])]
    assert staff["store_ids"] == [str(a.store_id)]
    assert len(manager["variants"]) == 2
    assert sorted(manager["store_ids"]) == sorted([str(a.store_id), str(a.second_store_id)])
