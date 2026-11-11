"""T016 / T025 — server-side sessions: lookup by token hash, sliding and absolute expiry,
revocation, and the session cookies (research R4)."""

from __future__ import annotations

import dataclasses
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from flask import Flask
from sqlalchemy import Engine, text

from app.config import Config
from app.core import sessions
from app.core.db import transaction
from app.core.security import hash_token
from tests.dbsupport import TwoTenants

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)


def _user(db, worlds: TwoTenants, *, now: datetime = NOW, **kwargs):  # type: ignore[no-untyped-def]
    a = worlds.a
    return sessions.create_user_session(
        db, user_id=a.user_id, tenant_id=a.tenant_id, now=now, **kwargs
    )


def _row(owner: Engine, session_id: uuid.UUID):  # type: ignore[no-untyped-def]
    with owner.connect() as conn:
        return conn.execute(text("SELECT * FROM sessions WHERE id = :id"), {"id": session_id}).one()


# ---- creation -------------------------------------------------------------------------------


def test_only_the_token_hash_is_stored(
    app_engine: Engine, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with transaction(app_engine) as db:
        token, record = _user(db, fresh_tenants, user_agent="Phone", ip="10.0.0.7")

    row = _row(owner_engine, record.id)
    assert bytes(row.token_hash) == hash_token(token)
    assert token.encode() not in bytes(row.token_hash)
    assert row.user_id == fresh_tenants.a.user_id
    assert row.tenant_id == fresh_tenants.a.tenant_id
    assert row.operator_id is None
    assert row.user_agent == "Phone"
    assert str(row.ip) == "10.0.0.7"


def test_user_session_lasts_30_days_idle_and_90_days_at_most(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with transaction(app_engine) as db:
        _, record = _user(db, fresh_tenants)

    assert record.created_at == NOW
    assert record.last_seen_at == NOW
    assert record.idle_expires_at == NOW + timedelta(days=30)
    assert record.absolute_expires_at == NOW + timedelta(days=90)
    assert record.is_operator is False


def test_operator_session_lasts_12_hours_idle_and_7_days_at_most(
    app_engine: Engine, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with transaction(app_engine) as db:
        _, record = sessions.create_operator_session(
            db, operator_id=fresh_tenants.operator_id, now=NOW
        )

    assert record.idle_expires_at == NOW + timedelta(hours=12)
    assert record.absolute_expires_at == NOW + timedelta(days=7)
    assert record.is_operator is True
    row = _row(owner_engine, record.id)
    assert row.operator_id == fresh_tenants.operator_id
    assert row.user_id is None and row.tenant_id is None


def test_long_user_agent_is_truncated(app_engine: Engine, fresh_tenants: TwoTenants) -> None:
    with transaction(app_engine) as db:
        _, record = _user(db, fresh_tenants, user_agent="x" * 1000)

    assert len(record.user_agent) == 255


# ---- lookup ---------------------------------------------------------------------------------


def test_lookup_finds_a_live_session_by_its_token(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with transaction(app_engine) as db:
        token, created = _user(db, fresh_tenants)
    with transaction(app_engine) as db:
        found = sessions.lookup(db, token, now=NOW + timedelta(minutes=1))

    assert found is not None
    assert found.id == created.id
    assert found.user_id == fresh_tenants.a.user_id
    assert found.tenant_id == fresh_tenants.a.tenant_id


@pytest.mark.parametrize("token", ["", "made-up", "x" * 500])
def test_lookup_of_an_unknown_token_finds_nothing(
    app_engine: Engine, fresh_tenants: TwoTenants, token: str
) -> None:
    with transaction(app_engine) as db:
        _user(db, fresh_tenants)
    with transaction(app_engine) as db:
        assert sessions.lookup(db, token, now=NOW) is None


@pytest.mark.parametrize(
    ("operator", "idle", "absolute"),
    [
        (False, timedelta(days=30), timedelta(days=90)),
        (True, timedelta(hours=12), timedelta(days=7)),
    ],
    ids=["user", "operator"],
)
def test_lookup_refuses_idle_and_absolute_expiry(
    app_engine: Engine,
    fresh_tenants: TwoTenants,
    operator: bool,
    idle: timedelta,
    absolute: timedelta,
) -> None:
    def create() -> str:
        with transaction(app_engine) as db:
            if operator:
                return sessions.create_operator_session(
                    db, operator_id=fresh_tenants.operator_id, now=NOW
                )[0]
            return _user(db, fresh_tenants)[0]

    unused, token = create(), create()
    with transaction(app_engine) as db:
        assert sessions.lookup(db, unused, now=NOW + idle + timedelta(seconds=1)) is None
    with transaction(app_engine) as db:
        assert sessions.lookup(db, token, now=NOW + idle - timedelta(seconds=1)) is not None

    # Kept active by regular use, it still ends at the absolute limit.
    moment = NOW
    while moment + idle / 2 < NOW + absolute:
        moment += idle / 2
        with transaction(app_engine) as db:
            assert sessions.lookup(db, token, now=moment) is not None
    with transaction(app_engine) as db:
        assert sessions.lookup(db, token, now=NOW + absolute + timedelta(seconds=1)) is None


def test_lookup_slides_idle_expiry_but_writes_at_most_every_five_minutes(
    app_engine: Engine, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    with transaction(app_engine) as db:
        token, record = _user(db, fresh_tenants)

    soon = NOW + timedelta(minutes=4)
    with transaction(app_engine) as db:
        sessions.lookup(db, token, now=soon)
    row = _row(owner_engine, record.id)
    assert row.last_seen_at == NOW
    assert row.idle_expires_at == NOW + timedelta(days=30)

    later = NOW + timedelta(minutes=6)
    with transaction(app_engine) as db:
        found = sessions.lookup(db, token, now=later)
    assert found is not None
    assert found.last_seen_at == later
    row = _row(owner_engine, record.id)
    assert row.last_seen_at == later
    assert row.idle_expires_at == later + timedelta(days=30)
    assert row.absolute_expires_at == NOW + timedelta(days=90)


# ---- revocation and listing -------------------------------------------------------------------


def test_revoked_session_is_not_found(app_engine: Engine, fresh_tenants: TwoTenants) -> None:
    a = fresh_tenants.a
    with transaction(app_engine) as db:
        token, record = _user(db, fresh_tenants)
    with transaction(app_engine) as db:
        assert sessions.revoke(db, record.id, user_id=a.user_id) is True
    with transaction(app_engine) as db:
        assert sessions.lookup(db, token) is None
        assert sessions.revoke(db, record.id, user_id=a.user_id) is False


def test_revoke_one_only_touches_the_given_users_session(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    b = fresh_tenants.b
    with transaction(app_engine) as db:
        token, record = _user(db, fresh_tenants)
    with transaction(app_engine) as db:
        # Another user (even in another business) cannot end it by guessing its id.
        assert sessions.revoke(db, record.id, user_id=b.user_id) is False
    with transaction(app_engine) as db:
        assert sessions.lookup(db, token) is not None


def test_revoke_needs_exactly_one_owner(app_engine: Engine, fresh_tenants: TwoTenants) -> None:
    with transaction(app_engine) as db:
        with pytest.raises(ValueError):
            sessions.revoke(db, uuid.uuid4())
        with pytest.raises(ValueError):
            sessions.revoke(db, uuid.uuid4(), user_id=uuid.uuid4(), operator_id=uuid.uuid4())


def test_operator_session_can_be_revoked(app_engine: Engine, fresh_tenants: TwoTenants) -> None:
    with transaction(app_engine) as db:
        token, record = sessions.create_operator_session(db, operator_id=fresh_tenants.operator_id)
    with transaction(app_engine) as db:
        assert sessions.revoke(db, record.id, operator_id=fresh_tenants.operator_id) is True
    with transaction(app_engine) as db:
        assert sessions.lookup(db, token) is None


def test_revoke_all_for_a_user(app_engine: Engine, fresh_tenants: TwoTenants) -> None:
    a, b = fresh_tenants.a, fresh_tenants.b
    with transaction(app_engine) as db:
        tokens = [_user(db, fresh_tenants)[0] for _ in range(3)]
        other, _ = sessions.create_user_session(db, user_id=b.user_id, tenant_id=b.tenant_id)
    with transaction(app_engine) as db:
        assert sessions.revoke_all_for_user(db, a.user_id) == 3
    with transaction(app_engine) as db:
        assert all(sessions.lookup(db, t) is None for t in tokens)
        assert sessions.lookup(db, other) is not None


def test_revoke_all_except_the_current_one(app_engine: Engine, fresh_tenants: TwoTenants) -> None:
    a = fresh_tenants.a
    with transaction(app_engine) as db:
        keep_token, keep = _user(db, fresh_tenants)
        others = [_user(db, fresh_tenants)[0] for _ in range(2)]
    with transaction(app_engine) as db:
        assert sessions.revoke_others_for_user(db, a.user_id, keep.id) == 2
    with transaction(app_engine) as db:
        assert sessions.lookup(db, keep_token) is not None
        assert all(sessions.lookup(db, t) is None for t in others)


def test_list_shows_only_the_users_live_sessions(
    app_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    a, b = fresh_tenants.a, fresh_tenants.b
    real_now = datetime.now(UTC)
    with transaction(app_engine) as db:
        _, live = _user(db, fresh_tenants, now=real_now, user_agent="Phone")
        _, revoked = _user(db, fresh_tenants, now=real_now)
        _, expired = _user(db, fresh_tenants, now=real_now - timedelta(days=31))
        sessions.create_user_session(db, user_id=b.user_id, tenant_id=b.tenant_id)
        sessions.revoke(db, revoked.id, user_id=a.user_id)

    with transaction(app_engine) as db:
        listed = sessions.list_for_user(db, a.user_id)

    assert [s.id for s in listed] == [live.id]
    assert listed[0].user_agent == "Phone"
    assert expired.id not in {s.id for s in listed}


# ---- cookies --------------------------------------------------------------------------------


@pytest.mark.parametrize("secure", [True, False])
@pytest.mark.parametrize(
    ("operator", "name", "max_age"),
    [(False, "bos_session", 90 * 86400), (True, "bos_ops_session", 7 * 86400)],
    ids=["user", "operator"],
)
def test_session_cookie_attributes(
    app: Flask, config: Config, secure: bool, operator: bool, name: str, max_age: int
) -> None:
    cfg = dataclasses.replace(config, cookie_secure=secure)
    response = app.response_class()

    sessions.set_session_cookie(response, "tok", operator=operator, config=cfg)

    header = response.headers["Set-Cookie"]
    assert header.startswith(f"{name}=tok;")
    assert "HttpOnly" in header
    assert "SameSite=Lax" in header
    assert "Path=/" in header
    assert f"Max-Age={max_age}" in header
    assert ("Secure" in header) is secure


@pytest.mark.parametrize("operator", [False, True])
def test_clearing_the_session_cookie(app: Flask, config: Config, operator: bool) -> None:
    response = app.response_class()

    sessions.clear_session_cookie(response, operator=operator, config=config)

    header = response.headers["Set-Cookie"]
    assert header.startswith(f"{sessions.cookie_name(operator=operator)}=;")
    assert "Max-Age=0" in header
    assert "HttpOnly" in header
