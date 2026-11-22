from __future__ import annotations

import codecs
import csv
import hashlib
import io
import threading
from concurrent.futures import ThreadPoolExecutor
from time import perf_counter
from typing import Any

import pytest
from flask.testing import FlaskClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.contract.support import assert_matches_contract
from tests.dbsupport import TwoTenants, insert_product
from tests.integration.us1_support import CSRF, history, owner_rows

pytestmark = pytest.mark.usefixtures("integrity_check")
BASE = "/api/v1/catalog/imports"
HEADER = b"product_code,name_en,name_ar,sku,price,currency,opening_quantity\n"
FILE = HEADER + "A,,قميص,SKU-A,1,USD,٢\nB,Two,,SKU-B,2,USD,\n".encode()


def upload(client: FlaskClient, data: bytes = FILE) -> Any:
    return client.post(BASE, data={"file": (io.BytesIO(data), "catalog.csv")}, headers=CSRF)


def confirm(client: FlaskClient, batch: str) -> Any:
    return client.post(f"{BASE}/{batch}/confirm", headers=CSRF)


@pytest.fixture()
def merchant(user_client: Any, fresh_tenants: TwoTenants) -> FlaskClient:
    a = fresh_tenants.a
    return user_client(a.user_id, a.tenant_id)


@pytest.mark.parametrize(
    ("data", "code", "columns"),
    [
        (b"x" * (2 * 1024 * 1024 + 1), "file_too_large", None),
        (b"\xff", "file_not_csv", None),
        (b"", "file_not_csv", None),
        (b"not comma separated", "file_not_csv", None),
        (b"PK\x03\x04\x00", "file_not_csv", None),
        (b"code,name_en\n" + b"X,Name\n" * 2001, "too_many_rows", None),
        (
            b"product_code,name_en,currency,image_url\nX,Name,USD,url\n",
            "missing_columns",
            ["price"],
        ),
        (
            b"product_code,name_en,price,currency,image_url\nX,Name,1,USD,url\n",
            "unknown_columns",
            ["image_url"],
        ),
    ],
)
def test_file_errors_precede_row_checks(
    merchant: FlaskClient, owner_engine: Engine, data: bytes, code: str, columns: list[str] | None
) -> None:
    response = upload(merchant, data)
    assert response.status_code == 400
    error = response.json["error"]
    assert (error["code"], error.get("columns")) == (code, columns)
    assert not owner_rows(owner_engine, "SELECT id FROM import_batches")


def test_template_has_bom_and_one_product_with_two_variants(merchant: FlaskClient) -> None:
    response = merchant.get(f"{BASE}/template")
    assert response.status_code == 200
    assert response.mimetype == "text/csv"
    assert response.data.startswith(codecs.BOM_UTF8)
    first, second = csv.DictReader(io.StringIO(response.data.decode("utf-8-sig")))
    assert first["product_code"] == second["product_code"]
    assert first["option1_value"] != second["option1_value"]
    assert first["name_ar"] == "قميص"


@pytest.mark.parametrize("bom", [b"", codecs.BOM_UTF8])
def test_confirm_persists_catalog_ledger_and_single_audit(
    merchant: FlaskClient, owner_engine: Engine, fresh_tenants: TwoTenants, bom: bytes
) -> None:
    a = fresh_tenants.a
    response = upload(merchant, bom + FILE)
    assert response.status_code == 201
    preview = response.json
    assert_matches_contract(response)
    assert (
        preview["status"],
        preview["products"],
        preview["variants"],
        preview["opening_units"],
    ) == ("previewed", 2, 2, 2)
    assert merchant.get(f"{BASE}/{preview['id']}").json == preview
    assert not owner_rows(owner_engine, "SELECT id FROM products")
    response = confirm(merchant, preview["id"])
    assert response.status_code == 200, response.get_data(as_text=True)
    assert_matches_contract(response)
    saved = response.json
    assert saved["status"] == "committed"
    assert confirm(merchant, preview["id"]).json == saved
    [batch] = owner_rows(owner_engine, "SELECT payload, file_sha256 FROM import_batches")
    assert batch.payload is None and bytes(batch.file_sha256) == hashlib.sha256(bom + FILE).digest()
    products = owner_rows(
        owner_engine, "SELECT name_ar, import_batch_id FROM products ORDER BY code"
    )
    assert [p.name_ar for p in products] == ["قميص", None]
    assert all(str(p.import_batch_id) == saved["id"] for p in products)
    assert (
        len(owner_rows(owner_engine, "SELECT id FROM variants WHERE low_stock_level IS NULL")) == 2
    )
    assert len(owner_rows(owner_engine, "SELECT id FROM inventory_items")) == 2
    assert sorted(
        r.on_hand for r in owner_rows(owner_engine, "SELECT on_hand FROM stock_balances")
    ) == [0, 2]
    [movement] = owner_rows(owner_engine, "SELECT * FROM stock_movements")
    assert (
        movement.reason,
        movement.source,
        movement.quantity,
        movement.actor_id,
        str(movement.import_batch_id),
    ) == ("opening", "import", 2, a.user_id, saved["id"])
    [audited] = history(owner_engine, a.tenant_id, "catalog.imported")
    assert (audited.actor_type, audited.actor_id) == ("user", a.user_id)
    assert (audited.target_type, str(audited.target_id)) == ("import_batch", saved["id"])
    assert audited.data == {
        "products": 2,
        "variants": 2,
        "opening_units": 2,
    }
    assert not history(owner_engine, a.tenant_id, "product.created")
    assert len(merchant.get("/api/v1/catalog/products?no_photo=true").json["items"]) == 2
    again = upload(merchant, FILE).json
    assert again["status"] == "failed"
    assert {(e["row"], e["code"]) for e in again["errors"]} == {
        (n, code) for n in (2, 3) for code in ("product_code_in_use", "sku_in_use")
    }


def test_failed_preview_reports_each_error_and_cannot_confirm(
    merchant: FlaskClient, owner_engine: Engine
) -> None:
    data = HEADER + (
        b"A,Name,,SKU,1,USD,0\nB,Name,,SKU,1,USD,0\nC,Name,,C,,USD,0\nD,Name,,D,1,USD,-1\n"
    )
    response = upload(merchant, data)
    assert response.status_code == 201
    assert_matches_contract(response)
    batch = response.json
    assert batch["status"] == "failed"
    assert batch["errors"] == [
        {"row": 3, "column": "sku", "code": "duplicate_in_file"},
        {"row": 4, "column": "price", "code": "required"},
        {"row": 5, "column": "opening_quantity", "code": "negative"},
    ]
    response = confirm(merchant, batch["id"])
    assert response.status_code == 409 and response.json["error"]["code"] == "import_has_errors"
    assert not owner_rows(owner_engine, "SELECT id FROM products")


def test_expired_preview_cannot_confirm(merchant: FlaskClient, owner_engine: Engine) -> None:
    batch = upload(merchant).json
    with owner_engine.begin() as conn:
        conn.execute(text("UPDATE import_batches SET expires_at = now() - interval '1 second'"))
    response = confirm(merchant, batch["id"])
    assert response.status_code == 410 and response.json["error"]["code"] == "import_expired"


def test_locked_batch_asks_client_to_retry(
    merchant: FlaskClient, owner_engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services import catalog_import

    batch = upload(merchant).json
    real_confirm = catalog_import.confirm

    def confirm_with_short_timeout(db: Session, *args: Any) -> Any:
        db.execute(text("SET LOCAL lock_timeout = '100ms'"))
        return real_confirm(db, *args)

    monkeypatch.setattr(catalog_import, "confirm", confirm_with_short_timeout)
    with owner_engine.begin() as conn:
        conn.execute(
            text("SELECT id FROM import_batches WHERE id = :id FOR UPDATE"), {"id": batch["id"]}
        )
        response = confirm(merchant, batch["id"])
    assert response.status_code == 503
    assert response.json["error"]["code"] == "try_again"
    assert response.headers["Retry-After"] == "1"
    assert merchant.get(f"{BASE}/{batch['id']}").json == batch
    assert not owner_rows(owner_engine, "SELECT id FROM products")


def test_new_sku_after_preview_is_reported_without_import(
    merchant: FlaskClient, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    batch = upload(merchant).json
    a = fresh_tenants.a
    with owner_engine.begin() as conn:
        competitor = insert_product(conn, a.tenant_id, a.user_id, code="OTHER")
        conn.execute(
            text("UPDATE variants SET sku = 'sku-b' WHERE product_id = :id"),
            {"id": competitor.product_id},
        )
    response = confirm(merchant, batch["id"])
    assert response.status_code == 409
    assert response.json["error"]["code"] == "import_conflict"
    assert response.json["error"]["errors"] == [{"row": 3, "column": "sku", "code": "sku_in_use"}]
    assert [r.code for r in owner_rows(owner_engine, "SELECT code FROM products")] == ["OTHER"]


def test_mid_confirm_failure_rolls_back_every_write(
    merchant: FlaskClient, owner_engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services import catalog

    batch = upload(merchant).json
    real = catalog.create_product

    def break_after_second(*args: Any, **kwargs: Any) -> Any:
        saved = real(*args, **kwargs)
        if args[2].code == "B":
            raise RuntimeError("simulated write failure")
        return saved

    monkeypatch.setattr(catalog, "create_product", break_after_second)
    assert confirm(merchant, batch["id"]).status_code == 500
    assert not owner_rows(owner_engine, "SELECT id FROM products")
    assert not owner_rows(owner_engine, "SELECT id FROM stock_movements")
    assert merchant.get(f"{BASE}/{batch['id']}").json == batch


@pytest.mark.parametrize("after_plan", [False, True])
def test_late_sku_race_rolls_back_prior_products_and_returns_row_error(
    merchant: FlaskClient,
    owner_engine: Engine,
    fresh_tenants: TwoTenants,
    monkeypatch: pytest.MonkeyPatch,
    after_plan: bool,
) -> None:
    from app.services import catalog

    batch = upload(merchant).json
    a = fresh_tenants.a
    name = "_write" if after_plan else "create_product"
    real = getattr(catalog, name)

    def race(*args: Any, **kwargs: Any) -> Any:
        data = args[3 if after_plan else 2]
        if data.code == "B":
            with owner_engine.begin() as conn:
                other = insert_product(conn, a.tenant_id, a.user_id, code="OTHER")
                conn.execute(
                    text("UPDATE variants SET sku = 'SKU-B' WHERE product_id = :id"),
                    {"id": other.product_id},
                )
        return real(*args, **kwargs)

    monkeypatch.setattr(catalog, name, race)
    response = confirm(merchant, batch["id"])
    assert response.status_code == 409, response.get_data(as_text=True)
    assert response.json["error"]["code"] == "import_conflict"
    assert response.json["error"]["errors"] == [{"row": 3, "column": "sku", "code": "sku_in_use"}]
    assert [r.code for r in owner_rows(owner_engine, "SELECT code FROM products")] == ["OTHER"]
    assert not owner_rows(owner_engine, "SELECT id FROM stock_movements")
    assert not history(owner_engine, a.tenant_id, "catalog.imported")
    assert merchant.get(f"{BASE}/{batch['id']}").json == batch


def test_imported_variants_use_business_default_until_overridden(
    merchant: FlaskClient,
    owner_engine: Engine,
    fresh_tenants: TwoTenants,
) -> None:
    response = merchant.get(f"{BASE}/template")
    batch = upload(merchant, response.data).json
    assert confirm(merchant, batch["id"]).status_code == 200
    [product] = owner_rows(owner_engine, "SELECT id FROM products")
    a = fresh_tenants.a
    with owner_engine.begin() as conn:
        conn.execute(
            text("UPDATE tenants SET low_stock_default = 9 WHERE id = :id"), {"id": a.tenant_id}
        )
    refreshed = merchant.get(f"/api/v1/catalog/products/{product.id}").json
    assert [v["option_values"] for v in refreshed["variants"]] == [["Small"], ["Large"]]
    assert all(
        v["low_stock_level"] is None and v["effective_low_stock_level"] == 9
        for v in refreshed["variants"]
    )


def test_simultaneous_confirms_return_the_same_batch(
    merchant: FlaskClient, user_client: Any, fresh_tenants: TwoTenants, owner_engine: Engine
) -> None:
    batch = upload(merchant).json
    a = fresh_tenants.a
    clients = [user_client(a.user_id, a.tenant_id) for _ in range(2)]
    barrier = threading.Barrier(2, timeout=10)

    def submit(client: FlaskClient) -> Any:
        barrier.wait()
        return confirm(client, batch["id"])

    with ThreadPoolExecutor(2) as pool:
        first, second = pool.map(submit, clients)
    assert first.status_code == second.status_code == 200
    assert first.json == second.json and first.json["status"] == "committed"
    assert len(history(owner_engine, a.tenant_id, "catalog.imported")) == 1


def test_500_rows_preview_within_budget(merchant: FlaskClient) -> None:
    data = HEADER + b"".join(f"P{n},Product,,,1,USD,1\n".encode() for n in range(500))
    start = perf_counter()
    response = upload(merchant, data)
    elapsed = perf_counter() - start
    print(f"500-row preview: {elapsed:.3f}s")
    assert response.status_code == 201
    assert response.json["variants"] == 500
    assert elapsed < 30
