"""T057 — isolation and permission cases for every User Story 2 (staff) route.

* Every role without ``staff.view`` / ``staff.manage`` is refused on each route (403
  ``forbidden``), nothing changes, and the refusal is recorded.
* Another business's users and invitations are answered exactly like made-up ids (404
  ``not_found``), nothing of theirs changes, and the attempt is recorded as
  ``access.denied_tenant`` in the caller's history.
* Operators cannot reach any staff route.
* A store-limited user's ``/me`` lists only their stores (route-level cross-store cases
  arrive with the store routes in User Story 3).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from tests.dbsupport import TwoTenants, World
from tests.integration.us1_support import (
    CSRF,
    app_for,
    history,
    owner_rows,
    owner_value,
    shared_app_fixture,
)
from tests.isolation.coverage import covers

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
OperatorClient = Callable[[uuid.UUID], FlaskClient]

STAFF = "/api/v1/staff"
INVITATIONS = "/api/v1/staff/invitations"
INVITATION = "/api/v1/staff/invitations/<uuid:invitation_id>"
RESEND = "/api/v1/staff/invitations/<uuid:invitation_id>/resend"
MEMBER = "/api/v1/staff/<uuid:user_id>"
RESET = "/api/v1/staff/<uuid:user_id>/password-reset"


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


def _snapshot(owner: Engine, world: World) -> list[Any]:
    """Everything a staff route could change in one business."""
    return [
        owner_rows(
            owner,
            "SELECT id, roles, all_stores, status FROM users WHERE tenant_id = :t ORDER BY id",
            t=world.tenant_id,
        ),
        owner_rows(
            owner,
            "SELECT user_id, store_id FROM user_stores "
            "WHERE tenant_id = :t ORDER BY user_id, store_id",
            t=world.tenant_id,
        ),
        owner_rows(
            owner,
            "SELECT id, status, token_hash FROM invitations WHERE tenant_id = :t ORDER BY id",
            t=world.tenant_id,
        ),
        owner_rows(
            owner,
            "SELECT id, used_at FROM password_resets WHERE tenant_id = :t ORDER BY id",
            t=world.tenant_id,
        ),
        owner_value(
            owner,
            "SELECT count(*) FROM sessions WHERE tenant_id = :t AND revoked_at IS NOT NULL",
            t=world.tenant_id,
        ),
    ]


# (method, rule, path template, body, permission)
CALLS: list[tuple[str, str, str, dict[str, Any] | None, str]] = [
    ("GET", STAFF, STAFF, None, "staff.view"),
    (
        "POST",
        INVITATIONS,
        INVITATIONS,
        {"name": "X", "email": "x@example.test", "roles": ["sales"], "all_stores": True},
        "staff.manage",
    ),
    ("POST", RESEND, INVITATIONS + "/{invitation}/resend", None, "staff.manage"),
    ("DELETE", INVITATION, INVITATIONS + "/{invitation}", None, "staff.manage"),
    ("PATCH", MEMBER, STAFF + "/{user}", {"status": "inactive"}, "staff.manage"),
    ("POST", RESET, STAFF + "/{user}/password-reset", None, "staff.manage"),
]


def _path(
    template: str,
    world: World,
    *,
    invitation: uuid.UUID | None = None,
    user: uuid.UUID | None = None,
) -> str:
    return template.format(
        invitation=invitation or world.invitation_id, user=user or world.user("sales")
    )


# ---- roles without the permission ---------------------------------------------------------------


@covers("GET", STAFF, "missing_permission")
@covers("POST", INVITATIONS, "missing_permission")
@covers("POST", RESEND, "missing_permission")
@covers("DELETE", INVITATION, "missing_permission")
@covers("PATCH", MEMBER, "missing_permission")
@covers("POST", RESET, "missing_permission")
@pytest.mark.parametrize(
    ("method", "rule", "template", "body", "permission"), CALLS, ids=[c[1] + c[0] for c in CALLS]
)
@pytest.mark.parametrize("role", ["sales", "packing", "dispatch", "sales_limited"])
def test_roles_without_staff_permissions_are_refused_and_recorded(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    role: str,
    method: str,
    rule: str,
    template: str,
    body: dict[str, Any] | None,
    permission: str,
) -> None:
    a = worlds.a
    actor = a.user(role)
    target = a.user("packing") if role != "packing" else a.user("dispatch")
    before = _snapshot(owner_engine, a)

    response = user_client(actor, a.tenant_id).open(
        _path(template, a, user=target), method=method, json=body, headers=CSRF
    )

    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "forbidden"
    assert "invitee" not in response.get_data(as_text=True)
    assert _snapshot(owner_engine, a) == before
    [entry] = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert (entry.actor_id, entry.data["permission"]) == (actor, permission)
    assert entry.data["path"] == _path(template, a, user=target)


# ---- another business's records -----------------------------------------------------------------


@covers("POST", RESEND, "cross_tenant")
@covers("DELETE", INVITATION, "cross_tenant")
@covers("PATCH", MEMBER, "cross_tenant")
@covers("POST", RESET, "cross_tenant")
@pytest.mark.parametrize(
    ("method", "rule", "template", "body", "permission"),
    [c for c in CALLS if "{" in c[2]],
    ids=[c[1] + c[0] for c in CALLS if "{" in c[2]],
)
@pytest.mark.parametrize("role", ["owner", "manager"])
def test_another_business_records_are_not_found_like_made_up_ones(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    role: str,
    method: str,
    rule: str,
    template: str,
    body: dict[str, Any] | None,
    permission: str,
) -> None:
    a, b = worlds.a, worlds.b
    attacker = user_client(b.user(role), b.tenant_id)
    victim_before = _snapshot(owner_engine, a)
    own_before = _snapshot(owner_engine, b)
    # Even the owner of A, who only an owner of A could touch.
    targets = [a.user("sales"), a.user_id] if "{user}" in template else [a.invitation_id]

    for target in targets:
        foreign = attacker.open(
            _path(template, a, invitation=target, user=target),
            method=method,
            json=body,
            headers=CSRF,
        )
        made_up = attacker.open(
            _path(template, a, invitation=uuid.uuid4(), user=uuid.uuid4()),
            method=method,
            json=body,
            headers=CSRF,
        )

        assert foreign.status_code == made_up.status_code == 404
        assert foreign.get_data() == made_up.get_data()

    assert _snapshot(owner_engine, a) == victim_before
    assert _snapshot(owner_engine, b) == own_before
    denied = history(owner_engine, b.tenant_id, "access.denied_tenant")
    assert len(denied) == 2 * len(targets)
    assert {e.actor_id for e in denied} == {b.user(role)}
    assert history(owner_engine, a.tenant_id, "access.denied_tenant") == []


@covers("GET", STAFF, "cross_tenant")
def test_the_staff_list_shows_nothing_of_another_business(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b

    body = user_client(b.user_id, b.tenant_id).get(STAFF).get_json()

    text = str(body)
    for value in (a.tenant_id, a.invitation_id, *a.users.values()):
        assert str(value) not in text
    assert "-a@example.test" not in text and a.phone not in text
    assert {m["user_id"] for m in body["members"]} == {str(u) for u in b.users.values()}
    assert [i["invitation_id"] for i in body["invitations"]] == [str(b.invitation_id)]


@covers("POST", INVITATIONS, "cross_tenant")
def test_an_invitation_cannot_name_another_business_store(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    client = user_client(b.user_id, b.tenant_id)
    body = {"name": "X", "email": "x@example.test", "roles": ["sales"]}

    foreign = client.post(INVITATIONS, json={**body, "store_ids": [str(a.store_id)]}, headers=CSRF)
    made_up = client.post(
        INVITATIONS, json={**body, "store_ids": [str(uuid.uuid4())]}, headers=CSRF
    )

    assert foreign.status_code == made_up.status_code == 400
    assert foreign.get_data() == made_up.get_data()
    assert owner_value(owner_engine, "SELECT count(*) FROM invitations") == 2


def test_inviting_another_business_member_reveals_nothing_and_changes_nothing_there(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    before = _snapshot(owner_engine, a)

    response = user_client(b.user_id, b.tenant_id).post(
        INVITATIONS,
        json={"name": "X", "email": a.email, "roles": ["sales"], "all_stores": True},
        headers=CSRF,
    )

    assert response.status_code == 201
    assert str(a.tenant_id) not in response.get_data(as_text=True)
    assert _snapshot(owner_engine, a) == before


# ---- operators -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "rule", "template", "body", "permission"), CALLS, ids=[c[1] + c[0] for c in CALLS]
)
def test_operators_cannot_reach_staff_routes(
    app: Flask,
    operator_client: OperatorClient,
    worlds: TwoTenants,
    method: str,
    rule: str,
    template: str,
    body: dict[str, Any] | None,
    permission: str,
) -> None:
    unknown = app.test_client().get("/api/v1/no-such-thing").get_data()

    response = operator_client(worlds.operator_id).open(
        _path(template, worlds.a), method=method, json=body, headers=CSRF
    )

    assert response.status_code == 404
    assert response.get_data() == unknown


# ---- store limits ----------------------------------------------------------------------------------


def test_a_store_limited_user_sees_only_their_stores(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    a = worlds.a

    limited = user_client(a.user("sales_limited"), a.tenant_id).get("/api/v1/me").get_json()
    everyone = user_client(a.user("sales"), a.tenant_id).get("/api/v1/me").get_json()

    assert limited["all_stores"] is False
    assert [s["id"] for s in limited["stores"]] == [str(a.store_id)]
    assert str(a.second_store_id) not in str(limited)
    assert {s["id"] for s in everyone["stores"]} == {str(a.store_id), str(a.second_store_id)}
