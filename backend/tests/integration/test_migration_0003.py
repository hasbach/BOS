"""T014 — migration 0003 (catalog and inventory) and the rules the database itself enforces.

Part one starts from ``0002`` with M0 data (two businesses), upgrades to ``0003``, checks the
backfill, rolls back to ``0002`` with catalog data in place and upgrades to head again
(constitution VIII). Part two tries one bad row per CHECK, unique index and foreign key of
``specs/002-native-catalog-inventory/data-model.md`` as the owner role (which is not subject
to row-level security, so only the constraints can refuse), each in a transaction that is
rolled back.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest
from alembic import command
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from app.cli import alembic_config
from app.config import Config
from tests.dbsupport import (
    CATALOG_TABLES,
    TwoTenants,
    World,
    insert,
    insert_catalog_rows,
    make_operator,
    make_two_tenants,
    truncate_all,
)


def _value(owner: Engine, sql: str, **params: Any) -> Any:
    with owner.connect() as conn:
        return conn.execute(text(sql), params).scalar()


def _rows(owner: Engine, sql: str, **params: Any) -> list[Any]:
    with owner.connect() as conn:
        return list(conn.execute(text(sql), params).all())


# ---- part one: upgrade, backfill, downgrade, upgrade again ------------------------------------


@pytest.fixture()
def at_0002_with_m0_data(config: Config, owner_engine: Engine) -> Iterator[tuple[World, World]]:
    alembic = alembic_config(config.migration_database_url)
    truncate_all(owner_engine)
    command.downgrade(alembic, "0002")
    try:
        with owner_engine.begin() as conn:
            operator_id = make_operator(conn)
            worlds = (
                World(conn, operator_id, "a", warehouse=False),
                World(conn, operator_id, "b", warehouse=False),
            )
        yield worlds
    finally:
        command.upgrade(alembic, "head")
        truncate_all(owner_engine)


def test_0003_backfills_warehouses_and_rolls_back_to_0002_and_forward_again(
    config: Config, owner_engine: Engine, at_0002_with_m0_data: tuple[World, World]
) -> None:
    a, b = at_0002_with_m0_data
    alembic = alembic_config(config.migration_database_url)
    assert _value(owner_engine, "SELECT version_num FROM alembic_version") == "0002"

    command.upgrade(alembic, "0003")

    assert _value(owner_engine, "SELECT version_num FROM alembic_version") == "0003"
    for world in (a, b):
        warehouses = _rows(
            owner_engine,
            "SELECT name, is_default FROM warehouses WHERE tenant_id = :t",
            t=world.tenant_id,
        )
        assert [(w.name, w.is_default) for w in warehouses] == [("Main", True)]
        assert (
            _value(
                owner_engine,
                "SELECT low_stock_default FROM tenants WHERE id = :t",
                t=world.tenant_id,
            )
            == 2
        )
    assert _value(owner_engine, "SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm'") == 1
    for table in CATALOG_TABLES:
        row = _rows(
            owner_engine,
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE relname = :t AND relkind = 'r'",
            t=table,
        )
        assert [(r.relrowsecurity, r.relforcerowsecurity) for r in row] == [(True, True)], table
        policies = _value(
            owner_engine,
            "SELECT count(*) FROM pg_policies WHERE tablename = :t AND policyname = 'tenant_isolation'",
            t=table,
        )
        assert policies == 1, table
    trigram = _rows(
        owner_engine,
        "SELECT tablename, indexdef FROM pg_indexes "
        "WHERE indexdef LIKE '%USING gin%' AND indexdef LIKE '%gin_trgm_ops%'",
    )
    indexed = {
        (r.tablename, column)
        for r in trigram
        for column in ("lower(name_en)", "name_ar", "code_key", "sku_key")
        if f"({column} gin_trgm_ops)" in r.indexdef
    }
    assert indexed == {
        ("products", "lower(name_en)"),
        ("products", "name_ar"),
        ("products", "code_key"),
        ("variants", "sku_key"),
    }

    # Catalog data that the rollback must remove, including two product photo file rows.
    with owner_engine.begin() as conn:
        a._warehouse_id = conn.execute(
            text("SELECT id FROM warehouses WHERE tenant_id = :t"), {"t": a.tenant_id}
        ).scalar_one()
        insert_catalog_rows(conn, a)
    assert _value(owner_engine, "SELECT count(*) FROM files WHERE kind = 'product_photo'") == 2
    assert _value(owner_engine, "SELECT count(*) FROM stock_movements") == 1

    command.downgrade(alembic, "0002")

    assert _value(owner_engine, "SELECT version_num FROM alembic_version") == "0002"
    for table in CATALOG_TABLES:
        assert _value(owner_engine, f"SELECT to_regclass('public.{table}')") is None, table
    assert (
        _value(
            owner_engine,
            "SELECT count(*) FROM pg_proc WHERE proname = 'stock_movements_are_append_only'",
        )
        == 0
    )
    assert _value(owner_engine, "SELECT count(*) FROM files WHERE kind = 'product_photo'") == 0
    assert _value(owner_engine, "SELECT count(*) FROM files") == 2  # the two store logos stay
    assert (
        _value(
            owner_engine,
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_name = 'tenants' AND column_name = 'low_stock_default'",
        )
        == 0
    )
    # pg_trgm stays installed: it may predate BOS and is harmless.
    assert _value(owner_engine, "SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm'") == 1
    # M0's files CHECKs are back.
    for kind, size in (("product_photo", 10), ("store_logo", 2097153)):
        with pytest.raises(DBAPIError) as refused, owner_engine.begin() as conn:
            insert(
                conn,
                "files",
                id=uuid.uuid4(),
                tenant_id=a.tenant_id,
                kind=kind,
                storage_path=f"tenant/{a.tenant_id}/{uuid.uuid4().hex}.webp",
                mime="image/webp",
                size_bytes=size,
                created_by_user_id=a.user_id,
            )
        assert refused.value.orig.sqlstate == "23514"  # type: ignore[union-attr]

    command.upgrade(alembic, "head")

    assert _value(owner_engine, "SELECT version_num FROM alembic_version") == "0003"
    assert _value(owner_engine, "SELECT count(*) FROM warehouses") == 2


# ---- part two: every rule of the data model refuses a bad row ---------------------------------


@pytest.fixture(scope="module")
def worlds(owner_engine: Engine) -> Iterator[TwoTenants]:
    yield make_two_tenants(owner_engine, catalog=True)
    truncate_all(owner_engine)


def _params(worlds: TwoTenants) -> dict[str, Any]:
    a, b = worlds.a, worlds.b
    return {
        "t": a.tenant_id,
        "user": a.user_id,
        "store": a.store_id,
        "wh": a.warehouse_id,
        "file": a.file_id,
        "batch": a.catalog.import_batch_id,
        "product": a.catalog.product_id,
        "code": a.catalog.code,
        "option": a.catalog.option_id,
        "value": a.catalog.value_id,
        "photo": a.catalog.photo_id,
        "thumb": a.catalog.thumb_file_id,
        "large": a.catalog.large_file_id,
        "item": a.catalog.item_id,
        "variant": a.catalog.variant_id,
        "sku": a.catalog.sku,
        "allocation": a.catalog.allocation_id,
        "b_t": b.tenant_id,
        "b_store": b.store_id,
        "b_item": b.catalog.item_id,
        "b_product": b.catalog.product_id,
        **{f"n{i}": uuid.uuid4() for i in range(1, 7)},
    }


# Default columns (as SQL expressions over the parameters above) of a valid new row per table.
_DEFAULTS: dict[str, dict[str, str]] = {
    "warehouses": {"id": ":n1", "tenant_id": ":t", "name": "'Second'", "is_default": "true"},
    "import_batches": {
        "id": ":n1",
        "tenant_id": ":t",
        "created_by_user_id": ":user",
        "status": "'previewed'",
        "file_name": "'new.csv'",
        "file_sha256": "'\\x00'::bytea",
        "row_count": "1",
        "product_count": "1",
        "variant_count": "1",
        "opening_units": "0",
    },
    "products": {
        "id": ":n1",
        "tenant_id": ":t",
        "code": "'NEW-1'",
        "name_en": "'New product'",
        "created_by_user_id": ":user",
    },
    "product_stores": {"tenant_id": ":t", "product_id": ":product", "store_id": ":store"},
    "product_options": {
        "id": ":n1",
        "tenant_id": ":t",
        "product_id": ":product",
        "position": "2",
        "name": "'Colour'",
    },
    "option_values": {
        "id": ":n1",
        "tenant_id": ":t",
        "product_id": ":product",
        "option_id": ":option",
        "position": "2",
        "label": "'L'",
    },
    "product_photos": {
        "id": ":n1",
        "tenant_id": ":t",
        "product_id": ":product",
        "position": "1",
        "thumb_file_id": ":thumb",
        "large_file_id": ":large",
        "width": "100",
        "height": "100",
        "created_by_user_id": ":user",
    },
    "variants": {
        "id": ":n1",
        "tenant_id": ":t",
        "product_id": ":product",
        "inventory_item_id": ":n2",
        "sku": "'NEW-SKU'",
        "price": "10.50",
        "currency": "'USD'",
    },
    "stock_balances": {
        "tenant_id": ":t",
        "warehouse_id": ":wh",
        "inventory_item_id": ":n2",
        "on_hand": "0",
        "allocated": "0",
    },
    "stock_movements": {
        "id": ":n1",
        "tenant_id": ":t",
        "warehouse_id": ":wh",
        "inventory_item_id": ":item",
        "quantity": "1",
        "reason": "'received'",
        "on_hand_after": "6",
        "source": "'manual'",
        "actor_type": "'user'",
        "actor_id": ":user",
    },
    "allocations": {
        "id": ":n1",
        "tenant_id": ":t",
        "request_key": "'order-new'",
        "request_hash": "'\\x00'::bytea",
        "status": "'active'",
        "actor_type": "'system'",
    },
    "allocation_lines": {
        "id": ":n1",
        "tenant_id": ":t",
        "allocation_id": ":allocation",
        "warehouse_id": ":wh",
        "inventory_item_id": ":n2",
        "quantity": "1",
    },
    "files": {
        "id": ":n1",
        "tenant_id": ":t",
        "kind": "'product_photo'",
        "storage_path": "'tenant/x/new.webp'",
        "mime": "'image/webp'",
        "size_bytes": "10",
        "created_by_user_id": ":user",
    },
}

NEW_ITEM = "INSERT INTO inventory_items (id, tenant_id) VALUES (:n2, :t)"


def row(table: str, **overrides: str | None) -> str:
    """INSERT of a valid new row of ``table``, with some columns changed (None: left out)."""
    values = {**_DEFAULTS[table], **overrides}
    present = {name: expr for name, expr in values.items() if expr is not None}
    return (
        f"INSERT INTO {table} ({', '.join(present)}) "  # noqa: S608
        f"VALUES ({', '.join(present.values())})"
    )


def long(n: int) -> str:
    return "'" + "x" * n + "'"


@dataclass(frozen=True)
class Rule:
    id: str
    sql: str
    sqlstate: str | None  # None: the row is accepted
    constraint: str | None = None
    setup: list[str] = field(default_factory=list)
    immediate: bool = False  # check deferred constraints now


CHECK, UNIQUE, FK = "23514", "23505", "23503"
SRC = "stock_movements_source"

RULES = [
    # tenants and files (changed M0 tables)
    Rule(
        "low_stock_default_negative",
        "UPDATE tenants SET low_stock_default = -1 WHERE id = :t",
        CHECK,
    ),
    Rule(
        "low_stock_default_too_large",
        "UPDATE tenants SET low_stock_default = 1000001 WHERE id = :t",
        CHECK,
    ),
    Rule(
        "low_stock_default_zero_ok", "UPDATE tenants SET low_stock_default = 0 WHERE id = :t", None
    ),
    Rule("file_product_photo_ok", row("files"), None),
    Rule("file_5mb_ok", row("files", size_bytes="5242880"), None),
    Rule("file_over_5mb", row("files", size_bytes="5242881"), CHECK),
    Rule("file_unknown_kind", row("files", kind="'avatar'"), CHECK),
    # warehouses
    Rule("second_warehouse", row("warehouses"), UNIQUE),
    Rule("warehouse_not_default", row("warehouses", is_default="false"), CHECK),
    Rule("warehouse_name_empty", row("warehouses", name="''"), CHECK),
    Rule("warehouse_name_too_long", row("warehouses", name=long(81)), CHECK),
    # products
    Rule("product_ok", row("products"), None),
    Rule("product_code_space_inside", row("products", code="'JN SLIM'"), CHECK),
    Rule("product_code_bad_first_char", row("products", code="'-JN'"), CHECK),
    Rule("product_code_non_ascii", row("products", code="'ÉTÉ'"), CHECK),
    Rule("product_code_empty", row("products", code="''"), CHECK),
    Rule("product_code_too_long", row("products", code=long(33)), CHECK),
    Rule("product_code_32_ok", row("products", code=long(32)), None),
    Rule("product_code_same_key_other_case", row("products", code="upper(:code)"), UNIQUE),
    Rule("product_code_surrounding_spaces", row("products", code="' ' || :code || ' '"), CHECK),
    Rule(
        "archived_product_code_still_reserved",
        row("products", code="lower(:code)"),
        UNIQUE,
        setup=["UPDATE products SET status = 'archived', archived_at = now() WHERE id = :product"],
    ),
    Rule("product_without_names", row("products", name_en=None), CHECK),
    Rule("product_arabic_name_only_ok", row("products", name_en=None, name_ar="'جينز'"), None),
    Rule("product_name_empty", row("products", name_en="''"), CHECK),
    Rule("product_name_too_long", row("products", name_en=long(121)), CHECK),
    Rule("product_name_ar_too_long", row("products", name_ar=long(121)), CHECK),
    Rule("product_description_too_long", row("products", description_en=long(2001)), CHECK),
    Rule("product_description_ar_too_long", row("products", description_ar=long(2001)), CHECK),
    Rule("product_unknown_status", row("products", status="'deleted'"), CHECK),
    Rule("product_unknown_import_batch", row("products", import_batch_id=":n3"), FK),
    # product_stores
    Rule("product_listed_twice_in_a_store", row("product_stores"), UNIQUE),
    Rule("product_listed_in_other_tenants_store", row("product_stores", store_id=":b_store"), FK),
    # product_options
    Rule("option_position_3", row("product_options", position="3"), CHECK),
    Rule("option_position_taken", row("product_options", position="1"), UNIQUE),
    Rule("option_name_empty", row("product_options", name="''"), CHECK),
    Rule("option_name_too_long", row("product_options", name=long(41)), CHECK),
    # option_values
    Rule("value_ok", row("option_values"), None),
    Rule("value_position_0", row("option_values", position="0"), CHECK),
    Rule("value_position_21", row("option_values", position="21"), CHECK),
    Rule("value_label_empty", row("option_values", label="''"), CHECK),
    Rule("value_label_too_long", row("option_values", label=long(41)), CHECK),
    Rule("value_label_same_ignoring_case", row("option_values", label="'m'"), UNIQUE),
    Rule("value_unknown_status", row("option_values", status="'gone'"), CHECK),
    Rule(
        "archived_value_with_same_label_ok",
        row("option_values", label="'m'", status="'archived'"),
        None,
    ),
    Rule(
        "value_of_another_products_option",
        row("option_values", product_id=":n3"),
        FK,
        setup=[row("products", id=":n3", code="'Q'")],
    ),
    # product_photos
    Rule("photo_position_8", row("product_photos", position="8"), CHECK),
    Rule("photo_staged_with_position", row("product_photos", product_id=None), CHECK),
    Rule("photo_attached_without_position", row("product_photos", position=None), CHECK),
    Rule(
        "photo_staged_ok",
        row("product_photos", product_id=None, position=None, staged_expires_at="now()"),
        None,
    ),
    Rule(
        "photo_position_taken_at_commit",
        row("product_photos", position="0"),
        UNIQUE,
        immediate=True,
    ),
    Rule(
        "photos_reordered_in_one_transaction_ok",
        "UPDATE product_photos SET position = 0 WHERE id = :n1",
        None,
        setup=[
            row("product_photos", position="1"),
            "UPDATE product_photos SET position = 1 WHERE id = :photo",
        ],
        immediate=True,
    ),
    # variants
    Rule("variant_ok", row("variants"), None, setup=[NEW_ITEM]),
    Rule("variant_item_already_used", row("variants", inventory_item_id=":item"), UNIQUE),
    Rule(
        "variant_other_tenants_item",
        row("variants"),
        FK,
        setup=["INSERT INTO inventory_items (id, tenant_id) VALUES (:n2, :b_t)"],
    ),
    Rule("variant_sku_space_inside", row("variants", sku="'A B'"), CHECK, setup=[NEW_ITEM]),
    Rule("variant_sku_bad_first_char", row("variants", sku="'/AB'"), CHECK, setup=[NEW_ITEM]),
    Rule("variant_sku_empty", row("variants", sku="''"), CHECK, setup=[NEW_ITEM]),
    Rule("variant_sku_too_long", row("variants", sku=long(65)), CHECK, setup=[NEW_ITEM]),
    Rule("variant_sku_64_ok", row("variants", sku=long(64)), None, setup=[NEW_ITEM]),
    Rule(
        "variant_sku_same_key_other_case",
        row("variants", sku="lower(:sku)"),
        UNIQUE,
        setup=[NEW_ITEM],
    ),
    Rule(
        "variant_sku_surrounding_spaces",
        row("variants", sku="' ' || :sku || ' '"),
        CHECK,
        setup=[NEW_ITEM],
    ),
    Rule(
        "archived_variant_sku_still_reserved",
        row("variants", sku=":sku"),
        UNIQUE,
        setup=[NEW_ITEM, "UPDATE variants SET status = 'archived' WHERE id = :variant"],
    ),
    Rule(
        "variant_option2_without_option1",
        row("variants", option2_value_id=":value"),
        CHECK,
        setup=[NEW_ITEM],
    ),
    Rule(
        "variant_same_active_combination",
        row("variants", option1_value_id=":value"),
        UNIQUE,
        setup=[NEW_ITEM],
    ),
    Rule(
        "variant_same_combination_archived_ok",
        row("variants", option1_value_id=":value", status="'archived'"),
        None,
        setup=[NEW_ITEM],
    ),
    Rule(
        "variant_no_options_twice_nulls_not_distinct",
        row("variants", id=":n4", product_id=":n3", inventory_item_id=":n5", sku="'Q-2'"),
        UNIQUE,
        setup=[
            row("products", id=":n3", code="'Q'"),
            NEW_ITEM,
            "INSERT INTO inventory_items (id, tenant_id) VALUES (:n5, :t)",
            row("variants", product_id=":n3", sku="'Q-1'"),
        ],
    ),
    Rule(
        "variant_value_of_another_product",
        row("variants", product_id=":n3", option1_value_id=":value"),
        FK,
        setup=[row("products", id=":n3", code="'Q'"), NEW_ITEM],
    ),
    Rule(
        "variant_photo_of_another_product",
        row("variants", product_id=":n3", photo_id=":photo"),
        FK,
        setup=[row("products", id=":n3", code="'Q'"), NEW_ITEM],
    ),
    Rule("variant_price_negative", row("variants", price="-0.01"), CHECK, setup=[NEW_ITEM]),
    Rule("variant_price_zero_ok", row("variants", price="0"), None, setup=[NEW_ITEM]),
    Rule(
        "variant_price_max_ok",
        row("variants", price="99999999999.99"),
        None,
        setup=[NEW_ITEM],
    ),
    Rule(
        "variant_price_too_large",
        row("variants", price="100000000000.00"),
        CHECK,
        setup=[NEW_ITEM],
    ),
    Rule(
        "variant_lbp_with_decimals",
        row("variants", price="89500.50", currency="'LBP'"),
        CHECK,
        setup=[NEW_ITEM],
    ),
    Rule(
        "variant_lbp_whole_ok",
        row("variants", price="89500", currency="'LBP'"),
        None,
        setup=[NEW_ITEM],
    ),
    Rule("variant_unknown_currency", row("variants", currency="'EUR'"), CHECK, setup=[NEW_ITEM]),
    Rule(
        "variant_low_stock_negative",
        row("variants", low_stock_level="-1"),
        CHECK,
        setup=[NEW_ITEM],
    ),
    Rule(
        "variant_low_stock_too_large",
        row("variants", low_stock_level="1000001"),
        CHECK,
        setup=[NEW_ITEM],
    ),
    Rule("variant_unknown_status", row("variants", status="'gone'"), CHECK, setup=[NEW_ITEM]),
    # stock_balances
    Rule("balance_ok", row("stock_balances", on_hand="3", allocated="3"), None, setup=[NEW_ITEM]),
    Rule("second_balance_for_an_item", row("stock_balances", inventory_item_id=":item"), UNIQUE),
    Rule(
        "balance_oversold",
        row("stock_balances", on_hand="1", allocated="2"),
        CHECK,
        "stock_balances_not_oversold",
        setup=[NEW_ITEM],
    ),
    Rule(
        "balance_negative_allocated",
        row("stock_balances", allocated="-1"),
        CHECK,
        "stock_balances_not_oversold",
        setup=[NEW_ITEM],
    ),
    Rule(
        "balance_negative_on_hand_is_answered_as_oversold",
        row("stock_balances", on_hand="-1"),
        CHECK,
        "stock_balances_not_oversold",
        setup=[NEW_ITEM],
    ),
    Rule(
        "balance_on_hand_too_large",
        row("stock_balances", on_hand="1000001"),
        CHECK,
        "stock_balances_on_hand_range",
        setup=[NEW_ITEM],
    ),
    Rule(
        "allocating_more_than_on_hand",
        "UPDATE stock_balances SET allocated = 6 WHERE inventory_item_id = :item",
        CHECK,
        "stock_balances_not_oversold",
    ),
    # stock_movements: reasons and their signs
    Rule("opening_zero", row("stock_movements", reason="'opening'", quantity="0"), CHECK),
    Rule("received_negative", row("stock_movements", quantity="-1"), CHECK),
    Rule("found_zero", row("stock_movements", reason="'found'", quantity="0"), CHECK),
    Rule("damaged_positive", row("stock_movements", reason="'damaged'"), CHECK),
    Rule("lost_zero", row("stock_movements", reason="'lost'", quantity="0"), CHECK),
    Rule("damaged_negative_ok", row("stock_movements", reason="'damaged'", quantity="-1"), None),
    Rule(
        "allocation_consumed_positive",
        row(
            "stock_movements",
            reason="'allocation_consumed'",
            allocation_id=":allocation",
            source="'allocation'",
            actor_type="'system'",
            actor_id=None,
        ),
        CHECK,
    ),
    Rule(
        "allocation_consumed_ok",
        row(
            "stock_movements",
            reason="'allocation_consumed'",
            quantity="-1",
            on_hand_after="4",
            allocation_id=":allocation",
            source="'allocation'",
            actor_type="'system'",
            actor_id=None,
        ),
        None,
    ),
    Rule(
        "allocation_consumed_without_allocation",
        row(
            "stock_movements",
            reason="'allocation_consumed'",
            quantity="-1",
            source="'allocation'",
        ),
        CHECK,
    ),
    Rule(
        "allocation_on_another_reason",
        row("stock_movements", allocation_id=":allocation"),
        CHECK,
    ),
    Rule("other_zero", row("stock_movements", reason="'other'", quantity="0", note="'x'"), CHECK),
    Rule("other_without_note", row("stock_movements", reason="'other'"), CHECK),
    Rule("other_with_note_ok", row("stock_movements", reason="'other'", note="'gift'"), None),
    Rule(
        "count_correction_without_count", row("stock_movements", reason="'count_correction'"), CHECK
    ),
    Rule(
        "count_correction_zero_ok",
        row(
            "stock_movements",
            reason="'count_correction'",
            quantity="0",
            counted_quantity="5",
            on_hand_after="5",
        ),
        None,
    ),
    Rule("counted_quantity_on_received", row("stock_movements", counted_quantity="6"), CHECK),
    Rule(
        "counted_quantity_negative",
        row("stock_movements", reason="'count_correction'", counted_quantity="-1"),
        CHECK,
    ),
    Rule(
        "quantity_too_large",
        row("stock_movements", quantity="1000001", on_hand_after="1000000"),
        CHECK,
    ),
    Rule(
        "on_hand_after_negative",
        row("stock_movements", reason="'lost'", quantity="-1", on_hand_after="-1"),
        CHECK,
        "stock_movements_on_hand_after_range",
    ),
    Rule(
        "on_hand_after_too_large",
        row("stock_movements", on_hand_after="1000001"),
        CHECK,
        "stock_movements_on_hand_after_range",
    ),
    Rule("note_too_long", row("stock_movements", note=long(501)), CHECK),
    Rule("unknown_reason", row("stock_movements", reason="'stolen'"), CHECK),
    Rule("unknown_actor_type", row("stock_movements", actor_type="'operator'"), CHECK),
    Rule("movement_other_tenants_item", row("stock_movements", inventory_item_id=":b_item"), FK),
    # stock_movements: where a movement came from (stock_movements_source)
    Rule("manual_opening_ok", row("stock_movements", reason="'opening'"), None),
    Rule(
        "product_form_opening_ok",
        row("stock_movements", reason="'opening'", source="'product_form'"),
        None,
    ),
    Rule(
        "import_opening_ok",
        row("stock_movements", reason="'opening'", source="'import'", import_batch_id=":batch"),
        None,
    ),
    Rule("unknown_source", row("stock_movements", source="'robot'"), CHECK, SRC),
    Rule(
        "allocation_source_on_opening",
        row("stock_movements", reason="'opening'", source="'allocation'"),
        CHECK,
        SRC,
    ),
    Rule(
        "allocation_consumed_from_manual",
        row(
            "stock_movements",
            reason="'allocation_consumed'",
            quantity="-1",
            on_hand_after="4",
            allocation_id=":allocation",
        ),
        CHECK,
        SRC,
    ),
    Rule(
        "import_without_batch",
        row("stock_movements", reason="'opening'", source="'import'"),
        CHECK,
        SRC,
    ),
    Rule(
        "batch_on_a_manual_movement",
        row("stock_movements", reason="'opening'", import_batch_id=":batch"),
        CHECK,
        SRC,
    ),
    Rule(
        "import_received",
        row("stock_movements", source="'import'", import_batch_id=":batch"),
        CHECK,
        SRC,
    ),
    Rule("product_form_received", row("stock_movements", source="'product_form'"), CHECK, SRC),
    # an item with history cannot be deleted (no ON DELETE on the ledger and allocation lines)
    Rule(
        "item_with_movements_cannot_be_deleted",
        "DELETE FROM inventory_items WHERE id = :item",
        FK,
        setup=[
            "DELETE FROM allocation_lines WHERE inventory_item_id = :item",
            "DELETE FROM variants WHERE id = :variant",
            "DELETE FROM stock_balances WHERE inventory_item_id = :item",
        ],
    ),
    Rule(
        "item_with_allocation_lines_cannot_be_deleted",
        "DELETE FROM inventory_items WHERE id = :n2",
        FK,
        setup=[NEW_ITEM, row("allocation_lines", id=":n3", allocation_id=":allocation")],
    ),
    # allocations
    Rule("allocation_ok", row("allocations"), None),
    Rule("allocation_key_reused", row("allocations", request_key="'order-a'"), UNIQUE),
    Rule("allocation_key_empty", row("allocations", request_key="''"), CHECK),
    Rule("allocation_key_too_long", row("allocations", request_key=long(201)), CHECK),
    Rule("allocation_unknown_status", row("allocations", status="'paused'"), CHECK),
    Rule("released_without_time", row("allocations", status="'released'"), CHECK),
    Rule("active_with_released_time", row("allocations", released_at="now()"), CHECK),
    Rule("consumed_without_time", row("allocations", status="'consumed'"), CHECK),
    Rule("active_with_consumed_time", row("allocations", consumed_at="now()"), CHECK),
    Rule(
        "released_ok",
        row("allocations", status="'released'", released_at="now()"),
        None,
    ),
    # allocation_lines
    Rule("allocation_line_zero", row("allocation_lines", quantity="0"), CHECK, setup=[NEW_ITEM]),
    Rule(
        "allocation_line_too_large",
        row("allocation_lines", quantity="1000001"),
        CHECK,
        setup=[NEW_ITEM],
    ),
    Rule("allocation_line_item_twice", row("allocation_lines", inventory_item_id=":item"), UNIQUE),
    Rule(
        "allocation_line_other_tenants_item",
        row("allocation_lines", inventory_item_id=":b_item"),
        FK,
    ),
    # import_batches
    Rule("import_batch_ok", row("import_batches"), None),
    Rule("import_batch_unknown_status", row("import_batches", status="'done'"), CHECK),
    Rule("import_batch_too_many_rows", row("import_batches", row_count="2001"), CHECK),
    Rule("import_batch_file_name_too_long", row("import_batches", file_name=long(256)), CHECK),
]


def test_rule_ids_are_unique() -> None:
    assert len({rule.id for rule in RULES}) == len(RULES)


@pytest.mark.parametrize("rule", RULES, ids=lambda rule: rule.id)
def test_database_enforces_each_rule(owner_engine: Engine, worlds: TwoTenants, rule: Rule) -> None:
    params = _params(worlds)
    with owner_engine.connect() as conn:
        trans = conn.begin()
        try:
            for statement in rule.setup:
                conn.execute(text(statement), params)
            if rule.sqlstate is None:
                conn.execute(text(rule.sql), params)
                if rule.immediate:
                    conn.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
                return
            with pytest.raises(DBAPIError) as refused:
                conn.execute(text(rule.sql), params)
                if rule.immediate:
                    conn.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
            error = refused.value.orig
            assert error.sqlstate == rule.sqlstate, error  # type: ignore[union-attr]
            if rule.constraint is not None:
                assert error.diag.constraint_name == rule.constraint  # type: ignore[union-attr]
        finally:
            trans.rollback()


def test_generated_keys_ignore_case_and_surrounding_spaces(
    owner_engine: Engine, worlds: TwoTenants
) -> None:
    with owner_engine.connect() as conn:
        code_key, sku_key = conn.execute(
            text(
                "SELECT p.code_key, v.sku_key FROM products p JOIN variants v "
                "ON v.product_id = p.id WHERE p.id = :p"
            ),
            {"p": worlds.a.catalog.product_id},
        ).one()
        spaced = conn.execute(text("SELECT lower(btrim('  AbC/1.x_Y-z  '))")).scalar()
    assert code_key == worlds.a.catalog.code.lower()
    assert sku_key == worlds.a.catalog.sku.lower()
    assert spaced == "abc/1.x_y-z"


def test_a_code_and_a_sku_taken_in_one_business_are_free_in_another(
    owner_engine: Engine, worlds: TwoTenants
) -> None:
    params = {**_params(worlds), "bt": worlds.b.tenant_id, "bu": worlds.b.user_id}
    with owner_engine.connect() as conn:
        trans = conn.begin()
        try:
            conn.execute(
                text(row("products", tenant_id=":bt", code=":code", created_by_user_id=":bu")),
                params,
            )
            conn.execute(
                text("INSERT INTO inventory_items (id, tenant_id) VALUES (:n2, :bt)"), params
            )
            conn.execute(
                text(row("variants", id=":n3", tenant_id=":bt", product_id=":n1", sku=":sku")),
                params,
            )
        finally:
            trans.rollback()
