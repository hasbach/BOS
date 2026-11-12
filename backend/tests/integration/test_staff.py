"""T055 — the staff API (``app.api.staff``, ``app.services.staff``), User Story 2.

Real requests against the shared application, checked against the contract wherever the
contract documents the answer.
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
from app.core.sessions import USER_COOKIE
from tests.dbsupport import TwoTenants
from tests.integration.us1_support import (
    CSRF,
    NEW_PASSWORD,
    PASSWORD,
    app_for,
    cookie,
    error,
    history,
    ok,
    owner_rows,
    owner_sql,
    owner_value,
    refused,
    set_password,
    shared_app_fixture,
    token_hash,
    token_of,
    with_valid_phones,
)

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]

STAFF = "/api/v1/staff"
INVITE = "/api/v1/staff/invitations"


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants, owner_engine: Engine) -> TwoTenants:
    return with_valid_phones(owner_engine, fresh_staffed_tenants)


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


@pytest.fixture()
def owner(user_client: UserClient, worlds: TwoTenants) -> FlaskClient:
    return user_client(worlds.a.user_id, worlds.a.tenant_id)


def _invite(client: FlaskClient, key: str | None = None, **body: Any) -> Any:
    headers = {**CSRF, **({"Idempotency-Key": key} if key else {})}
    payload = {"name": "Rami Haddad", "roles": ["sales"], **body}
    return client.post(INVITE, json=payload, headers=headers)


def _preview(app: Flask, link: str) -> Any:
    token = token_of(link, "activate")
    return app.test_client().post(
        "/api/v1/invitations/preview", json={"token": token}, headers=CSRF
    )


def _accept(app: Flask, link: str, client: FlaskClient | None = None) -> Any:
    token = token_of(link, "activate")
    return (client or app.test_client()).post(
        "/api/v1/invitations/accept",
        json={"token": token, "password": PASSWORD, "locale": "en"},
        headers=CSRF,
    )


def _patch(client: FlaskClient, user_id: uuid.UUID, **body: Any) -> Any:
    return client.patch(f"{STAFF}/{user_id}", json=body, headers=CSRF)


def _invitation(owner: Engine, invitation_id: str | uuid.UUID) -> Any:
    [row] = owner_rows(
        owner,
        "SELECT id, tenant_id, kind, invitee_name, invitee_phone_e164, invitee_email, roles, "
        "all_stores, store_ids, status, token_hash, created_by_user_id "
        "FROM invitations WHERE id = :i",
        i=invitation_id,
    )
    return row


def _member(listing: dict[str, Any], user_id: uuid.UUID) -> dict[str, Any]:
    [found] = [m for m in listing["members"] if m["user_id"] == str(user_id)]
    return found


# ---- inviting ---------------------------------------------------------------------------------


def test_invite_by_email_with_roles_and_stores_returns_the_link_once(
    app: Flask, owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a

    body = ok(
        _invite(
            owner,
            email=" Rami@Example.TEST ",
            roles=["sales", "packing"],
            store_ids=[str(a.store_id)],
        ),
        201,
    )

    invitation = body["invitation"]
    assert invitation["name"] == "Rami Haddad"
    assert invitation["email"] == "rami@example.test"
    assert invitation["phone"] is None
    assert invitation["roles"] == ["sales", "packing"]
    assert invitation["all_stores"] is False
    assert invitation["store_ids"] == [str(a.store_id)]
    assert invitation["status"] == "pending"
    token = token_of(body["link"], "activate")
    row = _invitation(owner_engine, invitation["invitation_id"])
    assert (row.tenant_id, row.kind, row.created_by_user_id) == (a.tenant_id, "employee", a.user_id)
    assert bytes(row.token_hash) == token_hash(token)
    # The link is never shown again: not in the list, not in the history.
    listing = ok(owner.get(STAFF))
    assert token not in str(listing) and "link" not in str(listing)
    [entry] = history(owner_engine, a.tenant_id, "invitation.created")
    assert (entry.actor_id, entry.target_id) == (a.user_id, uuid.UUID(invitation["invitation_id"]))
    assert token not in str(entry.data)
    assert ok(_preview(app, body["link"]))["invitee_name"] == "Rami Haddad"


def test_invite_by_phone_in_a_local_format_is_stored_internationally(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    body = ok(_invite(owner, phone="03 123 456", all_stores=True), 201)

    assert body["invitation"]["phone"] == "+9613123456"
    assert body["invitation"]["all_stores"] is True
    assert body["invitation"]["store_ids"] == []


@pytest.mark.parametrize("role", ["owner", "manager"])
def test_owner_and_manager_invitations_always_get_every_store(
    owner: FlaskClient, worlds: TwoTenants, role: str
) -> None:
    body = ok(
        _invite(
            owner,
            email="boss@example.test",
            roles=[role],
            all_stores=False,
            store_ids=[str(worlds.a.store_id)],
        ),
        201,
    )

    assert body["invitation"]["all_stores"] is True
    assert body["invitation"]["store_ids"] == []


def test_an_employee_with_no_store_and_not_all_stores_is_refused(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    body = refused(
        _invite(owner, email="x@example.test", all_stores=False), 400, "validation_failed"
    )

    assert body["error"]["fields"] == {"store_ids": "required"}
    assert owner_value(owner_engine, "SELECT count(*) FROM invitations") == 2


@pytest.mark.parametrize("which", ["unknown", "other_business", "inactive"])
def test_a_store_outside_this_business_or_inactive_is_refused_without_saying_why(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, which: str
) -> None:
    a = worlds.a
    store = {
        "unknown": uuid.uuid4(),
        "other_business": worlds.b.store_id,
        "inactive": a.second_store_id,
    }[which]
    if which == "inactive":
        owner_sql(owner_engine, "UPDATE stores SET status = 'inactive' WHERE id = :s", s=store)

    body = refused(
        _invite(owner, email="x@example.test", store_ids=[str(a.store_id), str(store)]),
        400,
        "validation_failed",
    )

    assert body == {
        "error": {
            "code": "validation_failed",
            "message": "Some fields are not valid",
            "fields": {"store_ids": "invalid"},
        }
    }
    assert owner_value(owner_engine, "SELECT count(*) FROM invitations") == 2


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"name": ""}, {"name": "required"}),
        ({"name": "x" * 121}, {"name": "too_long"}),
        ({"phone": None, "email": None}, {"phone": "required"}),
        ({"phone": "12"}, {"phone": "invalid_phone"}),
        ({"email": "not-an-email"}, {"email": "invalid_email"}),
        ({"roles": []}, {"roles": "required"}),
        ({"roles": ["sales", "boss"]}, {"roles": "invalid"}),
        ({"roles": "sales"}, {"roles": "invalid"}),
        ({"all_stores": "yes"}, {"all_stores": "invalid"}),
        ({"store_ids": ["not-a-uuid"]}, {"store_ids": "invalid"}),
    ],
)
def test_invalid_invitations_name_each_field(
    owner: FlaskClient, worlds: TwoTenants, body: dict[str, Any], fields: dict[str, str]
) -> None:
    payload = {"email": "x@example.test", "all_stores": True, **body}

    response = refused(_invite(owner, **payload), 400, "validation_failed")

    assert response["error"]["fields"] == fields


@pytest.mark.parametrize("who", ["member_email", "member_phone_local_format", "pending_invitation"])
def test_an_identifier_already_in_this_business_is_refused(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, who: str
) -> None:
    a = worlds.a
    identifier = {
        "member_email": {"email": "SALES-a@example.test"},
        "member_phone_local_format": {"phone": "0" + a.phone.removeprefix("+961")},
        "pending_invitation": {"email": "invitee-a@example.test"},
    }[who]

    refused(_invite(owner, all_stores=True, **identifier), 409, "already_member")

    assert owner_value(owner_engine, "SELECT count(*) FROM invitations") == 2


def test_an_expired_invitation_does_not_block_a_new_one(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    owner_sql(
        owner_engine,
        "UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = :i",
        i=worlds.a.invitation_id,
    )

    ok(_invite(owner, email="invitee-a@example.test", all_stores=True), 201)

    assert _invitation(owner_engine, worlds.a.invitation_id).status == "expired"


def test_an_identifier_of_another_business_is_invited_silently_and_refused_at_acceptance(
    app: Flask, owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    b = worlds.b

    body = ok(_invite(owner, email=b.email, all_stores=True), 201)
    body_by_phone = ok(_invite(owner, phone=b.phone, email=None, all_stores=True), 201)

    assert set(body) == {"link", "expires_at", "invitation"}  # no hint of any kind
    for link in (body["link"], body_by_phone["link"]):
        refused(_accept(app, link), 409, "identifier_unavailable")
    assert (
        owner_value(
            owner_engine, "SELECT count(*) FROM users WHERE tenant_id = :t", t=worlds.a.tenant_id
        )
        == 6
    )
    assert _invitation(owner_engine, body["invitation"]["invitation_id"]).status == "pending"


def test_an_accepted_invitation_creates_exactly_the_chosen_employee(
    app: Flask, owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    body = ok(
        _invite(
            owner,
            email="rami@example.test",
            roles=["sales", "dispatch"],
            store_ids=[str(a.second_store_id)],
        ),
        201,
    )
    employee = app.test_client()

    me = ok(_accept(app, body["link"], employee))

    assert me["business"]["id"] == str(a.tenant_id)
    assert me["user"]["roles"] == ["sales", "dispatch"]
    assert me["all_stores"] is False
    assert [s["id"] for s in me["stores"]] == [str(a.second_store_id)]
    member = _member(ok(owner.get(STAFF)), uuid.UUID(me["user"]["id"]))
    assert member["store_ids"] == [str(a.second_store_id)]
    assert member["status"] == "active"
    refused(_accept(app, body["link"]), 410, "link_already_used")


# ---- idempotent invitation ---------------------------------------------------------------------


def test_a_repeat_with_the_same_key_returns_the_same_invitation_with_a_fresh_link(
    app: Flask, owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    first = ok(_invite(owner, key="invite-1", email="rami@example.test", all_stores=True), 201)
    second = ok(_invite(owner, key="invite-1", email="rami@example.test", all_stores=True), 201)

    assert second["invitation"] == first["invitation"]
    assert second["link"] != first["link"]
    refused(_preview(app, first["link"]), 410, "link_invalid")
    ok(_preview(app, second["link"]))
    rows = owner_rows(
        owner_engine, "SELECT id FROM invitations WHERE invitee_email = 'rami@example.test'"
    )
    assert [str(r.id) for r in rows] == [first["invitation"]["invitation_id"]]
    assert [
        e.event
        for e in history(owner_engine, worlds.a.tenant_id)
        if e.event.startswith("invitation.")
    ] == ["invitation.created", "invitation.resent"]


def test_the_same_key_with_a_different_body_is_a_conflict(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    ok(_invite(owner, key="invite-2", email="rami@example.test", all_stores=True), 201)

    response = _invite(owner, key="invite-2", email="other@example.test", all_stores=True)

    assert response.status_code == 409
    assert error(response) == "idempotency_conflict"
    assert (
        owner_value(
            owner_engine,
            "SELECT count(*) FROM invitations WHERE invitee_email = 'other@example.test'",
        )
        == 0
    )


def test_replaying_an_invitation_that_was_since_revoked_is_closed(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    first = ok(_invite(owner, key="invite-3", email="rami@example.test", all_stores=True), 201)
    invitation_id = first["invitation"]["invitation_id"]
    assert owner.delete(f"{INVITE}/{invitation_id}", headers=CSRF).status_code == 204

    refused(
        _invite(owner, key="invite-3", email="rami@example.test", all_stores=True),
        409,
        "invitation_closed",
    )


# ---- resend and revoke -------------------------------------------------------------------------


def test_resending_a_pending_invitation_replaces_its_link(
    app: Flask, owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    first = ok(_invite(owner, email="rami@example.test", store_ids=[str(worlds.a.store_id)]), 201)
    old_id = first["invitation"]["invitation_id"]

    second = ok(owner.post(f"{INVITE}/{old_id}/resend", headers=CSRF), 201)

    new = second["invitation"]
    assert new["invitation_id"] != old_id
    assert {k: v for k, v in new.items() if k not in ("invitation_id", "expires_at")} == {
        k: v for k, v in first["invitation"].items() if k not in ("invitation_id", "expires_at")
    }
    assert _invitation(owner_engine, old_id).status == "revoked"
    refused(_preview(app, first["link"]), 410, "link_invalid")
    ok(_preview(app, second["link"]))
    pending = [
        i["invitation_id"]
        for i in ok(owner.get(STAFF))["invitations"]
        if i["email"] == "rami@example.test"
    ]
    assert pending == [new["invitation_id"]]
    [entry] = history(owner_engine, worlds.a.tenant_id, "invitation.resent")
    assert entry.data["previous_invitation_id"] == old_id


def test_an_expired_invitation_is_listed_as_expired_and_can_be_resent(
    app: Flask, owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    owner_sql(
        owner_engine,
        "UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = :i",
        i=a.invitation_id,
    )

    listed = ok(owner.get(STAFF))["invitations"]
    resent = ok(owner.post(f"{INVITE}/{a.invitation_id}/resend", headers=CSRF), 201)

    assert [(i["invitation_id"], i["status"]) for i in listed] == [
        (str(a.invitation_id), "expired")
    ]
    assert resent["invitation"]["status"] == "pending"
    assert _invitation(owner_engine, a.invitation_id).status == "expired"  # terminal
    ok(_preview(app, resent["link"]))


def test_resending_an_expired_invitation_whose_person_joined_meanwhile_is_refused(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    owner_sql(
        owner_engine,
        "UPDATE invitations SET expires_at = now() - interval '1 minute', "
        "invitee_email = 'sales-a@example.test' WHERE id = :i",
        i=a.invitation_id,
    )

    refused(owner.post(f"{INVITE}/{a.invitation_id}/resend", headers=CSRF), 409, "already_member")


def test_revoking_a_pending_invitation_kills_its_link(
    app: Flask, owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    body = ok(_invite(owner, email="rami@example.test", all_stores=True), 201)
    invitation_id = body["invitation"]["invitation_id"]

    response = owner.delete(f"{INVITE}/{invitation_id}", headers=CSRF)

    assert response.status_code == 204
    refused(_preview(app, body["link"]), 410, "link_invalid")
    assert invitation_id not in str(ok(owner.get(STAFF)))
    [entry] = history(owner_engine, worlds.a.tenant_id, "invitation.revoked")
    assert (entry.actor_id, str(entry.target_id)) == (worlds.a.user_id, invitation_id)


@pytest.mark.parametrize("state", ["accepted", "revoked"])
def test_resend_and_revoke_of_a_closed_invitation_are_refused(
    app: Flask, owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, state: str
) -> None:
    body = ok(_invite(owner, email="rami@example.test", all_stores=True), 201)
    invitation_id = body["invitation"]["invitation_id"]
    if state == "accepted":
        ok(_accept(app, body["link"]))
    else:
        assert owner.delete(f"{INVITE}/{invitation_id}", headers=CSRF).status_code == 204

    refused(owner.post(f"{INVITE}/{invitation_id}/resend", headers=CSRF), 409, "invitation_closed")
    refused(owner.delete(f"{INVITE}/{invitation_id}", headers=CSRF), 409, "invitation_closed")

    assert _invitation(owner_engine, invitation_id).status == state


def test_revoking_an_expired_invitation_is_refused(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    owner_sql(
        owner_engine,
        "UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = :i",
        i=worlds.a.invitation_id,
    )

    refused(
        owner.delete(f"{INVITE}/{worlds.a.invitation_id}", headers=CSRF), 409, "invitation_closed"
    )


def test_an_owner_activation_is_not_a_staff_invitation(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    owner_sql(
        owner_engine,
        "UPDATE invitations SET kind = 'owner_activation', roles = '{owner}', status = 'expired' "
        "WHERE id = :i",
        i=a.invitation_id,
    )

    assert ok(owner.get(STAFF))["invitations"] == []
    assert owner.post(f"{INVITE}/{a.invitation_id}/resend", headers=CSRF).status_code == 404
    assert owner.delete(f"{INVITE}/{a.invitation_id}", headers=CSRF).status_code == 404


def test_a_simultaneous_accept_and_revoke_leave_exactly_one_outcome(
    app: Flask, user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    body = ok(
        _invite(user_client(a.user_id, a.tenant_id), email="rami@example.test", all_stores=True),
        201,
    )
    invitation_id = body["invitation"]["invitation_id"]
    clients = [app.test_client(), user_client(a.user_id, a.tenant_id)]
    barrier = threading.Barrier(2)
    results: list[Any] = [None, None]

    def accept() -> None:
        barrier.wait()
        results[0] = _accept(app, body["link"], clients[0])

    def revoke() -> None:
        barrier.wait()
        results[1] = clients[1].delete(f"{INVITE}/{invitation_id}", headers=CSRF)

    threads = [threading.Thread(target=accept), threading.Thread(target=revoke)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    accepted, revoked = results
    users = owner_value(
        owner_engine, "SELECT count(*) FROM users WHERE email = 'rami@example.test'"
    )
    status = _invitation(owner_engine, invitation_id).status
    if accepted.status_code == 200:
        assert (revoked.status_code, error(revoked)) == (409, "invitation_closed")
        assert (users, status) == (1, "accepted")
    else:
        assert (accepted.status_code, error(accepted)) == (410, "link_invalid")
        assert revoked.status_code == 204
        assert (users, status) == (0, "revoked")


# ---- the staff list ----------------------------------------------------------------------------


def test_the_staff_list_shows_members_and_open_invitations_of_this_business_only(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a, b = worlds.a, worlds.b
    ok(_invite(owner, email="rami@example.test", store_ids=[str(a.second_store_id)]), 201)
    revoked = ok(_invite(owner, email="gone@example.test", all_stores=True), 201)
    owner.delete(f"{INVITE}/{revoked['invitation']['invitation_id']}", headers=CSRF)
    owner_sql(
        owner_engine, "UPDATE users SET status = 'inactive' WHERE id = :u", u=a.user("dispatch")
    )

    listing = ok(owner.get(STAFF))

    assert {m["user_id"] for m in listing["members"]} == {str(u) for u in a.users.values()}
    assert _member(listing, a.user_id) == {
        "user_id": str(a.user_id),
        "name": "Owner a",
        "phone": a.phone,
        "email": a.email,
        "roles": ["owner"],
        "all_stores": True,
        "store_ids": [],
        "status": "active",
    }
    limited = _member(listing, a.user("sales_limited"))
    assert (limited["all_stores"], limited["store_ids"]) == (False, [str(a.store_id)])
    assert _member(listing, a.user("dispatch"))["status"] == "inactive"
    assert sorted(i["email"] for i in listing["invitations"]) == [
        "invitee-a@example.test",
        "rami@example.test",
    ]
    assert str(b.tenant_id) not in str(listing) and "-b@example.test" not in str(listing)


def test_a_manager_sees_and_manages_staff_too(user_client: UserClient, worlds: TwoTenants) -> None:
    a = worlds.a
    manager = user_client(a.user("manager"), a.tenant_id)

    ok(manager.get(STAFF))
    ok(_invite(manager, email="rami@example.test", all_stores=True), 201)
    member = ok(_patch(manager, a.user("packing"), roles=["packing", "dispatch"]))

    assert member["roles"] == ["packing", "dispatch"]


# ---- changing an employee ---------------------------------------------------------------------


def test_a_role_change_applies_on_the_employees_next_request(
    owner: FlaskClient, user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    employee = user_client(a.user("sales"), a.tenant_id)
    assert ok(employee.get("/api/v1/me"))["start_tab"] == "sales"

    member = ok(_patch(owner, a.user("sales"), roles=["packing"]))

    assert member["roles"] == ["packing"]
    me = ok(employee.get("/api/v1/me"))
    assert (me["user"]["roles"], me["tabs"], me["start_tab"]) == (
        ["packing"],
        ["packing", "orders", "more"],
        "packing",
    )
    [entry] = history(owner_engine, a.tenant_id, "user.roles_changed")
    assert (entry.actor_id, entry.target_id) == (a.user_id, a.user("sales"))
    assert entry.data == {"before": ["sales"], "after": ["packing"]}


def test_a_store_change_applies_on_the_employees_next_request(
    owner: FlaskClient, user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    user = a.user("sales_limited")
    employee = user_client(user, a.tenant_id)
    assert [s["id"] for s in ok(employee.get("/api/v1/me"))["stores"]] == [str(a.store_id)]

    member = ok(_patch(owner, user, store_ids=[str(a.second_store_id)]))

    assert (member["all_stores"], member["store_ids"]) == (False, [str(a.second_store_id)])
    assert [s["id"] for s in ok(employee.get("/api/v1/me"))["stores"]] == [str(a.second_store_id)]
    ok(_patch(owner, user, all_stores=True))
    assert len(ok(employee.get("/api/v1/me"))["stores"]) == 2
    entries = history(owner_engine, a.tenant_id, "user.stores_changed")
    assert [e.data for e in entries] == [
        {
            "before": {"all_stores": False, "store_ids": [str(a.store_id)]},
            "after": {"all_stores": False, "store_ids": [str(a.second_store_id)]},
        },
        {
            "before": {"all_stores": False, "store_ids": [str(a.second_store_id)]},
            "after": {"all_stores": True, "store_ids": []},
        },
    ]


def test_promoting_to_manager_gives_every_store(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a

    member = ok(_patch(owner, a.user("sales_limited"), roles=["manager"], all_stores=False))

    assert (member["all_stores"], member["store_ids"]) == (True, [])
    assert (
        owner_value(
            owner_engine,
            "SELECT count(*) FROM user_stores WHERE user_id = :u",
            u=a.user("sales_limited"),
        )
        == 0
    )


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"roles": []}, {"roles": "required"}),
        ({"roles": ["chief"]}, {"roles": "invalid"}),
        ({"status": "gone"}, {"status": "invalid"}),
        ({"all_stores": 1}, {"all_stores": "invalid"}),
        ({"store_ids": "x"}, {"store_ids": "invalid"}),
        ({"store_ids": [], "all_stores": False}, {"store_ids": "required"}),
        ({"store_ids": ["{other_store}"]}, {"store_ids": "invalid"}),
    ],
)
def test_invalid_changes_name_each_field(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    body: dict[str, Any],
    fields: dict[str, str],
) -> None:
    a = worlds.a
    payload = {
        k: ([str(worlds.b.store_id)] if v == ["{other_store}"] else v) for k, v in body.items()
    }

    response = _patch(owner, a.user("sales_limited"), **payload)

    # 400 is not (yet) documented for this operation in the contract.
    assert response.status_code == 400
    assert response.get_json()["error"]["fields"] == fields
    assert owner_value(
        owner_engine, "SELECT roles FROM users WHERE id = :u", u=a.user("sales_limited")
    ) == ["sales"]


def test_demoting_a_manager_to_sales_needs_stores_unless_all_stores_is_kept(
    owner: FlaskClient, worlds: TwoTenants
) -> None:
    a = worlds.a

    refused_once = _patch(owner, a.user("manager"), roles=["sales"], all_stores=False)
    member = ok(_patch(owner, a.user("manager"), roles=["sales"]))

    assert refused_once.status_code == 400
    assert refused_once.get_json()["error"]["fields"] == {"store_ids": "required"}
    assert (member["roles"], member["all_stores"]) == (["sales"], True)


def test_an_empty_change_changes_nothing(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    member = ok(_patch(owner, worlds.a.user("sales")))

    assert member["roles"] == ["sales"]
    assert [
        e for e in history(owner_engine, worlds.a.tenant_id) if e.event.startswith("user.")
    ] == []


def test_deactivating_ends_every_session_and_reactivating_lets_them_back(
    app: Flask,
    owner: FlaskClient,
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
) -> None:
    a = worlds.a
    user = a.user("packing")
    phones = [user_client(user, a.tenant_id), user_client(user, a.tenant_id)]
    for phone in phones:
        ok(phone.get("/api/v1/me"))

    member = ok(_patch(owner, user, status="inactive"))

    assert member["status"] == "inactive"
    for phone in phones:
        assert phone.get("/api/v1/me").status_code == 401
    assert (
        owner_value(
            owner_engine,
            "SELECT count(*) FROM sessions WHERE user_id = :u AND revoked_at IS NULL",
            u=user,
        )
        == 0
    )
    [entry] = history(owner_engine, a.tenant_id, "user.deactivated")
    assert entry.data == {"before": "active", "after": "inactive", "sessions_ended": 2}
    set_password(owner_engine, user)
    signed_in = app.test_client().post(
        "/api/v1/auth/sign-in",
        json={"identifier": "packing-a@example.test", "password": PASSWORD},
        headers=CSRF,
    )
    assert signed_in.status_code == 401

    member = ok(_patch(owner, user, status="active"))

    assert member["status"] == "active"
    client = app.test_client()
    ok(
        client.post(
            "/api/v1/auth/sign-in",
            json={"identifier": "packing-a@example.test", "password": PASSWORD},
            headers=CSRF,
        )
    )
    assert cookie(client, USER_COOKIE)
    [entry] = history(owner_engine, a.tenant_id, "user.reactivated")
    assert entry.data == {"before": "inactive", "after": "active"}


# ---- reset links -------------------------------------------------------------------------------


def test_an_owner_issues_a_reset_link_that_works_once_and_ends_the_sessions(
    app: Flask,
    owner: FlaskClient,
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
) -> None:
    a = worlds.a
    user = a.user("dispatch")
    employee = user_client(user, a.tenant_id)
    ok(employee.get("/api/v1/me"))

    first = ok(owner.post(f"{STAFF}/{user}/password-reset", headers=CSRF), 201)
    second = ok(owner.post(f"{STAFF}/{user}/password-reset", headers=CSRF), 201)

    def complete(link: str) -> Any:
        return app.test_client().post(
            "/api/v1/auth/password-reset/complete",
            json={"token": token_of(link, "reset"), "new_password": NEW_PASSWORD},
            headers=CSRF,
        )

    assert complete(first["link"]).status_code == 410  # the newer link replaced it
    assert complete(second["link"]).status_code == 204
    assert complete(second["link"]).status_code == 410
    assert employee.get("/api/v1/me").status_code == 401
    entries = history(owner_engine, a.tenant_id, "auth.password_reset_issued")
    assert [(e.actor_type, e.actor_id, e.target_id) for e in entries] == [
        ("user", a.user_id, user)
    ] * 2
    assert all(first["link"] not in str(e.data) for e in entries)


def test_a_reset_link_for_an_inactive_employee_is_refused(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    owner_sql(
        owner_engine, "UPDATE users SET status = 'inactive' WHERE id = :u", u=a.user("dispatch")
    )

    response = owner.post(f"{STAFF}/{a.user('dispatch')}/password-reset", headers=CSRF)

    assert (response.status_code, error(response)) == (409, "user_inactive")
    assert (
        owner_value(
            owner_engine,
            "SELECT count(*) FROM password_resets WHERE user_id = :u",
            u=a.user("dispatch"),
        )
        == 0
    )


def test_unknown_ids_are_not_found(owner: FlaskClient, worlds: TwoTenants) -> None:
    unknown = uuid.uuid4()

    for response in (
        owner.post(f"{INVITE}/{unknown}/resend", headers=CSRF),
        owner.delete(f"{INVITE}/{unknown}", headers=CSRF),
        _patch(owner, unknown, status="inactive"),
        owner.post(f"{STAFF}/{unknown}/password-reset", headers=CSRF),
    ):
        refused(response, 404, "not_found")
