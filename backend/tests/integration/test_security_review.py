"""T089 — security review: the fixes it made and the claims it relies on.

See specs/001-platform-foundation/checklists/security.md for the full review.
"""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import Callable, Iterator

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import StatementError

from app import create_app
from app.config import Config
from app.core.db import engine_of, make_engine
from tests.dbsupport import TwoTenants, new_operator_session

CSRF = {"X-BOS-CSRF": "1"}
UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]


def _store_count(owner: Engine, tenant_id: uuid.UUID) -> int:
    with owner.connect() as conn:
        return int(
            conn.execute(
                text("SELECT count(*) FROM stores WHERE tenant_id = :t"), {"t": tenant_id}
            ).scalar_one()
        )


def test_a_cross_site_form_post_with_the_session_cookie_is_refused(
    user_client: UserClient, fresh_tenants: TwoTenants, owner_engine: Engine
) -> None:
    """What a hostile page's <form method=post> sends: the cookie, a simple body, no header."""
    owner = user_client(fresh_tenants.a.user_id, fresh_tenants.a.tenant_id)
    before = _store_count(owner_engine, fresh_tenants.a.tenant_id)

    for content_type, body in (
        ("application/x-www-form-urlencoded", "name=Forged+store"),
        ("text/plain", '{"name": "Forged store"}'),
        (
            "multipart/form-data; boundary=x",
            '--x\r\nContent-Disposition: form-data; name="name"\r\n\r\nForged store\r\n--x--\r\n',
        ),
    ):
        response = owner.post(
            "/api/v1/stores",
            data=body,
            headers={"Content-Type": content_type, "Origin": "https://evil.example"},
        )
        assert response.status_code == 403
        assert response.get_json()["error"]["code"] == "csrf_required"

    # Only the exact header value counts.
    wrong = owner.post("/api/v1/stores", json={"name": "Forged"}, headers={"X-BOS-CSRF": "yes"})
    assert wrong.status_code == 403
    assert _store_count(owner_engine, fresh_tenants.a.tenant_id) == before


def test_api_answers_are_never_cached_and_never_sniffed(
    user_client: UserClient, fresh_tenants: TwoTenants, client: FlaskClient
) -> None:
    owner = user_client(fresh_tenants.a.user_id, fresh_tenants.a.tenant_id)
    for response in (
        owner.get("/api/v1/me"),
        client.get("/api/v1/health"),
        client.get("/api/v1/me"),  # 401
        client.get("/api/v1/no-such-route"),  # 404
        client.post("/api/v1/auth/sign-in", json={}),  # 403 csrf_required
    ):
        assert response.headers["Cache-Control"] == "no-store"
        assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_database_errors_do_not_carry_bound_values(config: Config) -> None:
    """Logged tracebacks of failed statements must not hold password hashes or contacts."""
    engine = make_engine(config.database_url)
    secret = "do-not-log-this-value@example.test"
    try:
        with pytest.raises(StatementError) as raised, engine.connect() as conn:
            # Fails for a reason that does not echo the value (PostgreSQL's own message would
            # for a type error or a duplicate key; see security.md finding F-07).
            conn.execute(text("SELECT 1 / 0 WHERE :v <> ''"), {"v": secret})
        assert secret not in str(raised.value)
        assert "parameters hidden" in str(raised.value)
    finally:
        engine.dispose()


@pytest.fixture()
def proxied_app(config: Config) -> Iterator[Flask]:
    application = create_app(dataclasses.replace(config, trusted_proxy_hops=1))
    yield application
    engine_of(application).dispose()


def _attempt_ips(owner: Engine) -> list[str]:
    with owner.connect() as conn:
        return [
            row.ip
            for row in conn.execute(
                text("SELECT host(ip) AS ip FROM login_attempts ORDER BY id")
            ).all()
        ]


def test_behind_a_trusted_proxy_the_client_address_is_counted(
    proxied_app: Flask, app: Flask, fresh_tenants: TwoTenants, owner_engine: Engine
) -> None:
    body = {"identifier": "nobody@example.test", "password": "wrong password 1"}
    forwarded = {**CSRF, "X-Forwarded-For": "203.0.113.7"}

    assert (
        proxied_app.test_client()
        .post("/api/v1/auth/sign-in", json=body, headers=forwarded)
        .status_code
        == 401
    )
    # Without a trusted proxy (the default) the header is ignored: it could be forged.
    assert (
        app.test_client().post("/api/v1/auth/sign-in", json=body, headers=forwarded).status_code
        == 401
    )

    assert _attempt_ips(owner_engine)[-2:] == ["203.0.113.7", "127.0.0.1"]


def test_trusted_proxy_hops_must_be_a_small_number(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import ConfigError

    for bad in ("-1", "x", "6"):
        monkeypatch.setenv("BOS_TRUSTED_PROXY_HOPS", bad)
        with pytest.raises(ConfigError):
            Config.from_env(testing=True)
    monkeypatch.setenv("BOS_TRUSTED_PROXY_HOPS", "1")
    assert Config.from_env(testing=True).trusted_proxy_hops == 1
    monkeypatch.delenv("BOS_TRUSTED_PROXY_HOPS")
    assert Config.from_env(testing=True).trusted_proxy_hops == 0


def test_resetting_an_operator_password_ends_their_sessions(
    config: Config, fresh_tenants: TwoTenants, app_engine: Engine, owner_engine: Engine
) -> None:
    with owner_engine.connect() as conn:
        email = conn.execute(
            text("SELECT email FROM operators WHERE id = :id"), {"id": fresh_tenants.operator_id}
        ).scalar_one()
    application = create_app(dataclasses.replace(config, operator_emails=frozenset({email})))
    try:
        token = new_operator_session(app_engine, fresh_tenants.operator_id)
        signed_in = application.test_client()
        signed_in.set_cookie("bos_ops_session", token)
        assert signed_in.get("/api/v1/ops/businesses").status_code == 200

        result = application.test_cli_runner().invoke(
            args=["bos", "create-operator", "--email", email],
            env={"BOS_OPERATOR_PASSWORD": "a brand new operator passphrase"},
        )

        assert result.exit_code == 0, result.output
        assert "1 session(s) ended" in result.output
        assert signed_in.get("/api/v1/ops/businesses").status_code == 401
    finally:
        engine_of(application).dispose()


def test_config_repr_holds_no_secret(config: Config) -> None:
    shown = repr(config)
    for secret in (config.secret_key, config.database_url, config.migration_database_url):
        assert secret not in shown
