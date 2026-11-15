"""T039 — the operator API (``app.api.ops``, ``app.services.onboarding``), through real requests.

Every response is checked against the contract. Operator actions on a business must appear in
that business's own history with actor type ``operator`` (data-model attribution table).
"""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from app.core.sessions import OPERATOR_COOKIE
from tests.dbsupport import TwoTenants
from tests.integration.us1_support import (
    CSRF,
    NEW_PASSWORD,
    OPERATOR_PASSWORD,
    PASSWORD,
    app_for,
    cookie,
    error,
    events,
    history,
    ok,
    owner_rows,
    owner_sql,
    owner_value,
    refused,
    set_operator_password,
    set_password,
    shared_app_fixture,
    token_hash,
    token_of,
    with_valid_phones,
)

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
OperatorClient = Callable[[uuid.UUID], FlaskClient]

NEW_BUSINESS: dict[str, Any] = {
    "business_name": "Cedar Threads",
    "store_name": "Hamra",
    "edition": "social",
    "default_currency": "USD",
    "usd_lbp_rate": "89500",
    "owner_name": "Rana Haddad",
    "owner_phone": "03 123 456",
}


@pytest.fixture()
def worlds(fresh_tenants: TwoTenants, owner_engine: Engine) -> TwoTenants:
    return with_valid_phones(owner_engine, fresh_tenants)


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


@pytest.fixture()
def ops(operator_client: OperatorClient, worlds: TwoTenants) -> FlaskClient:
    return operator_client(worlds.operator_id)


def _create(ops: FlaskClient, body: dict[str, Any] | None = None, **headers: str) -> Any:
    return ops.post(
        "/api/v1/ops/businesses", json=body or NEW_BUSINESS, headers={**CSRF, **headers}
    )


def _created(ops: FlaskClient, body: dict[str, Any] | None = None, **headers: str) -> Any:
    return ok(_create(ops, body, **headers), 201)


def _preview(app: Flask, token: str) -> Any:
    return app.test_client().post(
        "/api/v1/invitations/preview", json={"token": token}, headers=CSRF
    )


def _accept(app: Flask, token: str, **extra: Any) -> Any:
    return app.test_client().post(
        "/api/v1/invitations/accept",
        json={"token": token, "password": PASSWORD, "locale": "ar", **extra},
        headers=CSRF,
    )


# ---- sign-in ----------------------------------------------------------------------------------


def test_operator_signs_in_with_email_and_password(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    set_operator_password(owner_engine, worlds.operator_id)
    client = app.test_client()

    body = ok(
        client.post(
            "/api/v1/ops/auth/sign-in",
            json={"email": worlds.operator_email.upper(), "password": OPERATOR_PASSWORD},
            headers=CSRF,
        )
    )

    assert body == {
        "id": str(worlds.operator_id),
        "name": "Operator",
        "email": worlds.operator_email,
    }
    assert cookie(client, OPERATOR_COOKIE)
    me = ok(client.get("/api/v1/ops/me"))
    assert me["id"] == str(worlds.operator_id)
    [entry] = history(owner_engine, None, "operator.sign_in")
    assert (entry.actor_type, entry.actor_id) == ("operator", worlds.operator_id)
    assert "password" not in str(entry.data).lower()


@pytest.mark.parametrize(
    "case", ["wrong_password", "unknown_email", "not_allow_listed", "inactive"]
)
def test_every_failed_operator_sign_in_gets_the_same_answer(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, case: str
) -> None:
    set_operator_password(owner_engine, worlds.operator_id)
    email, password = worlds.operator_email, OPERATOR_PASSWORD
    if case == "wrong_password":
        password = "Not-The-Password-1"
    elif case == "unknown_email":
        email = "nobody@example.test"
    elif case == "not_allow_listed":
        app.extensions["bos_config"] = dataclasses.replace(
            app.extensions["bos_config"], operator_emails=frozenset()
        )
    else:
        owner_sql(owner_engine, "UPDATE operators SET is_active = false")
    client = app.test_client()

    response = client.post(
        "/api/v1/ops/auth/sign-in", json={"email": email, "password": password}, headers=CSRF
    )

    refused(response, 401, "invalid_credentials")
    assert response.get_json() == {
        "error": {"code": "invalid_credentials", "message": "Invalid credentials", "fields": {}}
    }
    assert cookie(client, OPERATOR_COOKIE) is None
    assert history(owner_engine, None, "operator.sign_in") == []


def test_operator_sign_in_is_blocked_after_five_failures(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    set_operator_password(owner_engine, worlds.operator_id)
    client = app.test_client()
    for _ in range(5):
        client.post(
            "/api/v1/ops/auth/sign-in",
            json={"email": worlds.operator_email, "password": "Wrong-Password-9"},
            headers=CSRF,
        )

    response = client.post(
        "/api/v1/ops/auth/sign-in",
        json={"email": worlds.operator_email, "password": OPERATOR_PASSWORD},
        headers=CSRF,
    )

    refused(response, 401, "invalid_credentials")


def test_ops_me_needs_an_operator_session(app: Flask) -> None:
    refused(app.test_client().get("/api/v1/ops/me"), 401, "unauthenticated")


def test_operator_signs_out(ops: FlaskClient, owner_engine: Engine) -> None:
    assert ops.get("/api/v1/ops/me").status_code == 200

    response = ops.post("/api/v1/ops/auth/sign-out", headers=CSRF)

    assert response.status_code == 204
    ok(response, 204)
    assert owner_value(owner_engine, "SELECT count(*) FROM sessions WHERE revoked_at IS NULL") == 0
    assert ops.get("/api/v1/ops/me").status_code == 401


# ---- setting up a business --------------------------------------------------------------------


def test_setting_up_a_business_creates_one_pending_tenant_store_and_owner_link(
    ops: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    body = _created(ops)

    token = token_of(body["link"], "activate")
    business = body["business"]
    tenant_id = uuid.UUID(business["id"])
    assert business["name"] == "Cedar Threads"
    assert business["status"] == "pending"
    assert business["edition"] == "social"
    assert business["store_count"] == 1
    assert business["user_count"] == 0
    assert business["owners"] == []
    assert business["pending_owner_contact"] == "+9613123456"
    [tenant] = owner_rows(
        owner_engine,
        "SELECT status, usd_lbp_rate, default_currency, created_by_operator_id, is_demo "
        "FROM tenants WHERE id = :t",
        t=tenant_id,
    )
    assert tenant.status == "pending"
    assert str(tenant.usd_lbp_rate) == "89500.00"
    assert tenant.created_by_operator_id == worlds.operator_id
    assert tenant.is_demo is False
    assert (
        owner_value(owner_engine, "SELECT count(*) FROM stores WHERE tenant_id = :t", t=tenant_id)
        == 1
    )
    assert (
        owner_value(owner_engine, "SELECT count(*) FROM users WHERE tenant_id = :t", t=tenant_id)
        == 0
    )
    [invitation] = owner_rows(
        owner_engine,
        "SELECT kind, status, roles, all_stores, invitee_name, invitee_phone_e164, token_hash, "
        "created_by_operator_id, expires_at - created_at AS ttl FROM invitations WHERE tenant_id = :t",
        t=tenant_id,
    )
    assert (invitation.kind, invitation.status) == ("owner_activation", "pending")
    assert invitation.roles == ["owner"]
    assert invitation.all_stores is True
    assert (invitation.invitee_name, invitation.invitee_phone_e164) == (
        "Rana Haddad",
        "+9613123456",
    )
    assert bytes(invitation.token_hash) == token_hash(token)
    assert invitation.created_by_operator_id == worlds.operator_id
    assert invitation.ttl.days == 7
    created = history(owner_engine, tenant_id)
    assert [e.event for e in created] == ["invitation.created", "store.created", "tenant.created"]
    assert {(e.actor_type, e.actor_id) for e in created} == {("operator", worlds.operator_id)}
    assert token not in str([e.data for e in created])


def test_a_new_business_gets_exactly_one_default_warehouse_in_the_same_transaction(
    ops: FlaskClient, owner_engine: Engine
) -> None:
    """FR-011, research R39: created with the business, never shown to anyone in M1."""
    tenant_id = uuid.UUID(_created(ops)["business"]["id"])

    warehouses = owner_rows(
        owner_engine,
        "SELECT w.name, w.is_default, w.created_at = t.created_at AS same_transaction "
        "FROM warehouses w JOIN tenants t ON t.id = w.tenant_id WHERE w.tenant_id = :t",
        t=tenant_id,
    )
    # now() is the transaction's start time, so equal timestamps mean one transaction.
    assert [(w.name, w.is_default, w.same_transaction) for w in warehouses] == [
        ("Main", True, True)
    ]


def test_the_activation_link_is_not_stored_or_shown_again(
    ops: FlaskClient, owner_engine: Engine
) -> None:
    body = _created(ops)
    token = token_of(body["link"], "activate")

    listing = ok(ops.get("/api/v1/ops/businesses"))

    assert token not in str(listing)
    for table in ("invitations", "idempotency_keys", "audit_entries"):
        dump = str(owner_rows(owner_engine, f"SELECT * FROM {table}"))  # noqa: S608
        assert token not in dump


@pytest.mark.parametrize(
    ("change", "field", "code"),
    [
        ({"usd_lbp_rate": None}, "usd_lbp_rate", "required"),
        ({"usd_lbp_rate": "0"}, "usd_lbp_rate", "invalid"),
        ({"usd_lbp_rate": "-5"}, "usd_lbp_rate", "invalid"),
        ({"usd_lbp_rate": "89,500"}, "usd_lbp_rate", "invalid"),
        ({"usd_lbp_rate": 1.5}, "usd_lbp_rate", "invalid"),
        ({"business_name": " "}, "business_name", "required"),
        ({"business_name": "x" * 121}, "business_name", "too_long"),
        ({"store_name": "x" * 81}, "store_name", "too_long"),
        ({"edition": "enterprise"}, "edition", "invalid"),
        ({"default_currency": "EUR"}, "default_currency", "invalid"),
        ({"owner_name": None}, "owner_name", "required"),
        ({"owner_phone": "12"}, "owner_phone", "invalid_phone"),
        ({"owner_phone": None}, "owner_phone", "required"),
        ({"owner_email": "not-an-email"}, "owner_email", "invalid_email"),
    ],
)
def test_invalid_setup_is_refused_with_field_errors(
    ops: FlaskClient, owner_engine: Engine, change: dict[str, Any], field: str, code: str
) -> None:
    body = {key: value for key, value in {**NEW_BUSINESS, **change}.items() if value is not None}

    response = refused(_create(ops, body), 400, "validation_failed")

    assert response["error"]["fields"][field] == code
    assert owner_value(owner_engine, "SELECT count(*) FROM tenants") == 2


@pytest.mark.parametrize("identifier", ["phone", "email", "email_other_case"])
def test_owner_identifier_already_used_by_a_bos_user_is_refused(
    ops: FlaskClient, owner_engine: Engine, worlds: TwoTenants, identifier: str
) -> None:
    body = {key: value for key, value in NEW_BUSINESS.items() if key != "owner_phone"}
    if identifier == "phone":
        body["owner_phone"] = worlds.a.phone.replace("+961", "0")
    else:
        email = worlds.b.email
        body["owner_email"] = email.upper() if identifier == "email_other_case" else email

    refused(_create(ops, body), 409, "identifier_unavailable")

    assert owner_value(owner_engine, "SELECT count(*) FROM tenants") == 2
    assert owner_value(owner_engine, "SELECT count(*) FROM invitations") == 2


def test_repeating_setup_with_the_same_key_gives_the_same_business_and_a_fresh_link(
    app: Flask, ops: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    first = _created(ops, **{"Idempotency-Key": "setup-1"})
    second = _created(ops, **{"Idempotency-Key": "setup-1"})

    assert second["business"]["id"] == first["business"]["id"]
    assert second["link"] != first["link"]
    tenant_id = uuid.UUID(first["business"]["id"])
    assert owner_value(owner_engine, "SELECT count(*) FROM tenants") == 3
    assert (
        owner_value(owner_engine, "SELECT count(*) FROM stores WHERE tenant_id = :t", t=tenant_id)
        == 1
    )
    statuses = owner_rows(
        owner_engine,
        "SELECT status FROM invitations WHERE tenant_id = :t ORDER BY created_at",
        t=tenant_id,
    )
    assert [row.status for row in statuses] == ["revoked", "pending"]
    refused(_preview(app, token_of(first["link"], "activate")), 410, "link_invalid")
    ok(_preview(app, token_of(second["link"], "activate")))
    resent = history(owner_engine, tenant_id, "invitation.resent")
    assert [(e.actor_type, e.actor_id) for e in resent] == [("operator", worlds.operator_id)]

    conflict = _create(
        ops, {**NEW_BUSINESS, "business_name": "Other"}, **{"Idempotency-Key": "setup-1"}
    )
    refused(conflict, 409, "idempotency_conflict")


def test_repeat_after_the_owner_activated_returns_the_business_without_a_link(
    app: Flask, ops: FlaskClient
) -> None:
    first = _created(ops, **{"Idempotency-Key": "setup-2"})
    ok(_accept(app, token_of(first["link"], "activate")))

    again = _created(ops, **{"Idempotency-Key": "setup-2"})

    assert again["business"]["id"] == first["business"]["id"]
    assert again["business"]["status"] == "active"
    assert "link" not in again


def test_business_list_shows_account_level_information_only(
    ops: FlaskClient, worlds: TwoTenants
) -> None:
    _created(ops)

    listing = ok(ops.get("/api/v1/ops/businesses"))

    assert len(listing) == 3
    for business in listing:
        assert set(business) == {
            "id",
            "name",
            "edition",
            "status",
            "is_demo",
            "owners",
            "pending_owner_contact",
            "store_count",
            "user_count",
            "created_at",
        }
    a = next(b for b in listing if b["id"] == str(worlds.a.tenant_id))
    assert a["owners"] == [
        {
            "user_id": str(worlds.a.user_id),
            "name": "Owner a",
            "contact": worlds.a.phone,
            "has_email": True,
        }
    ]
    assert (a["store_count"], a["user_count"], a["status"]) == (1, 1, "active")


# ---- suspend and reactivate -------------------------------------------------------------------


def test_suspending_blocks_every_user_of_the_business_and_reactivating_restores_them(
    app: Flask,
    ops: FlaskClient,
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
) -> None:
    a = worlds.a
    set_password(owner_engine, a.user_id)
    signed_in = user_client(a.user_id, a.tenant_id)
    assert signed_in.get("/api/v1/me").status_code == 200

    suspended = ok(
        ops.patch(
            f"/api/v1/ops/businesses/{a.tenant_id}", json={"status": "suspended"}, headers=CSRF
        )
    )

    assert suspended["status"] == "suspended"
    assert error(signed_in.get("/api/v1/me")) == "business_suspended"
    sign_in = app.test_client().post(
        "/api/v1/auth/sign-in", json={"identifier": a.email, "password": PASSWORD}, headers=CSRF
    )
    refused(sign_in, 403, "business_suspended")
    assert user_client(worlds.b.user_id, worlds.b.tenant_id).get("/api/v1/me").status_code == 200

    reactivated = ok(
        ops.patch(f"/api/v1/ops/businesses/{a.tenant_id}", json={"status": "active"}, headers=CSRF)
    )

    assert reactivated["status"] == "active"
    assert signed_in.get("/api/v1/me").status_code == 200
    entries = [
        (e.event, e.actor_type, e.actor_id)
        for e in history(owner_engine, a.tenant_id)
        if e.event.startswith("tenant.")
    ]
    assert entries == [
        ("tenant.suspended", "operator", worlds.operator_id),
        ("tenant.reactivated", "operator", worlds.operator_id),
    ]


def test_setting_the_status_a_business_already_has_changes_nothing(
    ops: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    ok(
        ops.patch(
            f"/api/v1/ops/businesses/{worlds.a.tenant_id}", json={"status": "active"}, headers=CSRF
        )
    )

    assert history(owner_engine, worlds.a.tenant_id, "tenant.reactivated") == []


@pytest.mark.parametrize("status", ["active", "suspended"])
def test_a_pending_business_can_be_neither_suspended_nor_set_active(
    ops: FlaskClient, owner_engine: Engine, status: str
) -> None:
    tenant_id = _created(ops)["business"]["id"]

    response = ops.patch(
        f"/api/v1/ops/businesses/{tenant_id}", json={"status": status}, headers=CSRF
    )

    refused(response, 409, "business_pending")
    assert (
        owner_value(owner_engine, "SELECT status FROM tenants WHERE id = :t", t=tenant_id)
        == "pending"
    )


def test_status_change_for_an_unknown_business_is_not_found(ops: FlaskClient) -> None:
    response = ops.patch(
        f"/api/v1/ops/businesses/{uuid.uuid4()}", json={"status": "suspended"}, headers=CSRF
    )

    refused(response, 404, "not_found")


def test_status_must_be_active_or_suspended(ops: FlaskClient, worlds: TwoTenants) -> None:
    response = ops.patch(
        f"/api/v1/ops/businesses/{worlds.a.tenant_id}", json={"status": "pending"}, headers=CSRF
    )

    assert response.status_code == 400
    assert response.get_json()["error"]["fields"] == {"status": "invalid"}


# ---- owner activation -------------------------------------------------------------------------


def test_resending_the_owner_activation_issues_a_new_link_and_invalidates_the_old_one(
    app: Flask, ops: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    first = _created(ops)
    tenant_id = first["business"]["id"]

    resent = ok(ops.post(f"/api/v1/ops/businesses/{tenant_id}/owner-activation", headers=CSRF), 201)

    new_token = token_of(resent["link"], "activate")
    assert resent["link"] != first["link"]
    refused(_preview(app, token_of(first["link"], "activate")), 410, "link_invalid")
    assert ok(_preview(app, new_token))["invitee_name"] == "Rana Haddad"
    [entry] = history(owner_engine, uuid.UUID(tenant_id), "invitation.resent")
    assert (entry.actor_type, entry.actor_id) == ("operator", worlds.operator_id)


def test_an_expired_owner_activation_can_be_resent(
    app: Flask, ops: FlaskClient, owner_engine: Engine
) -> None:
    tenant_id = _created(ops)["business"]["id"]
    owner_sql(
        owner_engine,
        "UPDATE invitations SET status = 'expired', expires_at = now() - interval '1 day' "
        "WHERE tenant_id = :t",
        t=tenant_id,
    )

    resent = ok(ops.post(f"/api/v1/ops/businesses/{tenant_id}/owner-activation", headers=CSRF), 201)

    ok(_preview(app, token_of(resent["link"], "activate")))


def test_owner_activation_cannot_be_resent_once_the_owner_activated(
    app: Flask, ops: FlaskClient, worlds: TwoTenants
) -> None:
    created = _created(ops)
    ok(_accept(app, token_of(created["link"], "activate")))

    response = ops.post(
        f"/api/v1/ops/businesses/{created['business']['id']}/owner-activation", headers=CSRF
    )
    active = ops.post(f"/api/v1/ops/businesses/{worlds.a.tenant_id}/owner-activation", headers=CSRF)

    refused(response, 409, "invitation_closed")
    refused(active, 409, "invitation_closed")


def test_owner_activation_for_an_unknown_business_is_not_found(ops: FlaskClient) -> None:
    response = ops.post(f"/api/v1/ops/businesses/{uuid.uuid4()}/owner-activation", headers=CSRF)

    assert response.status_code == 404
    assert error(response) == "not_found"


def test_activating_makes_the_business_active_with_one_owner(
    app: Flask, ops: FlaskClient, owner_engine: Engine
) -> None:
    created = _created(ops)

    me = ok(_accept(app, token_of(created["link"], "activate")))

    listing = ok(ops.get("/api/v1/ops/businesses"))
    business = next(b for b in listing if b["id"] == created["business"]["id"])
    assert business["status"] == "active"
    assert business["pending_owner_contact"] is None
    assert business["owners"] == [
        {
            "user_id": me["user"]["id"],
            "name": "Rana Haddad",
            "contact": "+9613123456",
            "has_email": False,
        }
    ]


# ---- owner password reset ---------------------------------------------------------------------


def _owner_without_email(owner_engine: Engine, worlds: TwoTenants) -> uuid.UUID:
    owner_sql(owner_engine, "UPDATE users SET email = NULL WHERE id = :u", u=worlds.a.user_id)
    return worlds.a.user_id


def test_operator_issues_a_reset_link_for_an_owner_without_email(
    app: Flask, ops: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    owner_id = _owner_without_email(owner_engine, worlds)

    body = ok(
        ops.post(
            f"/api/v1/ops/businesses/{worlds.a.tenant_id}/owner-password-reset",
            json={"owner_user_id": str(owner_id)},
            headers=CSRF,
        ),
        201,
    )

    token = token_of(body["link"], "reset")
    [reset] = owner_rows(
        owner_engine,
        "SELECT user_id, issued_by_operator_id, token_hash, expires_at - created_at AS ttl "
        "FROM password_resets WHERE tenant_id = :t AND issued_by_operator_id IS NOT NULL",
        t=worlds.a.tenant_id,
    )
    assert (reset.user_id, reset.issued_by_operator_id) == (owner_id, worlds.operator_id)
    assert bytes(reset.token_hash) == token_hash(token)
    assert reset.ttl.total_seconds() == 3600
    [entry] = history(owner_engine, worlds.a.tenant_id, "auth.password_reset_issued")
    assert (entry.actor_type, entry.actor_id) == ("operator", worlds.operator_id)
    assert (entry.target_type, entry.target_id) == ("user", owner_id)
    assert token not in str(entry.data)
    # The link works.
    complete = app.test_client().post(
        "/api/v1/auth/password-reset/complete",
        json={"token": token, "new_password": NEW_PASSWORD},
        headers=CSRF,
    )
    assert complete.status_code == 204


def test_owner_reset_is_refused_when_the_owner_has_an_email(
    ops: FlaskClient, worlds: TwoTenants
) -> None:
    response = ops.post(
        f"/api/v1/ops/businesses/{worlds.a.tenant_id}/owner-password-reset",
        json={"owner_user_id": str(worlds.a.user_id)},
        headers=CSRF,
    )

    refused(response, 409, "owner_has_email")


@pytest.mark.parametrize(
    "case", ["other_business", "unknown_user", "inactive_owner", "not_an_owner"]
)
def test_owner_reset_for_anyone_but_an_active_owner_of_that_business_is_not_found(
    ops: FlaskClient, owner_engine: Engine, worlds: TwoTenants, case: str
) -> None:
    _owner_without_email(owner_engine, worlds)
    owner_sql(owner_engine, "UPDATE users SET email = NULL WHERE id = :u", u=worlds.b.user_id)
    tenant_id, user_id = worlds.a.tenant_id, worlds.a.user_id
    if case == "other_business":
        user_id = worlds.b.user_id
    elif case == "unknown_user":
        user_id = uuid.uuid4()
    elif case == "inactive_owner":
        owner_sql(owner_engine, "UPDATE users SET status = 'inactive' WHERE id = :u", u=user_id)
    else:
        owner_sql(
            owner_engine, "UPDATE users SET roles = ARRAY['manager'] WHERE id = :u", u=user_id
        )

    response = ops.post(
        f"/api/v1/ops/businesses/{tenant_id}/owner-password-reset",
        json={"owner_user_id": str(user_id)},
        headers=CSRF,
    )

    refused(response, 404, "not_found")
    assert owner_value(owner_engine, "SELECT count(*) FROM password_resets") == 2


def test_operator_actions_are_in_the_business_history_and_nothing_inside_is_read(
    ops: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    ops.patch(
        f"/api/v1/ops/businesses/{worlds.a.tenant_id}", json={"status": "suspended"}, headers=CSRF
    )
    ops.patch(
        f"/api/v1/ops/businesses/{worlds.a.tenant_id}", json={"status": "active"}, headers=CSRF
    )

    operator_events = [
        e for e in history(owner_engine, worlds.a.tenant_id) if e.actor_type == "operator"
    ]

    assert [e.event for e in operator_events] == ["tenant.suspended", "tenant.reactivated"]
    assert events(owner_engine, worlds.b.tenant_id) == ["auth.sign_in"]  # the fixture's entry only
