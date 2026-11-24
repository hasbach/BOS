from __future__ import annotations

import io
import uuid
from typing import Any

import pytest
from sqlalchemy import Engine

from tests.dbsupport import TwoTenants
from tests.integration.us1_support import CSRF, history, owner_rows
from tests.isolation.coverage import covers

pytestmark = pytest.mark.usefixtures("integrity_check")
BASE = "/api/v1/catalog/imports"
TEMPLATE = f"{BASE}/template"
BATCH = f"{BASE}/<uuid:batch_id>"
CONFIRM = f"{BATCH}/confirm"
DATA = b"product_code,name_en,price,currency\nA,Example,1,USD\n"


def csv_file() -> dict[str, Any]:
    return {"file": (io.BytesIO(DATA), "input.csv")}


@covers("GET", TEMPLATE, "missing_permission")
@covers("POST", BASE, "missing_permission")
@covers("GET", BATCH, "missing_permission")
@covers("POST", CONFIRM, "missing_permission")
@pytest.mark.parametrize("role", ["sales", "packing", "dispatch"])
def test_every_import_route_requires_catalog_manage(
    user_client: Any, owner_engine: Engine, fresh_staffed_tenants: TwoTenants, role: str
) -> None:
    a = fresh_staffed_tenants.a
    staff = user_client(a.user(role), a.tenant_id)
    batch_path = f"{BASE}/{uuid.uuid4()}"
    for response in (
        staff.get(TEMPLATE),
        staff.post(BASE, data=csv_file(), headers=CSRF),
        staff.get(batch_path),
        staff.post(f"{batch_path}/confirm", headers=CSRF),
    ):
        assert response.status_code == 403
        assert response.json["error"]["code"] == "forbidden"
    entries = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert len(entries) == 4
    assert all(
        e.actor_id == a.user(role) and e.data["permission"] == "catalog.manage" for e in entries
    )


@covers("GET", BATCH, "cross_tenant")
@covers("POST", CONFIRM, "cross_tenant")
def test_foreign_or_missing_batch_is_always_not_found(
    user_client: Any, owner_engine: Engine, fresh_staffed_tenants: TwoTenants
) -> None:
    a, b = fresh_staffed_tenants.a, fresh_staffed_tenants.b
    foreign = (
        user_client(b.user_id, b.tenant_id).post(BASE, data=csv_file(), headers=CSRF).json["id"]
    )
    own = user_client(a.user_id, a.tenant_id)
    for key in (foreign, str(uuid.uuid4())):
        path = f"{BASE}/{key}"
        for response in (own.get(path), own.post(f"{path}/confirm", headers=CSRF)):
            assert response.status_code == 404
            assert response.json["error"]["code"] == "not_found"
    entries = history(owner_engine, a.tenant_id, "access.denied_tenant")
    assert len(entries) == 4
    assert all(e.target_type == "import_batch" for e in entries)
    assert not owner_rows(owner_engine, "SELECT id FROM products")


@covers("GET", TEMPLATE, "cross_tenant")
@covers("POST", BASE, "cross_tenant")
def test_template_is_static_and_upload_is_tenant_bound(
    user_client: Any, owner_engine: Engine, fresh_staffed_tenants: TwoTenants
) -> None:
    a, b = fresh_staffed_tenants.a, fresh_staffed_tenants.b
    clients = [user_client(w.user_id, w.tenant_id) for w in (a, b)]
    baseline = clients[0].get(TEMPLATE)
    for client in clients:
        assert client.post(BASE, data=csv_file(), headers=CSRF).json["status"] == "previewed"
        assert client.get(TEMPLATE).data == baseline.data
    assert baseline.status_code == 200
    rows = owner_rows(owner_engine, "SELECT tenant_id, created_by_user_id FROM import_batches")
    assert {(r.tenant_id, r.created_by_user_id) for r in rows} == {
        (a.tenant_id, a.user_id),
        (b.tenant_id, b.user_id),
    }
