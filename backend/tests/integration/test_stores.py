"""T063 — stores (``app.api.stores``, ``app.services.stores``), User Story 3.

Real requests against the shared application, checked against the contract wherever the
contract documents the answer (it does not document 400 for ``PATCH /stores/{storeId}``, so
those answers are checked by hand).
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from tests.dbsupport import TwoTenants
from tests.integration.us1_support import (
    CSRF,
    app_for,
    error,
    history,
    ok,
    owner_rows,
    owner_value,
    refused,
    shared_app_fixture,
)
from tests.integration.us3_support import STORES

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]

NUMBER = "+96170123456"
OTHER_NUMBER = "+96176123456"


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


@pytest.fixture()
def owner(user_client: UserClient, worlds: TwoTenants) -> FlaskClient:
    return user_client(worlds.a.user_id, worlds.a.tenant_id)


def _create(client: FlaskClient, **body: Any) -> Any:
    return client.post(STORES, json={"name": "Denim Corner", **body}, headers=CSRF)


def _patch(client: FlaskClient, store_id: Any, **body: Any) -> Any:
    return client.patch(f"{STORES}/{store_id}", json=body, headers=CSRF)


def _store_row(owner: Engine, store_id: Any) -> Any:
    [row] = owner_rows(
        owner,
        "SELECT tenant_id, name, whatsapp_e164, logo_file_id, status FROM stores WHERE id = :s",
        s=store_id,
    )
    return row


def _fields(response: Any) -> dict[str, str]:
    assert response.status_code == 400, response.get_data(as_text=True)
    assert error(response) == "validation_failed"
    fields: dict[str, str] = response.get_json()["error"]["fields"]
    return fields


# ---- adding a store -------------------------------------------------------------------------


@pytest.mark.parametrize("typed", ["70 123 456", "070123456", "+961 70 123 456", "+96170123456"])
def test_add_a_store_with_a_whatsapp_number_in_any_common_format(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, typed: str
) -> None:
    a = worlds.a

    body = ok(_create(owner, whatsapp_number=typed), 201)

    assert body == {
        "id": body["id"],
        "name": "Denim Corner",
        "whatsapp_number": NUMBER,
        "has_logo": False,
        "status": "active",
    }
    row = _store_row(owner_engine, body["id"])
    assert (row.tenant_id, row.whatsapp_e164, row.status) == (a.tenant_id, NUMBER, "active")
    [entry] = history(owner_engine, a.tenant_id, "store.created")
    assert (entry.actor_id, entry.target_type, str(entry.target_id)) == (
        a.user_id,
        "store",
        body["id"],
    )
    assert entry.data == {"name": "Denim Corner", "whatsapp_number": NUMBER}


def test_a_store_needs_no_whatsapp_number_and_can_be_given_to_employees(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    body = ok(_create(owner, name="  Second Shop  "), 201)

    assert (body["name"], body["whatsapp_number"]) == ("Second Shop", None)
    invited = owner.post(
        "/api/v1/staff/invitations",
        json={
            "name": "Rami",
            "email": "rami@example.test",
            "roles": ["sales"],
            "store_ids": [body["id"]],
        },
        headers=CSRF,
    )
    assert invited.status_code == 201, invited.get_data(as_text=True)
    assert invited.get_json()["invitation"]["store_ids"] == [body["id"]]


def test_a_manager_can_add_a_store(user_client: UserClient, worlds: TwoTenants) -> None:
    a = worlds.a

    ok(_create(user_client(a.user("manager"), a.tenant_id)), 201)


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"name": None}, {"name": "required"}),
        ({"name": "   "}, {"name": "required"}),
        ({"name": 42}, {"name": "invalid"}),
        ({"name": "x" * 81}, {"name": "too_long"}),
        ({"whatsapp_number": "12"}, {"whatsapp_number": "invalid_phone"}),
        ({"whatsapp_number": "not a number"}, {"whatsapp_number": "invalid_phone"}),
        ({"whatsapp_number": 70123456}, {"whatsapp_number": "invalid"}),
        (
            {"name": "", "whatsapp_number": "12"},
            {"name": "required", "whatsapp_number": "invalid_phone"},
        ),
    ],
)
def test_invalid_store_fields_are_reported_and_nothing_is_created(
    owner: FlaskClient, owner_engine: Engine, body: dict[str, Any], fields: dict[str, str]
) -> None:
    before = owner_value(owner_engine, "SELECT count(*) FROM stores")

    response = owner.post(STORES, json={"name": "Shop", **body}, headers=CSRF)

    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == fields
    assert owner_value(owner_engine, "SELECT count(*) FROM stores") == before


def test_a_body_that_is_not_an_object_is_refused(owner: FlaskClient) -> None:
    refused(owner.post(STORES, json=["Shop"], headers=CSRF), 400, "validation_failed")


def test_long_and_mixed_script_names_are_accepted_up_to_80_characters(
    owner: FlaskClient,
) -> None:
    mixed = ("متجر Beirut ") * 6  # 72 characters
    name = (mixed + "دنيم ٢ Denim")[:80]
    assert len(name) == 80

    body = ok(_create(owner, name=name), 201)

    assert body["name"] == name
    assert _fields(owner.post(STORES, json={"name": name + "x"}, headers=CSRF)) == {
        "name": "too_long"
    }


def test_a_name_used_by_another_active_store_is_refused_in_any_case(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    taken = "Store a"  # the fixture's first store

    refused(_create(owner, name=taken.upper()), 409, "store_name_in_use")
    refused(_create(owner, name="  store A "), 409, "store_name_in_use")


def test_a_whatsapp_number_used_by_another_active_store_is_refused(owner: FlaskClient) -> None:
    ok(_create(owner, name="One", whatsapp_number="70 123 456"), 201)

    refused(
        _create(owner, name="Two", whatsapp_number="+961 70 123 456"), 409, "whatsapp_number_in_use"
    )


def test_name_and_number_of_an_inactive_store_can_be_used_again(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    old = ok(_create(owner, name="Pop-up", whatsapp_number=NUMBER), 201)
    ok(_patch(owner, old["id"], status="inactive"), 200)

    new = ok(_create(owner, name="POP-UP", whatsapp_number=NUMBER), 201)

    assert new["id"] != old["id"]


# ---- listing --------------------------------------------------------------------------------


def test_owners_list_every_store_with_its_own_details_including_inactive_ones(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    a = worlds.a
    first = ok(_create(owner, name="Hamra", whatsapp_number=NUMBER), 201)
    second = ok(_create(owner, name="Verdun", whatsapp_number=OTHER_NUMBER), 201)
    ok(_patch(owner, second["id"], status="inactive"), 200)

    listing = ok(owner.get(STORES))

    by_id = {s["id"]: s for s in listing}
    assert list(by_id) == [str(a.store_id), str(a.second_store_id), first["id"], second["id"]]
    assert by_id[first["id"]] == {**first, "status": "active"}
    assert by_id[second["id"]] == {**second, "status": "inactive"}
    assert by_id[first["id"]]["whatsapp_number"] != by_id[second["id"]]["whatsapp_number"]


def test_employees_with_every_store_see_the_active_stores_only(
    owner: FlaskClient, user_client: UserClient, worlds: TwoTenants
) -> None:
    a = worlds.a
    ok(_patch(owner, a.second_store_id, status="inactive"), 200)

    listing = ok(user_client(a.user("packing"), a.tenant_id).get(STORES))

    assert [s["id"] for s in listing] == [str(a.store_id)]


def test_a_store_limited_employee_sees_only_their_active_stores(
    owner: FlaskClient, user_client: UserClient, worlds: TwoTenants
) -> None:
    a = worlds.a
    limited = user_client(a.user("sales_limited"), a.tenant_id)

    assert [s["id"] for s in ok(limited.get(STORES))] == [str(a.store_id)]

    ok(_patch(owner, a.store_id, status="inactive", confirm=True), 200)
    assert ok(limited.get(STORES)) == []
    assert limited.get("/api/v1/me").get_json()["stores"] == []


# ---- editing --------------------------------------------------------------------------------


def test_rename_and_change_the_number_records_before_and_after(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a

    body = ok(_patch(owner, a.second_store_id, name="Verdun", whatsapp_number="76 123 456"), 200)

    assert (body["name"], body["whatsapp_number"]) == ("Verdun", OTHER_NUMBER)
    assert _store_row(owner_engine, a.second_store_id).name == "Verdun"
    [entry] = history(owner_engine, a.tenant_id, "store.updated")
    assert entry.data == {
        "before": {"name": "Store a 2", "whatsapp_number": None},
        "after": {"name": "Verdun", "whatsapp_number": OTHER_NUMBER},
    }
    assert (entry.actor_id, entry.target_id) == (a.user_id, a.second_store_id)


def test_the_number_can_be_removed_and_unchanged_fields_stay(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    ok(_patch(owner, a.second_store_id, whatsapp_number=NUMBER), 200)

    body = ok(_patch(owner, a.second_store_id, whatsapp_number=None), 200)

    assert (body["name"], body["whatsapp_number"]) == ("Store a 2", None)


def test_an_edit_that_changes_nothing_records_nothing(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a

    ok(_patch(owner, a.second_store_id, name="Store a 2"), 200)
    ok(_patch(owner, a.second_store_id), 200)

    assert history(owner_engine, a.tenant_id, "store.updated") == []


def test_a_store_may_change_the_case_of_its_own_name(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    body = ok(_patch(owner, worlds.a.store_id, name="STORE A"), 200)

    assert body["name"] == "STORE A"


def test_renaming_to_another_active_store_name_or_number_is_refused(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    ok(_patch(owner, a.store_id, whatsapp_number=NUMBER), 200)

    refused(_patch(owner, a.second_store_id, name="store A"), 409, "store_name_in_use")
    refused(
        _patch(owner, a.second_store_id, whatsapp_number="70123456"), 409, "whatsapp_number_in_use"
    )
    assert _store_row(owner_engine, a.second_store_id).name == "Store a 2"


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"name": "x" * 81}, {"name": "too_long"}),
        ({"name": ""}, {"name": "required"}),
        ({"whatsapp_number": "123"}, {"whatsapp_number": "invalid_phone"}),
        ({"status": "closed"}, {"status": "invalid"}),
        ({"confirm": "yes"}, {"confirm": "invalid"}),
    ],
)
def test_invalid_edits_are_reported_and_change_nothing(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    body: dict[str, Any],
    fields: dict[str, str],
) -> None:
    a = worlds.a
    before = _store_row(owner_engine, a.second_store_id)

    assert _fields(_patch(owner, a.second_store_id, **body)) == fields
    assert _store_row(owner_engine, a.second_store_id) == before


def test_an_unknown_store_is_not_found(owner: FlaskClient) -> None:
    refused(_patch(owner, uuid.uuid4(), name="X"), 404, "not_found")


# ---- deactivating and reactivating ------------------------------------------------------------


def test_deactivating_a_store_with_assigned_employees_asks_for_confirmation_first(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a

    asked = refused(_patch(owner, a.store_id, status="inactive"), 409, "confirmation_required")

    assert asked["error"]["affected"] == [
        {
            "kind": "employee",
            "id": str(a.user("sales_limited")),
            "name": "sales_limited a",
            "roles": ["sales"],
        }
    ]
    assert "@" not in str(asked) and "+961" not in str(asked)
    assert _store_row(owner_engine, a.store_id).status == "active"
    assert history(owner_engine, a.tenant_id, "store.deactivated") == []

    body = ok(_patch(owner, a.store_id, status="inactive", confirm=True), 200)

    assert body["status"] == "inactive"
    assert _store_row(owner_engine, a.store_id).status == "inactive"
    [entry] = history(owner_engine, a.tenant_id, "store.deactivated")
    assert entry.data == {
        "before": "active",
        "after": "inactive",
        "affected": [{"kind": "employee", "id": str(a.user("sales_limited"))}],
    }
    # The assignment is kept, so reactivating the store gives the employee their store back.
    assert (
        owner_value(
            owner_engine,
            "SELECT count(*) FROM user_stores WHERE user_id = :u AND store_id = :s",
            u=a.user("sales_limited"),
            s=a.store_id,
        )
        == 1
    )


def test_a_store_without_store_limited_employees_is_deactivated_at_once(
    owner: FlaskClient, owner_engine: Engine, user_client: UserClient, worlds: TwoTenants
) -> None:
    a = worlds.a

    ok(_patch(owner, a.second_store_id, status="inactive"), 200)

    me = user_client(a.user("sales"), a.tenant_id).get("/api/v1/me").get_json()
    assert [s["id"] for s in me["stores"]] == [str(a.store_id)]


def test_inactive_employees_are_not_listed_as_affected(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    ok(_patch_staff(owner, a.user("sales_limited"), status="inactive"), 200)

    ok(_patch(owner, a.store_id, status="inactive"), 200)


def test_employees_who_keep_another_active_store_are_not_affected(
    owner: FlaskClient, owner_engine: Engine, user_client: UserClient, worlds: TwoTenants
) -> None:
    a = worlds.a
    limited = a.user("sales_limited")
    ok(_patch_staff(owner, limited, store_ids=[str(a.store_id), str(a.second_store_id)]), 200)

    ok(_patch(owner, a.store_id, status="inactive"), 200)

    me = user_client(limited, a.tenant_id).get("/api/v1/me").get_json()
    assert [s["id"] for s in me["stores"]] == [str(a.second_store_id)]
    assert (
        owner_value(owner_engine, "SELECT count(*) FROM user_stores WHERE user_id = :u", u=limited)
        == 2
    )


def test_an_employee_whose_other_store_is_already_inactive_is_affected(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    a = worlds.a
    limited = a.user("sales_limited")
    third = ok(_create(owner, name="Third"), 201)
    ok(_patch_staff(owner, limited, store_ids=[str(a.store_id), third["id"]]), 200)
    ok(_patch(owner, third["id"], status="inactive", confirm=True), 200)

    asked = refused(_patch(owner, a.store_id, status="inactive"), 409, "confirmation_required")

    assert [x["id"] for x in asked["error"]["affected"]] == [str(limited)]


def test_pending_invitations_limited_to_the_store_are_affected(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    a = worlds.a
    only_here = owner.post(
        "/api/v1/staff/invitations",
        json={
            "name": "Nour",
            "email": "nour@example.test",
            "roles": ["packing", "sales"],
            "store_ids": [str(a.second_store_id)],
        },
        headers=CSRF,
    ).get_json()["invitation"]
    owner.post(
        "/api/v1/staff/invitations",
        json={
            "name": "Both",
            "email": "both@example.test",
            "roles": ["sales"],
            "store_ids": [str(a.store_id), str(a.second_store_id)],
        },
        headers=CSRF,
    )

    asked = refused(
        _patch(owner, a.second_store_id, status="inactive"), 409, "confirmation_required"
    )

    assert asked["error"]["affected"] == [
        {
            "kind": "invitation",
            "id": only_here["invitation_id"],
            "name": "Nour",
            "roles": ["sales", "packing"],
        }
    ]
    assert "nour@" not in str(asked)


def _patch_staff(client: FlaskClient, user_id: uuid.UUID, **body: Any) -> Any:
    return client.patch(f"/api/v1/staff/{user_id}", json=body, headers=CSRF)


def test_the_last_active_store_cannot_be_deactivated(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    ok(_patch(owner, a.second_store_id, status="inactive"), 200)

    refused(_patch(owner, a.store_id, status="inactive", confirm=True), 409, "last_active_store")

    assert _store_row(owner_engine, a.store_id).status == "active"


def test_reactivating_a_store_is_recorded(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    ok(_patch(owner, a.second_store_id, status="inactive"), 200)

    body = ok(_patch(owner, a.second_store_id, status="active"), 200)

    assert body["status"] == "active"
    [entry] = history(owner_engine, a.tenant_id, "store.reactivated")
    assert entry.data == {"before": "inactive", "after": "active"}


@pytest.mark.parametrize("taken", ["name", "whatsapp_number"])
def test_reactivating_checks_name_and_number_again(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, taken: str
) -> None:
    old = ok(_create(owner, name="Pop-up", whatsapp_number=NUMBER), 201)
    ok(_patch(owner, old["id"], status="inactive"), 200)
    clash = {"name": "pop-up"} if taken == "name" else {"name": "Other", "whatsapp_number": NUMBER}
    ok(_create(owner, **clash), 201)

    code = "store_name_in_use" if taken == "name" else "whatsapp_number_in_use"
    refused(_patch(owner, old["id"], status="active"), 409, code)
    assert _store_row(owner_engine, old["id"]).status == "inactive"


def test_an_inactive_store_can_be_renamed_and_reactivated_in_one_edit(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    old = ok(_create(owner, name="Pop-up"), 201)
    ok(_patch(owner, old["id"], status="inactive"), 200)
    ok(_create(owner, name="Pop-up"), 201)

    body = ok(_patch(owner, old["id"], status="active", name="Pop-up 2"), 200)

    assert (body["name"], body["status"]) == ("Pop-up 2", "active")


def test_two_stores_deactivated_at_the_same_moment_never_leave_none_active(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    clients = [
        user_client(a.user_id, a.tenant_id),
        user_client(a.user("manager"), a.tenant_id),
    ]
    stores = [a.store_id, a.second_store_id]
    barrier = threading.Barrier(2)
    results: list[Any] = [None, None]

    def send(index: int) -> None:
        barrier.wait()
        results[index] = _patch(clients[index], stores[index], status="inactive", confirm=True)

    threads = [threading.Thread(target=send, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert sorted(r.status_code for r in results) == [200, 409], [r.get_json() for r in results]
    loser = next(r for r in results if r.status_code == 409)
    assert error(loser) == "last_active_store"
    assert (
        owner_value(
            owner_engine,
            "SELECT count(*) FROM stores WHERE tenant_id = :t AND status = 'active'",
            t=a.tenant_id,
        )
        == 1
    )
