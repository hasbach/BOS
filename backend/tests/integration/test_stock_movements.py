"""T059 — a variant's stock history, ``GET /api/v1/catalog/variants/{variantId}/movements``.

Newest first, 50 per page with a keyset cursor; each movement with its reason, signed
quantity, counted quantity, running on hand, actor (current name; none for the system), note
and the stored ``source`` (FR-012, FR-013, FR-017, R41). Managers read it through
``stock.adjust``. Every test ends with the stock integrity check.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Connection, Engine, text

from app.config import Config
from tests.dbsupport import (
    CatalogProduct,
    TwoTenants,
    default_warehouse,
    insert,
    insert_allocation,
    insert_product,
)
from tests.integration.stock_support import (
    adjust,
    arrange_product,
    balance,
    change,
    movements_path,
)
from tests.integration.us1_support import (
    app_for,
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


def _page(client: FlaskClient, variant_id: Any, cursor: str | None = None) -> dict[str, Any]:
    query = {"cursor": cursor} if cursor else None
    body: dict[str, Any] = ok(client.get(movements_path(variant_id), query_string=query))
    return body


def _consume_as_the_system(
    conn: Connection, tenant_id: uuid.UUID, item_id: uuid.UUID, quantity: int
) -> None:
    """An allocation consumed by a system process, written as the allocation service does."""
    allocation_id = insert_allocation(conn, tenant_id, [(item_id, quantity)])
    on_hand = conn.execute(
        text(
            "UPDATE stock_balances SET on_hand = on_hand - :q, allocated = allocated - :q, "
            "version = version + 1 WHERE inventory_item_id = :i RETURNING on_hand"
        ),
        {"q": quantity, "i": item_id},
    ).scalar_one()
    conn.execute(
        text("UPDATE allocations SET status = 'consumed', consumed_at = now() WHERE id = :id"),
        {"id": allocation_id},
    )
    insert(
        conn,
        "stock_movements",
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        warehouse_id=default_warehouse(conn, tenant_id),
        inventory_item_id=item_id,
        quantity=-quantity,
        reason="allocation_consumed",
        on_hand_after=on_hand,
        allocation_id=allocation_id,
        source="allocation",
        actor_type="system",
    )


def _imported(conn: Connection, tenant_id: uuid.UUID, user_id: uuid.UUID) -> CatalogProduct:
    batch_id = uuid.uuid4()
    insert(
        conn,
        "import_batches",
        id=batch_id,
        tenant_id=tenant_id,
        created_by_user_id=user_id,
        status="committed",
        file_name="catalog.csv",
        file_sha256=bytes(32),
        row_count=1,
        product_count=1,
        variant_count=1,
        opening_units=4,
        committed_at=datetime.now(UTC),
        committed_by_user_id=user_id,
    )
    return insert_product(
        conn, tenant_id, user_id, on_hand=4, code="IMP-1", import_batch_id=batch_id
    )


# ---- what each movement shows (FR-017) ---------------------------------------------------------


def test_every_movement_newest_first_with_reason_actor_note_and_source(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=10, code="HIS-1")
    variant_id, item_id = product.variant_ids[0], product.item_ids[0]
    steps = [
        change("received", 5, version=1, note="Delivery"),
        change("damaged", 1, version=2),
        change("count_correction", version=3, counted=12),
        change("opening", 3, version=4),
    ]
    for body in steps:
        ok(adjust(manager, variant_id, body), 201)
    with owner_engine.begin() as conn:
        _consume_as_the_system(conn, a.tenant_id, item_id, 2)

    page = _page(manager, variant_id)

    items = page["items"]
    assert page["next_cursor"] is None
    assert [
        (m["reason"], m["quantity"], m["counted_quantity"], m["on_hand_after"], m["source"])
        for m in items
    ] == [
        ("allocation_consumed", -2, None, 13, "allocation"),
        ("opening", 3, None, 15, "manual"),
        ("count_correction", -2, 12, 12, "manual"),
        ("damaged", -1, None, 14, "manual"),
        ("received", 5, None, 15, "manual"),
        ("opening", 10, None, 10, "product_form"),
    ]
    assert [(m["actor_type"], m["actor_name"]) for m in items] == [
        ("system", None),
        *[("user", "manager a")] * 4,
        ("user", "Owner a"),
    ]
    assert [m["note"] for m in items] == [None, None, None, None, "Delivery", None]
    assert sum(m["quantity"] for m in items) == balance(owner_engine, item_id).on_hand == 13
    assert all(m["at"].endswith("Z") for m in items)
    assert len({m["id"] for m in items}) == 6


def test_imported_opening_stock_shows_the_import_source(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    with owner_engine.begin() as conn:
        product = _imported(conn, a.tenant_id, a.user_id)

    [movement] = _page(manager, product.variant_ids[0])["items"]

    assert (movement["reason"], movement["source"], movement["quantity"]) == (
        "opening",
        "import",
        4,
    )


def test_the_actor_is_shown_with_their_current_name(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=1)
    ok(adjust(manager, product.variant_ids[0], change("found", 1)), 201)
    owner_sql(owner_engine, "UPDATE users SET name = 'Renamed' WHERE id = :u", u=a.user("manager"))

    items = _page(manager, product.variant_ids[0])["items"]

    assert [m["actor_name"] for m in items] == ["Renamed", "Owner a"]


def test_only_the_variants_own_movements_are_listed(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=[3, 7], variants=2)

    first = _page(manager, product.variant_ids[0])["items"]
    second = _page(manager, product.variant_ids[1])["items"]

    assert [m["quantity"] for m in first] == [3]
    assert [m["quantity"] for m in second] == [7]


def test_a_variant_without_movements_has_an_empty_history(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=0)

    assert _page(manager, product.variant_ids[0]) == {"items": [], "next_cursor": None}


def test_an_archived_variants_history_can_still_be_read(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=2, status="archived")

    assert len(_page(manager, product.variant_ids[0])["items"]) == 1


# ---- paging ------------------------------------------------------------------------------------


def _received_one_by_one(owner: Engine, tenant_id: uuid.UUID, item_id: uuid.UUID, n: int) -> None:
    with owner.begin() as conn:
        warehouse_id = default_warehouse(conn, tenant_id)
        start = conn.execute(
            text("SELECT on_hand FROM stock_balances WHERE inventory_item_id = :i"), {"i": item_id}
        ).scalar_one()
        for step in range(1, n + 1):
            insert(
                conn,
                "stock_movements",
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                warehouse_id=warehouse_id,
                inventory_item_id=item_id,
                quantity=1,
                reason="received",
                on_hand_after=start + step,
                source="manual",
                actor_type="system",
            )
        conn.execute(
            text(
                "UPDATE stock_balances SET on_hand = on_hand + :n, version = version + 1 "
                "WHERE inventory_item_id = :i"
            ),
            {"n": n, "i": item_id},
        )


def test_50_per_page_with_a_stable_cursor(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=0)
    variant_id, item_id = product.variant_ids[0], product.item_ids[0]
    _received_one_by_one(owner_engine, a.tenant_id, item_id, 60)

    first = _page(manager, variant_id)
    # A movement recorded between two pages does not shift the next page.
    ok(adjust(manager, variant_id, change("found", 1, version=2)), 201)
    second = _page(manager, variant_id, first["next_cursor"])

    assert [m["on_hand_after"] for m in first["items"]] == list(range(60, 10, -1))
    assert first["next_cursor"]
    assert [m["on_hand_after"] for m in second["items"]] == list(range(10, 0, -1))
    assert second["next_cursor"] is None


def test_exactly_50_movements_fit_on_one_page(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=0)
    _received_one_by_one(owner_engine, a.tenant_id, product.item_ids[0], 50)

    page = _page(manager, product.variant_ids[0])

    assert len(page["items"]) == 50
    assert page["next_cursor"] is None


@pytest.mark.parametrize("cursor", ["not-a-cursor", "", "W10", "eyJ4IjogMX0"])
def test_a_malformed_cursor_is_refused(
    manager: FlaskClient, owner_engine: Engine, worlds: TwoTenants, cursor: str
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=1)

    response = manager.get(movements_path(product.variant_ids[0]), query_string={"cursor": cursor})

    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == {"cursor": "invalid"}


# ---- who reads it -------------------------------------------------------------------------------


def test_owners_and_managers_read_it_though_managers_have_no_audit_view(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=1)
    manager = user_client(a.user("manager"), a.tenant_id)

    assert manager.get("/api/v1/audit").status_code == 403
    for role in ("owner", "manager"):
        client = user_client(a.user(role), a.tenant_id)
        assert len(_page(client, product.variant_ids[0])["items"]) == 1


def test_an_unknown_variant_is_not_found(manager: FlaskClient) -> None:
    refused(manager.get(movements_path(uuid.uuid4())), 404, "not_found")
