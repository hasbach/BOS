"""T041 — passwords, sessions and the user's own details (``app.api.me``, ``app.api.auth``,
``app.services.accounts``), through real requests checked against the contract."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from email.message import EmailMessage
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from app.core.security import new_token
from app.core.sessions import USER_COOKIE
from tests.dbsupport import TwoTenants, insert
from tests.integration.us1_support import (
    BASE_URL,
    CSRF,
    NEW_PASSWORD,
    PASSWORD,
    app_for,
    cookie,
    history,
    ok,
    outbox,
    owner_rows,
    owner_sql,
    owner_value,
    refused,
    set_password,
    shared_app_fixture,
    token_of,
    with_valid_phones,
)

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants, owner_engine: Engine) -> TwoTenants:
    return with_valid_phones(owner_engine, fresh_staffed_tenants)


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


def _sign_in(app: Flask, identifier: str, password: str = PASSWORD) -> FlaskClient:
    client = app.test_client()
    response = client.post(
        "/api/v1/auth/sign-in", json={"identifier": identifier, "password": password}, headers=CSRF
    )
    assert response.status_code == 200, response.get_data(as_text=True)
    return client


def _request_reset(app: Flask, email: str) -> Any:
    return app.test_client().post(
        "/api/v1/auth/password-reset/request", json={"email": email}, headers=CSRF
    )


def _complete(app: Flask, token: str, password: str = NEW_PASSWORD) -> Any:
    return app.test_client().post(
        "/api/v1/auth/password-reset/complete",
        json={"token": token, "new_password": password},
        headers=CSRF,
    )


def _link_in(message: EmailMessage) -> str:
    body = message.get_body(("plain",))
    assert body is not None
    words = str(body.get_content()).split()
    [link] = [word for word in words if word.startswith(f"{BASE_URL}/reset#")]
    return link


def _live_sessions(owner: Engine, user_id: uuid.UUID) -> int:
    return int(
        owner_value(
            owner,
            "SELECT count(*) FROM sessions WHERE user_id = :u AND revoked_at IS NULL",
            u=user_id,
        )
    )


def _reset_row(owner: Engine, world_user: uuid.UUID) -> tuple[str, uuid.UUID]:
    token, hashed = new_token()
    reset_id = uuid.uuid4()
    tenant_id = owner_value(owner, "SELECT tenant_id FROM users WHERE id = :u", u=world_user)
    with owner.begin() as conn:
        insert(
            conn,
            "password_resets",
            id=reset_id,
            tenant_id=tenant_id,
            user_id=world_user,
            token_hash=hashed,
        )
    return token, reset_id


# ---- password reset by email --------------------------------------------------------------------


def test_reset_request_emails_a_single_use_link_in_the_users_language(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    user = a.user("sales_limited")  # saved language: Arabic

    ok(_request_reset(app, "Sales-Limited-A@Example.test"), 204)

    [message] = outbox(app).messages
    assert message["To"] == "sales-limited-a@example.test"
    assert "BOS" in message["Subject"]
    body = str(message.get_body(("plain",)).get_content())  # type: ignore[union-attr]
    assert "كلمة المرور" in body
    token = token_of(_link_in(message), "reset")
    [row] = owner_rows(
        owner_engine,
        "SELECT user_id, issued_by_user_id, issued_by_operator_id, used_at FROM password_resets "
        "WHERE tenant_id = :t AND user_id = :u",
        t=a.tenant_id,
        u=user,
    )
    assert (row.issued_by_user_id, row.issued_by_operator_id, row.used_at) == (None, None, None)
    [issued] = history(owner_engine, a.tenant_id, "auth.password_reset_issued")
    assert (issued.target_type, issued.target_id) == ("user", user)
    [sent] = history(owner_engine, a.tenant_id, "email.sent")
    assert sent.data["purpose"] == "password_reset"
    assert token not in str(history(owner_engine, a.tenant_id))


def test_english_user_gets_the_english_email(app: Flask, worlds: TwoTenants) -> None:
    ok(_request_reset(app, worlds.a.email), 204)

    [message] = outbox(app).messages
    body = str(message.get_body(("plain",)).get_content())  # type: ignore[union-attr]
    assert "password" in body.lower()
    assert "1 hour" in body


def test_the_email_is_sent_only_after_the_reset_is_saved(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    seen: list[int] = []
    outbox(app).on_send.append(
        lambda _message: seen.append(
            int(owner_value(owner_engine, "SELECT count(*) FROM password_resets"))
        )
    )

    ok(_request_reset(app, worlds.a.email), 204)

    assert seen == [3]  # the two fixture rows and the new one, already committed


@pytest.mark.parametrize(
    "case", ["unknown", "phone_only_user", "inactive_user", "suspended_business", "malformed"]
)
def test_reset_request_always_answers_204_and_sends_nothing_when_it_should_not(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, case: str
) -> None:
    a = worlds.a
    email = a.email
    if case == "unknown":
        email = "nobody@example.test"
    elif case == "phone_only_user":
        owner_sql(owner_engine, "UPDATE users SET email = NULL WHERE id = :u", u=a.user_id)
    elif case == "inactive_user":
        owner_sql(owner_engine, "UPDATE users SET status = 'inactive' WHERE id = :u", u=a.user_id)
    elif case == "suspended_business":
        owner_sql(
            owner_engine, "UPDATE tenants SET status = 'suspended' WHERE id = :t", t=a.tenant_id
        )
    else:
        email = "not an email"

    ok(_request_reset(app, email), 204)

    assert outbox(app).messages == []
    assert owner_value(owner_engine, "SELECT count(*) FROM password_resets") == 2


def test_reset_requests_are_limited_to_three_per_address_per_hour(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    for _ in range(4):
        ok(_request_reset(app, worlds.a.email), 204)

    assert len(outbox(app).messages) == 3
    owner_sql(owner_engine, "UPDATE login_attempts SET at = at - interval '61 minutes'")
    ok(_request_reset(app, worlds.a.email), 204)
    assert len(outbox(app).messages) == 4


def test_a_failed_email_is_recorded_in_the_business_history(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    outbox(app).fail = True

    ok(_request_reset(app, worlds.a.email), 204)

    [failed] = history(owner_engine, worlds.a.tenant_id, "email.failed")
    assert failed.actor_type == "system"
    assert failed.data["purpose"] == "password_reset"


def test_completing_a_reset_sets_the_password_and_ends_every_session(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    first, second = _sign_in(app, a.email), _sign_in(app, a.phone)
    ok(_request_reset(app, a.email), 204)
    token = token_of(_link_in(outbox(app).messages[0]), "reset")

    ok(_complete(app, token), 204)

    assert _live_sessions(owner_engine, a.user_id) == 0
    assert first.get("/api/v1/me").status_code == 401
    assert second.get("/api/v1/me").status_code == 401
    _sign_in(app, a.email, NEW_PASSWORD)
    [changed] = history(owner_engine, a.tenant_id, "auth.password_changed")
    assert (changed.actor_type, changed.actor_id) == ("user", a.user_id)
    # Single use.
    refused(_complete(app, token, "Another-Pass-31"), 410, "link_invalid")


def test_reset_link_expires_after_one_hour(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, reset_id = _reset_row(owner_engine, worlds.a.user_id)
    owner_sql(
        owner_engine,
        "UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE id = :r",
        r=reset_id,
    )

    refused(_complete(app, token), 410, "link_invalid")


@pytest.mark.parametrize("token", ["", "unknown", None])
def test_unknown_reset_token_is_link_invalid(app: Flask, token: Any) -> None:
    refused(_complete(app, token), 410, "link_invalid")


def test_weak_new_password_is_refused_and_the_link_stays_usable(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _reset_row(owner_engine, worlds.a.user_id)

    refused(_complete(app, token, "short"), 400, "weak_password")

    ok(_complete(app, token), 204)


def test_reset_link_of_a_deactivated_user_is_link_invalid(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _reset_row(owner_engine, worlds.a.user_id)
    owner_sql(
        owner_engine, "UPDATE users SET status = 'inactive' WHERE id = :u", u=worlds.a.user_id
    )

    refused(_complete(app, token), 410, "link_invalid")


def test_a_new_reset_link_invalidates_the_earlier_one(app: Flask, worlds: TwoTenants) -> None:
    ok(_request_reset(app, worlds.a.email), 204)
    ok(_request_reset(app, worlds.a.email), 204)
    first, second = (token_of(_link_in(m), "reset") for m in outbox(app).messages)

    refused(_complete(app, first), 410, "link_invalid")
    ok(_complete(app, second), 204)


# ---- GET /me ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("role", "tabs", "start"),
    [
        ("owner", ["sales", "packing", "delivery", "orders", "more"], "sales"),
        ("packing", ["packing", "orders", "more"], "packing"),
        ("dispatch", ["delivery", "orders", "more"], "delivery"),
    ],
)
def test_me_describes_the_user_their_business_permissions_and_tabs(
    user_client: UserClient, worlds: TwoTenants, role: str, tabs: list[str], start: str
) -> None:
    a = worlds.a

    me = ok(user_client(a.user(role), a.tenant_id).get("/api/v1/me"))

    assert me["user"]["id"] == str(a.user(role))
    assert me["user"]["roles"] == [role]
    assert me["business"] == {"id": str(a.tenant_id), "name": "Tenant a", "edition": "social"}
    assert me["tabs"] == tabs
    assert me["start_tab"] == start
    assert ("audit.view" in me["permissions"]) is (role == "owner")
    assert me["permissions"] == sorted(me["permissions"])
    assert {s["id"] for s in me["stores"]} == {str(a.store_id), str(a.second_store_id)}
    assert me["all_stores"] is True


def test_me_without_a_session_is_unauthenticated(app: Flask) -> None:
    refused(app.test_client().get("/api/v1/me"), 401, "unauthenticated")


# ---- PATCH /me --------------------------------------------------------------------------------


def _patch(client: FlaskClient, body: dict[str, Any]) -> Any:
    return client.patch("/api/v1/me", json=body, headers=CSRF)


def test_user_changes_their_name_and_language(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    client = user_client(a.user("sales"), a.tenant_id)

    me = ok(_patch(client, {"name": "  Sami  ", "locale": "ar"}))

    assert (me["user"]["name"], me["user"]["locale"]) == ("Sami", "ar")
    assert ok(client.get("/api/v1/me"))["user"]["locale"] == "ar"
    assert history(owner_engine, a.tenant_id, "auth.identifier_changed") == []


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"name": ""}, {"name": "required"}),
        ({"name": "x" * 121}, {"name": "too_long"}),
        ({"locale": "fr"}, {"locale": "invalid"}),
        ({"phone": "123", "current_password": PASSWORD}, {"phone": "invalid_phone"}),
        ({"email": "nope", "current_password": PASSWORD}, {"email": "invalid_email"}),
        ({"email": None, "current_password": PASSWORD}, {"identifier": "required"}),
    ],
)
def test_invalid_profile_changes_are_refused(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    body: dict[str, Any],
    fields: dict[str, str],
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user("sales"))  # sales users have an email and no phone

    response = refused(
        _patch(user_client(a.user("sales"), a.tenant_id), body), 400, "validation_failed"
    )

    assert response["error"]["fields"] == fields


@pytest.mark.parametrize("password", [None, "Wrong-Password-1"])
def test_changing_phone_or_email_needs_the_current_password(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, password: str | None
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    body: dict[str, Any] = {"email": "new-owner@example.test"}
    if password is not None:
        body["current_password"] = password

    refused(_patch(user_client(a.user_id, a.tenant_id), body), 400, "wrong_password")

    assert (
        owner_value(owner_engine, "SELECT email FROM users WHERE id = :u", u=a.user_id) == a.email
    )


def test_user_adds_a_phone_and_changes_their_email(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    sales = a.user("sales")
    set_password(owner_engine, sales)
    client = user_client(sales, a.tenant_id)

    me = ok(
        _patch(
            client,
            {
                "phone": "71 555 444",
                "email": "Sales.New@Example.test",
                "current_password": PASSWORD,
            },
        )
    )

    assert (me["user"]["phone"], me["user"]["email"]) == ("+96171555444", "sales.new@example.test")
    [entry] = history(owner_engine, a.tenant_id, "auth.identifier_changed")
    assert (entry.actor_type, entry.actor_id, entry.target_id) == ("user", sales, sales)
    assert entry.data == {
        "phone": {"from": None, "to": "+96171555444"},
        "email": {"from": "sales-a@example.test", "to": "sales.new@example.test"},
    }
    assert PASSWORD not in str(entry.data)


def test_user_can_remove_one_identifier_but_not_the_last(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)  # the owner has both a phone and an email
    client = user_client(a.user_id, a.tenant_id)

    me = ok(_patch(client, {"email": None, "current_password": PASSWORD}))
    last = _patch(client, {"phone": None, "current_password": PASSWORD})

    assert (me["user"]["email"], me["user"]["phone"]) == (None, a.phone)
    assert refused(last, 400, "validation_failed")["error"]["fields"] == {"identifier": "required"}


@pytest.mark.parametrize("field", ["phone", "email"])
def test_identifier_of_any_other_bos_user_is_unavailable(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, field: str
) -> None:
    a, b = worlds.a, worlds.b
    set_password(owner_engine, a.user("sales"))
    taken = b.phone if field == "phone" else b.email.upper()

    response = _patch(
        user_client(a.user("sales"), a.tenant_id), {field: taken, "current_password": PASSWORD}
    )

    refused(response, 409, "identifier_unavailable")
    assert history(owner_engine, a.tenant_id, "auth.identifier_changed") == []


def test_keeping_the_same_identifier_changes_nothing(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)

    ok(
        _patch(
            user_client(a.user_id, a.tenant_id), {"email": a.email, "current_password": PASSWORD}
        )
    )

    assert history(owner_engine, a.tenant_id, "auth.identifier_changed") == []


# ---- password change --------------------------------------------------------------------------


def _change_password(client: FlaskClient, current: str, new: str) -> Any:
    return client.post(
        "/api/v1/me/password", json={"current_password": current, "new_password": new}, headers=CSRF
    )


def test_changing_the_password_ends_every_other_session(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    current, other = _sign_in(app, a.email), _sign_in(app, a.email)

    ok(_change_password(current, PASSWORD, NEW_PASSWORD), 204)

    assert current.get("/api/v1/me").status_code == 200
    assert other.get("/api/v1/me").status_code == 401
    assert _live_sessions(owner_engine, a.user_id) == 1
    _sign_in(app, a.email, NEW_PASSWORD)
    [entry] = history(owner_engine, a.tenant_id, "auth.password_changed")
    assert (entry.actor_type, entry.actor_id) == ("user", a.user_id)


def test_password_change_needs_the_current_password_and_a_strong_new_one(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    client = _sign_in(app, a.email)

    refused(_change_password(client, "Wrong-Password-1", NEW_PASSWORD), 400, "wrong_password")
    refused(_change_password(client, PASSWORD, "short"), 400, "weak_password")

    _sign_in(app, a.email, PASSWORD)
    assert history(owner_engine, a.tenant_id, "auth.password_changed") == []


# ---- sessions ---------------------------------------------------------------------------------


def test_user_lists_their_own_devices(app: Flask, owner_engine: Engine, worlds: TwoTenants) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    set_password(owner_engine, worlds.b.user_id)
    phone = app.test_client()
    phone.post(
        "/api/v1/auth/sign-in",
        json={"identifier": a.email, "password": PASSWORD},
        headers={**CSRF, "User-Agent": "Mozilla/5.0 (Linux; Android 13) Phone"},
    )
    laptop = _sign_in(app, a.phone)
    _sign_in(app, worlds.b.email)

    devices = ok(laptop.get("/api/v1/me/sessions"))

    assert len(devices) == 2
    assert [d["current"] for d in devices].count(True) == 1
    assert any("Android" in d["device"] for d in devices)
    assert all(set(d) == {"id", "device", "last_seen_at", "current"} for d in devices)


def test_user_ends_one_of_their_sessions(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    lost_phone, laptop = _sign_in(app, a.email), _sign_in(app, a.email)
    devices = ok(laptop.get("/api/v1/me/sessions"))
    [lost] = [d["id"] for d in devices if not d["current"]]

    ok(laptop.delete(f"/api/v1/me/sessions/{lost}", headers=CSRF), 204)

    assert lost_phone.get("/api/v1/me").status_code == 401
    assert laptop.get("/api/v1/me").status_code == 200
    [entry] = history(owner_engine, a.tenant_id, "auth.session_revoked")
    assert (entry.actor_id, entry.target_type, str(entry.target_id)) == (a.user_id, "session", lost)
    refused(laptop.delete(f"/api/v1/me/sessions/{lost}", headers=CSRF), 404, "not_found")


def test_ending_the_current_session_signs_the_user_out(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    client = _sign_in(app, a.email)
    [mine] = ok(client.get("/api/v1/me/sessions"))

    ok(client.delete(f"/api/v1/me/sessions/{mine['id']}", headers=CSRF), 204)

    assert cookie(client, USER_COOKIE) is None
    assert client.get("/api/v1/me").status_code == 401


def test_user_ends_every_other_session(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    others = [_sign_in(app, a.email) for _ in range(2)]
    current = _sign_in(app, a.email)

    ok(current.delete("/api/v1/me/sessions", headers=CSRF), 204)

    assert current.get("/api/v1/me").status_code == 200
    assert all(other.get("/api/v1/me").status_code == 401 for other in others)
    [entry] = history(owner_engine, a.tenant_id, "auth.session_revoked")
    assert entry.data == {"ended": 2, "scope": "others"}
