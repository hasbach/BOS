"""T015 — idempotent creation (``app.core.idempotency``, research R10 + R25).

Throwaway routes on a test instance of the application create a store (business users) or a
business (operators) and hand out a one-time "link" each time they answer, like the real
setup and invitation endpoints will. Nothing but a reference to the created record may ever
be stored.
"""

from __future__ import annotations

import dataclasses
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask, jsonify, request
from flask.testing import FlaskClient
from flask.typing import ResponseReturnValue
from sqlalchemy import Engine, text

from app import create_app
from app.config import Config
from app.core.db import engine_of
from app.core.idempotency import MAX_KEY_LENGTH, idempotent
from app.core.permissions import operator_only, require
from app.core.request_context import current_operator, current_user, request_db
from app.core.security import new_token
from app.errors import ApiError
from tests.dbsupport import TwoTenants, as_operator, as_tenant

CSRF = {"X-BOS-CSRF": "1"}
UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
OperatorClient = Callable[[uuid.UUID], FlaskClient]

# Every one-time link handed out by the test routes, so a test can look for them in the table.
issued_links: list[str] = []
create_calls: list[str] = []
replay_calls: list[uuid.UUID] = []


def _link() -> str:
    token, _ = new_token()
    issued_links.append(token)
    return token


def _create_store(body: dict[str, Any]) -> tuple[uuid.UUID, ResponseReturnValue]:
    create_calls.append(request.endpoint or "")
    db = request_db()
    store_id = uuid.uuid4()
    name = body["name"]
    if body.get("unique_name"):
        name = f"{name} {uuid.uuid4().hex[:8]}"
    db.execute(
        text("INSERT INTO stores (id, tenant_id, name) VALUES (:id, :t, :name)"),
        {"id": store_id, "t": current_user().tenant_id, "name": name},
    )
    if body.get("then") == "fail":
        raise ApiError(409, "conflict_for_test")
    if body.get("sleep"):
        time.sleep(float(body["sleep"]))
    return store_id, (jsonify(id=str(store_id), link=_link(), replayed=False), 201)


def _replay_store(store_id: uuid.UUID) -> ResponseReturnValue:
    replay_calls.append(store_id)
    row = request_db().execute(text("SELECT id FROM stores WHERE id = :id"), {"id": store_id}).one()
    return jsonify(id=str(row.id), link=_link(), replayed=True), 201


def _add_test_routes(app: Flask) -> None:
    @app.post("/api/v1/_t/things")
    @require("store.manage")
    def things() -> ResponseReturnValue:
        body = request.get_json()
        return idempotent("store", create=lambda: _create_store(body), replay=_replay_store)

    @app.post("/api/v1/_t/other-things")
    @require("store.manage")
    def other_things() -> ResponseReturnValue:
        body = request.get_json()
        return idempotent("store", create=lambda: _create_store(body), replay=_replay_store)

    @app.post("/api/v1/ops/_t/businesses")
    @operator_only
    def businesses() -> ResponseReturnValue:
        body = request.get_json()

        def create() -> tuple[uuid.UUID, ResponseReturnValue]:
            create_calls.append("businesses")
            tenant_id = uuid.uuid4()
            request_db().execute(
                text(
                    "INSERT INTO tenants (id, name, edition, usd_lbp_rate, created_by_operator_id) "
                    "VALUES (:id, :name, 'social', 89500, :op)"
                ),
                {"id": tenant_id, "name": body["name"], "op": current_operator().operator_id},
            )
            return tenant_id, (jsonify(id=str(tenant_id), link=_link(), replayed=False), 201)

        def replay(tenant_id: uuid.UUID) -> ResponseReturnValue:
            replay_calls.append(tenant_id)
            return jsonify(id=str(tenant_id), link=_link(), replayed=True), 201

        return idempotent("tenant", create=create, replay=replay)


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture()
def app(config: Config, worlds: TwoTenants) -> Iterator[Flask]:
    issued_links.clear()
    create_calls.clear()
    replay_calls.clear()
    cfg = dataclasses.replace(config, operator_emails=frozenset({worlds.operator_email}))
    application = create_app(cfg)
    _add_test_routes(application)
    yield application
    engine_of(application).dispose()


def _post(client: FlaskClient, path: str, body: dict[str, Any], key: str | None = None) -> Any:
    headers = dict(CSRF)
    if key is not None:
        headers["Idempotency-Key"] = key
    return client.post(path, json=body, headers=headers)


def _stores_named(owner: Engine, tenant_id: uuid.UUID, prefix: str) -> list[uuid.UUID]:
    with owner.connect() as conn:
        return list(
            conn.execute(
                text("SELECT id FROM stores WHERE tenant_id = :t AND name LIKE :p ORDER BY name"),
                {"t": tenant_id, "p": f"{prefix}%"},
            ).scalars()
        )


def _keys(owner: Engine, key: str) -> list[Any]:
    with owner.connect() as conn:
        return conn.execute(
            text("SELECT * FROM idempotency_keys WHERE key = :k ORDER BY scope"), {"k": key}
        ).all()


def _error(response: Any) -> str:
    return str(response.get_json()["error"]["code"])


# ---- the basic contract -----------------------------------------------------------------------


def test_without_a_key_every_request_creates(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)

    first = _post(client, "/api/v1/_t/things", {"name": "NoKey", "unique_name": True})
    second = _post(client, "/api/v1/_t/things", {"name": "NoKey", "unique_name": True})

    assert first.status_code == second.status_code == 201
    assert first.get_json()["id"] != second.get_json()["id"]
    assert len(_stores_named(owner_engine, worlds.a.tenant_id, "NoKey")) == 2
    with owner_engine.connect() as conn:
        stored = conn.execute(
            text("SELECT count(*) FROM idempotency_keys WHERE scope = 'things'")
        ).scalar_one()
    assert stored == 0


def test_same_key_and_body_returns_the_same_resource_without_creating_again(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)
    body = {"name": "Repeat"}

    first = _post(client, "/api/v1/_t/things", body, key="k-repeat")
    second = _post(client, "/api/v1/_t/things", body, key="k-repeat")

    assert first.status_code == second.status_code == 201
    assert first.get_json()["replayed"] is False
    assert second.get_json()["replayed"] is True
    assert second.get_json()["id"] == first.get_json()["id"]
    # The repeat gets a fresh link from the endpoint's replay; nothing was stored to resend.
    assert second.get_json()["link"] != first.get_json()["link"]
    assert create_calls == ["things"]
    assert replay_calls == [uuid.UUID(first.get_json()["id"])]
    assert _stores_named(owner_engine, worlds.a.tenant_id, "Repeat") == [
        uuid.UUID(first.get_json()["id"])
    ]


def test_same_body_with_keys_in_a_different_order_is_the_same_request(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)
    headers = {**CSRF, "Idempotency-Key": "k-order", "Content-Type": "application/json"}

    first = client.post("/api/v1/_t/things", data='{"name": "Order", "x": 1}', headers=headers)
    second = client.post("/api/v1/_t/things", data='{"x":1,"name":"Order"}', headers=headers)

    assert first.status_code == second.status_code == 201
    assert second.get_json()["id"] == first.get_json()["id"]
    assert second.get_json()["replayed"] is True


def test_same_key_with_a_different_body_is_a_conflict(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)

    first = _post(client, "/api/v1/_t/things", {"name": "Conflict"}, key="k-conflict")
    second = _post(client, "/api/v1/_t/things", {"name": "Conflict 2"}, key="k-conflict")

    assert first.status_code == 201
    assert second.status_code == 409
    assert _error(second) == "idempotency_conflict"
    assert create_calls == ["things"]
    assert replay_calls == []
    assert _stores_named(owner_engine, worlds.a.tenant_id, "Conflict 2") == []


def test_keys_are_scoped_by_endpoint(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)
    body = {"name": "Scoped", "unique_name": True}

    first = _post(client, "/api/v1/_t/things", body, key="k-scope")
    second = _post(client, "/api/v1/_t/other-things", body, key="k-scope")

    assert first.status_code == second.status_code == 201
    assert first.get_json()["id"] != second.get_json()["id"]
    assert second.get_json()["replayed"] is False
    assert [row.scope for row in _keys(owner_engine, "k-scope")] == ["other_things", "things"]


def test_keys_are_scoped_by_actor(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    owner = user_client(a.user_id, a.tenant_id)
    manager = user_client(a.user("manager"), a.tenant_id)
    body = {"name": "Actor", "unique_name": True}

    first = _post(owner, "/api/v1/_t/things", body, key="k-actor")
    second = _post(manager, "/api/v1/_t/things", body, key="k-actor")

    assert first.status_code == second.status_code == 201
    assert first.get_json()["id"] != second.get_json()["id"]
    assert sorted(row.actor_id for row in _keys(owner_engine, "k-actor")) == sorted(
        [a.user_id, a.user("manager")]
    )


def test_another_business_can_neither_see_nor_replay_a_key(
    user_client: UserClient, owner_engine: Engine, app_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    body = {"name": "Shared key", "unique_name": True}

    first = _post(user_client(a.user_id, a.tenant_id), "/api/v1/_t/things", body, key="k-shared")
    second = _post(user_client(b.user_id, b.tenant_id), "/api/v1/_t/things", body, key="k-shared")

    assert first.status_code == second.status_code == 201
    assert second.get_json()["replayed"] is False
    assert second.get_json()["id"] != first.get_json()["id"]
    # B's request created B's own store; A's store was never returned to B.
    assert _stores_named(owner_engine, b.tenant_id, "Shared key") == [
        uuid.UUID(second.get_json()["id"])
    ]
    # Row-level security: each business sees only its own key row, operators see neither.
    for world in (a, b):
        with as_tenant(app_engine, world.tenant_id) as conn:
            rows = conn.execute(
                text("SELECT tenant_id FROM idempotency_keys WHERE key = 'k-shared'")
            ).all()
        assert [row.tenant_id for row in rows] == [world.tenant_id]
    with as_operator(app_engine) as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM idempotency_keys WHERE key = 'k-shared'")
            ).scalar_one()
            == 0
        )


def test_operator_requests_are_idempotent_and_their_keys_have_no_business(
    operator_client: OperatorClient,
    owner_engine: Engine,
    app_engine: Engine,
    worlds: TwoTenants,
) -> None:
    client = operator_client(worlds.operator_id)
    body = {"name": "Idempotent Business"}

    first = _post(client, "/api/v1/ops/_t/businesses", body, key="k-ops")
    second = _post(client, "/api/v1/ops/_t/businesses", body, key="k-ops")
    third = _post(client, "/api/v1/ops/_t/businesses", {"name": "Other"}, key="k-ops")

    assert first.status_code == second.status_code == 201
    assert second.get_json()["id"] == first.get_json()["id"]
    assert second.get_json()["replayed"] is True
    assert third.status_code == 409
    assert _error(third) == "idempotency_conflict"
    with owner_engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM tenants WHERE name = 'Idempotent Business'")
            ).scalar_one()
            == 1
        )
    [row] = _keys(owner_engine, "k-ops")
    assert row.tenant_id is None
    assert row.actor_id == worlds.operator_id
    assert row.resource_type == "tenant"
    # Only operator context sees an operator key; no business does.
    with as_operator(app_engine) as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM idempotency_keys WHERE key = 'k-ops'")
            ).scalar_one()
            == 1
        )
    for tenant_id in (worlds.a.tenant_id, None):
        with as_tenant(app_engine, tenant_id) as conn:
            assert (
                conn.execute(
                    text("SELECT count(*) FROM idempotency_keys WHERE key = 'k-ops'")
                ).scalar_one()
                == 0
            )


def test_only_a_reference_to_the_resource_is_stored(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)

    first = _post(client, "/api/v1/_t/things", {"name": "Stored"}, key="k-stored")
    _post(client, "/api/v1/_t/things", {"name": "Stored"}, key="k-stored")

    [row] = _keys(owner_engine, "k-stored")
    assert set(row._mapping) == {
        "key",
        "scope",
        "actor_id",
        "tenant_id",
        "request_hash",
        "resource_type",
        "resource_id",
        "created_at",
    }
    assert row.scope == "things"
    assert row.actor_id == worlds.a.user_id
    assert row.tenant_id == worlds.a.tenant_id
    assert row.resource_type == "store"
    assert row.resource_id == uuid.UUID(first.get_json()["id"])
    assert len(row.request_hash) == 32
    stored = repr(tuple(row))
    assert len(issued_links) == 2
    for link in issued_links:
        assert link not in stored
    assert "Stored" not in stored  # not even the request body


def test_a_key_older_than_24_hours_is_ignored(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)
    body = {"name": "Old", "unique_name": True}
    first = _post(client, "/api/v1/_t/things", body, key="k-old")
    with owner_engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE idempotency_keys SET created_at = now() - interval '25 hours' "
                "WHERE key = 'k-old'"
            )
        )

    second = _post(client, "/api/v1/_t/things", {"name": "Old 2"}, key="k-old")

    assert second.status_code == 201
    assert second.get_json()["replayed"] is False
    assert second.get_json()["id"] != first.get_json()["id"]
    [row] = _keys(owner_engine, "k-old")
    assert row.resource_id == uuid.UUID(second.get_json()["id"])


def test_a_failed_request_stores_no_key(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)

    failed = _post(client, "/api/v1/_t/things", {"name": "Fails", "then": "fail"}, key="k-fail")
    assert failed.status_code == 409
    assert _keys(owner_engine, "k-fail") == []

    # The same key with a corrected body is a new request, not a conflict.
    retried = _post(client, "/api/v1/_t/things", {"name": "Fails"}, key="k-fail")
    assert retried.status_code == 201
    assert retried.get_json()["replayed"] is False
    assert len(_keys(owner_engine, "k-fail")) == 1


@pytest.mark.parametrize("key", ["", "x" * (MAX_KEY_LENGTH + 1)], ids=["empty", "too-long"])
def test_an_unusable_key_is_refused(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, key: str
) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)

    response = _post(client, "/api/v1/_t/things", {"name": "Bad key"}, key=key)

    assert response.status_code == 400
    assert _error(response) == "invalid_idempotency_key"
    assert create_calls == []
    assert _stores_named(owner_engine, worlds.a.tenant_id, "Bad key") == []


def test_the_longest_allowed_key_works(user_client: UserClient, worlds: TwoTenants) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)
    key = "k" * MAX_KEY_LENGTH

    first = _post(client, "/api/v1/_t/things", {"name": "Long key"}, key=key)
    second = _post(client, "/api/v1/_t/things", {"name": "Long key"}, key=key)

    assert first.status_code == second.status_code == 201
    assert second.get_json()["id"] == first.get_json()["id"]


# ---- concurrency ------------------------------------------------------------------------------


def _concurrently(
    make_client: Callable[[], FlaskClient], body: dict[str, Any], key: str
) -> list[Any]:
    """Send two identical requests at the same moment; each waits inside create()."""
    clients = [make_client(), make_client()]
    barrier = threading.Barrier(2)
    results: list[Any] = [None, None]

    def send(index: int) -> None:
        barrier.wait()
        results[index] = _post(clients[index], "/api/v1/_t/things", body, key=key)

    threads = [threading.Thread(target=send, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return results


@pytest.mark.parametrize(
    "unique_name",
    [False, True],
    ids=["both-hit-the-store-name-constraint", "both-hit-only-the-key"],
)
def test_concurrent_duplicates_create_once_and_both_get_the_same_resource(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, unique_name: bool
) -> None:
    a = worlds.a
    body = {"name": "Race", "unique_name": unique_name, "sleep": 0.5}

    results = _concurrently(lambda: user_client(a.user_id, a.tenant_id), body, "k-race")

    assert [r.status_code for r in results] == [201, 201], [r.get_json() for r in results]
    ids = {r.get_json()["id"] for r in results}
    assert len(ids) == 1
    assert sorted(r.get_json()["replayed"] for r in results) == [False, True]
    assert _stores_named(owner_engine, a.tenant_id, "Race") == [uuid.UUID(ids.pop())]
    assert len(_keys(owner_engine, "k-race")) == 1
