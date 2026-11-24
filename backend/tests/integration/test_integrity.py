"""T020 — the integrity report (FR-022, data-model.md "Integrity rules").

A consistent business gives an empty report. Each rule is then broken on purpose with SQL as
the owner role (committed, because the report runs as the application role in its own
transaction) and the report must name the rule, the inventory item and the expected and
actual numbers. Rule 5 (``on_hand - allocated >= 0``) is not tested by breaking it: the
balance CHECK refuses that even to the owner role (tests/integration/test_migration_0003.py).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator

import pytest
from sqlalchemy import Engine, text

from app.core.tenancy import tenant_transaction
from app.services.inventory import IntegrityProblem, integrity_report
from tests.dbsupport import TwoTenants, insert, insert_product, make_two_tenants, truncate_all


@pytest.fixture()
def worlds(owner_engine: Engine) -> Iterator[TwoTenants]:
    yield make_two_tenants(owner_engine, catalog=True)
    truncate_all(owner_engine)


def _report(app_engine: Engine, tenant_id: uuid.UUID) -> list[IntegrityProblem]:
    with tenant_transaction(app_engine, tenant_id) as db:
        return integrity_report(db)


def _found(problems: list[IntegrityProblem]) -> set[tuple[int, uuid.UUID | None, int, int]]:
    return {(p.rule, p.inventory_item_id, p.expected, p.actual) for p in problems}


def _break(owner: Engine, *statements: str, **params: object) -> None:
    with owner.begin() as conn:
        # Only for the warehouse rule: the owner switches foreign-key checks off.
        conn.execute(text("SET LOCAL session_replication_role = replica"))
        for statement in statements:
            conn.execute(text(statement), params)


def _movement(owner: Engine, worlds: TwoTenants, **values: object) -> None:
    a = worlds.a
    with owner.begin() as conn:
        insert(
            conn,
            "stock_movements",
            id=uuid.uuid4(),
            tenant_id=a.tenant_id,
            warehouse_id=a.warehouse_id,
            inventory_item_id=a.catalog.item_id,
            source="manual",
            actor_type="user",
            actor_id=a.user_id,
            **values,
        )


def test_a_consistent_business_has_an_empty_report(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    with owner_engine.begin() as conn:
        insert_product(
            conn, worlds.a.tenant_id, worlds.a.user_id, variants=3, on_hand=[0, 4, 1_000_000]
        )

    assert _report(app_engine, worlds.a.tenant_id) == []
    assert _report(app_engine, worlds.b.tenant_id) == []


def test_a_variant_without_a_balance_is_reported(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    item = worlds.a.catalog.item_id
    _break(owner_engine, "DELETE FROM stock_balances WHERE inventory_item_id = :i", i=item)

    problems = _report(app_engine, worlds.a.tenant_id)

    assert (1, item, 1, 0) in _found(problems)
    assert all(p.rule == 1 for p in problems)
    assert _report(app_engine, worlds.b.tenant_id) == []  # one business at a time


def test_an_inventory_item_without_a_variant_is_reported(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    orphan = uuid.uuid4()
    with owner_engine.begin() as conn:
        insert(conn, "inventory_items", id=orphan, tenant_id=a.tenant_id)
        insert(
            conn,
            "stock_balances",
            tenant_id=a.tenant_id,
            warehouse_id=a.warehouse_id,
            inventory_item_id=orphan,
            on_hand=0,
            allocated=0,
        )

    assert _found(_report(app_engine, a.tenant_id)) == {(1, orphan, 1, 0)}


def test_on_hand_different_from_the_sum_of_movements_is_reported(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    # A movement of +2 whose balance was never written: the ledger says 7, the balance 5.
    _movement(owner_engine, worlds, quantity=2, reason="received", on_hand_after=5)

    problems = _report(app_engine, worlds.a.tenant_id)

    assert _found(problems) == {(2, worlds.a.catalog.item_id, 7, 5)}
    [problem] = problems
    assert problem.description


def test_on_hand_different_from_the_latest_on_hand_after_is_reported(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    # A count of 9 recorded (difference 0, so the sum still agrees) but the balance says 5.
    _movement(
        owner_engine,
        worlds,
        quantity=0,
        reason="count_correction",
        counted_quantity=9,
        on_hand_after=9,
    )

    assert _found(_report(app_engine, worlds.a.tenant_id)) == {(3, worlds.a.catalog.item_id, 9, 5)}


def test_allocated_different_from_the_active_allocation_lines_is_reported(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    item = worlds.a.catalog.item_id
    _break(
        owner_engine, "UPDATE stock_balances SET allocated = 3 WHERE inventory_item_id = :i", i=item
    )

    assert _found(_report(app_engine, worlds.a.tenant_id)) == {(4, item, 1, 3)}


def test_a_released_allocation_still_counted_in_allocated_is_reported(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    _break(
        owner_engine,
        "UPDATE allocations SET status = 'released', released_at = now() WHERE id = :id",
        id=worlds.a.catalog.allocation_id,
    )

    assert _found(_report(app_engine, worlds.a.tenant_id)) == {(4, worlds.a.catalog.item_id, 0, 1)}


def test_a_business_without_its_default_warehouse_is_reported(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants
) -> None:
    _break(owner_engine, "DELETE FROM warehouses WHERE tenant_id = :t", t=worlds.a.tenant_id)

    problems = _report(app_engine, worlds.a.tenant_id)

    assert (6, None, 1, 0) in _found(problems)
    assert _report(app_engine, worlds.b.tenant_id) == []


def test_the_integrity_check_fixture_fails_a_test_that_leaves_a_difference(
    integrity_check: Callable[[], None], owner_engine: Engine, worlds: TwoTenants
) -> None:
    item = worlds.a.catalog.item_id
    integrity_check()  # consistent: passes
    _break(
        owner_engine, "UPDATE stock_balances SET allocated = 2 WHERE inventory_item_id = :i", i=item
    )

    with pytest.raises(pytest.fail.Exception, match="rule 4"):
        integrity_check()

    # Repaired, so the check run after this test (pytest_runtest_call) passes again.
    _break(
        owner_engine, "UPDATE stock_balances SET allocated = 1 WHERE inventory_item_id = :i", i=item
    )
