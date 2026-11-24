"""T072 — allocations under real concurrency (FR-021, SC-002, SC-003, R42, R44, R45).

Every thread opens its own tenant transaction on its own connection from the application
engine; racing threads start together on a ``threading.Barrier``, and races whose order
matters are sequenced by waiting until the second session is blocked on the first one's
lock. Outcomes are exact. Every test ends with the stock integrity check.
"""

from __future__ import annotations

import threading
import uuid
from collections import Counter
from collections.abc import Callable
from typing import Any

import pytest
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.core.tenancy import tenant_transaction
from app.errors import ApiError
from app.services import allocation, catalog, inventory
from app.services.allocation import AllocationRefused
from app.services.inventory import AdjustmentIn, StockActor
from tests.dbsupport import Balance, TwoTenants
from tests.integration.catalog_support import as_update, put
from tests.integration.stock_support import (
    arrange_product,
    balance,
    item_movements,
    wait_until_waiting_for_a_lock,
)
from tests.integration.us1_support import history, owner_rows, owner_value

pytestmark = pytest.mark.usefixtures("integrity_check")

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
JOIN_TIMEOUT = 60


@pytest.fixture()
def worlds(fresh_tenants: TwoTenants) -> TwoTenants:
    return fresh_tenants


def _together(count: int, work: Callable[[int], Any]) -> list[Any]:
    """Run ``work(i)`` in ``count`` threads released at the same moment; return the results."""
    barrier = threading.Barrier(count)
    results: list[Any] = [None] * count
    failures: list[BaseException] = []

    def run(index: int) -> None:
        try:
            barrier.wait()
            results[index] = work(index)
        except BaseException as exc:
            failures.append(exc)

    threads = [threading.Thread(target=run, args=(i,)) for i in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=JOIN_TIMEOUT)
    assert not any(thread.is_alive() for thread in threads), "a thread did not finish"
    assert not failures, failures
    return results


def _allocator(
    app_engine: Engine, tenant_id: uuid.UUID
) -> Callable[[str, list[tuple[uuid.UUID, int]]], str]:
    """Allocate in a transaction of its own; the outcome as a word."""

    def allocate(key: str, lines: list[tuple[uuid.UUID, int]]) -> str:
        try:
            with tenant_transaction(app_engine, tenant_id) as db:
                allocation.allocate(db, StockActor(tenant_id=tenant_id), key, lines)
        except AllocationRefused as refusal:
            return refusal.code
        return "allocated"

    return allocate


def _allocations(owner: Engine, tenant_id: uuid.UUID) -> int:
    return int(
        owner_value(owner, "SELECT count(*) FROM allocations WHERE tenant_id = :t", t=tenant_id)
    )


# ---- races for the same units (US3 scenario 1) --------------------------------------------------


def test_two_allocations_for_the_last_unit_exactly_one_wins(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    item = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=1).item_ids[0]
    allocate = _allocator(app_engine, a.tenant_id)

    outcomes = Counter(_together(2, lambda i: allocate(f"order-{i}", [(item, 1)])))

    assert outcomes == {"allocated": 1, "insufficient_stock": 1}
    assert balance(owner_engine, item) == Balance(1, 1, 2)
    assert _allocations(owner_engine, a.tenant_id) == 1


def test_twenty_threads_racing_for_five_units_exactly_five_win(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    item = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=5).item_ids[0]
    allocate = _allocator(app_engine, a.tenant_id)

    outcomes = Counter(_together(20, lambda i: allocate(f"order-{i}", [(item, 1)])))

    assert outcomes == {"allocated": 5, "insufficient_stock": 15}
    assert balance(owner_engine, item) == Balance(5, 5, 6)
    assert _allocations(owner_engine, a.tenant_id) == 5
    assert len(history(owner_engine, a.tenant_id, "stock.allocated")) == 5


def test_the_same_request_key_from_several_threads_makes_one_allocation(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, variants=2, on_hand=[5, 5])
    lines = [(product.item_ids[0], 2), (product.item_ids[1], 3)]

    def send(_: int) -> uuid.UUID:
        with tenant_transaction(app_engine, a.tenant_id) as db:
            return allocation.allocate(db, StockActor(tenant_id=a.tenant_id), "order-1", lines).id

    ids = _together(6, send)

    assert len(set(ids)) == 1
    assert _allocations(owner_engine, a.tenant_id) == 1
    assert balance(owner_engine, product.item_ids[0]) == Balance(5, 2, 2)
    assert balance(owner_engine, product.item_ids[1]) == Balance(5, 3, 2)
    assert len(history(owner_engine, a.tenant_id, "stock.allocated")) == 1


def test_a_duplicate_waiting_on_the_first_request_key_returns_the_winners_allocation(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    """The savepoint loser path, sequenced: the second request is blocked on the first one's
    uncommitted key when the first commits."""
    a = worlds.a
    item = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=5).item_ids[0]
    system = StockActor(tenant_id=a.tenant_id)
    made: dict[str, uuid.UUID] = {}

    def allocate_then_pause(pause: Callable[[], None]) -> str:
        with tenant_transaction(app_engine, a.tenant_id) as db:
            made["first"] = allocation.allocate(db, system, "order-1", [(item, 2)]).id
            pause()
        return "allocated"

    def same_key() -> str:
        with tenant_transaction(app_engine, a.tenant_id) as db:
            made["second"] = allocation.allocate(db, system, "order-1", [(item, 2)]).id
        return "returned"

    assert _in_order(owner_engine, allocate_then_pause, same_key) == ("allocated", "returned")
    assert made["first"] == made["second"]
    assert balance(owner_engine, item) == Balance(5, 2, 2)
    assert _allocations(owner_engine, a.tenant_id) == 1


# ---- allocations racing adjustments (FR-021) ----------------------------------------------------


def test_allocations_racing_adjustments_never_oversell_and_lose_no_update(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=10)
    variant_id, item = product.variant_ids[0], product.item_ids[0]
    allocate = _allocator(app_engine, a.tenant_id)
    manager = StockActor(tenant_id=a.tenant_id, user_id=a.user_id)

    def remove_one(index: int) -> str:
        version = 1
        for attempt in range(200):
            try:
                with tenant_transaction(app_engine, a.tenant_id) as db:
                    inventory.adjust(
                        db,
                        manager,
                        inventory.find_variant(db, variant_id),
                        AdjustmentIn(reason="damaged", balance_version=version, quantity=1),
                        request_key=f"sheet-{index}-{attempt}",
                    )
                return "adjusted"
            except ApiError as refusal:
                if refusal.code == "stock_changed":
                    version = refusal.extra["balance"]["version"]
                    continue
                assert refusal.code == "not_enough_stock", refusal.code
                return "not_enough_stock"
        raise AssertionError("never settled")

    def work(index: int) -> str:
        if index % 2:
            return remove_one(index)
        outcome = allocate(f"order-{index}", [(item, 1)])
        return "insufficient_stock_alloc" if outcome == "insufficient_stock" else outcome

    outcomes = Counter(_together(20, work))

    allocated, adjusted = outcomes["allocated"], outcomes["adjusted"]
    assert allocated + adjusted == 10
    assert outcomes["insufficient_stock_alloc"] == 10 - allocated
    assert outcomes["not_enough_stock"] == 10 - adjusted
    final = balance(owner_engine, item)
    assert (final.on_hand, final.allocated, final.available) == (10 - adjusted, allocated, 0)
    assert final.version == 1 + 10
    assert [m.on_hand_after for m in item_movements(owner_engine, item)] == list(
        range(10, 10 - adjusted - 1, -1)
    )


# ---- allocations racing archiving (FR-007, R42) -------------------------------------------------


def _archive(app_engine: Engine, world: Any, product_id: uuid.UUID) -> str:
    actor = catalog.Actor(user_id=world.user_id, tenant_id=world.tenant_id)
    try:
        with tenant_transaction(app_engine, world.tenant_id) as db:
            catalog.set_status(db, actor, product_id, 1, "archived")
    except ApiError as refusal:
        return refusal.code
    return "archived"


def _in_order(
    owner: Engine,
    first: Callable[[Callable[[], None]], str],
    second: Callable[[], str],
) -> tuple[str, str]:
    """``first`` takes its locks and calls ``pause()``; ``second`` then starts and blocks on
    those locks; once it is seen waiting, ``first`` goes on and commits and ``second``
    finishes. Returns both outcomes."""
    holding = threading.Event()
    go_on = threading.Event()
    results: dict[str, str] = {}
    failures: list[BaseException] = []

    def pause() -> None:
        holding.set()
        assert go_on.wait(JOIN_TIMEOUT)

    def run(name: str, work: Callable[[], str]) -> None:
        try:
            results[name] = work()
        except BaseException as exc:
            failures.append(exc)
        finally:
            holding.set()

    one = threading.Thread(target=run, args=("first", lambda: first(pause)))
    one.start()
    assert holding.wait(JOIN_TIMEOUT)
    two = threading.Thread(target=run, args=("second", second))
    two.start()
    try:
        wait_until_waiting_for_a_lock(owner)
    finally:
        go_on.set()
    one.join(JOIN_TIMEOUT)
    two.join(JOIN_TIMEOUT)
    assert not failures, failures
    return results["first"], results["second"]


def test_an_allocation_holding_the_balance_makes_a_racing_archive_refused(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=3)
    item = product.item_ids[0]

    def allocate_then_pause(pause: Callable[[], None]) -> str:
        with tenant_transaction(app_engine, a.tenant_id) as db:
            allocation.allocate(db, StockActor(tenant_id=a.tenant_id), "order-1", [(item, 1)])
            pause()  # holds the balance lock until the archive waits for it
        return "allocated"

    first, second = _in_order(
        owner_engine, allocate_then_pause, lambda: _archive(app_engine, a, product.product_id)
    )

    assert (first, second) == ("allocated", "variant_has_allocations")
    assert (
        owner_value(owner_engine, "SELECT status FROM products WHERE id = :p", p=product.product_id)
        == "active"
    )
    assert balance(owner_engine, item) == Balance(3, 1, 2)


def test_an_archive_holding_the_balance_makes_a_racing_allocation_refused(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=3)
    item = product.item_ids[0]
    actor = catalog.Actor(user_id=a.user_id, tenant_id=a.tenant_id)

    def archive_then_pause(pause: Callable[[], None]) -> str:
        with tenant_transaction(app_engine, a.tenant_id) as db:
            catalog.set_status(db, actor, product.product_id, 1, "archived")
            pause()  # holds the product and balance locks until the allocation waits
        return "archived"

    first, second = _in_order(
        owner_engine,
        archive_then_pause,
        lambda: _allocator(app_engine, a.tenant_id)("order-1", [(item, 1)]),
    )

    assert (first, second) == ("archived", "variant_archived")
    assert balance(owner_engine, item) == Balance(3, 0, 1)
    assert _allocations(owner_engine, a.tenant_id) == 0


def test_allocations_racing_a_variant_archive_either_all_win_or_the_archive_does(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    user_client: UserClient,
) -> None:
    a = worlds.a
    product = arrange_product(
        owner_engine, a.tenant_id, a.user_id, variants=2, on_hand=[10, 1], code="RACE"
    )
    item = product.item_ids[0]
    owner = user_client(a.user_id, a.tenant_id)
    current = owner.get(f"/api/v1/catalog/products/{product.product_id}").get_json()
    removed = as_update(current)  # remove the first size: its variant has history, so archived
    removed["options"][0]["values"] = removed["options"][0]["values"][1:]
    removed["variants"] = removed["variants"][1:]
    allocate = _allocator(app_engine, a.tenant_id)

    def work(index: int) -> str:
        if index == 0:
            response = put(owner, product.product_id, removed)
            if response.status_code == 200:
                return "archived"
            return str(response.get_json()["error"]["code"])
        return allocate(f"order-{index}", [(item, 1)])

    outcomes = Counter(_together(7, work))

    status = owner_value(
        owner_engine, "SELECT status FROM variants WHERE id = :v", v=product.variant_ids[0]
    )
    if outcomes["archived"]:
        assert outcomes == {"archived": 1, "variant_archived": 6}
        assert status == "archived"
        assert balance(owner_engine, item).allocated == 0
    else:
        assert outcomes == {"variant_has_allocations": 1, "allocated": 6}
        assert status == "active"
        assert balance(owner_engine, item) == Balance(10, 6, 7)


# ---- lock order (R42) ----------------------------------------------------------------------------


def test_requests_naming_items_in_opposite_orders_never_deadlock(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(
        owner_engine, a.tenant_id, a.user_id, variants=3, on_hand=[100, 100, 100]
    )
    first, second, third = product.item_ids
    orders = [
        [(first, 1), (second, 1), (third, 1)],
        [(third, 1), (second, 1), (first, 1)],
        [(second, 1), (third, 1), (first, 1)],
    ]
    allocate = _allocator(app_engine, a.tenant_id)

    outcomes = Counter(_together(12, lambda i: allocate(f"order-{i}", orders[i % 3])))

    assert outcomes == {"allocated": 12}
    for item in product.item_ids:
        assert balance(owner_engine, item) == Balance(100, 12, 13)

    # Releasing and consuming them, again all at once, takes the same order.
    ids = [
        row.id
        for row in owner_rows(
            owner_engine,
            "SELECT id FROM allocations WHERE tenant_id = :t ORDER BY request_key",
            t=a.tenant_id,
        )
    ]
    system = StockActor(tenant_id=a.tenant_id)

    def close(index: int) -> str:
        with tenant_transaction(app_engine, a.tenant_id) as db:
            action = allocation.release if index % 2 else allocation.consume
            return action(db, system, ids[index]).status

    closed = Counter(_together(12, close))

    assert closed == {"released": 6, "consumed": 6}
    for item in product.item_ids:
        assert balance(owner_engine, item) == Balance(94, 0, 25)
