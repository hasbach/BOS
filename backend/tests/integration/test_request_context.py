"""T016 — the request lifecycle (T026) and endpoint policies (T024), through real requests.

The routes used here are throwaway routes added to a test instance of the application; the
production code has none of them.
"""

from __future__ import annotations

import dataclasses
import logging
import time
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask, g, jsonify, request
from flask.testing import FlaskClient
from flask.typing import ResponseReturnValue
from sqlalchemy import Engine, create_engine, text

from app import create_app
from app.config import Config
from app.core import sessions
from app.core.db import engine_of, get_engine, transaction
from app.core.permissions import authenticated, operator_only, public, require
from app.core.request_context import current_operator, current_user, not_found_in_tenant
from app.errors import ApiError
from tests.dbsupport import TwoTenants, World

CSRF = {"X-BOS-CSRF": "1"}
UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
OperatorClient = Callable[[uuid.UUID], FlaskClient]


def _add_test_routes(app: Flask) -> None:
    @app.get("/api/v1/_t/whoami")
    @authenticated
    def whoami() -> ResponseReturnValue:
        principal = current_user()
        row = g.db.execute(text("SELECT app_tenant_id() AS tenant, pg_backend_pid() AS pid")).one()
        stores = g.db.execute(text("SELECT id FROM stores ORDER BY name")).scalars().all()
        return jsonify(
            user_id=str(principal.user_id),
            tenant_id=str(principal.tenant_id),
            session_id=str(principal.session_id),
            name=principal.name,
            locale=principal.locale,
            roles=sorted(principal.roles),
            all_stores=principal.access.sees_all_stores,
            store_ids=sorted(str(s) for s in principal.access.store_ids),
            is_operator=principal.is_operator,
            db_tenant=str(row.tenant),
            pid=row.pid,
            visible_stores=[str(s) for s in stores],
        )

    @app.route("/api/v1/_t/echo", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    @authenticated(self_only=True)
    def echo() -> ResponseReturnValue:
        return jsonify(method=request.method)

    @app.get("/api/v1/_t/staff")
    @require("staff.view")
    def staff() -> ResponseReturnValue:
        return jsonify(ok=True)

    @app.get("/api/v1/_t/stores/<uuid:store_id>")
    @require("store.view", store_param="store_id")
    def store(store_id: uuid.UUID) -> ResponseReturnValue:
        row = g.db.execute(
            text("SELECT id, name FROM stores WHERE id = :id"), {"id": store_id}
        ).one_or_none()
        if row is None:
            not_found_in_tenant("store", store_id)
        return jsonify(id=str(row.id), name=row.name)

    @app.post("/api/v1/_t/stores")
    @require("store.manage")
    def add_store() -> ResponseReturnValue:
        body: dict[str, Any] = request.get_json()
        principal = current_user()
        g.db.execute(
            text("INSERT INTO stores (id, tenant_id, name) VALUES (:id, :t, :name)"),
            {"id": uuid.uuid4(), "t": principal.tenant_id, "name": body["name"]},
        )
        then = body.get("then")
        if then == "fail":
            raise ApiError(409, "conflict_for_test")
        if then == "foreign":
            not_found_in_tenant("store", uuid.uuid4())
        if then == "crash":
            raise RuntimeError("unexpected")
        return jsonify(ok=True), 201

    @app.get("/api/v1/ops/_t/whoami")
    @operator_only
    def ops_whoami() -> ResponseReturnValue:
        principal = current_operator()
        row = g.db.execute(
            text(
                "SELECT (SELECT count(*) FROM tenants) AS tenants, "
                "(SELECT count(*) FROM stores) AS stores, pg_backend_pid() AS pid"
            )
        ).one()
        return jsonify(
            operator_id=str(principal.operator_id),
            email=principal.email,
            is_operator=principal.is_operator,
            tenants=row.tenants,
            stores=row.stores,
            pid=row.pid,
        )

    @app.get("/api/v1/_t/operator-outside-ops")
    @operator_only
    def operator_outside_ops() -> ResponseReturnValue:
        return jsonify(ran=True)

    @app.get("/api/v1/ops/_t/user-inside-ops")
    @authenticated
    def user_inside_ops() -> ResponseReturnValue:
        return jsonify(ran=True)

    @app.get("/api/v1/_t/context")
    @public
    def context() -> ResponseReturnValue:
        with transaction(get_engine()) as db:
            row = db.execute(
                text(
                    "SELECT app_tenant_id() AS tenant, "
                    "current_setting('app.operator', true) AS operator, "
                    "pg_backend_pid() AS pid, "
                    "(SELECT count(*) FROM stores) AS stores, "
                    "(SELECT count(*) FROM tenants) AS tenants"
                )
            ).one()
        return jsonify(
            tenant=str(row.tenant) if row.tenant else None,
            operator=row.operator or None,
            pid=row.pid,
            stores=row.stores,
            tenants=row.tenants,
        )

    @app.get("/api/v1/_t/no-policy")
    def no_policy() -> ResponseReturnValue:
        raise AssertionError("a view without a policy must never run")


@pytest.fixture()
def app(config: Config, fresh_staffed_tenants: TwoTenants) -> Iterator[Flask]:
    cfg = dataclasses.replace(
        config, operator_emails=frozenset({fresh_staffed_tenants.operator_email})
    )
    application = create_app(cfg)
    _add_test_routes(application)
    yield application
    engine_of(application).dispose()


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


def _as(user_client: UserClient, world: World, role: str = "owner") -> FlaskClient:
    return user_client(world.user(role), world.tenant_id)


def _error(response: Any) -> str:
    return str(response.get_json()["error"]["code"])


def _history(owner: Engine, tenant_id: uuid.UUID, event: str) -> list[Any]:
    with owner.connect() as conn:
        return conn.execute(
            text(
                "SELECT actor_type, actor_id, target_type, target_id, data, ip "
                "FROM audit_entries WHERE tenant_id = :t AND event = :e ORDER BY at"
            ),
            {"t": tenant_id, "e": event},
        ).all()


def _owner_sql(owner: Engine, sql: str, **params: Any) -> None:
    with owner.begin() as conn:
        conn.execute(text(sql), params)


def _session_cookie(client: FlaskClient, name: str = sessions.USER_COOKIE) -> str:
    cookie = client.get_cookie(name)
    assert cookie is not None
    return cookie.value


# ---- authentication -------------------------------------------------------------------------


def test_no_cookie_is_unauthenticated(app: Flask) -> None:
    response = app.test_client().get("/api/v1/_t/whoami")

    assert response.status_code == 401
    assert _error(response) == "unauthenticated"


def test_unknown_token_is_unauthenticated(app: Flask) -> None:
    client = app.test_client()
    client.set_cookie(sessions.USER_COOKIE, "not-a-real-session")

    response = client.get("/api/v1/_t/whoami")

    assert response.status_code == 401
    assert _error(response) == "unauthenticated"


@pytest.mark.parametrize(
    "expire",
    [
        "UPDATE sessions SET revoked_at = now()",
        "UPDATE sessions SET idle_expires_at = now() - interval '1 second'",
        "UPDATE sessions SET absolute_expires_at = now() - interval '1 second'",
    ],
    ids=["revoked", "idle-expired", "absolute-expired"],
)
def test_ended_session_is_unauthenticated(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, expire: str
) -> None:
    client = _as(user_client, worlds.a)
    assert client.get("/api/v1/_t/whoami").status_code == 200

    _owner_sql(owner_engine, expire)
    response = client.get("/api/v1/_t/whoami")

    assert response.status_code == 401
    assert _error(response) == "unauthenticated"


def test_valid_session_gives_the_view_its_principal_and_only_its_tenant(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    a = worlds.a

    response = _as(user_client, a, "sales_limited").get("/api/v1/_t/whoami")

    assert response.status_code == 200
    body = response.get_json()
    assert body["user_id"] == str(a.user("sales_limited"))
    assert body["tenant_id"] == str(a.tenant_id)
    assert body["db_tenant"] == str(a.tenant_id)
    assert body["name"] == "sales_limited a"
    assert body["locale"] == "ar"
    assert body["roles"] == ["sales"]
    assert body["all_stores"] is False
    assert body["store_ids"] == [str(a.store_id)]
    assert body["is_operator"] is False
    uuid.UUID(body["session_id"])
    # RLS shows the request only its own business's rows.
    assert sorted(body["visible_stores"]) == sorted([str(a.store_id), str(a.second_store_id)])


def test_session_is_bound_to_its_own_user_and_tenant(
    app: Flask, app_engine: Engine, worlds: TwoTenants
) -> None:
    """A session row naming one tenant's user with another tenant's id finds no user."""
    with transaction(app_engine) as db:
        token, _ = sessions.create_user_session(
            db, user_id=worlds.a.user_id, tenant_id=worlds.b.tenant_id
        )
    client = app.test_client()
    client.set_cookie(sessions.USER_COOKIE, token)

    response = client.get("/api/v1/_t/whoami")

    assert response.status_code == 401


# ---- CSRF -----------------------------------------------------------------------------------


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_state_changing_request_without_csrf_header_is_refused(
    user_client: UserClient, worlds: TwoTenants, method: str
) -> None:
    client = _as(user_client, worlds.a)

    refused = client.open("/api/v1/_t/echo", method=method)
    allowed = client.open("/api/v1/_t/echo", method=method, headers=CSRF)

    assert refused.status_code == 403
    assert _error(refused) == "csrf_required"
    assert allowed.status_code == 200


def test_csrf_header_is_checked_before_anything_else(app: Flask) -> None:
    response = app.test_client().post("/api/v1/_t/echo")

    assert response.status_code == 403
    assert _error(response) == "csrf_required"


def test_safe_request_needs_no_csrf_header(user_client: UserClient, worlds: TwoTenants) -> None:
    assert _as(user_client, worlds.a).get("/api/v1/_t/echo").status_code == 200


# ---- business and user status -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "code"), [("suspended", "business_suspended"), ("pending", "business_pending")]
)
def test_business_that_is_not_active_is_refused(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, status: str, code: str
) -> None:
    client = _as(user_client, worlds.a)
    _owner_sql(
        owner_engine, "UPDATE tenants SET status = :s WHERE id = :t", s=status, t=worlds.a.tenant_id
    )

    response = client.get("/api/v1/_t/whoami")

    assert response.status_code == 403
    assert _error(response) == code
    # The other business is unaffected.
    assert _as(user_client, worlds.b).get("/api/v1/_t/whoami").status_code == 200


def test_user_set_inactive_is_signed_out_on_the_next_request(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    client = _as(user_client, a, "sales")
    assert client.get("/api/v1/_t/whoami").status_code == 200

    _owner_sql(
        owner_engine, "UPDATE users SET status = 'inactive' WHERE id = :u", u=a.user("sales")
    )
    response = client.get("/api/v1/_t/whoami")

    assert response.status_code == 401
    assert _error(response) == "unauthenticated"
    # The session itself was ended, so reactivating the user does not bring it back.
    _owner_sql(owner_engine, "UPDATE users SET status = 'active' WHERE id = :u", u=a.user("sales"))
    assert client.get("/api/v1/_t/whoami").status_code == 401


def test_signing_out_an_inactive_user_does_not_wait_on_the_requests_own_session_update(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    """The lookup updates last_seen_at (row lock) before the user is found inactive; ending
    the session on another connection must not wait for that lock (lock_timeout -> 500)."""
    a = worlds.a
    client = _as(user_client, a, "sales")
    _owner_sql(owner_engine, "UPDATE sessions SET last_seen_at = now() - interval '10 minutes'")
    _owner_sql(
        owner_engine, "UPDATE users SET status = 'inactive' WHERE id = :u", u=a.user("sales")
    )

    started = time.monotonic()
    response = client.get("/api/v1/_t/whoami")

    assert response.status_code == 401
    assert time.monotonic() - started < 5
    with owner_engine.connect() as conn:
        assert conn.execute(text("SELECT revoked_at FROM sessions")).scalar_one() is not None


# ---- permissions ------------------------------------------------------------------------------


def test_role_change_applies_on_the_next_request_and_the_refusal_is_recorded(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    manager = a.user("manager")
    client = _as(user_client, a, "manager")
    assert client.get("/api/v1/_t/staff").status_code == 200

    _owner_sql(owner_engine, "UPDATE users SET roles = ARRAY['sales'] WHERE id = :u", u=manager)
    response = client.get("/api/v1/_t/staff?q=private")

    assert response.status_code == 403
    assert _error(response) == "forbidden"
    [entry] = _history(owner_engine, a.tenant_id, "access.denied_permission")
    assert entry.actor_type == "user"
    assert entry.actor_id == manager
    assert entry.data["path"] == "/api/v1/_t/staff"
    assert entry.data["permission"] == "staff.view"
    assert "private" not in str(entry.data)
    assert _history(owner_engine, worlds.b.tenant_id, "access.denied_permission") == []


@pytest.mark.parametrize("role", ["sales", "packing", "dispatch"])
def test_roles_without_the_permission_are_refused(
    user_client: UserClient, worlds: TwoTenants, role: str
) -> None:
    response = _as(user_client, worlds.a, role).get("/api/v1/_t/staff")

    assert response.status_code == 403
    assert _error(response) == "forbidden"


def test_store_limited_user_on_another_store_gets_not_found_and_it_is_recorded(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    client = _as(user_client, a, "sales_limited")

    own = client.get(f"/api/v1/_t/stores/{a.store_id}")
    other = client.get(f"/api/v1/_t/stores/{a.second_store_id}")
    unknown = _as(user_client, a).get(f"/api/v1/_t/stores/{uuid.uuid4()}")

    assert own.status_code == 200
    assert other.status_code == 404
    assert other.get_json() == unknown.get_json()
    [entry] = _history(owner_engine, a.tenant_id, "access.denied_store")
    assert entry.actor_id == a.user("sales_limited")
    assert entry.data["path"] == f"/api/v1/_t/stores/{a.second_store_id}"
    assert entry.data["store_id"] == str(a.second_store_id)


def test_record_of_another_business_is_not_found_exactly_like_an_unknown_one(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    client = _as(user_client, a)  # owner: every store, so only the tenant boundary applies

    foreign = client.get(f"/api/v1/_t/stores/{b.store_id}")
    unknown = client.get(f"/api/v1/_t/stores/{uuid.uuid4()}")
    no_route = client.get("/api/v1/_t/nothing-here")

    assert foreign.status_code == unknown.status_code == 404
    assert foreign.get_data() == unknown.get_data() == no_route.get_data()
    # Both refusals are recorded: the foreign record and the unknown one look the same.
    first, second = _history(owner_engine, a.tenant_id, "access.denied_tenant")
    assert (first.target_type, first.target_id) == ("store", b.store_id)
    assert first.data["path"] == f"/api/v1/_t/stores/{b.store_id}"
    assert second.target_type == "store"
    assert _history(owner_engine, b.tenant_id, "access.denied_tenant") == []


# ---- the request transaction -------------------------------------------------------------------


def _store_names(owner: Engine, tenant_id: uuid.UUID) -> set[str]:
    with owner.connect() as conn:
        return set(
            conn.execute(text("SELECT name FROM stores WHERE tenant_id = :t"), {"t": tenant_id})
            .scalars()
            .all()
        )


def test_successful_view_commits(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    response = _as(user_client, worlds.a).post(
        "/api/v1/_t/stores", json={"name": "Committed"}, headers=CSRF
    )

    assert response.status_code == 201
    assert "Committed" in _store_names(owner_engine, worlds.a.tenant_id)


@pytest.mark.parametrize(("then", "status"), [("fail", 409), ("foreign", 404), ("crash", 500)])
def test_failing_view_rolls_back_its_writes(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, then: str, status: int
) -> None:
    response = _as(user_client, worlds.a).post(
        "/api/v1/_t/stores", json={"name": "Discarded", "then": then}, headers=CSRF
    )

    assert response.status_code == status
    assert "Discarded" not in _store_names(owner_engine, worlds.a.tenant_id)


def test_denial_record_survives_the_rollback_of_the_refused_request(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a

    _as(user_client, a).post(
        "/api/v1/_t/stores", json={"name": "Discarded", "then": "foreign"}, headers=CSRF
    )

    assert "Discarded" not in _store_names(owner_engine, a.tenant_id)
    [entry] = _history(owner_engine, a.tenant_id, "access.denied_tenant")
    assert entry.actor_id == a.user_id
    assert entry.data == {"path": "/api/v1/_t/stores", "method": "POST"}
    assert str(entry.ip) == "127.0.0.1"


def test_view_without_a_declared_policy_never_runs(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    response = _as(user_client, worlds.a).get("/api/v1/_t/no-policy")

    assert response.status_code == 500
    assert _error(response) == "internal_error"


# ---- operators ----------------------------------------------------------------------------------


def test_operator_session_works_under_ops_with_operator_context(
    operator_client: OperatorClient, worlds: TwoTenants
) -> None:
    response = operator_client(worlds.operator_id).get("/api/v1/ops/_t/whoami")

    assert response.status_code == 200
    body = response.get_json()
    assert body["operator_id"] == str(worlds.operator_id)
    assert body["email"] == worlds.operator_email
    assert body["is_operator"] is True
    assert body["tenants"] == 2  # operator context lists businesses...
    assert body["stores"] == 0  # ...but sees nothing inside them


def test_operator_session_is_refused_outside_ops_as_if_the_route_did_not_exist(
    operator_client: OperatorClient, worlds: TwoTenants
) -> None:
    client = operator_client(worlds.operator_id)

    business_route = client.get("/api/v1/_t/whoami")
    misplaced = client.get("/api/v1/_t/operator-outside-ops")

    assert business_route.status_code == misplaced.status_code == 404
    assert _error(business_route) == _error(misplaced) == "not_found"


def test_user_session_is_refused_under_ops_as_if_the_route_did_not_exist(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    client = _as(user_client, worlds.a)

    ops_route = client.get("/api/v1/ops/_t/whoami")
    misplaced = client.get("/api/v1/ops/_t/user-inside-ops")

    assert ops_route.status_code == misplaced.status_code == 404
    assert _error(ops_route) == _error(misplaced) == "not_found"


def test_ops_route_without_a_session_is_unauthenticated(app: Flask) -> None:
    response = app.test_client().get("/api/v1/ops/_t/whoami")

    assert response.status_code == 401


def test_operator_token_in_the_user_cookie_is_not_accepted(
    app: Flask, app_engine: Engine, worlds: TwoTenants
) -> None:
    with transaction(app_engine) as db:
        token, _ = sessions.create_operator_session(db, operator_id=worlds.operator_id)
    client = app.test_client()
    client.set_cookie(sessions.USER_COOKIE, token)

    assert client.get("/api/v1/ops/_t/whoami").status_code == 401


@pytest.mark.parametrize("change", ["deactivate", "remove_from_allow_list"])
def test_operator_who_lost_access_is_signed_out(
    config: Config,
    operator_client: OperatorClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    app: Flask,
    change: str,
) -> None:
    client = operator_client(worlds.operator_id)
    if change == "deactivate":
        _owner_sql(owner_engine, "UPDATE operators SET is_active = false")
    else:
        app.extensions["bos_config"] = dataclasses.replace(config, operator_emails=frozenset())

    response = client.get("/api/v1/ops/_t/whoami")

    assert response.status_code == 401
    with owner_engine.connect() as conn:
        assert conn.execute(text("SELECT revoked_at FROM sessions")).scalar_one() is not None


# ---- pooled connections and logging -------------------------------------------------------------


def test_tenant_context_does_not_leak_to_the_next_request_on_the_same_connection(
    app: Flask,
    config: Config,
    user_client: UserClient,
    operator_client: OperatorClient,
    worlds: TwoTenants,
) -> None:
    engine_of(app).dispose()
    app.extensions["bos_engine"] = create_engine(config.database_url, pool_size=1, max_overflow=0)
    user = _as(user_client, worlds.a)
    operator = operator_client(worlds.operator_id)
    anonymous = app.test_client()

    first = user.get("/api/v1/_t/whoami").get_json()
    after_user = anonymous.get("/api/v1/_t/context").get_json()
    operator_pid = operator.get("/api/v1/ops/_t/whoami").get_json()["pid"]
    after_operator = anonymous.get("/api/v1/_t/context").get_json()

    assert first["pid"] == after_user["pid"] == operator_pid == after_operator["pid"]
    for state in (after_user, after_operator):
        assert state["tenant"] is None
        assert state["operator"] is None
        assert state["stores"] == 0
        assert state["tenants"] == 0


def test_request_log_has_the_path_but_never_the_query_string(
    user_client: UserClient, worlds: TwoTenants, caplog: pytest.LogCaptureFixture
) -> None:
    client = _as(user_client, worlds.a)

    with caplog.at_level(logging.INFO, logger="bos.request"):
        client.get("/api/v1/_t/whoami?token=very-secret&phone=70000111")

    lines = [r.getMessage() for r in caplog.records if r.name == "bos.request"]
    assert len(lines) == 1
    assert "path=/api/v1/_t/whoami " in lines[0]
    assert "very-secret" not in lines[0]
    assert "70000111" not in lines[0]
    assert "?" not in lines[0]
