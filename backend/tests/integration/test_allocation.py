"""T071 — the allocation service, ``app.services.allocation`` (US3, FR-018 to FR-020, R44, R45).

No HTTP route exists in M1: the service is called the way M2's order confirmation will call
it, inside a tenant transaction of the application role. All or nothing; a request key makes
a repeat return the first result; release and consume follow the state rules of
data-model.md. Every test ends with the stock integrity check.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.tenancy import tenant_transaction
from app.services import allocation
from app.services.allocation import AllocationRefused
from app.services.common import NotFound
from app.services.inventory import StockActor
from tests.dbsupport import Balance, CatalogProduct, TwoTenants
from tests.integration.stock_support import arrange_product, balance, item_movements
from tests.integration.us1_support import history, owner_rows, owner_sql

pytestmark = pytest.mark.usefixtures("integrity_check")


@pytest.fixture()
def worlds(fresh_tenants: TwoTenants) -> TwoTenants:
    return fresh_tenants


@pytest.fixture()
def system(worlds: TwoTenants) -> StockActor:
    return StockActor(tenant_id=worlds.a.tenant_id)


@pytest.fixture()
def stock(owner_engine: Engine, worlds: TwoTenants) -> CatalogProduct:
    """Three variants of one product with 5, 3 and 0 on hand."""
    a = worlds.a
    return arrange_product(
        owner_engine, a.tenant_id, a.user_id, variants=3, on_hand=[5, 3, 0], code="ALC"
    )


@contextmanager
def _business(app_engine: Engine, worlds: TwoTenants) -> Iterator[Session]:
    with tenant_transaction(app_engine, worlds.a.tenant_id) as db:
        yield db


def _balances(owner: Engine, product: CatalogProduct) -> list[Balance]:
    return [balance(owner, item) for item in product.item_ids]


def _allocations(owner: Engine, tenant_id: uuid.UUID) -> list[tuple[str, str]]:
    return [
        (row.request_key, row.status)
        for row in owner_rows(
            owner,
            "SELECT request_key, status FROM allocations WHERE tenant_id = :t ORDER BY created_at",
            t=tenant_id,
        )
    ]


def _refused_inside(db: Session, code: str, call: Callable[[], object]) -> AllocationRefused:
    """The refusal, and proof the caller's transaction holds nothing of the request."""
    before = db.execute(text("SELECT count(*) FROM allocations")).scalar_one()
    balances = db.execute(
        text("SELECT inventory_item_id, allocated, version FROM stock_balances ORDER BY 1")
    ).all()
    with pytest.raises(AllocationRefused) as refusal:
        call()
    assert refusal.value.code == code
    assert db.execute(text("SELECT count(*) FROM allocations")).scalar_one() == before
    assert (
        db.execute(
            text("SELECT inventory_item_id, allocated, version FROM stock_balances ORDER BY 1")
        ).all()
        == balances
    )
    return refusal.value


# ---- all or nothing (US3 scenario 2) ---------------------------------------------------------


def test_every_line_is_reserved_in_one_step(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    first, second, _ = stock.item_ids
    with _business(app_engine, worlds) as db:
        made = allocation.allocate(db, system, "order-1", [(first, 2), (second, 3)])

    assert (made.request_key, made.status) == ("order-1", "active")
    assert sorted(made.lines) == sorted([allocation.Line(first, 2), allocation.Line(second, 3)])
    assert _balances(owner_engine, stock) == [Balance(5, 2, 2), Balance(3, 3, 2), Balance(0, 0, 1)]
    assert _allocations(owner_engine, worlds.a.tenant_id) == [("order-1", "active")]
    lines = owner_rows(
        owner_engine,
        "SELECT inventory_item_id, quantity FROM allocation_lines WHERE allocation_id = :a "
        "ORDER BY quantity",
        a=made.id,
    )
    assert [(r.inventory_item_id, r.quantity) for r in lines] == [(first, 2), (second, 3)]


def test_one_short_line_reserves_nothing_and_every_short_line_is_listed(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    first, second, third = stock.item_ids
    with _business(app_engine, worlds) as db:
        refusal = _refused_inside(
            db,
            "insufficient_stock",
            lambda: allocation.allocate(db, system, "order-1", [(first, 2), (second, 4)]),
        )
        assert refusal.lines == [{"inventory_item_id": second, "requested": 4, "available": 3}]
        refusal = _refused_inside(
            db,
            "insufficient_stock",
            lambda: allocation.allocate(
                db, system, "order-2", [(third, 1), (first, 6), (second, 3)]
            ),
        )
        assert sorted(refusal.lines, key=lambda line: str(line["inventory_item_id"])) == sorted(
            [
                {"inventory_item_id": first, "requested": 6, "available": 5},
                {"inventory_item_id": third, "requested": 1, "available": 0},
            ],
            key=lambda line: str(line["inventory_item_id"]),
        )

    assert _balances(owner_engine, stock) == [Balance(5, 0, 1), Balance(3, 0, 1), Balance(0, 0, 1)]
    assert _allocations(owner_engine, worlds.a.tenant_id) == []
    assert history(owner_engine, worlds.a.tenant_id, "stock.allocated") == []


def test_available_counts_what_is_already_allocated(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    first = stock.item_ids[0]
    with _business(app_engine, worlds) as db:
        allocation.allocate(db, system, "order-1", [(first, 4)])
    with _business(app_engine, worlds) as db:
        refusal = _refused_inside(
            db,
            "insufficient_stock",
            lambda: allocation.allocate(db, system, "order-2", [(first, 2)]),
        )
        assert refusal.lines == [{"inventory_item_id": first, "requested": 2, "available": 1}]
        allocation.allocate(db, system, "order-3", [(first, 1)])

    assert balance(owner_engine, first) == Balance(5, 5, 3)


def test_an_unknown_item_refuses_the_whole_request(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    unknown = uuid.uuid4()
    foreign = arrange_product(
        owner_engine, worlds.b.tenant_id, worlds.b.user_id, on_hand=9, code="B-1"
    ).item_ids[0]
    with _business(app_engine, worlds) as db:
        for missing in (unknown, foreign):
            refusal = _refused_inside(
                db,
                "unknown_item",
                lambda missing=missing: allocation.allocate(
                    db, system, "order-1", [(stock.item_ids[0], 1), (missing, 1)]
                ),
            )
            assert refusal.lines == [{"inventory_item_id": missing}]

    assert balance(owner_engine, foreign) == Balance(9, 0, 1)


@pytest.mark.parametrize("archived", ["variant", "product"])
def test_an_archived_variant_or_product_is_refused(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
    archived: str,
) -> None:
    other = arrange_product(owner_engine, worlds.a.tenant_id, worlds.a.user_id, on_hand=4)
    if archived == "variant":
        owner_sql(
            owner_engine,
            "UPDATE variants SET status = 'archived', archived_at = now() WHERE id = :v",
            v=stock.variant_ids[1],
        )
        target = stock.item_ids[1]
    else:
        owner_sql(
            owner_engine,
            "UPDATE products SET status = 'archived', archived_at = now() WHERE id = :p",
            p=stock.product_id,
        )
        target = stock.item_ids[0]
    with _business(app_engine, worlds) as db:
        refusal = _refused_inside(
            db,
            "variant_archived",
            lambda: allocation.allocate(
                db, system, "order-1", [(other.item_ids[0], 1), (target, 1)]
            ),
        )

    assert refusal.lines == [{"inventory_item_id": target}]
    assert balance(owner_engine, other.item_ids[0]) == Balance(4, 0, 1)


@pytest.mark.parametrize(
    ("key", "lines", "field"),
    [
        ("order-1", [], "lines"),
        ("order-1", "too many", "lines"),
        ("order-1", [("first", 0)], "lines.0.quantity"),
        ("order-1", [("first", -2)], "lines.0.quantity"),
        ("order-1", [("first", True)], "lines.0.quantity"),
        ("order-1", [("first", 1_000_001)], "lines.0.quantity"),
        ("order-1", [("first", 1), ("second", 1), ("first", 2)], "lines.2.inventory_item_id"),
        ("", [("first", 1)], "request_key"),
        ("k" * 201, [("first", 1)], "request_key"),
    ],
    ids=[
        "no lines",
        "101 lines",
        "zero",
        "negative",
        "boolean",
        "over 1000000",
        "item twice",
        "empty key",
        "key of 201",
    ],
)
def test_the_request_shape_is_checked(
    app_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
    key: str,
    lines: object,
    field: str,
) -> None:
    names = {"first": stock.item_ids[0], "second": stock.item_ids[1]}
    if lines == "too many":
        request = [(uuid.uuid4(), 1) for _ in range(101)]
    else:
        assert isinstance(lines, list)
        request = [(names[name], quantity) for name, quantity in lines]
    with _business(app_engine, worlds) as db:
        refusal = _refused_inside(
            db, "invalid", lambda: allocation.allocate(db, system, key, request)
        )

    assert refusal.field == field


def test_a_key_of_200_characters_and_100_lines_are_accepted(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants, system: StockActor
) -> None:
    a = worlds.a
    items = [
        item
        for n in range(5)
        for item in arrange_product(
            owner_engine, a.tenant_id, a.user_id, variants=20, on_hand=1, code=f"HUNDRED-{n}"
        ).item_ids
    ]
    with _business(app_engine, worlds) as db:
        made = allocation.allocate(db, system, "k" * 200, [(i, 1) for i in items])

    assert len(made.lines) == 100


# ---- the request key (FR-019, R44) --------------------------------------------------------------


def test_the_same_key_and_contents_return_the_original_whatever_its_state(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    first, second, _ = stock.item_ids
    with _business(app_engine, worlds) as db:
        made = allocation.allocate(db, system, "order-1", [(first, 2), (second, 1)])
    with _business(app_engine, worlds) as db:
        again = allocation.allocate(db, system, "order-1", [(second, 1), (first, 2)])
    assert again == made
    assert _balances(owner_engine, stock)[:2] == [Balance(5, 2, 2), Balance(3, 1, 2)]

    with _business(app_engine, worlds) as db:
        allocation.release(db, system, made.id)
    with _business(app_engine, worlds) as db:
        after_release = allocation.allocate(db, system, "order-1", [(first, 2), (second, 1)])

    assert (after_release.id, after_release.status) == (made.id, "released")
    assert _balances(owner_engine, stock)[:2] == [Balance(5, 0, 3), Balance(3, 0, 3)]
    assert len(history(owner_engine, worlds.a.tenant_id, "stock.allocated")) == 1


def test_the_same_key_with_other_contents_is_refused(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    first, second, _ = stock.item_ids
    with _business(app_engine, worlds) as db:
        allocation.allocate(db, system, "order-1", [(first, 2)])
    with _business(app_engine, worlds) as db:
        for other in ([(first, 3)], [(second, 2)], [(first, 2), (second, 1)]):
            _refused_inside(
                db,
                "allocation_key_conflict",
                lambda other=other: allocation.allocate(db, system, "order-1", other),
            )

    assert balance(owner_engine, first) == Balance(5, 2, 2)


def test_request_keys_belong_to_one_business(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    b = worlds.b
    other = arrange_product(owner_engine, b.tenant_id, b.user_id, on_hand=2, code="B-1")
    with _business(app_engine, worlds) as db:
        allocation.allocate(db, system, "order-1", [(stock.item_ids[0], 1)])
    with tenant_transaction(app_engine, b.tenant_id) as db:
        theirs = allocation.allocate(
            db, StockActor(tenant_id=b.tenant_id), "order-1", [(other.item_ids[0], 2)]
        )

    assert theirs.status == "active"
    assert balance(owner_engine, other.item_ids[0]) == Balance(2, 2, 2)


# ---- release and consume (FR-020, US3 scenario 4) -----------------------------------------------


def test_release_returns_the_quantity_and_can_be_repeated(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    first, second, _ = stock.item_ids
    with _business(app_engine, worlds) as db:
        made = allocation.allocate(db, system, "order-1", [(first, 2), (second, 3)])
    with _business(app_engine, worlds) as db:
        released = allocation.release(db, system, made.id)
    with _business(app_engine, worlds) as db:
        again = allocation.release(db, system, made.id)

    assert released.status == again.status == "released"
    assert _balances(owner_engine, stock)[:2] == [Balance(5, 0, 3), Balance(3, 0, 3)]
    assert len(history(owner_engine, worlds.a.tenant_id, "stock.released")) == 1
    released_at = owner_rows(
        owner_engine, "SELECT released_at, consumed_at FROM allocations WHERE id = :a", a=made.id
    )
    assert released_at[0].released_at is not None and released_at[0].consumed_at is None


def test_consume_lowers_on_hand_and_allocated_with_one_movement_per_line(
    app_engine: Engine, owner_engine: Engine, worlds: TwoTenants, stock: CatalogProduct
) -> None:
    a = worlds.a
    person = StockActor(tenant_id=a.tenant_id, user_id=a.user_id)
    first, second, _ = stock.item_ids
    with _business(app_engine, worlds) as db:
        made = allocation.allocate(db, person, "order-1", [(first, 2), (second, 3)])
    with _business(app_engine, worlds) as db:
        consumed = allocation.consume(db, person, made.id)
    with _business(app_engine, worlds) as db:
        again = allocation.consume(db, person, made.id)

    assert consumed.status == again.status == "consumed"
    assert _balances(owner_engine, stock)[:2] == [Balance(3, 0, 3), Balance(0, 0, 3)]
    for item, quantity, after in ((first, -2, 3), (second, -3, 0)):
        movement = item_movements(owner_engine, item)[-1]
        assert (movement.reason, movement.quantity, movement.on_hand_after) == (
            "allocation_consumed",
            quantity,
            after,
        )
        assert (movement.source, movement.allocation_id) == ("allocation", made.id)
        assert (movement.actor_type, movement.actor_id) == ("user", a.user_id)
        assert movement.request_key == "order-1"
    assert len(history(owner_engine, a.tenant_id, "stock.consumed")) == 1


def test_a_system_consumption_is_recorded_as_the_system(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    with _business(app_engine, worlds) as db:
        made = allocation.allocate(db, system, "order-1", [(stock.item_ids[0], 1)])
        allocation.consume(db, system, made.id)

    movement = item_movements(owner_engine, stock.item_ids[0])[-1]
    assert (movement.actor_type, movement.actor_id) == ("system", None)


def test_an_archived_variant_can_still_be_released_and_consumed(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    with _business(app_engine, worlds) as db:
        one = allocation.allocate(db, system, "order-1", [(stock.item_ids[0], 1)])
        two = allocation.allocate(db, system, "order-2", [(stock.item_ids[0], 1)])
    owner_sql(
        owner_engine,
        "UPDATE products SET status = 'archived', archived_at = now() WHERE id = :p",
        p=stock.product_id,
    )
    with _business(app_engine, worlds) as db:
        allocation.release(db, system, one.id)
        allocation.consume(db, system, two.id)

    assert balance(owner_engine, stock.item_ids[0]) == Balance(4, 0, 5)


@pytest.mark.parametrize(("first", "then"), [("consume", "release"), ("release", "consume")])
def test_the_other_transition_of_a_closed_allocation_is_refused(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
    first: str,
    then: str,
) -> None:
    with _business(app_engine, worlds) as db:
        made = allocation.allocate(db, system, "order-1", [(stock.item_ids[0], 2)])
        getattr(allocation, first)(db, system, made.id)
    before = balance(owner_engine, stock.item_ids[0])
    with _business(app_engine, worlds) as db:
        _refused_inside(
            db, "allocation_closed", lambda: getattr(allocation, then)(db, system, made.id)
        )

    assert balance(owner_engine, stock.item_ids[0]) == before


@pytest.mark.parametrize("action", ["release", "consume"])
def test_an_unknown_allocation_is_not_found(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
    action: str,
) -> None:
    b = worlds.b
    other = arrange_product(owner_engine, b.tenant_id, b.user_id, on_hand=2, code="B-1")
    with tenant_transaction(app_engine, b.tenant_id) as db:
        foreign = allocation.allocate(
            db, StockActor(tenant_id=b.tenant_id), "order-b", [(other.item_ids[0], 1)]
        )
    with _business(app_engine, worlds) as db:
        for allocation_id in (uuid.uuid4(), foreign.id):
            with pytest.raises(NotFound):
                getattr(allocation, action)(db, system, allocation_id)

    assert balance(owner_engine, other.item_ids[0]) == Balance(2, 1, 2)


# ---- history and versions (FR-020, R43) ---------------------------------------------------------


def test_each_change_is_recorded_with_the_allocation_id_and_lines(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    a = worlds.a
    person = StockActor(tenant_id=a.tenant_id, user_id=a.user_id)
    first, second, _ = stock.item_ids
    with _business(app_engine, worlds) as db:
        kept = allocation.allocate(db, person, "order-1", [(first, 2), (second, 1)])
        dropped = allocation.allocate(db, system, "order-2", [(first, 1)])
        allocation.consume(db, person, kept.id)
        allocation.release(db, system, dropped.id)

    rows = [e for e in history(owner_engine, a.tenant_id) if e.event.startswith("stock.")]
    assert len(rows) == 4
    entries = {(e.event, e.target_id): e for e in rows}
    expected_lines = sorted(
        [
            {"sku": stock.skus[0], "inventory_item_id": str(first), "quantity": 2},
            {"sku": stock.skus[1], "inventory_item_id": str(second), "quantity": 1},
        ],
        key=lambda line: line["inventory_item_id"],
    )
    for event in ("stock.allocated", "stock.consumed"):
        entry = entries[(event, kept.id)]
        assert (entry.target_type, entry.target_id) == ("allocation", kept.id)
        assert (entry.actor_type, entry.actor_id) == ("user", a.user_id)
        assert entry.data == {"lines": expected_lines}
    for event in ("stock.allocated", "stock.released"):
        entry = entries[(event, dropped.id)]
        assert (entry.target_type, entry.target_id) == ("allocation", dropped.id)
        assert (entry.actor_type, entry.actor_id) == ("system", None)
        assert entry.data == {
            "lines": [{"sku": stock.skus[0], "inventory_item_id": str(first), "quantity": 1}],
        }
    assert len(entries) == 4


def test_every_change_bumps_the_balance_version_by_one(
    app_engine: Engine,
    owner_engine: Engine,
    worlds: TwoTenants,
    stock: CatalogProduct,
    system: StockActor,
) -> None:
    item = stock.item_ids[0]
    versions = [balance(owner_engine, item).version]
    with _business(app_engine, worlds) as db:
        one = allocation.allocate(db, system, "order-1", [(item, 1)])
    versions.append(balance(owner_engine, item).version)
    with _business(app_engine, worlds) as db:
        allocation.release(db, system, one.id)
    versions.append(balance(owner_engine, item).version)
    with _business(app_engine, worlds) as db:
        two = allocation.allocate(db, system, "order-2", [(item, 1)])
    versions.append(balance(owner_engine, item).version)
    with _business(app_engine, worlds) as db:
        allocation.consume(db, system, two.id)
    versions.append(balance(owner_engine, item).version)

    assert versions == [1, 2, 3, 4, 5]
