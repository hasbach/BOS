"""T066 — isolation, permission and cross-store cases for every User Story 3 route.

* Sales, packing and dispatch (store-limited or not) are refused on every manage route (403
  ``forbidden``), nothing changes, and the refusal is recorded.
* Everyone holds ``store.view`` and ``business.view``, so no real role lacks them; the
  missing-permission cases for those routes take the permission away from the sales role for
  one test, which proves the routes enforce what they declare.
* Another business's stores and logos are answered exactly like made-up ids (404
  ``not_found``), nothing of theirs changes, and the attempt is recorded as
  ``access.denied_tenant`` in the caller's history. Settings routes only ever reach the
  caller's own business.
* A store-limited user gets 404 for another store's logo (``access.denied_store``) and does
  not see that store in ``GET /stores``.
* Operators cannot reach any of these routes.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from app.config import Config
from app.core import permissions
from app.core.permissions import Role
from tests.dbsupport import TwoTenants, World, as_tenant
from tests.integration.us1_support import (
    CSRF,
    app_for,
    history,
    owner_rows,
    shared_app_fixture,
)
from tests.integration.us3_support import (
    BUSINESS,
    STORES,
    image_bytes,
    stored_files,
    upload,
    with_upload_dir,
)
from tests.isolation.coverage import covers

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
OperatorClient = Callable[[uuid.UUID], FlaskClient]

STORE = "/api/v1/stores/<uuid:store_id>"
LOGO = "/api/v1/stores/<uuid:store_id>/logo"


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


def _give_logos(client: UserClient, world: World) -> None:
    """Both stores of a business get a logo, uploaded by its owner."""
    owner = client(world.user_id, world.tenant_id)
    for store_id in (world.store_id, world.second_store_id):
        response = upload(owner, store_id, image_bytes("PNG"))
        assert response.status_code == 200, response.get_data(as_text=True)


def _snapshot(owner: Engine, world: World) -> list[Any]:
    """Everything a US3 route could change in one business."""
    return [
        owner_rows(
            owner,
            "SELECT id, name, whatsapp_e164, logo_file_id, status FROM stores "
            "WHERE tenant_id = :t ORDER BY id",
            t=world.tenant_id,
        ),
        owner_rows(
            owner,
            "SELECT id, storage_path FROM files WHERE tenant_id = :t ORDER BY id",
            t=world.tenant_id,
        ),
        owner_rows(
            owner,
            "SELECT name, default_currency, usd_lbp_rate, default_delivery_fee, "
            "default_delivery_fee_currency FROM tenants WHERE id = :t",
            t=world.tenant_id,
        ),
    ]


def _send(client: FlaskClient, method: str, path: str, body: Any) -> Any:
    if body == "logo":
        return upload(client, path.rsplit("/", 2)[-2], image_bytes("PNG"))
    return client.open(path, method=method, json=body, headers=CSRF)


# (method, rule, path template, body, permission); "logo" = a multipart upload
MANAGE_CALLS: list[tuple[str, str, str, Any, str]] = [
    ("POST", "/api/v1/stores", STORES, {"name": "Intruder"}, "store.manage"),
    ("PATCH", STORE, STORES + "/{store}", {"name": "Renamed"}, "store.manage"),
    ("PUT", LOGO, STORES + "/{store}/logo", "logo", "store.manage"),
    ("DELETE", LOGO, STORES + "/{store}/logo", None, "store.manage"),
    ("PATCH", "/api/v1/business", BUSINESS, {"usd_lbp_rate": "1.00"}, "settings.manage"),
]
VIEW_CALLS: list[tuple[str, str, str, Any, str]] = [
    ("GET", "/api/v1/stores", STORES, None, "store.view"),
    ("GET", LOGO, STORES + "/{store}/logo", None, "store.view"),
    ("GET", "/api/v1/business", BUSINESS, None, "business.view"),
]


def _ids(calls: list[tuple[str, str, str, Any, str]]) -> list[str]:
    return [c[0] + " " + c[1] for c in calls]


# ---- roles without the permission ---------------------------------------------------------------


@covers("POST", "/api/v1/stores", "missing_permission")
@covers("PATCH", STORE, "missing_permission")
@covers("PUT", LOGO, "missing_permission")
@covers("DELETE", LOGO, "missing_permission")
@covers("PATCH", "/api/v1/business", "missing_permission")
@pytest.mark.parametrize(
    ("method", "rule", "template", "body", "permission"), MANAGE_CALLS, ids=_ids(MANAGE_CALLS)
)
@pytest.mark.parametrize("role", ["sales", "packing", "dispatch", "sales_limited"])
def test_roles_without_manage_permissions_are_refused_and_recorded(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
    role: str,
    method: str,
    rule: str,
    template: str,
    body: Any,
    permission: str,
) -> None:
    a = worlds.a
    _give_logos(user_client, a)
    before = _snapshot(owner_engine, a)
    files_before = stored_files(uploads)
    path = template.format(store=a.store_id)

    response = _send(user_client(a.user(role), a.tenant_id), method, path, body)

    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "forbidden"
    assert _snapshot(owner_engine, a) == before
    assert stored_files(uploads) == files_before
    [entry] = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert (entry.actor_id, entry.data["permission"], entry.data["path"]) == (
        a.user(role),
        permission,
        path,
    )


@covers("GET", "/api/v1/stores", "missing_permission")
@covers("GET", LOGO, "missing_permission")
@covers("GET", "/api/v1/business", "missing_permission")
@pytest.mark.parametrize(
    ("method", "rule", "template", "body", "permission"), VIEW_CALLS, ids=_ids(VIEW_CALLS)
)
def test_view_routes_enforce_the_permission_they_declare(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    rule: str,
    template: str,
    body: Any,
    permission: str,
) -> None:
    a = worlds.a
    _give_logos(user_client, a)
    reduced = permissions.ROLE_PERMISSIONS[Role.SALES] - {permission}
    monkeypatch.setitem(permissions.ROLE_PERMISSIONS, Role.SALES, reduced)
    path = template.format(store=a.store_id)

    response = user_client(a.user("sales"), a.tenant_id).get(path)

    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "forbidden"
    assert "Store a" not in response.get_data(as_text=True)
    [entry] = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert entry.data["permission"] == permission


# ---- another business's stores --------------------------------------------------------------------


@covers("PATCH", STORE, "cross_tenant")
@covers("PUT", LOGO, "cross_tenant")
@covers("DELETE", LOGO, "cross_tenant")
@covers("GET", LOGO, "cross_tenant")
@pytest.mark.parametrize(
    ("method", "template", "body"),
    [
        ("PATCH", STORES + "/{store}", {"name": "Taken over"}),
        ("PATCH", STORES + "/{store}", {"status": "inactive", "confirm": True}),
        ("PUT", STORES + "/{store}/logo", "logo"),
        ("DELETE", STORES + "/{store}/logo", None),
        ("GET", STORES + "/{store}/logo", None),
    ],
    ids=["rename", "deactivate", "upload-logo", "remove-logo", "read-logo"],
)
@pytest.mark.parametrize("role", ["owner", "manager"])
def test_another_business_stores_and_logos_are_not_found_like_made_up_ones(
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
    _give_logos(user_client, a)
    attacker = user_client(b.user(role), b.tenant_id)
    victim_before = _snapshot(owner_engine, a)
    own_before = _snapshot(owner_engine, b)
    files_before = stored_files(uploads)

    foreign = _send(attacker, method, template.format(store=a.store_id), body)
    made_up = _send(attacker, method, template.format(store=uuid.uuid4()), body)

    assert foreign.status_code == made_up.status_code == 404
    assert foreign.get_data() == made_up.get_data()
    assert _snapshot(owner_engine, a) == victim_before
    assert _snapshot(owner_engine, b) == own_before
    assert stored_files(uploads) == files_before
    denied = history(owner_engine, b.tenant_id, "access.denied_tenant")
    assert len(denied) == 2
    assert {e.actor_id for e in denied} == {b.user(role)}
    assert history(owner_engine, a.tenant_id, "access.denied_tenant") == []


@covers("GET", "/api/v1/stores", "cross_tenant")
def test_the_store_list_shows_nothing_of_another_business(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b

    listing = user_client(b.user_id, b.tenant_id).get(STORES).get_json()

    assert [s["id"] for s in listing] == [str(b.store_id), str(b.second_store_id)]
    assert str(a.store_id) not in str(listing) and a.phone not in str(listing)


@covers("POST", "/api/v1/stores", "cross_tenant")
def test_another_business_names_and_numbers_are_neither_refused_nor_revealed(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    client = user_client(b.user_id, b.tenant_id)
    owner_a = user_client(a.user_id, a.tenant_id)
    created = owner_a.post(
        STORES, json={"name": "Hamra", "whatsapp_number": "70 123 456"}, headers=CSRF
    )
    assert created.status_code == 201
    victim_before = _snapshot(owner_engine, a)

    response = client.post(
        STORES, json={"name": "HAMRA", "whatsapp_number": "+96170123456"}, headers=CSRF
    )

    assert response.status_code == 201, response.get_data(as_text=True)
    [row] = owner_rows(
        owner_engine, "SELECT tenant_id FROM stores WHERE id = :s", s=response.get_json()["id"]
    )
    assert row.tenant_id == b.tenant_id
    assert _snapshot(owner_engine, a) == victim_before


@covers("GET", "/api/v1/business", "cross_tenant")
def test_the_business_settings_are_always_the_callers_own(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b

    body = user_client(b.user("sales"), b.tenant_id).get(BUSINESS).get_json()

    assert (body["id"], body["name"]) == (str(b.tenant_id), "Tenant b")
    assert str(a.tenant_id) not in str(body)


@covers("PATCH", "/api/v1/business", "cross_tenant")
def test_changing_settings_never_touches_another_business(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    victim_before = _snapshot(owner_engine, a)

    response = user_client(b.user_id, b.tenant_id).patch(
        BUSINESS, json={"id": str(a.tenant_id), "usd_lbp_rate": "1.00"}, headers=CSRF
    )

    assert response.status_code == 200
    assert response.get_json()["id"] == str(b.tenant_id)
    assert _snapshot(owner_engine, a) == victim_before
    assert history(owner_engine, a.tenant_id, "tenant.settings_changed") == []


def test_a_store_cannot_point_at_another_business_file(
    app_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b

    with as_tenant(app_engine, b.tenant_id) as conn, pytest.raises(DBAPIError):
        conn.execute(
            text("UPDATE stores SET logo_file_id = :f WHERE id = :s"),
            {"f": a.file_id, "s": b.store_id},
        )


# ---- other stores of the same business ----------------------------------------------------------


@covers("GET", LOGO, "cross_store")
def test_a_store_limited_user_cannot_read_another_store_logo(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    _give_logos(user_client, a)
    limited = user_client(a.user("sales_limited"), a.tenant_id)

    own = limited.get(f"{STORES}/{a.store_id}/logo")
    other = limited.get(f"{STORES}/{a.second_store_id}/logo")
    made_up_id = uuid.uuid4()
    made_up = limited.get(f"{STORES}/{made_up_id}/logo")

    assert own.status_code == 200 and own.mimetype == "image/webp"
    assert other.status_code == made_up.status_code == 404
    assert other.get_data() == made_up.get_data()
    denied = history(owner_engine, a.tenant_id, "access.denied_store")
    assert sorted((str(e.actor_id), e.data["store_id"]) for e in denied) == sorted(
        [
            (str(a.user("sales_limited")), str(a.second_store_id)),
            (str(a.user("sales_limited")), str(made_up_id)),
        ]
    )
    listing = limited.get(STORES).get_json()
    assert [s["id"] for s in listing] == [str(a.store_id)]


def test_a_store_limited_user_loses_the_logo_of_a_deactivated_store(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    _give_logos(user_client, a)
    owner = user_client(a.user_id, a.tenant_id)
    response = owner.patch(
        f"{STORES}/{a.store_id}", json={"status": "inactive", "confirm": True}, headers=CSRF
    )
    assert response.status_code == 200

    limited = user_client(a.user("sales_limited"), a.tenant_id)

    assert limited.get(f"{STORES}/{a.store_id}/logo").status_code == 404
    assert history(owner_engine, a.tenant_id, "access.denied_store") != []
    assert owner.get(f"{STORES}/{a.store_id}/logo").status_code == 200


# ---- operators -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "rule", "template", "body", "permission"),
    MANAGE_CALLS + VIEW_CALLS,
    ids=_ids(MANAGE_CALLS + VIEW_CALLS),
)
def test_operators_cannot_reach_store_or_settings_routes(
    app: Flask,
    operator_client: OperatorClient,
    worlds: TwoTenants,
    method: str,
    rule: str,
    template: str,
    body: Any,
    permission: str,
) -> None:
    unknown = app.test_client().get("/api/v1/no-such-thing").get_data()

    response = _send(
        operator_client(worlds.operator_id), method, template.format(store=worlds.a.store_id), body
    )

    assert response.status_code == 404
    assert response.get_data() == unknown
