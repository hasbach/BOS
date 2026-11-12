"""T040 — activation links and sign-in (``app.api.auth``, ``app.services.invitations``,
``app.services.accounts``), through real requests checked against the contract."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from argon2 import PasswordHasher
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from app.core.db import engine_of
from app.core.security import new_token
from app.core.sessions import USER_COOKIE
from app.core.tenancy import tenant_transaction
from app.errors import ApiError
from app.services import invitations
from tests.dbsupport import TwoTenants, World, insert
from tests.integration.us1_support import (
    CSRF,
    PASSWORD,
    app_for,
    cookie,
    history,
    ok,
    owner_rows,
    owner_sql,
    owner_value,
    refused,
    set_password,
    shared_app_fixture,
    with_valid_phones,
)

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]

INVALID = {"error": {"code": "invalid_credentials", "message": "Invalid credentials", "fields": {}}}


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants, owner_engine: Engine) -> TwoTenants:
    return with_valid_phones(owner_engine, fresh_staffed_tenants)


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


def _invite(
    owner: Engine,
    world: World,
    *,
    email: str | None = "new.person@example.test",
    phone: str | None = None,
    roles: tuple[str, ...] = ("sales",),
    all_stores: bool = False,
    store_ids: list[uuid.UUID] | None = None,
    status: str = "pending",
    expires_in: timedelta = timedelta(days=7),
    kind: str = "employee",
) -> tuple[str, uuid.UUID]:
    token, hashed = new_token()
    invitation_id = uuid.uuid4()
    with owner.begin() as conn:
        insert(
            conn,
            "invitations",
            id=invitation_id,
            tenant_id=world.tenant_id,
            kind=kind,
            invitee_name="New Person",
            invitee_email=email,
            invitee_phone_e164=phone,
            roles=list(roles),
            all_stores=all_stores,
            store_ids=store_ids if store_ids is not None else [world.store_id],
            token_hash=hashed,
            status=status,
            expires_at=datetime.now(UTC) + expires_in,
            created_by_user_id=world.user_id,
        )
    return token, invitation_id


def _pending_business(owner: Engine, operator_id: uuid.UUID) -> tuple[str, uuid.UUID]:
    """A business set up by an operator whose owner has not activated yet."""
    tenant_id, store_id = uuid.uuid4(), uuid.uuid4()
    token, hashed = new_token()
    with owner.begin() as conn:
        insert(
            conn,
            "tenants",
            id=tenant_id,
            name="Pending Shop",
            edition="commerce",
            status="pending",
            usd_lbp_rate="89500",
            created_by_operator_id=operator_id,
        )
        insert(conn, "stores", id=store_id, tenant_id=tenant_id, name="First Store")
        insert(
            conn,
            "invitations",
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            kind="owner_activation",
            invitee_name="Pending Owner",
            invitee_phone_e164="+96171222333",
            roles=["owner"],
            all_stores=True,
            token_hash=hashed,
            created_by_operator_id=operator_id,
        )
    return token, tenant_id


def _post(app: Flask, path: str, body: dict[str, Any], client: FlaskClient | None = None) -> Any:
    return (client or app.test_client()).post(f"/api/v1{path}", json=body, headers=CSRF)


def _accept(app: Flask, token: str, client: FlaskClient | None = None, **extra: Any) -> Any:
    body = {"token": token, "password": PASSWORD, "locale": "ar", **extra}
    return _post(app, "/invitations/accept", body, client)


def _sign_in(
    app: Flask, identifier: str, password: str = PASSWORD, client: FlaskClient | None = None
) -> Any:
    return _post(app, "/auth/sign-in", {"identifier": identifier, "password": password}, client)


# ---- preview ------------------------------------------------------------------------------------


def test_preview_shows_only_what_the_inviter_entered(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _invite(owner_engine, worlds.a, roles=("sales", "packing"))

    body = ok(_post(app, "/invitations/preview", {"token": token}))

    assert set(body) == {"kind", "business_name", "invitee_name", "roles", "expires_at"}
    assert body["kind"] == "employee"
    assert body["business_name"] == "Tenant a"
    assert body["invitee_name"] == "New Person"
    assert body["roles"] == ["sales", "packing"]


def test_preview_of_an_owner_activation(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _pending_business(owner_engine, worlds.operator_id)

    body = ok(_post(app, "/invitations/preview", {"token": token}))

    assert (body["kind"], body["business_name"], body["roles"]) == (
        "owner_activation",
        "Pending Shop",
        ["owner"],
    )


@pytest.mark.parametrize("token", ["", "unknown-token", None, 42])
def test_preview_of_an_unknown_or_malformed_token_is_link_invalid(app: Flask, token: Any) -> None:
    refused(_post(app, "/invitations/preview", {"token": token}), 410, "link_invalid")


def test_the_token_is_only_accepted_in_the_body(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _invite(owner_engine, worlds.a)

    response = app.test_client().post(f"/api/v1/invitations/preview?token={token}", headers=CSRF)

    assert response.status_code == 410


# ---- accept -------------------------------------------------------------------------------------


def test_owner_activation_creates_the_owner_activates_the_business_and_signs_in(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, tenant_id = _pending_business(owner_engine, worlds.operator_id)
    client = app.test_client()

    me = ok(_accept(app, token, client))

    assert me["user"]["name"] == "Pending Owner"
    assert me["user"]["phone"] == "+96171222333"
    assert me["user"]["email"] is None
    assert me["user"]["locale"] == "ar"
    assert me["user"]["roles"] == ["owner"]
    assert me["business"] == {"id": str(tenant_id), "name": "Pending Shop", "edition": "commerce"}
    assert me["all_stores"] is True
    assert [s["name"] for s in me["stores"]] == ["First Store"]
    assert me["start_tab"] == "sales"
    assert (
        owner_value(owner_engine, "SELECT status FROM tenants WHERE id = :t", t=tenant_id)
        == "active"
    )
    [user] = owner_rows(
        owner_engine,
        "SELECT id, roles, all_stores, status, locale FROM users WHERE tenant_id = :t",
        t=tenant_id,
    )
    assert (user.roles, user.all_stores, user.status, user.locale) == (
        ["owner"],
        True,
        "active",
        "ar",
    )
    [invitation] = owner_rows(
        owner_engine,
        "SELECT status, accepted_user_id, accepted_at FROM invitations WHERE tenant_id = :t",
        t=tenant_id,
    )
    assert (invitation.status, invitation.accepted_user_id) == ("accepted", user.id)
    assert invitation.accepted_at is not None
    # Signed in: the cookie works for the next request.
    assert cookie(client, USER_COOKIE)
    assert ok(client.get("/api/v1/me"))["user"]["id"] == str(user.id)
    entries = [(e.event, e.actor_type, e.actor_id) for e in history(owner_engine, tenant_id)]
    assert ("invitation.accepted", "user", user.id) in entries
    assert ("auth.sign_in", "user", user.id) in entries


def test_employee_acceptance_gets_exactly_the_invited_roles_and_stores(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    token, _ = _invite(owner_engine, a, roles=("sales", "packing"), store_ids=[a.second_store_id])

    me = ok(_accept(app, token, locale="en"))

    assert sorted(me["user"]["roles"]) == ["packing", "sales"]
    assert me["user"]["email"] == "new.person@example.test"
    assert me["all_stores"] is False
    assert [s["id"] for s in me["stores"]] == [str(a.second_store_id)]
    assert me["start_tab"] == "sales"
    assert "store.manage" not in me["permissions"]
    user_id = uuid.UUID(me["user"]["id"])
    stores = owner_rows(
        owner_engine, "SELECT store_id, tenant_id FROM user_stores WHERE user_id = :u", u=user_id
    )
    assert [(s.store_id, s.tenant_id) for s in stores] == [(a.second_store_id, a.tenant_id)]


def test_stores_are_checked_again_when_the_invitation_is_accepted(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    token, _ = _invite(
        owner_engine, a, store_ids=[a.store_id, a.second_store_id, worlds.b.store_id]
    )
    owner_sql(
        owner_engine, "UPDATE stores SET status = 'inactive' WHERE id = :s", s=a.second_store_id
    )

    me = ok(_accept(app, token))

    assert [s["id"] for s in me["stores"]] == [str(a.store_id)]


def test_invitation_whose_stores_are_all_gone_cannot_be_accepted(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    token, _ = _invite(owner_engine, a, store_ids=[a.second_store_id])
    owner_sql(
        owner_engine, "UPDATE stores SET status = 'inactive' WHERE id = :s", s=a.second_store_id
    )

    refused(_accept(app, token), 410, "link_invalid")

    assert (
        owner_value(
            owner_engine, "SELECT count(*) FROM users WHERE email = 'new.person@example.test'"
        )
        == 0
    )


def test_second_acceptance_is_already_used_and_creates_nothing(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, tenant_id = _pending_business(owner_engine, worlds.operator_id)
    ok(_accept(app, token))

    again = _accept(app, token)
    preview = _post(app, "/invitations/preview", {"token": token})

    refused(again, 410, "link_already_used")
    refused(preview, 410, "link_already_used")
    assert (
        owner_value(owner_engine, "SELECT count(*) FROM users WHERE tenant_id = :t", t=tenant_id)
        == 1
    )


@pytest.mark.parametrize("state", ["expired_by_time", "marked_expired", "revoked"])
def test_closed_invitation_is_link_invalid_and_creates_nothing(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, state: str
) -> None:
    status = {"marked_expired": "expired", "revoked": "revoked"}.get(state, "pending")
    expires = timedelta(seconds=-1) if state != "revoked" else timedelta(days=1)
    token, invitation_id = _invite(owner_engine, worlds.a, status=status, expires_in=expires)

    refused(_post(app, "/invitations/preview", {"token": token}), 410, "link_invalid")
    refused(_accept(app, token), 410, "link_invalid")

    assert (
        owner_value(
            owner_engine, "SELECT count(*) FROM users WHERE email = 'new.person@example.test'"
        )
        == 0
    )
    expected = "revoked" if state == "revoked" else "expired"
    assert (
        owner_value(owner_engine, "SELECT status FROM invitations WHERE id = :i", i=invitation_id)
        == expected
    )


def test_weak_password_is_refused_and_the_link_stays_usable(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _invite(owner_engine, worlds.a)

    refused(_accept(app, token, password="short"), 400, "weak_password")
    refused(_accept(app, token, password="password123"), 400, "weak_password")

    ok(_accept(app, token))


def test_identifier_used_by_another_bos_user_is_refused_neutrally(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    by_email, email_invitation = _invite(owner_engine, worlds.a, email=worlds.b.email)
    by_phone, _ = _invite(owner_engine, worlds.a, email=None, phone=worlds.b.phone)

    first = refused(_accept(app, by_email), 409, "identifier_unavailable")
    second = refused(_accept(app, by_phone), 409, "identifier_unavailable")

    assert first == second
    assert "Tenant b" not in str(first)
    assert (
        owner_value(
            owner_engine, "SELECT status FROM invitations WHERE id = :i", i=email_invitation
        )
        == "pending"
    )
    assert (
        owner_value(
            owner_engine, "SELECT count(*) FROM users WHERE tenant_id = :t", t=worlds.a.tenant_id
        )
        == 6
    )


def test_invitation_of_a_suspended_business_cannot_be_accepted(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _invite(owner_engine, worlds.a)
    owner_sql(
        owner_engine, "UPDATE tenants SET status = 'suspended' WHERE id = :t", t=worlds.a.tenant_id
    )

    response = _accept(app, token)

    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "business_suspended"
    assert (
        owner_value(
            owner_engine, "SELECT count(*) FROM users WHERE email = 'new.person@example.test'"
        )
        == 0
    )


def test_invalid_locale_is_refused(app: Flask, owner_engine: Engine, worlds: TwoTenants) -> None:
    token, _ = _invite(owner_engine, worlds.a)

    response = refused(_accept(app, token, locale="fr"), 400, "validation_failed")

    assert response["error"]["fields"] == {"locale": "invalid"}


# ---- the invitations service (used by the staff API in User Story 2) --------------------------


def test_invitation_service_refuses_a_member_of_the_same_business(
    app: Flask, worlds: TwoTenants
) -> None:
    a = worlds.a
    with app.app_context(), tenant_transaction(engine_of(app), a.tenant_id) as db:
        with pytest.raises(ApiError) as same_user:
            invitations.create_employee_invitation(
                db,
                tenant_id=a.tenant_id,
                created_by_user_id=a.user_id,
                name="X",
                phone=None,
                email=a.email,
                roles=["sales"],
                all_stores=True,
                store_ids=[],
            )
        with pytest.raises(ApiError) as pending:
            invitations.create_employee_invitation(
                db,
                tenant_id=a.tenant_id,
                created_by_user_id=a.user_id,
                name="X",
                phone=None,
                email="invitee-a@example.test",
                roles=["sales"],
                all_stores=True,
                store_ids=[],
            )
        with pytest.raises(ApiError) as no_store:
            invitations.create_employee_invitation(
                db,
                tenant_id=a.tenant_id,
                created_by_user_id=a.user_id,
                name="X",
                phone=None,
                email="z@example.test",
                roles=["sales"],
                all_stores=False,
                store_ids=[worlds.b.store_id],
            )

    assert (same_user.value.status, same_user.value.code) == (409, "already_member")
    assert (pending.value.status, pending.value.code) == (409, "already_member")
    # Another business's store is refused exactly like a made-up one.
    assert (no_store.value.status, no_store.value.fields) == (400, {"store_ids": "invalid"})


def test_invitation_service_creates_resends_and_revokes(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    with app.app_context(), tenant_transaction(engine_of(app), a.tenant_id) as db:
        # Someone using another business's identifier is invited without any warning.
        invitation_id, first = invitations.create_employee_invitation(
            db,
            tenant_id=a.tenant_id,
            created_by_user_id=a.user_id,
            name="Other",
            phone=None,
            email=worlds.b.email,
            roles=["manager"],
            all_stores=False,
            store_ids=[],
        )
        new_id, second = invitations.resend(
            db, a.tenant_id, invitation_id, actor_type="user", actor_id=a.user_id
        )
        invitations.revoke(db, a.tenant_id, new_id, actor_type="user", actor_id=a.user_id)
        with pytest.raises(ApiError) as closed:
            invitations.revoke(db, a.tenant_id, new_id, actor_type="user", actor_id=a.user_id)

    assert closed.value.code == "invitation_closed"
    rows = owner_rows(
        owner_engine,
        "SELECT id, status, all_stores FROM invitations WHERE id IN (:i, :j)",
        i=invitation_id,
        j=new_id,
    )
    assert {(r.id, r.status, r.all_stores) for r in rows} == {
        (invitation_id, "revoked", True),  # managers always get every store
        (new_id, "revoked", True),
    }
    assert first.token != second.token
    assert [
        e.event for e in history(owner_engine, a.tenant_id) if e.event.startswith("invitation.")
    ] == [
        "invitation.created",
        "invitation.resent",
        "invitation.revoked",
    ]


# ---- sign-in ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "typed",
    [
        "{local}",
        "0{local}",
        "+961{local}",
        "00961{local}",
        "+961 {spaced}",
        "{email}",
        "{email_upper}",
    ],
)
def test_sign_in_by_phone_in_any_common_format_or_by_email(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, typed: str
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    local = a.phone.removeprefix("+961")
    identifier = typed.format(
        local=local,
        spaced=f"{local[:2]} {local[2:5]} {local[5:]}",
        email=a.email,
        email_upper=f"  {a.email.upper()} ",
    )
    client = app.test_client()

    me = ok(_sign_in(app, identifier, client=client))

    assert me["user"]["id"] == str(a.user_id)
    assert me["business"]["id"] == str(a.tenant_id)
    assert cookie(client, USER_COOKIE)
    assert ok(client.get("/api/v1/me"))["user"]["id"] == str(a.user_id)
    [entry] = history(owner_engine, a.tenant_id, "auth.sign_in")[-1:]
    assert (entry.actor_type, entry.actor_id, entry.target_id) == ("user", a.user_id, a.user_id)
    assert str(entry.ip) == "127.0.0.1"


def test_sign_in_answers_in_the_users_saved_language(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    user = worlds.a.user("sales_limited")
    set_password(owner_engine, user)

    me = ok(_sign_in(app, "sales-limited-a@example.test"))

    assert me["user"]["locale"] == "ar"
    assert me["all_stores"] is False
    assert [s["id"] for s in me["stores"]] == [str(worlds.a.store_id)]


@pytest.mark.parametrize(
    "case", ["wrong_password", "unknown", "inactive_user", "malformed", "locked"]
)
def test_every_kind_of_failed_sign_in_gets_the_identical_answer(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, case: str
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    identifier, password = a.email, PASSWORD
    if case == "wrong_password":
        password = "Wrong-Password-1"
    elif case == "unknown":
        identifier = "nobody@example.test"
    elif case == "inactive_user":
        owner_sql(owner_engine, "UPDATE users SET status = 'inactive' WHERE id = :u", u=a.user_id)
    elif case == "malformed":
        identifier = "not a phone"
    else:
        for _ in range(5):
            _sign_in(app, a.email, "Wrong-Password-1")
    client = app.test_client()

    response = _sign_in(app, identifier, password, client)

    refused(response, 401, "invalid_credentials")
    assert response.get_json() == INVALID
    assert cookie(client, USER_COOKIE) is None


def test_five_failures_lock_the_identifier_even_for_the_right_password(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    for _ in range(4):
        refused(_sign_in(app, a.email, "Wrong-Password-1"), 401, "invalid_credentials")
    ok(_sign_in(app, a.email))  # four failures: not yet locked
    refused(_sign_in(app, a.email, "Wrong-Password-1"), 401, "invalid_credentials")

    refused(_sign_in(app, a.email), 401, "invalid_credentials")
    # The lock is per identifier: another user is not affected.
    set_password(owner_engine, worlds.b.user_id)
    ok(_sign_in(app, worlds.b.email))
    # A refused-while-locked attempt is not counted again.
    assert owner_value(owner_engine, "SELECT count(*) FROM login_attempts WHERE NOT success") == 5


def test_lock_expires_after_fifteen_minutes(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    for _ in range(5):
        _sign_in(app, a.email, "Wrong-Password-1")
    owner_sql(owner_engine, "UPDATE login_attempts SET at = at - interval '16 minutes'")

    ok(_sign_in(app, a.email))


@pytest.mark.parametrize(
    ("status", "code"), [("suspended", "business_suspended"), ("pending", "business_pending")]
)
def test_business_that_is_not_active_is_reported_only_after_correct_credentials(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, status: str, code: str
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    owner_sql(owner_engine, "UPDATE tenants SET status = :s WHERE id = :t", s=status, t=a.tenant_id)
    client = app.test_client()

    wrong = _sign_in(app, a.email, "Wrong-Password-1")
    right = _sign_in(app, a.email, client=client)

    assert wrong.get_json() == INVALID
    refused(right, 403, code)
    assert cookie(client, USER_COOKIE) is None
    assert owner_value(owner_engine, "SELECT count(*) FROM sessions") == 0


def test_failed_sign_in_attribution(app: Flask, owner_engine: Engine, worlds: TwoTenants) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)

    _sign_in(app, a.email, "Wrong-Password-1")
    _sign_in(app, "stranger@example.test", "Wrong-Password-1")

    [known] = history(owner_engine, a.tenant_id, "auth.sign_in_failed")
    assert (known.actor_type, known.actor_id) == ("anonymous", None)
    assert (known.target_type, known.target_id) == ("user", a.user_id)
    assert "Wrong-Password" not in str(known.data)
    [unknown] = history(owner_engine, None, "auth.sign_in_failed")
    assert (unknown.tenant_id, unknown.actor_type) == (None, "anonymous")
    assert "stranger" not in str(unknown.data)
    assert history(owner_engine, worlds.b.tenant_id, "auth.sign_in_failed") == []


def test_sign_in_upgrades_an_outdated_password_hash(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    old = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1).hash(PASSWORD)
    owner_sql(owner_engine, "UPDATE users SET password_hash = :h WHERE id = :u", h=old, u=a.user_id)

    ok(_sign_in(app, a.email))

    new = owner_value(owner_engine, "SELECT password_hash FROM users WHERE id = :u", u=a.user_id)
    assert new != old
    ok(_sign_in(app, a.email))


def test_sign_in_with_missing_fields_is_a_validation_error(app: Flask) -> None:
    response = _post(app, "/auth/sign-in", {"identifier": "x"})

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_failed"


# ---- sign-out ---------------------------------------------------------------------------------


def test_sign_out_ends_the_session_and_is_recorded(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    client = app.test_client()
    ok(_sign_in(app, a.email, client=client))

    response = client.post("/api/v1/auth/sign-out", headers=CSRF)

    ok(response, 204)
    assert cookie(client, USER_COOKIE) is None
    assert client.get("/api/v1/me").status_code == 401
    assert owner_value(owner_engine, "SELECT count(*) FROM sessions WHERE revoked_at IS NULL") == 0
    [entry] = history(owner_engine, a.tenant_id, "auth.sign_out")
    assert (entry.actor_type, entry.actor_id) == ("user", a.user_id)


def test_a_user_of_a_suspended_business_can_still_sign_out(
    app: Flask, owner_engine: Engine, user_client: UserClient, worlds: TwoTenants
) -> None:
    a = worlds.a
    client = user_client(a.user_id, a.tenant_id)
    owner_sql(owner_engine, "UPDATE tenants SET status = 'suspended' WHERE id = :t", t=a.tenant_id)

    ok(client.post("/api/v1/auth/sign-out", headers=CSRF), 204)

    assert owner_value(owner_engine, "SELECT count(*) FROM sessions WHERE revoked_at IS NULL") == 0
    assert len(history(owner_engine, a.tenant_id, "auth.sign_out")) == 1


def test_sign_out_without_a_session_still_succeeds(app: Flask) -> None:
    ok(app.test_client().post("/api/v1/auth/sign-out", headers=CSRF), 204)


def test_sign_out_needs_the_csrf_header(user_client: UserClient, worlds: TwoTenants) -> None:
    client = user_client(worlds.a.user_id, worlds.a.tenant_id)

    assert client.post("/api/v1/auth/sign-out").status_code == 403
    assert client.get("/api/v1/me").status_code == 200
