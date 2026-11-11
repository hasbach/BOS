"""T043 — isolation cases for every User Story 1 route.

* A business user asking about another business's records gets exactly what a made-up id
  gets (404 ``not_found``), and the attempt is recorded as ``access.denied_tenant``.
* Business users cannot reach any operator route, and operators cannot reach any business
  route: both get the 404 an unknown URL gets.
* Routes about the caller's own data (``/me``...) are declared ``self_only`` and have no
  record id to guess; they are still exercised here with another business's session.
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
from tests.dbsupport import TwoTenants
from tests.integration.us1_support import CSRF, app_for, history, owner_value, shared_app_fixture
from tests.isolation.coverage import covers

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
OperatorClient = Callable[[uuid.UUID], FlaskClient]

BUSINESS = "/api/v1/ops/businesses/<uuid:business_id>"


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


def _unknown_url(app: Flask) -> bytes:
    return app.test_client().get("/api/v1/no-such-thing").get_data()


# ---- business users cannot reach operator routes -------------------------------------------------

OPS_CALLS: list[tuple[str, str, str, dict[str, Any] | None]] = [
    ("GET", "/api/v1/ops/me", "/api/v1/ops/me", None),
    ("GET", "/api/v1/ops/businesses", "/api/v1/ops/businesses", None),
    ("POST", "/api/v1/ops/businesses", "/api/v1/ops/businesses", {"business_name": "X"}),
    ("PATCH", BUSINESS, "/api/v1/ops/businesses/{a}", {"status": "suspended"}),
    ("POST", BUSINESS + "/owner-activation", "/api/v1/ops/businesses/{a}/owner-activation", None),
    (
        "POST",
        BUSINESS + "/owner-password-reset",
        "/api/v1/ops/businesses/{a}/owner-password-reset",
        {"owner_user_id": "{owner}"},
    ),
]


@covers("GET", "/api/v1/ops/me", "tenant_user_refused")
@covers("GET", "/api/v1/ops/businesses", "tenant_user_refused")
@covers("POST", "/api/v1/ops/businesses", "tenant_user_refused")
@covers("PATCH", BUSINESS, "tenant_user_refused")
@covers("POST", BUSINESS + "/owner-activation", "tenant_user_refused")
@covers("POST", BUSINESS + "/owner-password-reset", "tenant_user_refused")
@pytest.mark.parametrize(
    ("method", "rule", "path", "body"), OPS_CALLS, ids=[c[2] for c in OPS_CALLS]
)
@pytest.mark.parametrize("role", ["owner", "manager"])
def test_business_users_cannot_reach_operator_routes(
    app: Flask,
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    method: str,
    rule: str,
    path: str,
    body: dict[str, Any] | None,
    role: str,
) -> None:
    a = worlds.a
    url = path.format(a=a.tenant_id)
    payload = None
    if body is not None:
        payload = {k: (str(a.user_id) if v == "{owner}" else v) for k, v in body.items()}

    response = user_client(a.user(role), a.tenant_id).open(
        url, method=method, json=payload, headers=CSRF
    )

    assert response.status_code == 404
    assert response.get_data() == _unknown_url(app)
    assert (
        owner_value(owner_engine, "SELECT status FROM tenants WHERE id = :t", t=a.tenant_id)
        == "active"
    )
    assert owner_value(owner_engine, "SELECT count(*) FROM tenants") == 2


# ---- operators cannot reach business routes ------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/v1/me"),
        ("PATCH", "/api/v1/me"),
        ("POST", "/api/v1/me/password"),
        ("GET", "/api/v1/me/sessions"),
        ("DELETE", "/api/v1/me/sessions"),
        ("DELETE", "/api/v1/me/sessions/{session}"),
        ("GET", "/api/v1/audit"),
    ],
)
def test_operators_cannot_reach_business_routes(
    app: Flask, operator_client: OperatorClient, worlds: TwoTenants, method: str, path: str
) -> None:
    response = operator_client(worlds.operator_id).open(
        path.format(session=uuid.uuid4()), method=method, json={}, headers=CSRF
    )

    assert response.status_code == 404
    assert response.get_data() == _unknown_url(app)


# ---- another business's records ------------------------------------------------------------------


@covers("DELETE", "/api/v1/me/sessions/<uuid:session_id>", "cross_tenant")
def test_ending_another_business_users_session_is_not_found_like_a_made_up_one(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    victim = user_client(a.user_id, a.tenant_id)
    assert victim.get("/api/v1/me").status_code == 200
    victim_session = owner_value(
        owner_engine, "SELECT id FROM sessions WHERE user_id = :u", u=a.user_id
    )
    attacker = user_client(b.user_id, b.tenant_id)

    foreign = attacker.delete(f"/api/v1/me/sessions/{victim_session}", headers=CSRF)
    made_up = attacker.delete(f"/api/v1/me/sessions/{uuid.uuid4()}", headers=CSRF)

    assert foreign.status_code == made_up.status_code == 404
    assert foreign.get_data() == made_up.get_data()
    assert victim.get("/api/v1/me").status_code == 200
    denied = history(owner_engine, b.tenant_id, "access.denied_tenant")
    assert [(e.actor_id, e.target_type) for e in denied] == [(b.user_id, "session")] * 2
    assert history(owner_engine, a.tenant_id, "access.denied_tenant") == []


def test_ending_a_colleagues_session_is_not_found_too(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    colleague = user_client(a.user("sales"), a.tenant_id)
    colleague.get("/api/v1/me")
    session_id = owner_value(
        owner_engine, "SELECT id FROM sessions WHERE user_id = :u", u=a.user("sales")
    )

    response = user_client(a.user_id, a.tenant_id).delete(
        f"/api/v1/me/sessions/{session_id}", headers=CSRF
    )

    assert response.status_code == 404
    assert colleague.get("/api/v1/me").status_code == 200


@covers("GET", "/api/v1/audit", "cross_tenant")
def test_history_of_another_business_cannot_be_read_by_any_parameter(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    client = user_client(b.user_id, b.tenant_id)

    by_actor = client.get(f"/api/v1/audit?actor_id={a.user_id}").get_json()
    everything = client.get("/api/v1/audit").get_json()

    assert by_actor == {"items": [], "next_cursor": None}
    assert all(str(a.tenant_id) not in str(item) for item in everything["items"])
    assert str(a.audit_id) not in str(everything)
    assert [item["id"] for item in everything["items"]] == [str(b.audit_id)]


@covers("GET", "/api/v1/audit", "missing_permission")
def test_history_without_audit_view_is_forbidden_and_recorded(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a

    response = user_client(a.user("manager"), a.tenant_id).get("/api/v1/audit")

    assert response.status_code == 403
    [entry] = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert entry.data["permission"] == "audit.view"


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/api/v1/me", None),
        ("PATCH", "/api/v1/me", {"name": "Renamed"}),
        ("GET", "/api/v1/me/sessions", None),
        ("DELETE", "/api/v1/me/sessions", None),
    ],
)
def test_own_data_routes_only_ever_touch_the_callers_own_data(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    method: str,
    path: str,
    body: dict[str, Any] | None,
) -> None:
    a, b = worlds.a, worlds.b
    victim = user_client(a.user_id, a.tenant_id)
    victim.get("/api/v1/me")

    response = user_client(b.user_id, b.tenant_id).open(
        path, method=method, json=body, headers=CSRF
    )

    assert response.status_code in (200, 204)
    assert str(a.tenant_id) not in response.get_data(as_text=True)
    assert str(a.user_id) not in response.get_data(as_text=True)
    assert (
        owner_value(owner_engine, "SELECT name FROM users WHERE id = :u", u=a.user_id) == "Owner a"
    )
    assert victim.get("/api/v1/me").status_code == 200
