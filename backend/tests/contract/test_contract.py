"""T032 — every API route is in the contract, and responses match it."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from flask import Flask, jsonify
from flask.typing import ResponseReturnValue

from tests.contract.support import (
    app_operations,
    assert_matches_contract,
    contract_operations,
    undocumented_routes,
)
from tests.paths import OPENAPI_CONTRACTS, openapi_contract_for

Contract = Callable[[Any], None]


def test_every_registered_api_route_is_in_the_contract(app: Flask) -> None:
    missing = undocumented_routes(app)

    assert missing == [], (
        "Routes missing from every feature's contracts/openapi.yaml "
        "(add them to the contract in the same change):\n  " + "\n  ".join(missing)
    )


def test_health_response_matches_the_contract(client: Any, contract: Contract) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    contract(response)


# ---- the checks themselves catch what they should ---------------------------------------------


def _bare_app() -> Flask:
    """An app that is not BOS: only the routes a test adds (no database needed)."""
    app = Flask(__name__)
    app.config["TESTING"] = True
    return app


def test_a_route_missing_from_the_contract_is_reported() -> None:
    app = _bare_app()

    @app.get("/api/v1/health")
    def health() -> ResponseReturnValue:
        return jsonify(status="ok")

    @app.route("/api/v1/stores/<uuid:store_id>/secret", methods=["GET", "POST"])
    def undocumented(store_id: Any) -> ResponseReturnValue:
        return jsonify()

    @app.delete("/api/v1/health")
    def wrong_method() -> ResponseReturnValue:
        return jsonify()

    @app.get("/not-the-api")
    def elsewhere() -> ResponseReturnValue:
        return jsonify()

    assert undocumented_routes(app) == [
        "DELETE /api/v1/health",
        "GET /api/v1/stores/<uuid:store_id>/secret",
        "POST /api/v1/stores/<uuid:store_id>/secret",
    ]


def test_flask_arguments_match_contract_parameters_by_position() -> None:
    app = _bare_app()

    @app.patch("/api/v1/stores/<uuid:store_id>")
    def store(store_id: Any) -> ResponseReturnValue:
        return jsonify()

    @app.post("/api/v1/staff/invitations/<uuid:invitation_id>/resend")
    def resend(invitation_id: Any) -> ResponseReturnValue:
        return jsonify()

    assert ("PATCH", "/stores/{}") in contract_operations()
    assert {(m, s) for m, s, _ in app_operations(app)} >= {
        ("PATCH", "/stores/{}"),
        ("POST", "/staff/invitations/{}/resend"),
    }
    assert undocumented_routes(app) == []


@pytest.mark.parametrize(
    ("status", "body"),
    [(200, {"status": "broken"}), (418, {"status": "ok"})],
    ids=["wrong-body", "undocumented-status"],
)
def test_a_response_that_differs_from_the_contract_fails(status: int, body: dict[str, str]) -> None:
    app = _bare_app()

    @app.get("/api/v1/health")
    def health() -> ResponseReturnValue:
        return jsonify(body), status

    response = app.test_client().get("/api/v1/health")

    with pytest.raises(AssertionError, match=r"does not match openapi\.yaml"):
        assert_matches_contract(response)


def test_each_path_is_checked_against_the_feature_that_defines_it() -> None:
    m0, m1 = OPENAPI_CONTRACTS
    assert m0.parent.parent.name == "001-platform-foundation"
    assert m1.parent.parent.name == "002-native-catalog-inventory"

    assert openapi_contract_for("/api/v1/health") == m0
    assert openapi_contract_for(f"/api/v1/stores/{uuid.uuid4()}/logo") == m0
    # Changed in place by M1 but an M0 endpoint: M0's file carries the change.
    assert openapi_contract_for("/api/v1/business") == m0
    assert openapi_contract_for("/api/v1/catalog/products") == m1
    assert openapi_contract_for(f"/api/v1/catalog/photos/{uuid.uuid4()}/thumb") == m1
    assert openapi_contract_for("/api/v1/catalog/products/x/y/z") is None
    assert openapi_contract_for("/api/v1/nowhere") is None


def test_operations_of_every_feature_count_as_documented() -> None:
    assert ("GET", "/health") in contract_operations()
    assert ("POST", "/catalog/products") in contract_operations()
    assert ("POST", "/catalog/imports/{}/confirm") in contract_operations()

    app = _bare_app()

    @app.post("/api/v1/catalog/imports/<uuid:batch_id>/confirm")
    def confirm(batch_id: Any) -> ResponseReturnValue:
        return jsonify()

    @app.get("/api/v1/catalog/secret")
    def secret() -> ResponseReturnValue:
        return jsonify()

    assert undocumented_routes(app) == ["GET /api/v1/catalog/secret"]


def test_an_unknown_path_fails() -> None:
    app = _bare_app()

    @app.get("/api/v1/nowhere")
    def nowhere() -> ResponseReturnValue:
        return jsonify()

    with pytest.raises(AssertionError, match="does not match"):
        assert_matches_contract(app.test_client().get("/api/v1/nowhere"))
