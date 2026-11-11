"""T011 — every /api/v1 route declares an access policy and has its isolation cases.

The real check runs against the real application with the cases registered by every test
module (``tests.isolation.coverage.covers``). The other tests prove the harness itself fails,
with an exact message, on a fake application.
"""

from __future__ import annotations

import pytest
from flask import Flask

from app import create_app
from app.config import Config
from app.core.db import engine_of
from app.core.permissions import authenticated, operator_only, public, require
from tests.isolation.coverage import (
    REGISTRY,
    Case,
    Registry,
    assert_covered,
    covers,
    load_all_cases,
    missing_coverage,
)


def test_every_api_route_has_a_policy_and_its_isolation_cases(config: Config) -> None:
    app = create_app(config)
    try:
        assert_covered(app, load_all_cases())
    finally:
        engine_of(app).dispose()


# ---- the harness itself -----------------------------------------------------------------------


def _fake_app() -> Flask:
    app = Flask("fake")

    @app.get("/api/v1/health")
    @public
    def health() -> str:
        return "ok"

    @app.get("/api/v1/things")
    def things_without_policy() -> str:
        return ""

    @app.route("/api/v1/stores/<uuid:store_id>", methods=["GET", "POST"])
    @require("store.view", store_param="store_id")
    def store(store_id: str) -> str:
        return ""

    @app.get("/api/v1/me")
    @authenticated(self_only=True)
    def me() -> str:
        return ""

    @app.get("/api/v1/me/things")
    @authenticated
    def my_things() -> str:
        return ""

    @app.get("/api/v1/staff")
    @require("staff.view")
    def staff() -> str:
        return ""

    @app.get("/api/v1/ops/businesses")
    @operator_only
    def ops_businesses() -> str:
        return ""

    @app.post("/api/v1/ops/auth/sign-in")
    @public
    def ops_sign_in() -> str:
        return ""

    @app.get("/api/v1/business-ops")
    @operator_only
    def operator_route_outside_ops() -> str:
        return ""

    @app.get("/api/v1/ops/stores")
    @require("store.manage")
    def user_route_inside_ops() -> str:
        return ""

    @app.get("/api/v1/wrong-arg/<uuid:id>")
    @require("store.view", store_param="store_id")
    def wrong_store_arg(id: str) -> str:
        return ""

    @app.get("/elsewhere")
    def not_under_the_api() -> str:
        return ""

    return app


STORE = "/api/v1/stores/<uuid:store_id>"
CASES = {
    Case("GET", STORE, "cross_tenant"),
    Case("GET", STORE, "missing_permission"),
    Case("POST", STORE, "cross_tenant"),
    Case("POST", STORE, "missing_permission"),
    Case("POST", STORE, "cross_store"),
    Case("GET", "/api/v1/staff", "cross_tenant"),
    Case("GET", "/api/v1/staff", "missing_permission"),
    Case("GET", "/api/v1/gone", "cross_tenant"),
    Case("GET", "/api/v1/wrong-arg/<uuid:id>", "cross_tenant"),
    Case("GET", "/api/v1/wrong-arg/<uuid:id>", "missing_permission"),
    Case("GET", "/api/v1/wrong-arg/<uuid:id>", "cross_store"),
}


def test_harness_lists_exactly_what_is_missing() -> None:
    assert missing_coverage(_fake_app(), CASES) == [
        Case("GET", "/api/v1/business-ops", "ops_area"),
        Case("GET", "/api/v1/business-ops", "tenant_user_refused"),
        Case("GET", "/api/v1/gone", "no_such_route"),
        Case("GET", "/api/v1/me/things", "cross_tenant"),
        Case("GET", "/api/v1/ops/businesses", "tenant_user_refused"),
        Case("GET", "/api/v1/ops/stores", "cross_tenant"),
        Case("GET", "/api/v1/ops/stores", "missing_permission"),
        Case("GET", "/api/v1/ops/stores", "ops_area"),
        Case("GET", STORE, "cross_store"),
        Case("GET", "/api/v1/things", "policy"),
        Case("GET", "/api/v1/wrong-arg/<uuid:id>", "store_param"),
    ]


def test_harness_failure_message_names_each_missing_entry() -> None:
    with pytest.raises(AssertionError) as failure:
        assert_covered(_fake_app(), CASES)

    message = str(failure.value)
    assert "(GET, /api/v1/things, policy)" in message
    assert f"(GET, {STORE}, cross_store)" in message
    assert "(GET, /api/v1/me/things, cross_tenant)" in message
    assert "(GET, /api/v1/ops/businesses, tenant_user_refused)" in message
    assert f"(POST, {STORE}, cross_store)" not in message
    assert "/elsewhere" not in message


def test_harness_passes_when_everything_is_covered() -> None:
    app = Flask("covered")

    @app.get("/api/v1/stores/<uuid:store_id>")
    @require("store.view", store_param="store_id")
    def store(store_id: str) -> str:
        return ""

    @app.get("/api/v1/ops/businesses")
    @operator_only
    def ops_businesses() -> str:
        return ""

    assert_covered(
        app,
        {
            Case("GET", STORE, "cross_tenant"),
            Case("GET", STORE, "missing_permission"),
            Case("GET", STORE, "cross_store"),
            Case("GET", "/api/v1/ops/businesses", "tenant_user_refused"),
        },
    )


def test_covers_registers_cases_and_returns_the_test_unchanged() -> None:
    registry = Registry()

    def a_test() -> None: ...

    decorated = registry.covers("get", "/api/v1/x", "cross_tenant", "missing_permission")(a_test)

    assert decorated is a_test
    assert registry.cases == {
        Case("GET", "/api/v1/x", "cross_tenant"),
        Case("GET", "/api/v1/x", "missing_permission"),
    }


def test_covers_rejects_an_unknown_kind_or_no_kind() -> None:
    with pytest.raises(ValueError, match="unknown isolation case kind"):
        covers("GET", "/api/v1/x", "cross_galaxy")
    with pytest.raises(ValueError, match="at least one"):
        covers("GET", "/api/v1/x")


def test_the_shared_registry_is_what_load_all_cases_returns() -> None:
    assert load_all_cases() == REGISTRY.cases
