"""Phase 1 checkpoint: the API answers, and every failure uses the one error shape."""

from __future__ import annotations

from flask import Flask
from flask.testing import FlaskClient

from app.core.permissions import public
from app.errors import ApiError


def test_health_returns_ok(client: FlaskClient) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}
    assert response.headers["X-Request-ID"]


def test_unknown_route_uses_error_envelope(client: FlaskClient) -> None:
    response = client.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert response.get_json() == {
        "error": {"code": "not_found", "message": "Not Found", "fields": {}}
    }


def test_wrong_method_uses_error_envelope(client: FlaskClient) -> None:
    response = client.post("/api/v1/health")

    assert response.status_code == 405
    assert response.get_json()["error"]["code"] == "method_not_allowed"


def test_api_error_carries_code_and_field_errors(app: Flask) -> None:
    @app.get("/api/v1/_test/api-error")
    @public
    def _raise() -> str:
        raise ApiError(400, "validation_failed", "Invalid input", fields={"name": "required"})

    response = app.test_client().get("/api/v1/_test/api-error")

    assert response.status_code == 400
    assert response.get_json() == {
        "error": {
            "code": "validation_failed",
            "message": "Invalid input",
            "fields": {"name": "required"},
        }
    }


def test_unexpected_error_does_not_leak_details(app: Flask) -> None:
    @app.get("/api/v1/_test/boom")
    @public
    def _boom() -> str:
        raise RuntimeError("secret internal detail")

    response = app.test_client().get("/api/v1/_test/boom")

    assert response.status_code == 500
    body = response.get_json()
    assert body["error"]["code"] == "internal_error"
    assert "secret internal detail" not in response.get_data(as_text=True)
