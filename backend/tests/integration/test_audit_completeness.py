"""T077 — history completeness (SC-008): every action of stories 1 to 3 leaves exactly one entry.

One test runs one of every recorded action through real requests (and the maintenance
command), keeping a list of the entries each action must leave: business, event, actor type,
actor id and target. The history written during the test must equal that list exactly
(nothing missing, nothing twice, nothing extra), every event of the fixed list must appear,
and every entry's time must lie within the test. Then ``GET /audit`` must return the
entries with their actor and target fields right, and never resolve the name of a record of
another business.

T105 checks the M1 catalog and stock actions against the documented event list and
each entry's full payload.
"""

from __future__ import annotations

import io
import re
import uuid
from collections import Counter
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.core import audit
from app.core.tenancy import tenant_transaction
from app.services import allocation
from app.services.inventory import StockActor
from tests.dbsupport import TwoTenants, insert
from tests.integration import catalog_support as catalog
from tests.integration.stock_support import adjust, arrange_product, change
from tests.integration.us1_support import (
    CSRF,
    NEW_PASSWORD,
    OPERATOR_PASSWORD,
    PASSWORD,
    app_for,
    ok,
    outbox,
    owner_rows,
    owner_value,
    set_operator_password,
    set_password,
    shared_app_fixture,
    token_of,
    with_valid_phones,
)
from tests.integration.us3_support import STORES, image_bytes, upload, with_upload_dir
from tests.paths import DATA_MODELS, documented_events

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
OperatorClient = Callable[[uuid.UUID], FlaskClient]
Expected = tuple[
    uuid.UUID | None, str, str, uuid.UUID | None, str | None, uuid.UUID | None
]  # tenant, event, actor type, actor id, target type, target id

NEW_BUSINESS: dict[str, Any] = {
    "business_name": "Cedar Threads",
    "store_name": "Hamra",
    "edition": "social",
    "default_currency": "USD",
    "usd_lbp_rate": "89500",
    "owner_name": "Rana Haddad",
    "owner_phone": "03 123 456",  # no email: the operator may issue her reset link
}


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants, owner_engine: Engine) -> TwoTenants:
    return with_valid_phones(owner_engine, fresh_staffed_tenants)


@pytest.fixture(scope="module")
def shared_app(config: Any) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants, tmp_path: Path) -> Flask:
    return with_upload_dir(app_for(shared_app, worlds), tmp_path / "uploads")


class Ledger:
    """The history entries the test's actions must leave, in order."""

    def __init__(self) -> None:
        self.rows: list[Expected] = []

    def expect(
        self,
        tenant: uuid.UUID | None,
        event: str,
        actor_type: str,
        actor_id: uuid.UUID | None,
        target_type: str | None = None,
        target_id: Any = None,
    ) -> None:
        target = uuid.UUID(str(target_id)) if target_id is not None else None
        self.rows.append((tenant, event, actor_type, actor_id, target_type, target))


def _post(
    client: FlaskClient, path: str, body: dict[str, Any] | None = None, **headers: str
) -> Any:
    return client.post(path, json=body or {}, headers={**CSRF, **headers})


def _request_reset(app: Flask, email: str) -> Any:
    # Read and closed as a WSGI server does: the email goes out when the answer is closed.
    return app.test_client().post(
        "/api/v1/auth/password-reset/request", json={"email": email}, headers=CSRF, buffered=True
    )


def _patch(client: FlaskClient, path: str, body: dict[str, Any]) -> Any:
    return client.patch(path, json=body, headers=CSRF)


def _sign_in(app: Flask, identifier: str, password: str = PASSWORD) -> FlaskClient:
    client = app.test_client()
    ok(_post(client, "/api/v1/auth/sign-in", {"identifier": identifier, "password": password}))
    return client


def _current_session(client: FlaskClient) -> uuid.UUID:
    [current] = [s for s in ok(client.get("/api/v1/me/sessions")) if s["current"]]
    return uuid.UUID(current["id"])


def _other_session(client: FlaskClient) -> uuid.UUID:
    [other] = [s for s in ok(client.get("/api/v1/me/sessions")) if not s["current"]]
    return uuid.UUID(other["id"])


def _operator_actions(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, log: Ledger
) -> tuple[uuid.UUID, uuid.UUID, FlaskClient]:
    """Story 1, operator side: a new business up to its owner's activation.

    Returns the new business's id, its owner's id and the owner's signed-in client.
    """
    operator = worlds.operator_id
    set_operator_password(owner_engine, operator)
    ops = app.test_client()
    ok(
        _post(
            ops,
            "/api/v1/ops/auth/sign-in",
            {"email": worlds.operator_email, "password": OPERATOR_PASSWORD},
        )
    )
    log.expect(None, "operator.sign_in", "operator", operator)

    created = ok(_post(ops, "/api/v1/ops/businesses", NEW_BUSINESS), 201)
    tenant = uuid.UUID(created["business"]["id"])
    store = owner_value(owner_engine, "SELECT id FROM stores WHERE tenant_id = :t", t=tenant)
    first = owner_value(owner_engine, "SELECT id FROM invitations WHERE tenant_id = :t", t=tenant)
    log.expect(tenant, "tenant.created", "operator", operator, "tenant", tenant)
    log.expect(tenant, "store.created", "operator", operator, "store", store)
    log.expect(tenant, "invitation.created", "operator", operator, "invitation", first)

    resent = ok(_post(ops, f"/api/v1/ops/businesses/{tenant}/owner-activation"), 201)
    second = owner_value(
        owner_engine,
        "SELECT id FROM invitations WHERE tenant_id = :t AND status = 'pending'",
        t=tenant,
    )
    log.expect(tenant, "invitation.resent", "operator", operator, "invitation", second)

    owner_client = app.test_client()
    me = ok(
        _post(
            owner_client,
            "/api/v1/invitations/accept",
            {"token": token_of(resent["link"], "activate"), "password": PASSWORD, "locale": "ar"},
        )
    )
    owner = uuid.UUID(me["user"]["id"])
    log.expect(tenant, "invitation.accepted", "user", owner, "invitation", second)
    log.expect(tenant, "auth.sign_in", "user", owner, "user", owner)

    for status, event in (("suspended", "tenant.suspended"), ("active", "tenant.reactivated")):
        ok(_patch(ops, f"/api/v1/ops/businesses/{tenant}", {"status": status}))
        log.expect(tenant, event, "operator", operator, "tenant", tenant)

    ok(
        _post(
            ops,
            f"/api/v1/ops/businesses/{tenant}/owner-password-reset",
            {"owner_user_id": str(owner)},
        ),
        201,
    )
    log.expect(tenant, "auth.password_reset_issued", "operator", operator, "user", owner)
    return tenant, owner, owner_client


def _staff_actions(
    app: Flask, owner: FlaskClient, worlds: TwoTenants, log: Ledger
) -> tuple[uuid.UUID, uuid.UUID]:
    """Story 2: invitations and employees. Returns (accepted user, last invitation)."""
    a = worlds.a
    t, me = a.tenant_id, a.user_id

    def invite(name: str, email: str) -> Any:
        body = {"name": name, "email": email, "roles": ["sales"], "all_stores": True}
        return ok(_post(owner, "/api/v1/staff/invitations", body), 201)

    first = invite("New Hire", "hire@example.test")["invitation"]["invitation_id"]
    log.expect(t, "invitation.created", "user", me, "invitation", first)
    resent = ok(_post(owner, f"/api/v1/staff/invitations/{first}/resend"), 201)
    second = resent["invitation"]["invitation_id"]
    log.expect(t, "invitation.resent", "user", me, "invitation", second)
    token = token_of(resent["link"], "activate")

    def emailed_code() -> str:
        sent = app.test_client().post(
            "/api/v1/invitations/send-code", json={"token": token}, headers=CSRF, buffered=True
        )
        ok(sent, 204)
        log.expect(t, "invitation.code_sent", "anonymous", None, "invitation", second)
        log.expect(t, "email.sent", "system", None)
        [code] = re.findall(r"\b\d{6}\b", str(outbox(app).messages[-1].get_content()))
        return str(code)

    def accept(code: str) -> Any:
        body = {"token": token, "password": PASSWORD, "code": code}
        return _post(app.test_client(), "/api/v1/invitations/accept", body)

    first_code = emailed_code()
    wrong = f"{(int(first_code) + 1) % 1_000_000:06d}"
    for _ in range(5):
        assert accept(wrong).status_code == 400
    log.expect(t, "invitation.code_failed", "anonymous", None, "invitation", second)
    joined = ok(accept(emailed_code()))
    hire = uuid.UUID(joined["user"]["id"])
    log.expect(t, "invitation.accepted", "user", hire, "invitation", second)
    log.expect(t, "auth.sign_in", "user", hire, "user", hire)

    third = uuid.UUID(invite("Third Hire", "third@example.test")["invitation"]["invitation_id"])
    log.expect(t, "invitation.created", "user", me, "invitation", third)
    ok(owner.delete(f"/api/v1/staff/invitations/{third}", headers=CSRF), 204)
    log.expect(t, "invitation.revoked", "user", me, "invitation", third)

    sales = a.user("sales")
    for body, event in (
        ({"roles": ["packing"]}, "user.roles_changed"),
        ({"all_stores": False, "store_ids": [str(a.store_id)]}, "user.stores_changed"),
        ({"status": "inactive"}, "user.deactivated"),
        ({"status": "active"}, "user.reactivated"),
    ):
        ok(_patch(owner, f"/api/v1/staff/{sales}", body))
        log.expect(t, event, "user", me, "user", sales)

    link = ok(_post(owner, f"/api/v1/staff/{sales}/password-reset"), 201)["link"]
    log.expect(t, "auth.password_reset_issued", "user", me, "user", sales)
    ok(
        _post(
            app.test_client(),
            "/api/v1/auth/password-reset/complete",
            {"token": token_of(link, "reset"), "new_password": NEW_PASSWORD},
        ),
        204,
    )
    log.expect(t, "auth.password_changed", "user", sales, "user", sales)
    return hire, third


def _store_actions(owner: FlaskClient, worlds: TwoTenants, log: Ledger) -> uuid.UUID:
    """Story 3: stores, logos and business settings. Returns the new store's id."""
    t, me = worlds.a.tenant_id, worlds.a.user_id
    created = ok(_post(owner, STORES, {"name": "Verdun", "whatsapp_number": "+96170999888"}), 201)
    store = uuid.UUID(created["id"])
    log.expect(t, "store.created", "user", me, "store", store)
    for body, event in (
        ({"name": "Verdun Mall"}, "store.updated"),
        ({"status": "inactive"}, "store.deactivated"),
        ({"status": "active"}, "store.reactivated"),
    ):
        ok(_patch(owner, f"{STORES}/{store}", body))
        log.expect(t, event, "user", me, "store", store)

    ok(upload(owner, store, image_bytes("PNG")))
    log.expect(t, "store.updated", "user", me, "store", store)
    ok(owner.delete(f"{STORES}/{store}/logo", headers=CSRF), 204)
    log.expect(t, "store.updated", "user", me, "store", store)

    ok(_patch(owner, "/api/v1/business", {"usd_lbp_rate": "90000"}))
    log.expect(t, "tenant.settings_changed", "user", me, "tenant", t)
    return store


def test_every_action_leaves_exactly_one_entry(
    app: Flask,
    owner_engine: Engine,
    worlds: TwoTenants,
    user_client: UserClient,
) -> None:
    a, b = worlds.a, worlds.b
    t, me = a.tenant_id, a.user_id
    set_password(owner_engine, me)
    started = owner_value(owner_engine, "SELECT clock_timestamp()")
    log = Ledger()

    # ---- story 1: operator, activation ----------------------------------------------------
    new_tenant, new_owner, new_owner_client = _operator_actions(app, owner_engine, worlds, log)

    # ---- story 1: sign-in, passwords by email ---------------------------------------------
    bad = _post(
        app.test_client(),
        "/api/v1/auth/sign-in",
        {"identifier": a.email, "password": "Wrong-Password-1"},
    )
    assert bad.status_code == 401
    log.expect(t, "auth.sign_in_failed", "anonymous", None, "user", me)
    unknown = _post(
        app.test_client(),
        "/api/v1/auth/sign-in",
        {"identifier": "nobody@example.test", "password": PASSWORD},
    )
    assert unknown.status_code == 401
    log.expect(None, "auth.sign_in_failed", "anonymous", None)

    owner = _sign_in(app, a.email)
    log.expect(t, "auth.sign_in", "user", me, "user", me)

    ok(_request_reset(app, a.email), 204)
    log.expect(t, "auth.password_reset_issued", "anonymous", None, "user", me)
    log.expect(t, "email.sent", "system", None)
    outbox(app).fail = True
    manager_email = "manager-a@example.test"
    ok(_request_reset(app, manager_email), 204)
    outbox(app).fail = False
    log.expect(t, "auth.password_reset_issued", "anonymous", None, "user", a.user("manager"))
    log.expect(t, "email.failed", "system", None)

    # ---- stories 2 and 3 --------------------------------------------------------------------
    hire, revoked_invitation = _staff_actions(app, owner, worlds, log)
    new_store = _store_actions(owner, worlds, log)

    # ---- story 1: the user's own account ----------------------------------------------------
    ok(
        _patch(
            owner,
            "/api/v1/me",
            {
                "name": "Owner A Renamed",  # a name change is not an event
                "email": "owner.renamed@example.test",
                "current_password": PASSWORD,
            },
        )
    )
    log.expect(t, "auth.identifier_changed", "user", me, "user", me)

    user_client(me, t)  # another device
    lost = _other_session(owner)
    ok(owner.delete(f"/api/v1/me/sessions/{lost}", headers=CSRF), 204)
    log.expect(t, "auth.session_revoked", "user", me, "session", lost)
    user_client(me, t)
    ok(owner.delete("/api/v1/me/sessions", headers=CSRF), 204)
    log.expect(t, "auth.session_revoked", "user", me, "user", me)

    ok(
        _post(
            owner,
            "/api/v1/me/password",
            {"current_password": PASSWORD, "new_password": NEW_PASSWORD},
        ),
        204,
    )
    log.expect(t, "auth.password_changed", "user", me, "user", me)

    # ---- refusals ---------------------------------------------------------------------------
    limited = user_client(a.user("sales_limited"), t)
    assert limited.get("/api/v1/audit").status_code == 403
    log.expect(t, "access.denied_permission", "user", a.user("sales_limited"))
    assert limited.get(f"{STORES}/{a.second_store_id}/logo").status_code == 404
    log.expect(t, "access.denied_store", "user", a.user("sales_limited"))
    probe = _patch(owner, f"{STORES}/{b.store_id}", {"name": "Taken over"})
    assert probe.status_code == 404
    log.expect(t, "access.denied_tenant", "user", me, "store", b.store_id)

    # ---- sign-out, maintenance --------------------------------------------------------------
    session = _current_session(owner)
    ok(_post(owner, "/api/v1/auth/sign-out"), 204)
    log.expect(t, "auth.sign_out", "user", me, "session", session)

    result = app.test_cli_runner().invoke(args=["bos", "maintenance"])
    assert result.exit_code == 0, result.output
    log.expect(None, "maintenance.run", "system", None)
    ended = owner_value(owner_engine, "SELECT clock_timestamp()")

    # ---- the history equals the ledger ------------------------------------------------------
    rows = owner_rows(
        owner_engine,
        "SELECT tenant_id, event, actor_type, actor_id, target_type, target_id, at, data "
        "FROM audit_entries WHERE at >= :started ORDER BY at",
        started=started,
    )
    recorded = Counter(
        (r.tenant_id, r.event, r.actor_type, r.actor_id, r.target_type, r.target_id) for r in rows
    )
    expected = Counter(log.rows)
    assert recorded - expected == Counter(), "recorded but not expected"
    assert expected - recorded == Counter(), "expected but not recorded"
    # Every event of M0's fixed list. T105 checks M1 separately below.
    m0_events = documented_events(DATA_MODELS[0])
    assert m0_events <= set(audit.EVENTS)
    assert {r.event for r in rows} == m0_events
    assert all(started <= r.at <= ended for r in rows)
    # Only the fixture's own entries were there before.
    assert (
        owner_value(owner_engine, "SELECT count(*) FROM audit_entries WHERE at < :s", s=started)
        == 2
    )

    # Nothing secret or contact-like in any entry.
    everything = str([r.data for r in rows])
    for secret in (PASSWORD, NEW_PASSWORD, OPERATOR_PASSWORD, "#", "hire@", "owner.renamed@"):
        assert secret not in everything
    assert a.email not in everything and a.phone not in everything

    _check_history_api(
        user_client, owner_engine, worlds, hire=hire, invitation=revoked_invitation, store=new_store
    )
    _check_operator_entries_api(new_owner_client, new_tenant, new_owner)


def _check_history_api(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    *,
    hire: uuid.UUID,
    invitation: uuid.UUID,
    store: uuid.UUID,
) -> None:
    """``GET /audit`` returns the actor and target fields, names as they are now."""
    a, b = worlds.a, worlds.b
    # A crafted row of business a naming a user of business b: the name must not resolve.
    crafted = uuid.uuid4()
    with owner_engine.begin() as conn:
        insert(
            conn,
            "audit_entries",
            id=crafted,
            tenant_id=a.tenant_id,
            actor_type="user",
            actor_id=b.user_id,
            event="user.roles_changed",
            target_type="user",
            target_id=b.user_id,
            data="{}",
        )

    page = ok(user_client(a.user_id, a.tenant_id).get("/api/v1/audit"))
    assert page["next_cursor"] is None
    items = page["items"]

    def one(event: str, **match: Any) -> Any:
        found = [
            i for i in items if i["event"] == event and all(i[k] == v for k, v in match.items())
        ]
        assert len(found) == 1, (event, match, found)
        return found[0]

    sales = str(a.user("sales"))
    roles = one("user.roles_changed", target_id=sales)
    assert (roles["actor_type"], roles["actor_id"], roles["actor_name"]) == (
        "user",
        str(a.user_id),
        "Owner A Renamed",
    )
    assert (roles["target_type"], roles["target_name"]) == ("user", "sales a")
    assert roles["data"] == {"before": ["sales"], "after": ["packing"]}
    stores = one("user.stores_changed", target_id=sales)
    assert stores["data"] == {
        "before": {"all_stores": True, "store_ids": []},
        "after": {"all_stores": False, "store_ids": [str(a.store_id)]},
    }

    created = one("store.created", target_id=str(store))
    assert created["target_name"] == "Verdun Mall"  # the current name
    assert created["data"] == {"name": "Verdun", "whatsapp_number": "+96170999888"}
    assert one("invitation.revoked")["target_name"] == "Third Hire"
    assert one("invitation.revoked")["target_id"] == str(invitation)
    assert one("invitation.accepted")["actor_name"] == "New Hire"
    assert one("invitation.accepted")["actor_id"] == str(hire)
    settings = one("tenant.settings_changed")
    assert (settings["target_type"], settings["target_name"]) == ("tenant", "Tenant a")
    assert settings["data"] == {
        "before": {"usd_lbp_rate": "89500.00"},
        "after": {"usd_lbp_rate": "90000.00"},
    }

    failed = one("auth.sign_in_failed")
    assert (failed["actor_type"], failed["actor_id"], failed["actor_name"]) == (
        "anonymous",
        None,
        None,
    )
    assert failed["target_name"] == "Owner A Renamed"
    sent = one("email.sent", data={"purpose": "password_reset", "domain": "example.test"})
    codes_sent = [i for i in items if i["event"] == "invitation.code_sent"]
    assert len(codes_sent) == 2
    for code_sent in codes_sent:
        assert (code_sent["actor_type"], code_sent["actor_id"], code_sent["target_name"]) == (
            "anonymous",
            None,
            "New Hire",
        )
        assert code_sent["data"] == {"kind": "employee"}
    assert one("invitation.code_failed")["data"] == {"kind": "employee", "attempts": 5}
    assert len([i for i in items if i["data"].get("purpose") == "invitation_code"]) == 2
    assert (sent["actor_type"], sent["actor_id"], sent["actor_name"]) == ("system", None, None)
    assert sent["data"] == {"purpose": "password_reset", "domain": "example.test"}
    assert (sent["target_type"], sent["target_id"], sent["target_name"]) == (None, None, None)
    identifier = one("auth.identifier_changed")
    assert identifier["data"] == {
        "before": {"email": "••@example.test"},
        "after": {"email": "••@example.test"},
    }
    ended_one = one("auth.session_revoked", target_type="session")
    assert ended_one["target_name"] is None

    # Ids of another business never resolve to a name, whoever wrote the row.
    denied = one("access.denied_tenant")
    assert (denied["target_type"], denied["target_id"]) == ("store", str(b.store_id))
    assert denied["target_name"] is None
    probe = next(i for i in items if i["id"] == str(crafted))
    assert (probe["actor_name"], probe["target_name"]) == (None, None)
    for name in ("Store b", "Owner b", "Tenant b", "Invitee b"):
        assert name not in str(items)


def _check_operator_entries_api(client: FlaskClient, tenant: uuid.UUID, owner: uuid.UUID) -> None:
    """The new business's owner sees what the operator did, without the operator's identity."""
    items = ok(client.get("/api/v1/audit"))["items"]
    by_event = {i["event"]: i for i in items}
    assert set(by_event) == {
        "tenant.created",
        "store.created",
        "invitation.created",
        "invitation.resent",
        "invitation.accepted",
        "auth.sign_in",
        "tenant.suspended",
        "tenant.reactivated",
        "auth.password_reset_issued",
    }
    for item in items:
        if item["actor_type"] == "operator":
            assert (item["actor_id"], item["actor_name"]) == (None, None)
    created = by_event["tenant.created"]
    assert (created["target_type"], created["target_id"], created["target_name"]) == (
        "tenant",
        str(tenant),
        "Cedar Threads",
    )
    assert by_event["store.created"]["target_name"] == "Hamra"
    assert by_event["store.created"]["data"] == {"name": "Hamra", "whatsapp_number": None}
    assert by_event["invitation.resent"]["target_name"] == "Rana Haddad"
    assert by_event["tenant.suspended"]["data"] == {"before": "active", "after": "suspended"}
    assert by_event["tenant.reactivated"]["data"] == {"before": "suspended", "after": "active"}
    reset = by_event["auth.password_reset_issued"]
    assert (reset["target_id"], reset["target_name"]) == (str(owner), "Rana Haddad")
    sign_in = by_event["auth.sign_in"]
    assert (sign_in["actor_id"], sign_in["actor_name"]) == (str(owner), "Rana Haddad")


@pytest.mark.usefixtures("integrity_check")
def test_every_m1_action_leaves_exactly_one_entry(
    owner_engine: Engine, app_engine: Engine, worlds: TwoTenants, user_client: UserClient
) -> None:
    a = worlds.a
    tenant, owner_id, manager_id = a.tenant_id, a.user_id, a.user("manager")
    owner = user_client(owner_id, tenant)
    manager = user_client(manager_id, tenant)
    person = StockActor(tenant_id=tenant, user_id=owner_id)
    system = StockActor(tenant_id=tenant)

    # A product with stock history cannot be deleted. Release and consume also need
    # different allocations; set up the release candidate before the audit window.
    deletable = arrange_product(owner_engine, tenant, owner_id, code="DELETE-ME", on_hand=0)
    stocked = arrange_product(owner_engine, tenant, owner_id, code="RELEASE-ME", on_hand=2)
    release_item = stocked.item_ids[0]
    with tenant_transaction(app_engine, tenant) as db:
        held = allocation.allocate(db, system, "order-cancelled", [(release_item, 1)])
    started = owner_value(owner_engine, "SELECT clock_timestamp()")

    store_id = str(a.store_id)
    sku = "AUDIT-TEE-SKU"
    product = catalog.created(
        owner,
        catalog.simple(
            "AUDIT-TEE",
            store_ids=[store_id],
            name_ar="قميص",
            variants=[catalog.variant(sku=sku, price="25.00", opening=8)],
        ),
    )
    product_id = uuid.UUID(product["id"])
    update = catalog.as_update(product)
    update["name_en"] = "Cotton tee"
    update["variants"][0]["price"] = "27.50"
    updated = ok(catalog.put(owner, product_id, update))
    archived = ok(catalog.action(owner, product_id, "archive", updated["version"]))
    restored = ok(catalog.action(owner, product_id, "restore", archived["version"]))
    ok(catalog.delete(owner, deletable.product_id, 1), 204)

    [variant] = restored["variants"]
    note = "Counted during stocktake"
    ok(
        adjust(
            manager,
            variant["id"],
            change(
                "count_correction",
                version=variant["stock"]["version"],
                counted=6,
                note=note,
            ),
        ),
        201,
    )
    item = uuid.UUID(variant["inventory_item_id"])
    with tenant_transaction(app_engine, tenant) as db:
        reserved = allocation.allocate(db, person, "order-packed", [(item, 2)])
    with tenant_transaction(app_engine, tenant) as db:
        allocation.release(db, system, held.id)
    with tenant_transaction(app_engine, tenant) as db:
        allocation.consume(db, person, reserved.id)

    imports = "/api/v1/catalog/imports"
    csv = (
        b"product_code,name_en,sku,price,currency,opening_quantity\n"
        b"IMPORT-A,Apron,SKU-A,10,USD,3\nIMPORT-B,Bag,SKU-B,15,USD,4\n"
    )
    preview = ok(
        owner.post(
            imports,
            data={"file": (io.BytesIO(csv), "stocktake.csv")},
            headers=CSRF,
        ),
        201,
    )
    ok(_post(owner, f"{imports}/{preview['id']}/confirm"))
    ok(_patch(owner, "/api/v1/business", {"low_stock_default": 5}))

    packed = {
        "request_key": "order-packed",
        "lines": [{"sku": sku, "inventory_item_id": str(item), "quantity": 2}],
    }
    # Each expected row gives actor id (None for system), target type/id and exact JSON data.
    expected = {
        "product.created": (
            owner_id,
            "product",
            product_id,
            {
                "code": "AUDIT-TEE",
                "name_en": "Product AUDIT-TEE",
                "name_ar": "قميص",
                "variants": 1,
                "store_ids": [store_id],
                "opening_units": 8,
            },
        ),
        "product.updated": (
            owner_id,
            "product",
            product_id,
            {
                "before": {"name_en": "Product AUDIT-TEE"},
                "after": {"name_en": "Cotton tee"},
                "variants_added": [],
                "variants_archived": [],
                "variants_restored": [],
                "variants_deleted": [],
                "variants_changed": [
                    {"sku": sku, "before": {"price": "25.00"}, "after": {"price": "27.50"}},
                ],
            },
        ),
        "product.archived": (
            owner_id,
            "product",
            product_id,
            {"before": "active", "after": "archived"},
        ),
        "product.restored": (
            owner_id,
            "product",
            product_id,
            {"before": "archived", "after": "active"},
        ),
        "product.deleted": (
            owner_id,
            "product",
            deletable.product_id,
            {
                "code": "DELETE-ME",
                "name_en": "Product",
                "name_ar": None,
            },
        ),
        "stock.adjusted": (
            manager_id,
            "variant",
            uuid.UUID(variant["id"]),
            {
                "sku": sku,
                "reason": "count_correction",
                "quantity": -2,
                "counted_quantity": 6,
                "on_hand_before": 8,
                "on_hand_after": 6,
                "note": note,
            },
        ),
        "stock.allocated": (owner_id, "allocation", reserved.id, packed),
        "stock.released": (
            None,
            "allocation",
            held.id,
            {
                "request_key": "order-cancelled",
                "lines": [
                    {"sku": stocked.skus[0], "inventory_item_id": str(release_item), "quantity": 1}
                ],
            },
        ),
        "stock.consumed": (owner_id, "allocation", reserved.id, packed),
        "catalog.imported": (
            owner_id,
            "import_batch",
            uuid.UUID(preview["id"]),
            {
                "file_name": "stocktake.csv",
                "products": 2,
                "variants": 2,
                "opening_units": 7,
            },
        ),
        "tenant.settings_changed": (
            owner_id,
            "tenant",
            tenant,
            {
                "before": {"low_stock_default": 2},
                "after": {"low_stock_default": 5},
            },
        ),
    }
    # M1 also mentions M0's refusal events, covered by T077 above. The setting
    # change reuses an M0 event too, but has a new payload to exercise here.
    inherited = documented_events(DATA_MODELS[0]) - {"tenant.settings_changed"}
    assert set(expected) == documented_events(DATA_MODELS[1]) - inherited
    assert set(expected) <= set(audit.EVENTS)

    # Do not filter by event or tenant: that could hide extra or misattributed entries.
    rows = owner_rows(
        owner_engine,
        "SELECT tenant_id, event, actor_type, actor_id, target_type, target_id, data "
        "FROM audit_entries WHERE at >= :started",
        started=started,
    )
    assert Counter(row.event for row in rows) == Counter(expected.keys())
    for row in rows:
        actor_id, target_type, target_id, data = expected[row.event]
        actor_type = "user" if actor_id is not None else "system"
        assert row.tenant_id == tenant, row.event
        assert (row.actor_type, row.actor_id) == (actor_type, actor_id), row.event
        assert (row.target_type, row.target_id) == (target_type, target_id), row.event
        assert row.data == data, row.event
