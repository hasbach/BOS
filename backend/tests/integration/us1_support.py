"""Helpers shared by the User Story 1 endpoint tests (operators, sign-in, me, history)."""

from __future__ import annotations

import dataclasses
import functools
import smtplib
import uuid
from collections.abc import Iterator
from email.message import EmailMessage
from typing import Any

from argon2 import PasswordHasher
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine, text

from app import create_app
from app.config import Config
from app.core import security
from app.core.db import engine_of
from app.core.mailer import Mailer
from app.core.security import hash_token
from tests.contract.support import assert_matches_contract
from tests.dbsupport import TwoTenants

CSRF = {"X-BOS-CSRF": "1"}
PASSWORD = "Correct-Horse-42"
NEW_PASSWORD = "Battery-Staple-77"
OPERATOR_PASSWORD = "Operator-Pass-2026"
BASE_URL = "https://bos.example.test"


FAST_HASHER = PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)


@functools.cache
def password_hash(password: str = PASSWORD) -> str:
    return FAST_HASHER.hash(password)


def shared_app_fixture(config: Config) -> Iterator[Flask]:
    """One real application for a whole test module (use with ``scope="module"``).

    Creating an application per test also means new database connections per test, which is
    most of the cost of these tests; ``app_for`` resets what a test may change instead.

    The Argon2id hasher is swapped for a cheap one while the module runs: the production
    parameters cost about 0.1 s per hash or check, and these tests sign in and set passwords
    hundreds of times. Same algorithm and code paths, only the cost differs
    (``tests/unit/test_security.py`` covers the real parameters).
    """
    real = security._hasher
    security._hasher = FAST_HASHER
    app = create_app(dataclasses.replace(config, public_base_url=BASE_URL))
    app.extensions["bos_base_config"] = app.extensions["bos_config"]
    try:
        yield app
    finally:
        engine_of(app).dispose()
        security._hasher = real


def app_for(app: Flask, worlds: TwoTenants) -> Flask:
    """The shared app, reset for one test: the test's operator allowed, an empty outbox."""
    base: Config = app.extensions["bos_base_config"]
    cfg = dataclasses.replace(base, operator_emails=frozenset({worlds.operator_email}))
    app.extensions["bos_config"] = cfg
    box = Outbox()
    app.extensions["bos_outbox"] = box
    app.extensions["bos_mailer"] = Mailer(cfg, engine_of(app), smtp_factory=box.smtp)
    return app


def outbox(app: Flask) -> Outbox:
    box = app.extensions["bos_outbox"]
    assert isinstance(box, Outbox)
    return box


class Outbox:
    """Stands in for ``smtplib.SMTP``: keeps what would have been sent."""

    def __init__(self) -> None:
        self.messages: list[EmailMessage] = []
        self.fail = False
        self.on_send: list[Any] = []  # callables run when a message is "sent"

    def smtp(self, *args: Any, **kwargs: Any) -> _FakeSmtp:
        return _FakeSmtp(self)


class _FakeSmtp:
    def __init__(self, box: Outbox) -> None:
        self.box = box

    def __enter__(self) -> _FakeSmtp:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def starttls(self, **kwargs: Any) -> None: ...

    def login(self, user: str, password: str) -> None: ...

    def send_message(self, message: EmailMessage) -> None:
        if self.box.fail:
            raise smtplib.SMTPRecipientsRefused({})
        for hook in self.box.on_send:
            hook(message)
        self.box.messages.append(message)


# ---- database ---------------------------------------------------------------------------------


def owner_sql(owner: Engine, sql: str, **params: Any) -> None:
    with owner.begin() as conn:
        conn.execute(text(sql), params)


def owner_rows(owner: Engine, sql: str, **params: Any) -> list[Any]:
    with owner.connect() as conn:
        return list(conn.execute(text(sql), params).all())


def owner_value(owner: Engine, sql: str, **params: Any) -> Any:
    with owner.connect() as conn:
        return conn.execute(text(sql), params).scalar()


VALID_PHONES = {"a": "+96170123456", "b": "+96176123456"}


def with_valid_phones(owner: Engine, worlds: TwoTenants) -> TwoTenants:
    """Give both owners a real Lebanese mobile number (the fixture's random one may not be)."""
    for world in (worlds.a, worlds.b):
        world.phone = VALID_PHONES[world.label]
        owner_sql(
            owner, "UPDATE users SET phone_e164 = :p WHERE id = :u", p=world.phone, u=world.user_id
        )
    return worlds


def set_password(owner: Engine, user_id: uuid.UUID, password: str = PASSWORD) -> None:
    owner_sql(
        owner,
        "UPDATE users SET password_hash = :h WHERE id = :u",
        h=password_hash(password),
        u=user_id,
    )


def set_operator_password(owner: Engine, operator_id: uuid.UUID) -> None:
    owner_sql(
        owner,
        "UPDATE operators SET password_hash = :h WHERE id = :o",
        h=password_hash(OPERATOR_PASSWORD),
        o=operator_id,
    )


def history(owner: Engine, tenant_id: uuid.UUID | None, event: str | None = None) -> list[Any]:
    """History rows of one tenant (or platform rows when ``tenant_id`` is None), oldest first."""
    return owner_rows(
        owner,
        "SELECT tenant_id, actor_type, actor_id, event, target_type, target_id, data, ip "
        "FROM audit_entries WHERE "
        "(CASE WHEN CAST(:t AS uuid) IS NULL THEN tenant_id IS NULL "
        "ELSE tenant_id = CAST(:t AS uuid) END) "
        "AND (CAST(:e AS text) IS NULL OR event = CAST(:e AS text)) ORDER BY at, event",
        t=tenant_id,
        e=event,
    )


def events(owner: Engine, tenant_id: uuid.UUID | None) -> list[str]:
    return [row.event for row in history(owner, tenant_id)]


# ---- responses --------------------------------------------------------------------------------


def error(response: Any) -> str:
    return str(response.get_json()["error"]["code"])


def ok(response: Any, status: int = 200) -> Any:
    """Assert the status, check the response against the contract, return the JSON body."""
    assert response.status_code == status, response.get_data(as_text=True)
    assert_matches_contract(response)
    return response.get_json()


def refused(response: Any, status: int, code: str) -> Any:
    assert response.status_code == status, response.get_data(as_text=True)
    assert error(response) == code
    assert_matches_contract(response)
    return response.get_json()


def token_of(link: str, page: str) -> str:
    prefix = f"{BASE_URL}/{page}#"
    assert link.startswith(prefix), link
    token = link[len(prefix) :]
    assert token
    return token


def token_hash(token: str) -> bytes:
    return hash_token(token)


def cookie(client: FlaskClient, name: str) -> str | None:
    found = client.get_cookie(name)
    return found.value if found is not None and found.value else None
