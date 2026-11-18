"""Finding P2 (exit gate) / F-16 — "does not exist" and "belongs to another business" are one answer.

For every route with a record id in its path, a made-up id and a real id of another business
get the same status and the same body whether the request body is valid or not (an invalid
body must not be checked before the record is looked up, or it would tell the two apart), and
each attempt is recorded as ``access.denied_tenant`` in the caller's own history (including
``POST /staff/{id}/password-reset``). For the caller's own records an invalid body is still a
400, so the order is: find the record in this business, then check the body, then the rules.
"""

from __future__ import annotations

import io
import re
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from tests.dbsupport import TwoTenants, World, insert_catalog_rows
from tests.integration.us1_support import (
    CSRF,
    app_for,
    history,
    owner_value,
    shared_app_fixture,
)
from tests.integration.us3_support import image_bytes

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]

STAFF = "/api/v1/staff"
STORES = "/api/v1/stores"
PRODUCTS = "/api/v1/catalog/products"
PHOTOS = "/api/v1/catalog/photos"
_PRODUCT = {
    "version": 1,
    "code": "TAKEN",
    "name_en": "Taken",
    "variants": [{"option_values": [], "price": "1.00", "currency": "USD"}],
}


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


# (label, method, path template, how to send it)
#   {id} is the record id; "json" bodies go as JSON, "raw" as text with a JSON content type,
#   "no-file" is a multipart upload without a file, "bad-file" one with a file that is no image.
Call = tuple[str, str, str, str, Any]

_WRITES: list[Call] = [
    ("staff-patch-empty-roles", "PATCH", STAFF + "/{id}", "json", {"roles": []}),
    ("staff-patch-bad-role", "PATCH", STAFF + "/{id}", "json", {"roles": ["wizard"]}),
    ("staff-patch-bad-status", "PATCH", STAFF + "/{id}", "json", {"status": "gone"}),
    ("staff-patch-bad-stores", "PATCH", STAFF + "/{id}", "json", {"store_ids": "x"}),
    ("staff-patch-array-body", "PATCH", STAFF + "/{id}", "raw", "[1]"),
    ("staff-patch-valid", "PATCH", STAFF + "/{id}", "json", {"status": "inactive"}),
    ("staff-reset-no-body", "POST", STAFF + "/{id}/password-reset", "json", None),
    ("staff-reset-junk-body", "POST", STAFF + "/{id}/password-reset", "raw", "[1]"),
    ("invitation-resend", "POST", STAFF + "/invitations/{id}/resend", "json", None),
    ("invitation-resend-junk", "POST", STAFF + "/invitations/{id}/resend", "raw", "[1]"),
    ("invitation-revoke", "DELETE", STAFF + "/invitations/{id}", "json", None),
    ("invitation-revoke-junk", "DELETE", STAFF + "/invitations/{id}", "raw", "[1]"),
    ("store-patch-empty-name", "PATCH", STORES + "/{id}", "json", {"name": ""}),
    ("store-patch-bad-status", "PATCH", STORES + "/{id}", "json", {"status": "gone"}),
    ("store-patch-bad-confirm", "PATCH", STORES + "/{id}", "json", {"confirm": "yes"}),
    ("store-patch-bad-number", "PATCH", STORES + "/{id}", "json", {"whatsapp_number": "x"}),
    ("store-patch-array-body", "PATCH", STORES + "/{id}", "raw", "[1]"),
    ("store-patch-valid", "PATCH", STORES + "/{id}", "json", {"name": "Renamed"}),
    ("logo-put-no-file", "PUT", STORES + "/{id}/logo", "no-file", None),
    ("logo-put-bad-file", "PUT", STORES + "/{id}/logo", "bad-file", None),
    ("logo-put-image", "PUT", STORES + "/{id}/logo", "image", None),
    ("logo-delete", "DELETE", STORES + "/{id}/logo", "json", None),
    ("logo-delete-junk", "DELETE", STORES + "/{id}/logo", "raw", "[1]"),
    ("logo-read", "GET", STORES + "/{id}/logo", "json", None),
    ("session-end", "DELETE", "/api/v1/me/sessions/{id}", "json", None),
    ("session-end-junk", "DELETE", "/api/v1/me/sessions/{id}", "raw", "[1]"),
    # M1 catalog (T042): the product is looked up before the body or the version is checked.
    ("product-read", "GET", PRODUCTS + "/{id}", "json", None),
    ("product-put-no-version", "PUT", PRODUCTS + "/{id}", "json", {"code": "x y"}),
    ("product-put-junk", "PUT", PRODUCTS + "/{id}", "raw", "[1]"),
    ("product-put-valid", "PUT", PRODUCTS + "/{id}", "json", _PRODUCT),
    ("product-delete-no-version", "DELETE", PRODUCTS + "/{id}", "json", None),
    ("product-archive-bad-version", "POST", PRODUCTS + "/{id}/archive", "json", {"version": 0}),
    ("product-archive", "POST", PRODUCTS + "/{id}/archive", "json", {"version": 1}),
    ("product-restore-junk", "POST", PRODUCTS + "/{id}/restore", "raw", "[1]"),
    ("product-restore", "POST", PRODUCTS + "/{id}/restore", "json", {"version": 1}),
    ("photo-read", "GET", PHOTOS + "/{id}/thumb", "json", None),
]


def test_every_business_route_with_an_id_in_its_path_is_in_the_list_above(app: Flask) -> None:
    """A new route with a record id must be added to ``_WRITES`` (with its invalid bodies)."""
    routes = {
        # A photo's size is listed as one real size.
        (method, re.sub(r"<uuid:\w+>", "{id}", rule.rule).replace("<size>", "thumb"))
        for rule in app.url_map.iter_rules()
        if rule.rule.startswith("/api/v1/")
        and not rule.rule.startswith("/api/v1/ops/")
        and "<uuid:" in rule.rule
        for method in rule.methods or ()
        if method not in {"HEAD", "OPTIONS"}
    }
    listed = {(method, template) for _, method, template, _, _ in _WRITES}

    assert routes == listed


def _send(client: FlaskClient, method: str, path: str, how: str, payload: Any) -> Any:
    if how == "json":
        return client.open(path, method=method, json=payload, headers=CSRF)
    if how == "raw":
        return client.open(
            path, method=method, data=payload, content_type="application/json", headers=CSRF
        )
    files = {
        "no-file": {},
        "bad-file": {"file": (io.BytesIO(b"not an image"), "x.png", "image/png")},
        "image": {"file": (io.BytesIO(image_bytes("PNG")), "x.png", "image/png")},
    }[how]
    return client.open(
        path, method=method, data=files, content_type="multipart/form-data", headers=CSRF
    )


def _foreign_ids(a: World, path: str) -> list[uuid.UUID]:
    """Real ids of business A that fit the route (including its owner and its stores)."""
    if path.startswith(PHOTOS):
        return [a.catalog.photo_id]
    if path.startswith(PRODUCTS):
        return [a.catalog.product_id]
    if "/invitations/" in path:
        return [a.invitation_id]
    if "/staff/" in path:
        return [a.user("sales"), a.user_id]
    if "/stores/" in path:
        return [a.store_id, a.second_store_id]
    return []  # sessions: the other business's session ids are not exposed anywhere


@pytest.mark.parametrize(
    ("label", "method", "template", "how", "payload"), _WRITES, ids=[c[0] for c in _WRITES]
)
@pytest.mark.parametrize("role", ["owner", "manager"])
def test_foreign_and_made_up_ids_get_one_answer_whatever_the_body(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    label: str,
    method: str,
    template: str,
    how: str,
    payload: Any,
    role: str,
) -> None:
    a, b = worlds.a, worlds.b
    attacker = user_client(b.user(role), b.tenant_id)
    if "/catalog/" in template:
        with owner_engine.begin() as conn:
            a._catalog = insert_catalog_rows(conn, a)
    foreign_ids = _foreign_ids(a, template)
    if not foreign_ids:
        # Sessions: ids of another business's sessions are found through the database only.
        user_client(a.user_id, a.tenant_id)  # signing in creates one of A's sessions
        foreign_ids = [_a_session_id(owner_engine, a)]
    seen = len(history(owner_engine, b.tenant_id, "access.denied_tenant"))

    for target in foreign_ids:
        path = template.format(id=target)
        foreign = _send(attacker, method, path, how, payload)
        made_up_path = template.format(id=uuid.uuid4())
        made_up = _send(attacker, method, made_up_path, how, payload)

        assert foreign.status_code == made_up.status_code == 404, label
        assert foreign.get_data() == made_up.get_data(), label
        denied = history(owner_engine, b.tenant_id, "access.denied_tenant")
        assert len(denied) == seen + 2, label
        assert [e.data["path"] for e in denied[-2:]] == [path, made_up_path], label
        assert {e.actor_id for e in denied[-2:]} == {b.user(role)}, label
        seen += 2

    assert history(owner_engine, a.tenant_id, "access.denied_tenant") == []


def _a_session_id(owner: Engine, world: World) -> uuid.UUID:
    session_id = owner_value(
        owner,
        "SELECT id FROM sessions WHERE tenant_id = :t ORDER BY created_at LIMIT 1",
        t=world.tenant_id,
    )
    assert isinstance(session_id, uuid.UUID)
    return session_id


def test_the_password_reset_of_every_foreign_staff_id_is_recorded(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    attacker = user_client(b.user_id, b.tenant_id)
    foreign = [*a.users.values()]

    for target in foreign:
        response = attacker.post(f"{STAFF}/{target}/password-reset", headers=CSRF)
        assert response.status_code == 404

    denied = history(owner_engine, b.tenant_id, "access.denied_tenant")
    assert [e.target_id for e in denied] == foreign
    assert {e.target_type for e in denied} == {"user"}
    assert history(owner_engine, b.tenant_id, "auth.password_reset_issued") == []


@pytest.mark.parametrize(
    ("method", "template", "payload"),
    [
        ("PATCH", STAFF + "/{id}", {"roles": []}),
        ("PATCH", STAFF + "/{id}", {"status": "gone"}),
        ("PATCH", STORES + "/{id}", {"name": ""}),
        ("PATCH", STORES + "/{id}", {"status": "gone"}),
    ],
    ids=["staff-roles", "staff-status", "store-name", "store-status"],
)
def test_an_invalid_body_for_the_callers_own_record_is_still_a_validation_error(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    method: str,
    template: str,
    payload: dict[str, Any],
) -> None:
    b = worlds.b
    own = b.user("sales") if "/staff/" in template else b.store_id

    response = user_client(b.user_id, b.tenant_id).open(
        template.format(id=own), method=method, json=payload, headers=CSRF
    )

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_failed"
    assert history(owner_engine, b.tenant_id, "access.denied_tenant") == []
