"""T065 — business settings (``GET/PATCH /business``), User Story 3.

Money travels as decimal strings and is stored as ``numeric``; no float is ever involved.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from decimal import Decimal
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
    history,
    ok,
    owner_rows,
    refused,
    shared_app_fixture,
)
from tests.integration.us3_support import BUSINESS

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]


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


def _patch(client: FlaskClient, **body: Any) -> Any:
    return client.patch(BUSINESS, json=body, headers=CSRF)


def _tenant(owner: Engine, tenant_id: uuid.UUID) -> Any:
    [row] = owner_rows(
        owner,
        "SELECT name, default_currency, usd_lbp_rate, default_delivery_fee, "
        "default_delivery_fee_currency FROM tenants WHERE id = :t",
        t=tenant_id,
    )
    return row


@pytest.mark.parametrize(
    "role", ["owner", "manager", "sales", "packing", "dispatch", "sales_limited"]
)
def test_everyone_in_the_business_can_read_its_settings(
    user_client: UserClient, worlds: TwoTenants, role: str
) -> None:
    a = worlds.a

    body = ok(user_client(a.user(role), a.tenant_id).get(BUSINESS))

    assert body == {
        "id": str(a.tenant_id),
        "name": "Tenant a",
        "edition": "social",
        "default_currency": "USD",
        "usd_lbp_rate": "89500.00",
        "default_delivery_fee": "0.00",
        "default_delivery_fee_currency": "USD",
        "timezone": "Asia/Beirut",
    }


@pytest.mark.parametrize("role", ["owner", "manager"])
def test_owners_and_managers_change_the_settings_and_it_is_recorded(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, role: str
) -> None:
    a = worlds.a
    client = user_client(a.user(role), a.tenant_id)

    body = ok(
        _patch(
            client,
            name="  Denim House  ",
            default_currency="LBP",
            usd_lbp_rate="90000.5",
            default_delivery_fee="3",
            default_delivery_fee_currency="USD",
        )
    )

    assert body["name"] == "Denim House"
    assert (body["default_currency"], body["usd_lbp_rate"]) == ("LBP", "90000.50")
    assert (body["default_delivery_fee"], body["default_delivery_fee_currency"]) == ("3.00", "USD")
    assert ok(client.get(BUSINESS)) == body
    row = _tenant(owner_engine, a.tenant_id)
    assert row.usd_lbp_rate == Decimal("90000.50")
    assert row.default_delivery_fee == Decimal("3.00")
    [entry] = history(owner_engine, a.tenant_id, "tenant.settings_changed")
    assert (entry.actor_type, entry.actor_id, entry.target_type, entry.target_id) == (
        "user",
        a.user(role),
        "tenant",
        a.tenant_id,
    )
    # Only what changed; the delivery-fee currency was already USD.
    assert entry.data == {
        "before": {
            "name": "Tenant a",
            "default_currency": "USD",
            "usd_lbp_rate": "89500.00",
            "default_delivery_fee": "0.00",
        },
        "after": {
            "name": "Denim House",
            "default_currency": "LBP",
            "usd_lbp_rate": "90000.50",
            "default_delivery_fee": "3.00",
        },
    }


def test_decimals_are_kept_exactly(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    body = ok(
        _patch(
            owner,
            usd_lbp_rate="0.10",
            default_delivery_fee="150000.05",
            default_delivery_fee_currency="LBP",
        )
    )

    assert (body["usd_lbp_rate"], body["default_delivery_fee"]) == ("0.10", "150000.05")
    row = _tenant(owner_engine, worlds.a.tenant_id)
    assert (row.usd_lbp_rate, row.default_delivery_fee) == (Decimal("0.10"), Decimal("150000.05"))
    assert row.default_delivery_fee_currency == "LBP"


def test_a_delivery_fee_of_zero_is_allowed(owner: FlaskClient) -> None:
    assert ok(_patch(owner, default_delivery_fee="5"))["default_delivery_fee"] == "5.00"
    assert ok(_patch(owner, default_delivery_fee="0"))["default_delivery_fee"] == "0.00"


def test_an_empty_or_unchanged_update_records_nothing(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    ok(_patch(owner))
    ok(_patch(owner, usd_lbp_rate="89500", name="Tenant a"))

    assert history(owner_engine, worlds.a.tenant_id, "tenant.settings_changed") == []


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"usd_lbp_rate": "0"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": "0.00"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": "-1"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": "abc"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": "1.234"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": "89,500"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": "1e5"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": "NaN"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": "٨٩٥٠٠"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": "100000000"}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": 89500}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": 89500.5}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": True}, {"usd_lbp_rate": "invalid"}),
        ({"usd_lbp_rate": None}, {"usd_lbp_rate": "required"}),
        ({"usd_lbp_rate": ""}, {"usd_lbp_rate": "required"}),
        ({"default_delivery_fee": "-0.01"}, {"default_delivery_fee": "invalid"}),
        ({"default_delivery_fee": "2.555"}, {"default_delivery_fee": "invalid"}),
        ({"default_delivery_fee": 3}, {"default_delivery_fee": "invalid"}),
        ({"default_delivery_fee": "1000000000"}, {"default_delivery_fee": "invalid"}),
        ({"default_currency": "EUR"}, {"default_currency": "invalid"}),
        ({"default_currency": None}, {"default_currency": "required"}),
        ({"default_delivery_fee_currency": "usd"}, {"default_delivery_fee_currency": "invalid"}),
        ({"name": ""}, {"name": "required"}),
        ({"name": "x" * 121}, {"name": "too_long"}),
        ({"name": 7}, {"name": "invalid"}),
        (
            {"usd_lbp_rate": "0", "default_delivery_fee": "-1", "name": ""},
            {"usd_lbp_rate": "invalid", "default_delivery_fee": "invalid", "name": "required"},
        ),
    ],
)
def test_invalid_values_are_refused_with_field_errors_and_nothing_changes(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    body: dict[str, Any],
    fields: dict[str, str],
) -> None:
    before = _tenant(owner_engine, worlds.a.tenant_id)

    response = owner.patch(BUSINESS, json={"default_currency": "LBP", **body}, headers=CSRF)

    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == fields
    assert _tenant(owner_engine, worlds.a.tenant_id) == before
    assert history(owner_engine, worlds.a.tenant_id, "tenant.settings_changed") == []


def test_a_body_that_is_not_an_object_is_refused(owner: FlaskClient) -> None:
    refused(owner.patch(BUSINESS, json=["x"], headers=CSRF), 400, "validation_failed")


@pytest.mark.parametrize("role", ["sales", "packing", "dispatch", "sales_limited"])
def test_other_roles_cannot_change_the_settings(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, role: str
) -> None:
    a = worlds.a
    before = _tenant(owner_engine, a.tenant_id)

    response = _patch(user_client(a.user(role), a.tenant_id), usd_lbp_rate="1.00")

    refused(response, 403, "forbidden")
    assert _tenant(owner_engine, a.tenant_id) == before
    [entry] = history(owner_engine, a.tenant_id, "access.denied_permission")
    assert entry.data["permission"] == "settings.manage"


def test_changing_settings_leaves_earlier_history_as_it_was(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    ok(_patch(owner, usd_lbp_rate="90000"))
    earlier = history(owner_engine, a.tenant_id)

    ok(_patch(owner, usd_lbp_rate="95000"))

    assert history(owner_engine, a.tenant_id)[: len(earlier)] == earlier
    entries = history(owner_engine, a.tenant_id, "tenant.settings_changed")
    assert [e.data["after"]["usd_lbp_rate"] for e in entries] == ["90000.00", "95000.00"]
