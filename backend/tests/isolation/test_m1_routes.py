"""T042, T061 — isolation, permission and cross-store cases for every M1 route so far.

* Sales, packing and dispatch are refused on every ``catalog.manage`` route (403
  ``forbidden``, ``access.denied_permission`` with ``catalog.manage``) and nothing changes.
* Everyone holds ``catalog.view``; the missing-permission cases of the view routes take it
  away from the sales role for one test (as M0's ``test_us3_routes.py`` does), proving the
  routes enforce what they declare.
* Another business's products and photos are answered exactly like made-up ids (404
  ``not_found``), recorded as ``access.denied_tenant`` in the caller's history.
* A store-limited agent asking for a product (or its photo) listed only in another store
  gets the same 404, recorded as ``access.denied_store`` (``catalog.view``).
* Stock adjustments and a variant's stock history need ``stock.adjust`` (owners and
  managers): every other role is refused and recorded, and another business's variants are
  answered like made-up ids (T061).
"""

from __future__ import annotations

import io
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from PIL import Image
from sqlalchemy import Engine

from app.config import Config
from app.core import permissions
from app.core.permissions import Role
from tests.dbsupport import CatalogProduct, TwoTenants, World
from tests.integration.catalog_support import (
    PHOTO_RULE,
    PHOTOS,
    PHOTOS_RULE,
    PRODUCT_RULE,
    PRODUCTS,
    PRODUCTS_RULE,
    catalog_snapshot,
    created,
    simple,
    upload_photo,
)
from tests.integration.stock_support import (
    ADJUST_RULE,
    MOVEMENTS_RULE,
    adjust,
    arrange_product,
    change,
    movements_path,
)
from tests.integration.us1_support import CSRF, app_for, history, owner_rows, shared_app_fixture
from tests.integration.us3_support import stored_files, with_upload_dir
from tests.isolation.coverage import covers

pytestmark = pytest.mark.usefixtures("integrity_check")

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]

ARCHIVE_RULE = PRODUCT_RULE + "/archive"
RESTORE_RULE = PRODUCT_RULE + "/restore"


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def uploads(tmp_path: Path) -> Path:
    return tmp_path / "uploads"


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants, uploads: Path) -> Flask:
    return with_upload_dir(app_for(shared_app, worlds), uploads)


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), color=(1, 2, 3)).save(buffer, format="PNG")
    return buffer.getvalue()


@dataclass(frozen=True)
class Arranged:
    product_id: str  # listed only in the business's second store, with one photo
    photo_id: str
    version: int


def _arrange(client: UserClient, world: World) -> Arranged:
    owner = client(world.user_id, world.tenant_id)
    upload = upload_photo(owner, _png())
    assert upload.status_code == 201, upload.get_data(as_text=True)
    photo_id = upload.get_json()["id"]
    product = created(
        owner, simple("ISO-1", store_ids=[world.second_store_id], photo_ids=[photo_id])
    )
    return Arranged(product["id"], photo_id, product["version"])


def _send(client: FlaskClient, method: str, path: str, body: Any) -> Any:
    if body == "photo":
        return upload_photo(client, _png())
    return client.open(path, method=method, json=body, headers=CSRF)


def _update_body(version: int) -> dict[str, Any]:
    return {**simple("ISO-1"), "name_en": "Taken over", "version": version}


# (method, rule, path template, body)
MANAGE_CALLS: list[tuple[str, str, str, Any]] = [
    ("POST", PRODUCTS_RULE, PRODUCTS, simple("INTRUDER")),
    ("PUT", PRODUCT_RULE, PRODUCTS + "/{product}", "update"),
    ("DELETE", PRODUCT_RULE, PRODUCTS + "/{product}?version={version}", None),
    ("POST", ARCHIVE_RULE, PRODUCTS + "/{product}/archive", "version"),
    ("POST", RESTORE_RULE, PRODUCTS + "/{product}/restore", "version"),
    ("POST", PHOTOS_RULE, PHOTOS, "photo"),
]
VIEW_CALLS: list[tuple[str, str, str]] = [
    ("GET", PRODUCTS_RULE, PRODUCTS),
    ("GET", PRODUCT_RULE, PRODUCTS + "/{product}"),
    ("GET", PHOTO_RULE, PHOTOS + "/{photo}/thumb"),
]


def _body(body: Any, version: int) -> Any:
    if body == "update":
        return _update_body(version)
    if body == "version":
        return {"version": version}
    return body


def _path(template: str, arranged: Arranged | None, product: Any = None, photo: Any = None) -> str:
    return template.format(
        product=product or (arranged.product_id if arranged else uuid.uuid4()),
        photo=photo or (arranged.photo_id if arranged else uuid.uuid4()),
        version=arranged.version if arranged else 1,
    )


# ---- roles without catalog.manage -----------------------------------------------------------------


@covers("POST", PRODUCTS_RULE, "missing_permission")
@covers("PUT", PRODUCT_RULE, "missing_permission")
@covers("DELETE", PRODUCT_RULE, "missing_permission")
@covers("POST", ARCHIVE_RULE, "missing_permission")
@covers("POST", RESTORE_RULE, "missing_permission")
@covers("POST", PHOTOS_RULE, "missing_permission")
@pytest.mark.parametrize(
    ("method", "rule", "template", "body"),
    MANAGE_CALLS,
    ids=[f"{c[0]} {c[1]}" for c in MANAGE_CALLS],
)
@pytest.mark.parametrize("role", ["sales", "packing", "dispatch", "sales_limited"])
def test_roles_without_catalog_manage_are_refused_and_recorded(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
    role: str,
    method: str,
    rule: str,
    template: str,
    body: Any,
) -> None:
    a = worlds.a
    arranged = _arrange(user_client, a)
    before = catalog_snapshot(owner_engine, a.tenant_id)
    files_before = stored_files(uploads)
    path = _path(template, arranged)

    response = _send(
        user_client(a.user(role), a.tenant_id), method, path, _body(body, arranged.version)
    )

    assert response.status_code == 403, response.get_data(as_text=True)
    assert response.get_json()["error"]["code"] == "forbidden"
    assert catalog_snapshot(owner_engine, a.tenant_id) == before
    assert stored_files(uploads) == files_before
    [entry] = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert (entry.actor_id, entry.data["permission"]) == (a.user(role), "catalog.manage")


@covers("GET", PRODUCTS_RULE, "missing_permission")
@covers("GET", PRODUCT_RULE, "missing_permission")
@covers("GET", PHOTO_RULE, "missing_permission")
@pytest.mark.parametrize(("method", "rule", "template"), VIEW_CALLS, ids=[c[1] for c in VIEW_CALLS])
def test_view_routes_enforce_catalog_view(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    rule: str,
    template: str,
) -> None:
    a = worlds.a
    arranged = _arrange(user_client, a)
    reduced = permissions.ROLE_PERMISSIONS[Role.SALES] - {"catalog.view"}
    monkeypatch.setitem(permissions.ROLE_PERMISSIONS, Role.SALES, reduced)

    response = user_client(a.user("sales"), a.tenant_id).get(_path(template, arranged))

    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "forbidden"
    assert "ISO-1" not in response.get_data(as_text=True)
    [entry] = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert entry.data["permission"] == "catalog.view"


# ---- another business -------------------------------------------------------------------------------


@covers("PUT", PRODUCT_RULE, "cross_tenant")
@covers("DELETE", PRODUCT_RULE, "cross_tenant")
@covers("POST", ARCHIVE_RULE, "cross_tenant")
@covers("POST", RESTORE_RULE, "cross_tenant")
@covers("GET", PRODUCT_RULE, "cross_tenant")
@covers("GET", PHOTO_RULE, "cross_tenant")
@pytest.mark.parametrize(
    ("method", "template", "body"),
    [
        ("PUT", PRODUCTS + "/{product}", "update"),
        ("DELETE", PRODUCTS + "/{product}?version={version}", None),
        ("POST", PRODUCTS + "/{product}/archive", "version"),
        ("POST", PRODUCTS + "/{product}/restore", "version"),
        ("GET", PRODUCTS + "/{product}", None),
        ("GET", PHOTOS + "/{photo}/thumb", None),
        ("GET", PHOTOS + "/{photo}/large", None),
    ],
    ids=["edit", "delete", "archive", "restore", "read", "thumb", "large"],
)
@pytest.mark.parametrize("role", ["owner", "manager"])
def test_another_business_products_and_photos_are_not_found_like_made_up_ones(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
    role: str,
    method: str,
    template: str,
    body: Any,
) -> None:
    a, b = worlds.a, worlds.b
    arranged = _arrange(user_client, a)
    attacker = user_client(b.user(role), b.tenant_id)
    victim_before = catalog_snapshot(owner_engine, a.tenant_id)
    files_before = stored_files(uploads)

    foreign = _send(attacker, method, _path(template, arranged), _body(body, arranged.version))
    made_up = _send(attacker, method, _path(template, None), _body(body, arranged.version))

    assert foreign.status_code == made_up.status_code == 404
    assert foreign.get_data() == made_up.get_data()
    assert catalog_snapshot(owner_engine, a.tenant_id) == victim_before
    assert stored_files(uploads) == files_before
    denied = history(owner_engine, b.tenant_id, "access.denied_tenant")
    assert len(denied) == 2 and {e.actor_id for e in denied} == {b.user(role)}
    assert history(owner_engine, a.tenant_id, "access.denied_tenant") == []


@covers("GET", PRODUCTS_RULE, "cross_tenant")
def test_the_catalog_list_shows_nothing_of_another_business(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    arranged = _arrange(user_client, worlds.a)
    client = user_client(worlds.b.user_id, worlds.b.tenant_id)

    listing = client.get(PRODUCTS).get_json()
    searched = client.get(PRODUCTS, query_string={"q": "ISO"}).get_json()

    assert listing["items"] == searched["items"] == []
    assert arranged.product_id not in str(listing)


@covers("POST", PRODUCTS_RULE, "cross_tenant")
@pytest.mark.parametrize("field", ["store_ids", "photo_ids"])
def test_a_product_cannot_use_another_business_stores_or_photos(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, field: str
) -> None:
    a, b = worlds.a, worlds.b
    arranged = _arrange(user_client, a)
    foreign = {"store_ids": [str(a.store_id)], "photo_ids": [arranged.photo_id]}[field]
    victim_before = catalog_snapshot(owner_engine, a.tenant_id)

    response = user_client(b.user_id, b.tenant_id).post(
        PRODUCTS, json=simple("TAKE-1", **{field: foreign}), headers=CSRF
    )

    assert response.status_code == 400
    assert response.get_json()["error"]["fields"] == {field: "invalid"}
    assert catalog_snapshot(owner_engine, a.tenant_id) == victim_before


@covers("POST", PHOTOS_RULE, "cross_tenant")
def test_an_upload_always_lands_in_the_callers_business(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path
) -> None:
    a, b = worlds.a, worlds.b
    victim_before = catalog_snapshot(owner_engine, a.tenant_id)

    response = upload_photo(user_client(b.user_id, b.tenant_id), _png())

    assert response.status_code == 201
    assert catalog_snapshot(owner_engine, a.tenant_id) == victim_before
    assert all(f"tenant/{b.tenant_id}/" in p.as_posix() for p in stored_files(uploads))
    assert not any(str(a.tenant_id) in p.as_posix() for p in stored_files(uploads))


# ---- another store of the same business ------------------------------------------------------------


@covers("GET", PRODUCT_RULE, "cross_store")
@covers("GET", PHOTO_RULE, "cross_store")
@pytest.mark.parametrize(
    "template", [PRODUCTS + "/{product}", PHOTOS + "/{photo}/thumb", PHOTOS + "/{photo}/large"]
)
def test_a_product_of_another_store_and_its_photo_are_not_found_for_a_store_agent(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, template: str
) -> None:
    a = worlds.a
    arranged = _arrange(user_client, a)
    agent = user_client(a.user("sales_limited"), a.tenant_id)

    other = agent.get(_path(template, arranged))
    made_up = agent.get(_path(template, None))

    assert other.status_code == made_up.status_code == 404
    assert other.get_data() == made_up.get_data()
    [denied] = history(owner_engine, a.tenant_id, "access.denied_store")
    assert (denied.target_type, denied.target_id) == ("product", uuid.UUID(arranged.product_id))
    assert denied.data["permission"] == "catalog.view"
    # Everyone working in that store does see it.
    sales = user_client(a.user("sales"), a.tenant_id)
    assert sales.get(_path(template, arranged)).status_code == 200


@covers("GET", PRODUCTS_RULE, "cross_store")
def test_the_list_hides_other_stores_and_refuses_their_filter(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    arranged = _arrange(user_client, a)
    agent = user_client(a.user("sales_limited"), a.tenant_id)

    listing = agent.get(PRODUCTS).get_json()
    filtered = agent.get(PRODUCTS, query_string={"store_id": str(a.second_store_id)})

    assert arranged.product_id not in str(listing)
    assert filtered.status_code == 404
    [denied] = history(owner_engine, a.tenant_id, "access.denied_store")
    assert denied.data["store_id"] == str(a.second_store_id)


# ---- stock: adjustments and a variant's stock history (US2, FR-014, SC-007) -------------------


STOCK_CALLS: list[tuple[str, str, str]] = [
    ("POST", ADJUST_RULE, "adjust"),
    ("GET", MOVEMENTS_RULE, "movements"),
]


def _stocked(owner_engine: Engine, world: World) -> CatalogProduct:
    return arrange_product(owner_engine, world.tenant_id, world.user_id, on_hand=10, code="STK-1")


def _stock_call(client: FlaskClient, kind: str, variant_id: Any) -> Any:
    if kind == "adjust":
        return adjust(client, variant_id, change("damaged", 1))
    return client.get(movements_path(variant_id))


def _stock_snapshot(owner_engine: Engine, world: World) -> list[Any]:
    return [
        catalog_snapshot(owner_engine, world.tenant_id),
        owner_rows(
            owner_engine,
            "SELECT key FROM idempotency_keys WHERE tenant_id = :t ORDER BY key",
            t=world.tenant_id,
        ),
    ]


@covers("POST", ADJUST_RULE, "missing_permission")
@covers("GET", MOVEMENTS_RULE, "missing_permission")
@pytest.mark.parametrize(("method", "rule", "kind"), STOCK_CALLS, ids=[c[2] for c in STOCK_CALLS])
@pytest.mark.parametrize("role", ["sales", "packing", "dispatch", "sales_limited"])
def test_roles_without_stock_adjust_are_refused_and_recorded(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    role: str,
    method: str,
    rule: str,
    kind: str,
) -> None:
    a = worlds.a
    product = _stocked(owner_engine, a)
    before = _stock_snapshot(owner_engine, a)

    response = _stock_call(user_client(a.user(role), a.tenant_id), kind, product.variant_ids[0])

    assert response.status_code == 403, response.get_data(as_text=True)
    assert response.get_json()["error"]["code"] == "forbidden"
    assert "STK-1" not in response.get_data(as_text=True)
    assert _stock_snapshot(owner_engine, a) == before
    [entry] = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert (entry.actor_id, entry.data["permission"]) == (a.user(role), "stock.adjust")
    assert history(owner_engine, a.tenant_id, "stock.adjusted") == []


@covers("POST", ADJUST_RULE, "cross_tenant")
@covers("GET", MOVEMENTS_RULE, "cross_tenant")
@pytest.mark.parametrize(("method", "rule", "kind"), STOCK_CALLS, ids=[c[2] for c in STOCK_CALLS])
@pytest.mark.parametrize("role", ["owner", "manager"])
def test_another_business_variants_are_not_found_like_made_up_ones(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    role: str,
    method: str,
    rule: str,
    kind: str,
) -> None:
    a, b = worlds.a, worlds.b
    product = _stocked(owner_engine, a)
    attacker = user_client(b.user(role), b.tenant_id)
    victim_before = _stock_snapshot(owner_engine, a)

    foreign = _stock_call(attacker, kind, product.variant_ids[0])
    made_up = _stock_call(attacker, kind, uuid.uuid4())

    assert foreign.status_code == made_up.status_code == 404
    assert foreign.get_data() == made_up.get_data()
    assert _stock_snapshot(owner_engine, a) == victim_before
    denied = history(owner_engine, b.tenant_id, "access.denied_tenant")
    assert len(denied) == 2 and {e.actor_id for e in denied} == {b.user(role)}
    assert history(owner_engine, a.tenant_id, "access.denied_tenant") == []
