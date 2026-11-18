"""T058 — stock adjustments, ``POST /api/v1/catalog/variants/{variantId}/adjustments``.

Reasons and their signs, validation, stale balance versions, limits (also when only the
database's CHECKs are left to catch them), idempotency, archived variants and the history
entry (FR-012 to FR-017, R41 to R44). Every response is checked against the M1 contract;
every test ends with the stock integrity check.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from app.services import inventory
from tests.dbsupport import CatalogProduct, TwoTenants, insert_allocation
from tests.integration.stock_support import (
    adjust,
    arrange_product,
    balance,
    change,
    item_movements,
)
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


@pytest.fixture()
def manager(user_client: UserClient, worlds: TwoTenants) -> FlaskClient:
    return user_client(worlds.a.user("manager"), worlds.a.tenant_id)


@pytest.fixture()
def product(owner_engine: Engine, worlds: TwoTenants) -> CatalogProduct:
    """One variant with 10 on hand (one ``opening`` movement from the product form)."""
    a = worlds.a
    return arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=10, code="ADJ-1")


def _recorded(response: Any) -> dict[str, Any]:
    body: dict[str, Any] = ok(response, 201)
    return body


# ---- each reason and its sign (R41) -------------------------------------------------------------


@pytest.mark.parametrize("reason", ["opening", "received", "found"])
def test_increasing_reasons_add_the_quantity(
    manager: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    product: CatalogProduct,
    reason: str,
) -> None:
    result = _recorded(adjust(manager, product.variant_ids[0], change(reason, 5)))

    movement = result["movement"]
    assert (movement["reason"], movement["quantity"], movement["on_hand_after"]) == (reason, 5, 15)
    assert movement["counted_quantity"] is None
    assert movement["source"] == "manual"  # a manual opening too, never product_form
    assert (movement["actor_type"], movement["actor_name"]) == ("user", "manager a")
    assert result["balance"] == {"on_hand": 15, "allocated": 0, "available": 15, "version": 2}
    latest = item_movements(owner_engine, product.item_ids[0])[-1]
    assert (latest.reason, latest.quantity, latest.source) == (reason, 5, "manual")
    assert latest.actor_id == worlds.a.user("manager")
    assert balance(owner_engine, product.item_ids[0]).on_hand == 15


@pytest.mark.parametrize("reason", ["damaged", "lost"])
def test_decreasing_reasons_remove_the_quantity(
    manager: FlaskClient, owner_engine: Engine, product: CatalogProduct, reason: str
) -> None:
    result = _recorded(adjust(manager, product.variant_ids[0], change(reason, 3)))

    assert (result["movement"]["quantity"], result["movement"]["on_hand_after"]) == (-3, 7)
    assert result["balance"]["on_hand"] == 7
    assert balance(owner_engine, product.item_ids[0]).on_hand == 7


@pytest.mark.parametrize(("direction", "signed", "after"), [("in", 4, 14), ("out", -4, 6)])
def test_other_takes_its_sign_from_direction_and_keeps_its_note(
    manager: FlaskClient,
    owner_engine: Engine,
    product: CatalogProduct,
    direction: str,
    signed: int,
    after: int,
) -> None:
    body = change("other", 4, direction=direction, note="  Returned by a neighbour  ")

    result = _recorded(adjust(manager, product.variant_ids[0], body))

    assert result["movement"]["quantity"] == signed
    assert result["movement"]["note"] == "Returned by a neighbour"
    assert balance(owner_engine, product.item_ids[0]).on_hand == after


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        (change("other", 4, note="why"), {"direction": "required"}),
        (change("other", 4, direction="sideways", note="why"), {"direction": "invalid"}),
        (change("other", 4, direction="in"), {"note": "required"}),
        (change("other", 4, direction="in", note="   "), {"note": "required"}),
    ],
    ids=["no direction", "bad direction", "no note", "blank note"],
)
def test_other_needs_a_direction_and_a_note(
    manager: FlaskClient,
    owner_engine: Engine,
    product: CatalogProduct,
    body: dict[str, Any],
    fields: dict[str, str],
) -> None:
    response = adjust(manager, product.variant_ids[0], body)

    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == fields
    assert len(item_movements(owner_engine, product.item_ids[0])) == 1


@pytest.mark.parametrize("direction", ["out", "in", "sideways"])
def test_direction_is_ignored_for_every_other_reason(
    manager: FlaskClient, owner_engine: Engine, product: CatalogProduct, direction: str
) -> None:
    result = _recorded(
        adjust(manager, product.variant_ids[0], change("received", 2, direction=direction))
    )
    assert result["movement"]["quantity"] == 2

    result = _recorded(
        adjust(manager, product.variant_ids[0], change("damaged", 1, version=2, direction="in"))
    )
    assert result["movement"]["quantity"] == -1
    assert balance(owner_engine, product.item_ids[0]).on_hand == 11


@pytest.mark.parametrize(("counted", "difference"), [(12, 2), (10, 0), (7, -3), (0, -10)])
def test_a_count_correction_records_the_difference_with_the_counted_number(
    manager: FlaskClient,
    owner_engine: Engine,
    product: CatalogProduct,
    counted: int,
    difference: int,
) -> None:
    result = _recorded(
        adjust(manager, product.variant_ids[0], change("count_correction", counted=counted))
    )

    movement = result["movement"]
    assert (movement["quantity"], movement["counted_quantity"]) == (difference, counted)
    assert movement["on_hand_after"] == counted
    assert result["balance"]["on_hand"] == counted
    latest = item_movements(owner_engine, product.item_ids[0])[-1]
    assert (latest.quantity, latest.counted_quantity) == (difference, counted)


def test_a_count_correction_ignores_a_quantity(
    manager: FlaskClient, product: CatalogProduct
) -> None:
    body = change("count_correction", 99, counted=4)

    result = _recorded(adjust(manager, product.variant_ids[0], body))

    assert (result["movement"]["quantity"], result["balance"]["on_hand"]) == (-6, 4)


# ---- request shape -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "code"),
    [
        (None, "required"),
        ("5", "invalid"),
        (5.0, "invalid"),
        (2.5, "invalid"),
        (True, "invalid"),
        (0, "invalid"),
        (-1, "invalid"),
        (1_000_001, "too_large"),
    ],
    ids=["missing", "string", "float", "decimal", "boolean", "zero", "negative", "over"],
)
def test_quantity_must_be_a_json_integer_from_1_to_1000000(
    manager: FlaskClient, owner_engine: Engine, product: CatalogProduct, value: Any, code: str
) -> None:
    body = change("received")
    if value is not None:
        body["quantity"] = value

    response = adjust(manager, product.variant_ids[0], body)

    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == {"quantity": code}
    assert len(item_movements(owner_engine, product.item_ids[0])) == 1


@pytest.mark.parametrize(
    ("value", "code"),
    [
        (None, "required"),
        ("3", "invalid"),
        (3.5, "invalid"),
        (False, "invalid"),
        (-1, "invalid"),
        (1_000_001, "too_large"),
    ],
    ids=["missing", "string", "decimal", "boolean", "negative", "over"],
)
def test_a_counted_quantity_must_be_a_json_integer_from_0_to_1000000(
    manager: FlaskClient, product: CatalogProduct, value: Any, code: str
) -> None:
    body = change("count_correction")
    if value is not None:
        body["counted_quantity"] = value

    response = adjust(manager, product.variant_ids[0], body)

    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == {"counted_quantity": code}


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"quantity": 1, "balance_version": 1}, {"reason": "required"}),
        (change("allocation_consumed", 1), {"reason": "invalid"}),
        (change("stolen", 1), {"reason": "invalid"}),
        ({"reason": "received", "quantity": 1}, {"balance_version": "required"}),
        (change("received", 1, version=0), {"balance_version": "invalid"}),
        ({**change("received", 1), "balance_version": "1"}, {"balance_version": "invalid"}),
        (change("received", 1, note="x" * 501), {"note": "too_long"}),
        ({**change("received", 1), "note": 5}, {"note": "invalid"}),
    ],
    ids=[
        "no reason",
        "system reason",
        "unknown reason",
        "no version",
        "zero version",
        "string version",
        "long note",
        "note not text",
    ],
)
def test_other_fields_are_checked_with_their_field_codes(
    manager: FlaskClient, product: CatalogProduct, body: dict[str, Any], fields: dict[str, str]
) -> None:
    response = adjust(manager, product.variant_ids[0], body)

    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == fields


def test_a_note_of_500_characters_is_kept(manager: FlaskClient, product: CatalogProduct) -> None:
    result = _recorded(adjust(manager, product.variant_ids[0], change("found", 1, note="n" * 500)))
    assert result["movement"]["note"] == "n" * 500


# ---- stale screens and limits (FR-015, R42, R43) -------------------------------------------------


def test_a_stale_balance_version_is_refused_with_the_current_numbers(
    manager: FlaskClient, owner_engine: Engine, product: CatalogProduct
) -> None:
    variant_id, item_id = product.variant_ids[0], product.item_ids[0]
    _recorded(adjust(manager, variant_id, change("received", 5)))

    response = adjust(manager, variant_id, change("damaged", 1, version=1))

    refused(response, 409, "stock_changed")
    assert response.get_json()["error"]["balance"] == {
        "on_hand": 15,
        "allocated": 0,
        "available": 15,
        "version": 2,
    }
    assert len(item_movements(owner_engine, item_id)) == 2
    # Repeated knowingly with the version just shown, it is recorded.
    _recorded(adjust(manager, variant_id, change("damaged", 1, version=2)))
    assert balance(owner_engine, item_id).on_hand == 14


@pytest.mark.parametrize(
    "body",
    [change("damaged", 11), change("lost", 7), change("count_correction", counted=3)],
    ids=["below zero", "below allocated", "count below allocated"],
)
def test_on_hand_may_not_go_below_zero_or_below_allocated(
    manager: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    product: CatalogProduct,
    body: dict[str, Any],
) -> None:
    item_id = product.item_ids[0]
    with owner_engine.begin() as conn:
        insert_allocation(conn, worlds.a.tenant_id, [(item_id, 4)])
    body["balance_version"] = 2

    response = adjust(manager, product.variant_ids[0], body)

    refused(response, 409, "not_enough_stock")
    assert response.get_json()["error"]["balance"] == {
        "on_hand": 10,
        "allocated": 4,
        "available": 6,
        "version": 2,
    }
    assert len(item_movements(owner_engine, item_id)) == 1
    assert balance(owner_engine, item_id).version == 2


def test_down_to_exactly_the_allocated_quantity_is_allowed(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants, product: CatalogProduct
) -> None:
    with owner_engine.begin() as conn:
        insert_allocation(conn, worlds.a.tenant_id, [(product.item_ids[0], 4)])

    result = _recorded(adjust(manager, product.variant_ids[0], change("lost", 6, version=2)))

    assert result["balance"] == {"on_hand": 4, "allocated": 4, "available": 0, "version": 3}


def test_on_hand_above_1000000_is_too_large(
    manager: FlaskClient, owner_engine: Engine, product: CatalogProduct
) -> None:
    response = adjust(manager, product.variant_ids[0], change("received", 999_991))

    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == {"quantity": "too_large"}
    assert balance(owner_engine, product.item_ids[0]).on_hand == 10
    # Exactly 1,000,000 is allowed.
    result = _recorded(adjust(manager, product.variant_ids[0], change("received", 999_990)))
    assert result["balance"]["on_hand"] == 1_000_000


@pytest.mark.parametrize(
    ("body", "status", "code", "fields"),
    [
        (change("damaged", 11), 409, "not_enough_stock", {}),
        (change("other", 11, direction="out", note="gone"), 409, "not_enough_stock", {}),
        (change("received", 999_991), 400, "validation_failed", {"quantity": "too_large"}),
    ],
    ids=["below zero", "other below zero", "above the maximum"],
)
def test_the_database_checks_answer_by_name_when_the_service_checks_are_bypassed(
    manager: FlaskClient,
    owner_engine: Engine,
    product: CatalogProduct,
    monkeypatch: pytest.MonkeyPatch,
    body: dict[str, Any],
    status: int,
    code: str,
    fields: dict[str, str],
) -> None:
    monkeypatch.setattr(inventory, "check_adjustment_limits", lambda *args, **kwargs: None)

    response = adjust(manager, product.variant_ids[0], body)

    refused(response, status, code)
    assert response.get_json()["error"]["fields"] == fields
    assert len(item_movements(owner_engine, product.item_ids[0])) == 1
    assert balance(owner_engine, product.item_ids[0]).on_hand == 10


def test_below_allocated_is_caught_by_the_database_check_too(
    manager: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    product: CatalogProduct,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with owner_engine.begin() as conn:
        insert_allocation(conn, worlds.a.tenant_id, [(product.item_ids[0], 4)])
    monkeypatch.setattr(inventory, "check_adjustment_limits", lambda *args, **kwargs: None)

    response = adjust(manager, product.variant_ids[0], change("damaged", 7, version=2))

    refused(response, 409, "not_enough_stock")
    assert response.get_json()["error"]["balance"]["on_hand"] == 10


# ---- idempotency (FR-016, R44) -------------------------------------------------------------------


def test_the_same_key_twice_records_one_movement_and_replays_it_with_the_balance_now(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants, product: CatalogProduct
) -> None:
    variant_id, item_id = product.variant_ids[0], product.item_ids[0]
    body = change("received", 5)

    first = _recorded(adjust(manager, variant_id, body, key="sheet-1"))
    _recorded(adjust(manager, variant_id, change("damaged", 2, version=2), key="sheet-2"))
    replay = _recorded(adjust(manager, variant_id, body, key="sheet-1"))

    assert replay["movement"] == first["movement"]
    assert replay["balance"] == {"on_hand": 13, "allocated": 0, "available": 13, "version": 3}
    assert len(item_movements(owner_engine, item_id)) == 3
    assert len(history(owner_engine, worlds.a.tenant_id, "stock.adjusted")) == 2
    latest = item_movements(owner_engine, item_id)[1]
    assert latest.request_key == "sheet-1"


def test_the_same_key_with_another_body_is_an_idempotency_conflict(
    manager: FlaskClient, owner_engine: Engine, product: CatalogProduct
) -> None:
    variant_id = product.variant_ids[0]
    _recorded(adjust(manager, variant_id, change("received", 5), key="sheet-1"))

    refused(
        adjust(manager, variant_id, change("received", 6), key="sheet-1"),
        409,
        "idempotency_conflict",
    )
    assert len(item_movements(owner_engine, product.item_ids[0])) == 2


def test_a_refused_change_stores_no_key_so_it_can_be_repeated_with_it(
    manager: FlaskClient, owner_engine: Engine, product: CatalogProduct
) -> None:
    variant_id = product.variant_ids[0]
    refused(
        adjust(manager, variant_id, change("damaged", 1, version=7), key="k"), 409, "stock_changed"
    )

    _recorded(adjust(manager, variant_id, change("damaged", 1, version=1), key="k"))

    assert balance(owner_engine, product.item_ids[0]).on_hand == 9


# ---- archived variants, history, versions ---------------------------------------------------------


@pytest.mark.parametrize("archived", ["variant", "product"])
def test_archived_variants_can_still_be_adjusted(
    manager: FlaskClient,
    owner_engine: Engine,
    product: CatalogProduct,
    archived: str,
) -> None:
    if archived == "variant":
        owner_sql(
            owner_engine,
            "UPDATE variants SET status = 'archived', archived_at = now() WHERE id = :v",
            v=product.variant_ids[0],
        )
    else:
        owner_sql(
            owner_engine,
            "UPDATE products SET status = 'archived', archived_at = now() WHERE id = :p",
            p=product.product_id,
        )

    result = _recorded(adjust(manager, product.variant_ids[0], change("lost", 10)))

    assert result["balance"]["on_hand"] == 0


def test_each_change_is_recorded_in_history_with_the_numbers(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants, product: CatalogProduct
) -> None:
    a = worlds.a
    variant_id = product.variant_ids[0]
    _recorded(adjust(manager, variant_id, change("received", 5, note="Delivery 12")))
    _recorded(adjust(manager, variant_id, change("count_correction", version=2, counted=12)))

    received, counted = history(owner_engine, a.tenant_id, "stock.adjusted")

    assert (received.actor_type, received.actor_id) == ("user", a.user("manager"))
    assert (received.target_type, received.target_id) == ("variant", variant_id)
    assert received.data == {
        "sku": "ADJ-1",
        "reason": "received",
        "quantity": 5,
        "on_hand_before": 10,
        "on_hand_after": 15,
        "note": "Delivery 12",
    }
    assert counted.data == {
        "sku": "ADJ-1",
        "reason": "count_correction",
        "quantity": -3,
        "counted_quantity": 12,
        "on_hand_before": 15,
        "on_hand_after": 12,
        "note": None,
    }


def test_the_balance_version_grows_by_one_and_earlier_movements_never_change(
    manager: FlaskClient, owner_engine: Engine, product: CatalogProduct
) -> None:
    variant_id, item_id = product.variant_ids[0], product.item_ids[0]
    _recorded(adjust(manager, variant_id, change("received", 5)))
    before = item_movements(owner_engine, item_id)

    for version, body in enumerate(
        [change("damaged", 1), change("found", 2), change("count_correction", counted=3)], start=2
    ):
        body["balance_version"] = version
        result = _recorded(adjust(manager, variant_id, body))
        assert result["balance"]["version"] == version + 1

    after = item_movements(owner_engine, item_id)
    assert after[: len(before)] == before
    assert [m.on_hand_after for m in after] == [10, 15, 14, 16, 3]
    assert balance(owner_engine, item_id).version == 5


def test_an_unknown_variant_is_not_found(manager: FlaskClient) -> None:
    refused(adjust(manager, uuid.uuid4(), change("received", 1)), 404, "not_found")
