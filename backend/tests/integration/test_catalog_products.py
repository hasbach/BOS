"""T038 — products: create, read, edit, archive, restore, delete (FR-001 to FR-008).

``/api/v1/catalog/products`` and ``/api/v1/catalog/products/{productId}``. Every response is
checked against the M1 contract; every test ends with the stock integrity check.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable, Iterator
from decimal import Decimal
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from tests.dbsupport import TwoTenants, insert_allocation, insert_product
from tests.integration.catalog_support import (
    PRODUCTS,
    action,
    as_update,
    by_options,
    catalog_snapshot,
    count,
    create,
    created,
    delete,
    jeans,
    movements,
    put,
    simple,
    variant,
)
from tests.integration.us1_support import (
    CSRF,
    app_for,
    history,
    ok,
    owner_rows,
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


@pytest.fixture()
def owner(user_client: UserClient, worlds: TwoTenants) -> FlaskClient:
    return user_client(worlds.a.user_id, worlds.a.tenant_id)


def _with_history(owner: FlaskClient, sizes: tuple[str, ...] = ("S", "M")) -> dict[str, Any]:
    """A one-option product whose first variant has stock history (opening 3)."""
    body = {
        "code": "SH-1",
        "name_en": "Shirt",
        "options": [{"name": "Size", "values": [{"label": s} for s in sizes]}],
        "variants": [variant(s, opening=3 if i == 0 else 0) for i, s in enumerate(sizes)],
    }
    return created(owner, body)


# ---- create -------------------------------------------------------------------------------------


def test_two_options_give_six_variants_each_with_item_balance_and_opening_movement(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    body = jeans(store_ids=[a.store_id])
    for index, item in enumerate(body["variants"]):
        item["opening_quantity"] = index  # 0..5: the first has no movement

    product = ok(create(owner, body), 201)

    assert len(product["variants"]) == 6
    assert {tuple(v["option_values"]) for v in product["variants"]} == {
        (s, c) for s in ("30", "32", "34") for c in ("Blue", "Black")
    }
    assert by_options(product)[("32", "Blue")]["sku"] == "JN-SLIM-32-BLUE"
    assert len({v["inventory_item_id"] for v in product["variants"]}) == 6
    assert [v["stock"]["on_hand"] for v in product["variants"]] == [0, 1, 2, 3, 4, 5]
    assert product["store_ids"] == [str(a.store_id)]
    assert product["version"] == 1 and product["status"] == "active"
    assert product["has_history"] is True
    assert count(owner_engine, "inventory_items", a.tenant_id) == 6
    assert count(owner_engine, "stock_balances", a.tenant_id) == 6
    moves = movements(owner_engine, a.tenant_id)
    assert [m.quantity for m in moves] == [1, 2, 3, 4, 5]
    assert {(m.reason, m.source, m.actor_type, m.actor_id) for m in moves} == {
        ("opening", "product_form", "user", a.user_id)
    }
    assert [m.on_hand_after for m in moves] == [1, 2, 3, 4, 5]
    [entry] = history(owner_engine, a.tenant_id, "product.created")
    assert entry.target_id == uuid.UUID(product["id"])
    assert entry.data["opening_units"] == 15
    assert entry.data["variants"] == 6
    assert entry.data["code"] == "JN-SLIM"
    assert entry.data["store_ids"] == [str(a.store_id)]


def test_a_product_without_options_has_exactly_one_variant(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    product = ok(create(owner, simple("TEE-1")), 201)

    [only] = product["variants"]
    assert only["option_values"] == [] and only["sku"] == "TEE-1"
    assert product["options"] == []
    assert product["has_history"] is False
    assert movements(owner_engine, worlds.a.tenant_id) == []


def test_a_typed_sku_is_kept_as_typed_after_trimming(owner: FlaskClient) -> None:
    body = simple("TEE-2")
    body["variants"][0]["sku"] = "  tee-Two "

    product = ok(create(owner, body), 201)

    assert product["variants"][0]["sku"] == "tee-Two"


def _break(body: dict[str, Any], change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    change(body)
    return body


def _set(path: str, value: Any) -> Callable[[dict[str, Any]], None]:
    def change(body: dict[str, Any]) -> None:
        target: Any = body
        parts = path.split(".")
        for part in parts[:-1]:
            target = target[int(part)] if isinstance(target, list) else target[part]
        last = parts[-1]
        if isinstance(target, list):
            target[int(last)] = value
        else:
            target[last] = value

    return change


def _drop(name: str) -> Callable[[dict[str, Any]], None]:
    return lambda body: body.pop(name, None)


TWO_OPTION_CASES: list[tuple[str, Callable[[dict[str, Any]], None], str, str]] = [
    ("code-missing", _drop("code"), "code", "required"),
    ("code-blank", _set("code", "  "), "code", "required"),
    ("code-long", _set("code", "C" * 33), "code", "too_long"),
    ("code-chars", _set("code", "JN SLIM"), "code", "invalid"),
    ("code-arabic", _set("code", "جينز"), "code", "invalid"),
    (
        "no-names",
        lambda b: b.update(name_en=None, name_ar="  "),
        "name_en",
        "required",
    ),
    ("name-en-long", _set("name_en", "n" * 121), "name_en", "too_long"),
    ("name-ar-long", _set("name_ar", "ن" * 121), "name_ar", "too_long"),
    ("desc-en-long", _set("description_en", "d" * 2001), "description_en", "too_long"),
    ("desc-ar-long", _set("description_ar", "د" * 2001), "description_ar", "too_long"),
    ("stores-not-list", _set("store_ids", "x"), "store_ids", "invalid"),
    ("stores-not-uuid", _set("store_ids", ["nope"]), "store_ids", "invalid"),
    ("stores-unknown", _set("store_ids", [str(uuid.uuid4())]), "store_ids", "invalid"),
    (
        "photos-too-many",
        _set("photo_ids", [str(uuid.uuid4()) for _ in range(9)]),
        "photo_ids",
        "too_many",
    ),
    ("photos-unknown", _set("photo_ids", [str(uuid.uuid4())]), "photo_ids", "invalid"),
    (
        "options-too-many",
        lambda b: b["options"].append({"name": "Fit", "values": [{"label": "Slim"}]}),
        "options",
        "too_many",
    ),
    ("option-name", _set("options.0.name", " "), "options.0.name", "required"),
    ("option-name-long", _set("options.0.name", "o" * 41), "options.0.name", "too_long"),
    (
        "values-too-many",
        _set("options.1.values", [{"label": f"C{i}"} for i in range(21)]),
        "options.1.values",
        "too_many",
    ),
    (
        "values-duplicate",
        _set("options.1.values", [{"label": "Blue"}, {"label": "BLUE"}]),
        "options.1.values",
        "duplicate",
    ),
    (
        "value-label-long",
        _set("options.0.values.0.label", "v" * 41),
        "options.0.values.0",
        "too_long",
    ),
    ("variants-missing-one", lambda b: b["variants"].pop(), "variants", "invalid"),
    (
        "variants-extra",
        lambda b: b["variants"].append(variant("36", "Blue")),
        "variants",
        "invalid",
    ),
    (
        "variants-repeated",
        lambda b: b["variants"].__setitem__(1, variant("30", "Blue")),
        "variants",
        "invalid",
    ),
    ("sku-long", _set("variants.2.sku", "S" * 65), "variants.2.sku", "too_long"),
    ("sku-chars", _set("variants.2.sku", "SKU 1"), "variants.2.sku", "invalid"),
    (
        "sku-duplicate",
        lambda b: (_set("variants.0.sku", "same")(b), _set("variants.3.sku", "SAME ")(b)),
        "variants.3.sku",
        "duplicate",
    ),
    ("price-missing", _set("variants.1.price", None), "variants.1.price", "required"),
    ("price-number", _set("variants.1.price", 25), "variants.1.price", "invalid"),
    ("price-3-decimals", _set("variants.1.price", "1.005"), "variants.1.price", "invalid"),
    ("price-negative", _set("variants.1.price", "-1"), "variants.1.price", "invalid"),
    ("price-large", _set("variants.1.price", "100000000000.00"), "variants.1.price", "too_large"),
    (
        "price-lbp-cents",
        lambda b: b["variants"][1].update(price="89500.50", currency="LBP"),
        "variants.1.price",
        "not_whole",
    ),
    ("currency", _set("variants.1.currency", "EUR"), "variants.1.currency", "invalid"),
    (
        "level-text",
        _set("variants.1.low_stock_level", "3"),
        "variants.1.low_stock_level",
        "invalid",
    ),
    (
        "level-negative",
        _set("variants.1.low_stock_level", -1),
        "variants.1.low_stock_level",
        "invalid",
    ),
    (
        "level-large",
        _set("variants.1.low_stock_level", 1_000_001),
        "variants.1.low_stock_level",
        "too_large",
    ),
    (
        "opening-text",
        _set("variants.1.opening_quantity", "5"),
        "variants.1.opening_quantity",
        "invalid",
    ),
    (
        "opening-bool",
        _set("variants.1.opening_quantity", True),
        "variants.1.opening_quantity",
        "invalid",
    ),
    (
        "opening-decimal",
        _set("variants.1.opening_quantity", 1.5),
        "variants.1.opening_quantity",
        "invalid",
    ),
    (
        "opening-negative",
        _set("variants.1.opening_quantity", -1),
        "variants.1.opening_quantity",
        "invalid",
    ),
    (
        "opening-large",
        _set("variants.1.opening_quantity", 1_000_001),
        "variants.1.opening_quantity",
        "too_large",
    ),
    (
        "photo-not-listed",
        _set("variants.1.photo_id", str(uuid.uuid4())),
        "variants.1.photo_id",
        "invalid",
    ),
]


@pytest.mark.parametrize(
    ("change", "field", "code"),
    [c[1:] for c in TWO_OPTION_CASES],
    ids=[c[0] for c in TWO_OPTION_CASES],
)
def test_every_field_rule_is_answered_with_its_field_code_and_nothing_is_saved(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    change: Callable[[dict[str, Any]], None],
    field: str,
    code: str,
) -> None:
    before = catalog_snapshot(owner_engine, worlds.a.tenant_id)

    body = refused(create(owner, _break(jeans(opening=2), change)), 400, "validation_failed")

    assert body["error"]["fields"].get(field) == code, body["error"]["fields"]
    assert catalog_snapshot(owner_engine, worlds.a.tenant_id) == before


def test_variants_over_100_are_too_many(owner: FlaskClient) -> None:
    body = jeans(sizes=tuple(str(n) for n in range(20)), colours=tuple(f"C{n}" for n in range(6)))

    error = refused(create(owner, body), 400, "validation_failed")

    assert error["error"]["fields"]["variants"] == "too_many"


def test_no_variant_at_all_is_refused(owner: FlaskClient) -> None:
    error = refused(create(owner, simple(variants=[])), 400, "validation_failed")
    assert error["error"]["fields"]["variants"] in ("required", "invalid")


# ---- SKU and code uniqueness (FR-005, SC-004) --------------------------------------------------


@pytest.mark.parametrize("typed", ["TEE-1", "tee-1", "  Tee-1  "])
def test_a_sku_used_by_another_product_is_refused_ignoring_case_and_spaces(
    owner: FlaskClient, worlds: TwoTenants, typed: str
) -> None:
    first = created(owner, simple("TEE-1"))
    body = simple("OTHER")
    body["variants"][0]["sku"] = typed

    error = refused(create(owner, body), 409, "sku_in_use")["error"]

    assert error["fields"] == {"variants.0.sku": "in_use"}
    assert error["conflicts"] == [
        {"sku": "TEE-1", "product_id": first["id"], "product_name": "Product TEE-1"}
    ]


def test_archived_variants_and_products_keep_their_sku_reserved(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    with owner_engine.begin() as conn:
        archived_product = insert_product(
            conn, a.tenant_id, a.user_id, code="OLD-1", status="archived", name_en="Old"
        )
        archived_variant = insert_product(conn, a.tenant_id, a.user_id, variants=2, code="VAR-1")
    owner_sql(
        owner_engine,
        "UPDATE variants SET status = 'archived', archived_at = now() WHERE id = :v",
        v=archived_variant.variant_ids[1],
    )
    body = simple("NEW-1", variants=[variant(sku="old-1")])
    body2 = simple("NEW-2", variants=[variant(sku="VAR-1-2")])

    first = refused(create(owner, body), 409, "sku_in_use")["error"]
    second = refused(create(owner, body2), 409, "sku_in_use")["error"]

    assert first["conflicts"][0]["product_id"] == str(archived_product.product_id)
    assert second["conflicts"][0]["product_id"] == str(archived_variant.product_id)


def test_the_same_sku_and_code_in_another_business_are_allowed(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    created(user_client(worlds.b.user_id, worlds.b.tenant_id), simple("TEE-1"))

    product = ok(create(user_client(worlds.a.user_id, worlds.a.tenant_id), simple("TEE-1")), 201)

    assert product["variants"][0]["sku"] == "TEE-1"


@pytest.mark.parametrize("typed", ["JN-SLIM", "jn-slim", " Jn-Slim "])
def test_a_product_code_in_use_is_refused(owner: FlaskClient, typed: str) -> None:
    created(owner, jeans())

    error = refused(create(owner, jeans(code=typed)), 409, "product_code_in_use")["error"]

    assert error["fields"] == {"code": "in_use"}


def test_suggested_skus_skip_taken_ones(owner: FlaskClient) -> None:
    created(owner, simple("XX", variants=[variant(sku="ts2-red")]))
    body = {
        "code": "TS2",
        "name_en": "T-shirt",
        "options": [{"name": "Colour", "values": [{"label": "Red"}, {"label": "أحمر"}]}],
        "variants": [
            variant("Red"),
            variant("أحمر"),
        ],
    }
    body["variants"][1]["sku"] = "TS2-RED-2"  # typed SKUs are taken before suggesting

    product = ok(create(owner, body), 201)

    assert [v["sku"] for v in product["variants"]] == ["TS2-RED-3", "TS2-RED-2"]


# ---- stores (data-model.md product_stores) --------------------------------------------------------


def test_an_inactive_store_is_refused_on_create(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    owner_sql(
        owner_engine, "UPDATE stores SET status = 'inactive' WHERE id = :s", s=a.second_store_id
    )

    error = refused(
        create(owner, simple(store_ids=[a.store_id, a.second_store_id])), 400, "validation_failed"
    )

    assert error["error"]["fields"] == {"store_ids": "invalid"}


def test_another_business_store_is_refused(owner: FlaskClient, worlds: TwoTenants) -> None:
    error = refused(create(owner, simple(store_ids=[worlds.b.store_id])), 400, "validation_failed")
    assert error["error"]["fields"] == {"store_ids": "invalid"}


def test_a_listing_in_a_store_deactivated_later_is_kept_but_cannot_be_added(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    listed = created(owner, simple("A-1", store_ids=[a.store_id]))
    other = created(owner, simple("B-1", store_ids=[a.store_id]))
    owner_sql(owner_engine, "UPDATE stores SET status = 'inactive' WHERE id = :s", s=a.store_id)
    owner_sql(
        owner_engine, "UPDATE stores SET status = 'active' WHERE id = :s", s=a.second_store_id
    )

    kept = ok(put(owner, listed["id"], {**as_update(listed), "name_en": "Renamed"}))
    body = as_update(other)
    body["store_ids"] = [str(a.store_id)]
    still = ok(put(owner, other["id"], body))
    readded = as_update(still)
    readded["store_ids"] = []
    emptied = ok(put(owner, other["id"], readded))
    again = as_update(emptied)
    again["store_ids"] = [str(a.store_id)]
    error = refused(put(owner, other["id"], again), 400, "validation_failed")

    assert kept["store_ids"] == [str(a.store_id)]
    assert still["store_ids"] == [str(a.store_id)]
    assert error["error"]["fields"] == {"store_ids": "invalid"}


# ---- prices (FR-006) ------------------------------------------------------------------------------


def test_prices_are_stored_exactly_with_their_currency_and_never_converted(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    body = {
        "code": "PR-1",
        "name_en": "Priced",
        "options": [{"name": "Size", "values": [{"label": "S"}, {"label": "M"}]}],
        "variants": [
            variant("S", price="12.5"),
            variant("M", price="89500000", currency="LBP"),
        ],
    }
    product = ok(create(owner, body), 201)

    response = owner.patch("/api/v1/business", json={"usd_lbp_rate": "100000.00"}, headers=CSRF)
    assert response.status_code == 200
    again = ok(owner.get(f"{PRODUCTS}/{product['id']}"))

    assert [(v["price"], v["currency"]) for v in again["variants"]] == [
        ("12.50", "USD"),
        ("89500000.00", "LBP"),
    ]
    rows = owner_rows(
        owner_engine,
        "SELECT price, currency FROM variants WHERE product_id = :p ORDER BY position",
        p=product["id"],
    )
    assert [(r.price, r.currency) for r in rows] == [
        (Decimal("12.50"), "USD"),
        (Decimal("89500000.00"), "LBP"),
    ]


# ---- idempotency (R44, Principle IV, SC-002) ----------------------------------------------------


def test_repeating_a_create_with_the_same_key_creates_nothing_new(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    body = jeans(opening=2)

    first = ok(create(owner, body, key="form-1"), 201)
    second = ok(create(owner, body, key="form-1"), 201)

    assert second["id"] == first["id"]
    assert count(owner_engine, "products", a.tenant_id) == 1
    assert len(movements(owner_engine, a.tenant_id)) == 6
    assert len(history(owner_engine, a.tenant_id, "product.created")) == 1
    other = refused(create(owner, jeans(code="OTHER"), key="form-1"), 409, "idempotency_conflict")
    assert other["error"]["code"] == "idempotency_conflict"


def test_a_refused_create_can_be_corrected_and_sent_again_with_the_same_key(
    owner: FlaskClient,
) -> None:
    refused(create(owner, jeans(code="bad code"), key="form-2"), 400, "validation_failed")

    ok(create(owner, jeans(), key="form-2"), 201)


def test_two_identical_creates_at_the_same_moment_create_one_product(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    clients = [user_client(a.user_id, a.tenant_id) for _ in range(2)]
    barrier = threading.Barrier(2)
    results: list[Any] = [None, None]
    body = jeans(opening=1)

    def send(index: int) -> None:
        barrier.wait()
        results[index] = create(clients[index], body, key="race-1")

    threads = [threading.Thread(target=send, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert [r.status_code for r in results] == [201, 201], [r.get_json() for r in results]
    assert len({r.get_json()["id"] for r in results}) == 1
    assert count(owner_engine, "products", a.tenant_id) == 1
    assert len(movements(owner_engine, a.tenant_id)) == 6
    assert len(history(owner_engine, a.tenant_id, "product.created")) == 1


# ---- editing (FR-004, FR-008) ---------------------------------------------------------------------


def test_a_stale_version_is_refused_with_the_current_product(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    product = created(owner, jeans())
    first = ok(put(owner, product["id"], {**as_update(product), "name_en": "First"}))
    before = catalog_snapshot(owner_engine, worlds.a.tenant_id)

    error = refused(
        put(owner, product["id"], {**as_update(product), "name_en": "Second"}),
        409,
        "product_changed",
    )["error"]

    assert error["current"]["version"] == first["version"] == 2
    assert error["current"]["name_en"] == "First"
    assert catalog_snapshot(owner_engine, worlds.a.tenant_id) == before


def test_renaming_options_values_skus_and_prices_keeps_every_inventory_item(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    product = created(owner, jeans(opening=1))
    items = {v["id"]: v["inventory_item_id"] for v in product["variants"]}
    body = as_update(product)
    body["options"][0]["name"] = "Waist"
    body["options"][1]["values"][0]["label"] = "Navy"
    for item in body["variants"]:
        item["option_values"] = ["Navy" if x == "Blue" else x for x in item["option_values"]]
        item["sku"] = "X-" + item["sku"]
        item["price"] = "30.00"

    updated = ok(put(owner, product["id"], body))

    assert {v["id"]: v["inventory_item_id"] for v in updated["variants"]} == items
    assert updated["options"][0]["name"] == "Waist"
    assert ("32", "Navy") in by_options(updated)
    assert {v["price"] for v in updated["variants"]} == {"30.00"}
    assert by_options(updated)[("32", "Navy")]["sku"] == "X-JN-SLIM-32-BLUE"
    assert updated["version"] == 2


def test_swapping_two_skus_in_one_save_works(owner: FlaskClient) -> None:
    product = created(owner, jeans())
    body = as_update(product)
    body["variants"][0]["sku"], body["variants"][1]["sku"] = (
        body["variants"][1]["sku"],
        body["variants"][0]["sku"],
    )

    updated = ok(put(owner, product["id"], body))

    assert updated["variants"][0]["sku"] == product["variants"][1]["sku"]


def test_adding_a_value_creates_zero_stock_variants(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    product = created(owner, jeans(opening=1))
    body = as_update(product)
    body["options"][0]["values"].append({"label": "36"})
    body["variants"] += [variant("36", "Blue"), variant("36", "Black")]

    updated = ok(put(owner, product["id"], body))

    assert len(updated["variants"]) == 8
    new = [by_options(updated)[("36", c)] for c in ("Blue", "Black")]
    assert [v["stock"]["on_hand"] for v in new] == [0, 0]
    assert [v["sku"] for v in new] == ["JN-SLIM-36-BLUE", "JN-SLIM-36-BLACK"]
    assert len(movements(owner_engine, worlds.a.tenant_id)) == 6
    [entry] = history(owner_engine, worlds.a.tenant_id, "product.updated")
    assert sorted(entry.data["variants_added"]) == ["JN-SLIM-36-BLACK", "JN-SLIM-36-BLUE"]


def test_opening_quantity_is_refused_on_update(owner: FlaskClient) -> None:
    product = created(owner, jeans())
    body = as_update(product)
    body["variants"][0]["opening_quantity"] = 5

    error = refused(put(owner, product["id"], body), 400, "validation_failed")

    assert error["error"]["fields"] == {"variants.0.opening_quantity": "invalid"}


def test_removing_a_value_archives_variants_with_history_and_deletes_the_others(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    body = jeans()
    by = {tuple(v["option_values"]): v for v in body["variants"]}
    by[("34", "Blue")]["opening_quantity"] = 2
    product = created(owner, body)
    kept = by_options(product)[("34", "Blue")]
    gone = by_options(product)[("34", "Black")]
    update = as_update(product)
    update["options"][0]["values"] = [
        v for v in update["options"][0]["values"] if v["label"] != "34"
    ]
    update["variants"] = [v for v in update["variants"] if v["option_values"][0] != "34"]

    updated = ok(put(owner, product["id"], update))

    statuses = {v["id"]: v["status"] for v in updated["variants"]}
    assert statuses[kept["id"]] == "archived"
    assert gone["id"] not in statuses
    assert [v["label"] for v in updated["options"][0]["values"]] == ["30", "32"]
    assert count(owner_engine, "inventory_items", a.tenant_id) == 5
    assert count(owner_engine, "stock_balances", a.tenant_id) == 5
    rows = owner_rows(
        owner_engine,
        "SELECT status FROM option_values WHERE product_id = :p AND label = '34'",
        p=product["id"],
    )
    assert [r.status for r in rows] == ["archived"]
    [entry] = history(owner_engine, a.tenant_id, "product.updated")
    assert entry.data["variants_archived"] == [kept["sku"]]
    assert entry.data["variants_deleted"] == [gone["sku"]]


def test_the_number_of_options_cannot_change_once_a_variant_has_history(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    product = _with_history(owner)
    body = as_update(product)
    body["options"].append({"name": "Colour", "values": [{"label": "Red"}]})
    body["variants"] = [
        {**v, "option_values": [*v["option_values"], "Red"]} for v in body["variants"]
    ]
    before = catalog_snapshot(owner_engine, worlds.a.tenant_id)

    refused(put(owner, product["id"], body), 409, "options_locked")

    assert catalog_snapshot(owner_engine, worlds.a.tenant_id) == before


def test_the_number_of_options_can_change_while_nothing_has_history(owner: FlaskClient) -> None:
    product = created(owner, simple("TEE-9"))
    body = as_update(product)
    body["options"] = [{"name": "Size", "values": [{"label": "S"}, {"label": "M"}]}]
    body["variants"] = [variant("S"), variant("M")]

    updated = ok(put(owner, product["id"], body))

    assert [v["option_values"] for v in updated["variants"]] == [["S"], ["M"]]


def test_restoring_a_variant_reactivates_its_value(owner: FlaskClient) -> None:
    product = _with_history(owner)
    removed = as_update(product)
    removed["options"][0]["values"] = removed["options"][0]["values"][1:]
    removed["variants"] = removed["variants"][1:]
    archived = ok(put(owner, product["id"], removed))
    old = next(v for v in archived["variants"] if v["status"] == "archived")
    restore = as_update(archived)
    restore["options"][0]["values"].insert(
        0, {"id": product["options"][0]["values"][0]["id"], "label": "S"}
    )
    for item in restore["variants"]:
        if item["id"] == old["id"]:
            item["status"] = "active"

    restored = ok(put(owner, product["id"], restore))

    assert {v["id"]: v["status"] for v in restored["variants"]}[old["id"]] == "active"
    assert [v["label"] for v in restored["options"][0]["values"]] == ["S", "M"]


def test_restoring_a_variant_whose_combination_is_active_is_refused(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    product = _with_history(owner)
    old_s = by_options(product)[("S",)]
    replace = as_update(product)
    for item in replace["variants"]:
        if item["id"] == old_s["id"]:
            item["status"] = "archived"
    replace["variants"].append(variant("S"))
    replace["variants"][-1]["sku"] = "SH-1-S-NEW"
    replaced = ok(put(owner, product["id"], replace))
    restore = as_update(replaced)
    for item in restore["variants"]:
        if item["id"] == old_s["id"]:
            item["status"] = "active"
    before = catalog_snapshot(owner_engine, worlds.a.tenant_id)

    refused(put(owner, product["id"], restore), 409, "combination_in_use")

    assert catalog_snapshot(owner_engine, worlds.a.tenant_id) == before


def test_restoring_a_variant_whose_value_label_is_taken_again_is_refused(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    product = _with_history(owner)
    old_s = by_options(product)[("S",)]
    removed = as_update(product)
    removed["options"][0]["values"] = removed["options"][0]["values"][1:]
    removed["variants"] = removed["variants"][1:]
    archived = ok(put(owner, product["id"], removed))
    readd = as_update(archived)
    readd["options"][0]["values"].append({"label": "s"})
    readd["variants"].append(variant("s"))
    readded = ok(put(owner, product["id"], readd))
    restore = as_update(readded)
    for item in restore["variants"]:
        if item["id"] == old_s["id"]:
            item["status"] = "active"
    before = catalog_snapshot(owner_engine, worlds.a.tenant_id)

    refused(put(owner, product["id"], restore), 409, "value_in_use")

    assert catalog_snapshot(owner_engine, worlds.a.tenant_id) == before


def test_a_variant_with_reserved_stock_cannot_be_archived_nor_its_product(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = _with_history(owner)
    s = by_options(product)[("S",)]
    with owner_engine.begin() as conn:
        insert_allocation(conn, a.tenant_id, [(uuid.UUID(s["inventory_item_id"]), 1)])
    removed = as_update(product)
    removed["options"][0]["values"] = removed["options"][0]["values"][1:]
    removed["variants"] = removed["variants"][1:]
    before = catalog_snapshot(owner_engine, a.tenant_id)

    refused(put(owner, product["id"], removed), 409, "variant_has_allocations")
    refused(
        action(owner, product["id"], "archive", product["version"]), 409, "variant_has_allocations"
    )

    assert catalog_snapshot(owner_engine, a.tenant_id) == before


def test_an_archived_product_cannot_be_edited_until_restored(owner: FlaskClient) -> None:
    product = created(owner, simple("ARC-1"))
    archived = ok(action(owner, product["id"], "archive", product["version"]))

    refused(put(owner, product["id"], as_update(archived)), 409, "product_archived")

    restored = ok(action(owner, product["id"], "restore", archived["version"]))
    ok(put(owner, product["id"], as_update(restored)))


def test_archive_and_restore_are_idempotent_and_recorded(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = created(owner, simple("ARC-2"))

    archived = ok(action(owner, product["id"], "archive", product["version"]))
    again = ok(action(owner, product["id"], "archive", product["version"]))
    restored = ok(action(owner, product["id"], "restore", archived["version"]))
    once_more = ok(action(owner, product["id"], "restore", archived["version"]))

    assert (archived["status"], archived["version"]) == ("archived", 2)
    assert (again["status"], again["version"]) == ("archived", 2)
    assert (restored["status"], restored["version"]) == ("active", 3)
    assert once_more["version"] == 3
    [archive_entry] = history(owner_engine, a.tenant_id, "product.archived")
    [restore_entry] = history(owner_engine, a.tenant_id, "product.restored")
    assert archive_entry.data == {"before": "active", "after": "archived"}
    assert restore_entry.data == {"before": "archived", "after": "active"}


def test_archiving_with_a_stale_version_is_refused(owner: FlaskClient) -> None:
    product = created(owner, simple("ARC-3"))
    ok(put(owner, product["id"], {**as_update(product), "name_en": "New"}))

    error = refused(action(owner, product["id"], "archive", 1), 409, "product_changed")
    assert error["error"]["current"]["version"] == 2


def test_delete_is_refused_with_history_and_removes_everything_without(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    with_history = _with_history(owner)
    plain = created(owner, jeans(code="PLAIN", store_ids=[a.store_id]))

    refused(delete(owner, with_history["id"], with_history["version"]), 409, "has_history")
    refused(delete(owner, plain["id"], 99), 409, "product_changed")
    refused(owner.delete(f"{PRODUCTS}/{plain['id']}", headers=CSRF), 400, "validation_failed")
    response = delete(owner, plain["id"], plain["version"])

    assert response.status_code == 204
    assert count(owner_engine, "products", a.tenant_id) == 1
    assert count(owner_engine, "variants", a.tenant_id) == 2
    assert count(owner_engine, "inventory_items", a.tenant_id) == 2
    assert count(owner_engine, "stock_balances", a.tenant_id) == 2
    assert count(owner_engine, "product_stores", a.tenant_id) == 0
    [entry] = history(owner_engine, a.tenant_id, "product.deleted")
    assert entry.data == {"code": "PLAIN", "name_en": "Slim jeans", "name_ar": "جينز ضيق"}
    assert owner.get(f"{PRODUCTS}/{plain['id']}").status_code == 404


def test_one_product_updated_entry_per_save_with_the_changes(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = created(owner, jeans(store_ids=[a.store_id]))
    body = as_update(product)
    body["name_en"] = "Skinny jeans"
    body["store_ids"] = [str(a.store_id), str(a.second_store_id)]
    body["variants"][0]["price"] = "19.99"
    body["variants"][0]["low_stock_level"] = 4

    ok(put(owner, product["id"], body))

    [entry] = history(owner_engine, a.tenant_id, "product.updated")
    assert entry.target_id == uuid.UUID(product["id"])
    assert entry.data["before"]["name_en"] == "Slim jeans"
    assert entry.data["after"]["name_en"] == "Skinny jeans"
    assert sorted(entry.data["after"]["store_ids"]) == sorted(
        [str(a.store_id), str(a.second_store_id)]
    )
    assert "code" not in entry.data["after"]
    [changed] = entry.data["variants_changed"]
    assert changed == {
        "sku": "JN-SLIM-30-BLUE",
        "before": {"price": "25.00", "low_stock_level": None},
        "after": {"price": "19.99", "low_stock_level": 4},
    }
    assert entry.data["variants_added"] == []
    assert entry.data["variants_archived"] == entry.data["variants_deleted"] == []


def test_a_product_can_be_read_with_its_stock_numbers(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    product = _with_history(owner)
    s = by_options(product)[("S",)]
    with owner_engine.begin() as conn:
        insert_allocation(conn, worlds.a.tenant_id, [(uuid.UUID(s["inventory_item_id"]), 2)])

    read = ok(owner.get(f"{PRODUCTS}/{product['id']}"))

    numbers = by_options(read)[("S",)]
    assert numbers["stock"]["on_hand"] == 3
    assert numbers["stock"]["allocated"] == 2
    assert numbers["stock"]["available"] == 1
    assert numbers["stock"]["version"] == 2
    assert numbers["effective_low_stock_level"] == 2
    assert numbers["stock_state"] == "low"
    assert by_options(read)[("M",)]["stock_state"] == "out"
    assert numbers["has_history"] is True
    assert by_options(read)[("M",)]["has_history"] is False


def test_an_unknown_product_is_not_found(owner: FlaskClient) -> None:
    refused(owner.get(f"{PRODUCTS}/{uuid.uuid4()}"), 404, "not_found")
    refused(put(owner, uuid.uuid4(), {"version": 1}), 404, "not_found")
