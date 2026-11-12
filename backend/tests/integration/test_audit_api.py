"""T042 — the business's history, ``GET /audit`` (``app.api.audit``)."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine, text

from app.config import Config
from tests.dbsupport import TwoTenants, insert
from tests.integration.us1_support import app_for, ok, owner_value, shared_app_fixture

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
START = datetime(2026, 11, 1, 8, 0, tzinfo=UTC)


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


def _entry(
    owner: Engine,
    tenant_id: uuid.UUID | None,
    event: str,
    minutes: int,
    *,
    actor_type: str = "user",
    actor_id: uuid.UUID | None = None,
    target: tuple[str, uuid.UUID] | None = None,
    data: str = "{}",
) -> uuid.UUID:
    entry_id = uuid.uuid4()
    with owner.begin() as conn:
        insert(
            conn,
            "audit_entries",
            id=entry_id,
            tenant_id=tenant_id,
            actor_type=actor_type,
            actor_id=actor_id,
            event=event,
            target_type=target[0] if target else None,
            target_id=target[1] if target else None,
            data=data,
            at=START + timedelta(minutes=minutes),
        )
    return entry_id


def _owner(user_client: UserClient, worlds: TwoTenants) -> FlaskClient:
    return user_client(worlds.a.user_id, worlds.a.tenant_id)


def _page(client: FlaskClient, query: str = "") -> Any:
    return ok(client.get(f"/api/v1/audit{query}"))


def test_history_is_the_callers_business_only_newest_first(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    first = _entry(owner_engine, a.tenant_id, "store.created", 1, actor_id=a.user_id)
    second = _entry(
        owner_engine,
        a.tenant_id,
        "tenant.suspended",
        2,
        actor_type="operator",
        actor_id=worlds.operator_id,
        target=("tenant", a.tenant_id),
    )
    third = _entry(
        owner_engine,
        a.tenant_id,
        "auth.sign_in_failed",
        3,
        actor_type="anonymous",
        target=("user", a.user_id),
    )
    _entry(owner_engine, b.tenant_id, "store.created", 4, actor_id=b.user_id)
    _entry(owner_engine, None, "auth.sign_in_failed", 5, actor_type="anonymous")

    page = _page(_owner(user_client, worlds))

    ids = [item["id"] for item in page["items"]]
    # Newest first; the fixture's own sign-in entry ("now") comes before the dated ones.
    assert ids[-3:] == [str(third), str(second), str(first)]
    assert len(ids) == 4
    assert page["next_cursor"] is None
    by_id = {item["id"]: item for item in page["items"]}
    assert by_id[str(first)]["actor_name"] == "Owner a"
    assert by_id[str(first)]["actor_type"] == "user"
    assert by_id[str(first)]["actor_id"] == str(a.user_id)
    assert by_id[str(second)]["actor_type"] == "operator"
    # Operators are never identified to merchants: neither their name nor their id.
    assert (by_id[str(second)]["actor_id"], by_id[str(second)]["actor_name"]) == (None, None)
    assert worlds.operator_email not in str(page)
    assert str(worlds.operator_id) not in str(page)
    assert by_id[str(second)]["target_type"] == "tenant"
    assert by_id[str(second)]["target_id"] == str(a.tenant_id)
    assert by_id[str(second)]["target_name"] == "Tenant a"
    assert by_id[str(third)]["actor_name"] is None
    assert by_id[str(third)]["target_name"] == "Owner a"
    assert set(by_id[str(third)]) == {
        "id",
        "at",
        "event",
        "actor_type",
        "actor_id",
        "actor_name",
        "target_type",
        "target_id",
        "target_name",
        "data",
    }
    assert by_id[str(first)]["target_type"] is None
    assert by_id[str(first)]["target_id"] is None
    assert by_id[str(first)]["target_name"] is None


def test_target_names_are_current_and_only_from_the_callers_business(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    own_store = _entry(owner_engine, a.tenant_id, "store.updated", 1, target=("store", a.store_id))
    own_invite = _entry(
        owner_engine, a.tenant_id, "invitation.created", 2, target=("invitation", a.invitation_id)
    )
    own_user = _entry(
        owner_engine, a.tenant_id, "user.roles_changed", 3, target=("user", a.user("sales"))
    )
    session = _entry(
        owner_engine, a.tenant_id, "auth.session_revoked", 4, target=("session", uuid.uuid4())
    )
    # Rows of business a that name records of business b, as a refused request would.
    probes = {
        _entry(owner_engine, a.tenant_id, "access.denied_tenant", 5 + i, target=target)
        for i, target in enumerate(
            [
                ("store", b.store_id),
                ("user", b.user_id),
                ("invitation", b.invitation_id),
                ("tenant", b.tenant_id),
            ]
        )
    }
    with owner_engine.begin() as conn:
        conn.execute(
            text("UPDATE stores SET name = 'Renamed a' WHERE id = :id"), {"id": a.store_id}
        )

    by_id = {item["id"]: item for item in _page(_owner(user_client, worlds))["items"]}

    assert by_id[str(own_store)]["target_name"] == "Renamed a"
    assert by_id[str(own_invite)]["target_name"] == "Invitee a"
    assert by_id[str(own_user)]["target_name"] == "sales a"
    assert by_id[str(session)]["target_name"] is None
    for probe in probes:
        item = by_id[str(probe)]
        assert item["target_id"] is not None
        assert item["target_name"] is None
    assert "Store b" not in str(by_id) and "Owner b" not in str(by_id)
    assert "Invitee b" not in str(by_id) and "Tenant b" not in str(by_id)


def test_actor_name_of_another_business_never_resolves(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    crafted = _entry(
        owner_engine, worlds.a.tenant_id, "store.updated", 1, actor_id=worlds.b.user_id
    )

    [item] = [i for i in _page(_owner(user_client, worlds))["items"] if i["id"] == str(crafted)]

    assert item["actor_id"] == str(worlds.b.user_id)
    assert item["actor_name"] is None


def test_history_is_paginated_with_an_opaque_cursor(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    for minute in range(60):
        _entry(owner_engine, a.tenant_id, "store.updated", minute, actor_id=a.user_id)
    client = _owner(user_client, worlds)

    first = _page(client)
    second = _page(client, f"?cursor={first['next_cursor']}")

    assert len(first["items"]) == 50
    assert first["next_cursor"]
    assert len(second["items"]) == 11  # 60 + the fixture's entry
    assert second["next_cursor"] is None
    seen = [item["id"] for item in first["items"] + second["items"]]
    assert len(set(seen)) == 61
    times = [item["at"] for item in first["items"] + second["items"]]
    assert times == sorted(times, reverse=True)


def test_history_filters_by_event_and_actor(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    manager = a.user("manager")
    by_owner = _entry(owner_engine, a.tenant_id, "store.updated", 1, actor_id=a.user_id)
    by_manager = _entry(owner_engine, a.tenant_id, "store.updated", 2, actor_id=manager)
    _entry(owner_engine, a.tenant_id, "store.created", 3, actor_id=manager)
    client = _owner(user_client, worlds)

    updates = _page(client, "?event=store.updated")
    managers = _page(client, f"?actor_id={manager}")
    both = _page(client, f"?event=store.updated&actor_id={manager}")

    assert [i["id"] for i in updates["items"]] == [str(by_manager), str(by_owner)]
    assert {i["actor_name"] for i in managers["items"]} == {"manager a"}
    assert len(managers["items"]) == 2
    assert [i["id"] for i in both["items"]] == [str(by_manager)]


def test_actor_of_another_business_finds_nothing(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    _entry(owner_engine, worlds.b.tenant_id, "store.created", 1, actor_id=worlds.b.user_id)

    page = _page(_owner(user_client, worlds), f"?actor_id={worlds.b.user_id}")

    assert page == {"items": [], "next_cursor": None}


@pytest.mark.parametrize("query", ["?cursor=not-a-cursor", "?actor_id=12", "?cursor="])
def test_malformed_parameters_are_refused(
    user_client: UserClient, worlds: TwoTenants, query: str
) -> None:
    response = _owner(user_client, worlds).get(f"/api/v1/audit{query}")

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_failed"


@pytest.mark.parametrize("role", ["manager", "sales", "packing", "dispatch", "sales_limited"])
def test_only_owners_may_read_the_history(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, role: str
) -> None:
    a = worlds.a

    response = user_client(a.user(role), a.tenant_id).get("/api/v1/audit")

    # 403 is not documented for GET /audit in the contract yet, so only the code is checked.
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "forbidden"

    assert (
        owner_value(
            owner_engine,
            "SELECT count(*) FROM audit_entries WHERE tenant_id = :t AND event = 'access.denied_permission'",
            t=a.tenant_id,
        )
        == 1
    )


def test_platform_entries_never_appear(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    for minute in range(3):
        _entry(owner_engine, None, "operator.sign_in", minute, actor_type="operator")

    page = _page(_owner(user_client, worlds), "?event=operator.sign_in")

    assert page["items"] == []
