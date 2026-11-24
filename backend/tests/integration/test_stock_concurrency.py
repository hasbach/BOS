"""T060 — stock adjustments under real concurrency (FR-021, SC-002, R42 to R44).

Each thread sends its request through its own signed-in test client, so each request runs
on its own connection from the application engine's pool; the threads start together on a
``threading.Barrier``. Outcomes are exact. Every test ends with the stock integrity check.
"""

from __future__ import annotations

import threading
import uuid
from collections import Counter
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine, create_engine, text

from app.config import Config
from tests.dbsupport import TwoTenants
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
    owner_value,
    shared_app_fixture,
)

pytestmark = pytest.mark.usefixtures("integrity_check")

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
JOIN_TIMEOUT = 60


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


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


def _clients(user_client: UserClient, worlds: TwoTenants, count: int) -> list[FlaskClient]:
    a = worlds.a
    return [user_client(a.user("manager"), a.tenant_id) for _ in range(count)]


def test_two_changes_from_the_same_balance_version_record_exactly_one(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=10)
    clients = _clients(user_client, worlds, 2)
    bodies = [change("received", 5), change("damaged", 3)]

    responses = _together(
        2, lambda i: adjust(clients[i], product.variant_ids[0], bodies[i], key=f"sheet-{i}")
    )

    statuses = sorted(r.status_code for r in responses)
    assert statuses == [201, 409]
    [loser] = [r for r in responses if r.status_code == 409]
    [winner] = [r for r in responses if r.status_code == 201]
    assert loser.get_json()["error"]["code"] == "stock_changed"
    assert loser.get_json()["error"]["balance"] == winner.get_json()["balance"]
    assert len(item_movements(owner_engine, product.item_ids[0])) == 2
    assert balance(owner_engine, product.item_ids[0]).version == 2


def test_parallel_decrements_never_go_negative_and_lose_no_update(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    units, threads = 8, 12
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=units)
    variant_id, item_id = product.variant_ids[0], product.item_ids[0]
    clients = _clients(user_client, worlds, threads)

    def take_one(index: int) -> str:
        """Remove one unit; on stock_changed, repeat knowingly with the version shown."""
        version = 1
        for attempt in range(200):
            response = adjust(
                clients[index],
                variant_id,
                change("damaged", 1, version=version),
                key=f"take-{index}-{attempt}",
            )
            if response.status_code == 201:
                return "recorded"
            body = response.get_json()["error"]
            if body["code"] == "stock_changed":
                version = body["balance"]["version"]
                continue
            assert body["code"] == "not_enough_stock", body
            return "not_enough_stock"
        raise AssertionError("never settled")

    outcomes = Counter(_together(threads, take_one))

    assert outcomes == {"recorded": units, "not_enough_stock": threads - units}
    final = balance(owner_engine, item_id)
    assert (final.on_hand, final.allocated, final.version) == (0, 0, 1 + units)
    ledger = item_movements(owner_engine, item_id)
    assert [m.on_hand_after for m in ledger] == list(range(units, -1, -1))
    assert len(history(owner_engine, a.tenant_id, "stock.adjusted")) == units


def test_the_same_key_sent_by_several_threads_records_one_movement(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    threads = 5
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=10)
    clients = _clients(user_client, worlds, threads)
    body = change("received", 4)

    responses = _together(
        threads, lambda i: adjust(clients[i], product.variant_ids[0], body, key="double-tap")
    )

    assert [r.status_code for r in responses] == [201] * threads, [r.get_json() for r in responses]
    assert len({r.get_json()["movement"]["id"] for r in responses}) == 1
    assert len(item_movements(owner_engine, product.item_ids[0])) == 2
    assert balance(owner_engine, product.item_ids[0]).on_hand == 14
    assert len(history(owner_engine, a.tenant_id, "stock.adjusted")) == 1


def test_a_lock_held_past_the_lock_timeout_answers_try_again_and_records_nothing(
    user_client: UserClient,
    app: Flask,
    config: Config,
    owner_engine: Engine,
    worlds: TwoTenants,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    a = worlds.a
    product = arrange_product(owner_engine, a.tenant_id, a.user_id, on_hand=10)
    item_id = product.item_ids[0]
    client = user_client(a.user("manager"), a.tenant_id)
    # The application's engine with a short lock timeout, so the test need not wait 10 s.
    impatient = create_engine(
        config.database_url,
        connect_args={"options": "-c statement_timeout=30000 -c lock_timeout=300"},
    )
    monkeypatch.setitem(app.extensions, "bos_engine", impatient)
    try:
        with owner_engine.connect() as holder, holder.begin():
            holder.execute(
                text("SELECT 1 FROM stock_balances WHERE inventory_item_id = :i FOR UPDATE"),
                {"i": item_id},
            )
            response = adjust(client, product.variant_ids[0], change("received", 1), key="busy-1")
    finally:
        impatient.dispose()

    assert response.status_code == 503, response.get_data(as_text=True)
    assert response.get_json()["error"]["code"] == "try_again"
    assert response.headers["Retry-After"] == "1"
    assert len(item_movements(owner_engine, item_id)) == 1
    assert balance(owner_engine, item_id).version == 1
    assert (
        owner_value(owner_engine, "SELECT count(*) FROM idempotency_keys WHERE key = 'busy-1'") == 0
    )
    assert history(owner_engine, a.tenant_id, "stock.adjusted") == []
