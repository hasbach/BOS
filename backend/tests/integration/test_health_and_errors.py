"""Phase 1 checkpoint: the API answers, and every failure uses the one error shape."""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest
from flask import Flask, jsonify
from flask.testing import FlaskClient
from flask.typing import ResponseReturnValue
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.permissions import authenticated, public
from app.core.request_context import on_commit, on_rollback, request_db
from app.errors import ApiError
from tests.dbsupport import TwoTenants


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


# ---- lock timeouts and deadlocks: 503 try_again (T018, research R42) --------------------------


def _raise_sqlstate(db: Session, sqlstate: str) -> None:
    """Make PostgreSQL itself fail with ``sqlstate``, as a real lock timeout or deadlock does."""
    db.execute(
        text(
            f"DO $$ BEGIN RAISE EXCEPTION 'secret lock detail' USING ERRCODE = '{sqlstate}'; END $$"
        )
    )


@pytest.mark.parametrize("sqlstate", ["55P03", "40P01"], ids=["lock_timeout", "deadlock"])
@pytest.mark.parametrize("where", ["handler", "commit"])
def test_lock_timeout_or_deadlock_answers_try_again_and_applies_nothing(
    app: Flask,
    user_client: Callable[[uuid.UUID, uuid.UUID], FlaskClient],
    owner_engine: Engine,
    fresh_tenants: TwoTenants,
    monkeypatch: pytest.MonkeyPatch,
    sqlstate: str,
    where: str,
) -> None:
    a = fresh_tenants.a
    effects: list[str] = []

    @app.post("/api/v1/_test/locked")
    @authenticated(self_only=True)
    def _locked() -> ResponseReturnValue:
        db = request_db()
        db.execute(text("UPDATE users SET name = 'Changed' WHERE id = :id"), {"id": a.user_id})
        on_rollback(lambda: effects.append("undone"))
        on_commit(lambda: effects.append("committed"))
        if where == "handler":
            _raise_sqlstate(db, sqlstate)
        return jsonify(status="ok")

    client = user_client(a.user_id, a.tenant_id)
    if where == "commit":
        real_commit = Session.commit

        def failing_commit(self: Session) -> None:
            if self.in_transaction():
                _raise_sqlstate(self, sqlstate)
            real_commit(self)

        monkeypatch.setattr(Session, "commit", failing_commit)

    response = client.post("/api/v1/_test/locked", headers={"X-BOS-CSRF": "1"})
    monkeypatch.undo()

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "1"
    body = response.get_json()
    assert body == {
        "error": {"code": "try_again", "message": body["error"]["message"], "fields": {}}
    }
    raw = response.get_data(as_text=True)
    for leak in ("secret lock detail", "Traceback", sqlstate, "DO $$"):
        assert leak not in raw
    assert effects == ["undone"]
    with owner_engine.connect() as conn:
        name = conn.execute(
            text("SELECT name FROM users WHERE id = :id"), {"id": a.user_id}
        ).scalar_one()
    assert name == "Owner a"


def test_other_database_errors_are_still_internal_errors(
    app: Flask,
    user_client: Callable[[uuid.UUID, uuid.UUID], FlaskClient],
    fresh_tenants: TwoTenants,
) -> None:
    a = fresh_tenants.a

    @app.get("/api/v1/_test/broken")
    @authenticated(self_only=True)
    def _broken() -> ResponseReturnValue:
        _raise_sqlstate(request_db(), "XX000")
        return jsonify(status="ok")

    response = user_client(a.user_id, a.tenant_id).get("/api/v1/_test/broken")

    assert response.status_code == 500
    assert response.get_json()["error"]["code"] == "internal_error"
    assert "Retry-After" not in response.headers
