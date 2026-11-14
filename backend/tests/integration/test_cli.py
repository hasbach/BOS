"""T030 — operations commands: ``flask bos create-operator``, ``maintenance``, ``seed-demo``.

The commands commit, so every test starts from and leaves an empty database (``clean_db``)
or uses ``fresh_tenants``.
"""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from click.testing import Result
from flask import Flask
from sqlalchemy import Engine, text

from app import create_app
from app.config import Config
from app.core.db import engine_of
from app.core.identifiers import normalize_email, normalize_phone
from app.core.security import verify_password
from app.services import seed
from tests.dbsupport import TwoTenants, truncate_all

OPS_EMAIL = "ops.person@example.test"
STRONG = "correct horse battery"
OTHER_STRONG = "another long passphrase"
ALLOW_SEED = {"BOS_ALLOW_DEMO_SEED": "true"}


@pytest.fixture()
def app(config: Config) -> Iterator[Flask]:
    application = create_app(dataclasses.replace(config, operator_emails=frozenset({OPS_EMAIL})))
    yield application
    engine_of(application).dispose()


@pytest.fixture()
def clean_db(owner_engine: Engine) -> Iterator[None]:
    truncate_all(owner_engine)
    yield
    truncate_all(owner_engine)


def _run(app: Flask, *args: str, env: dict[str, str] | None = None) -> Result:
    environment = {
        "BOS_OPERATOR_PASSWORD": "",
        "BOS_DEMO_PASSWORD": "",
        "BOS_ALLOW_DEMO_SEED": "",
        **(env or {}),
    }
    return app.test_cli_runner().invoke(args=["bos", *args], env=environment)


def _rows(owner: Engine, sql: str, **params: Any) -> list[Any]:
    with owner.connect() as conn:
        return conn.execute(text(sql), params).all()


def _snapshot(owner: Engine) -> dict[str, list[Any]]:
    tables = [
        "operators",
        "tenants",
        "stores",
        "users",
        "user_stores",
        "invitations",
        "invitation_codes",
        "password_resets",
        "files",
        "sessions",
        "login_attempts",
        "idempotency_keys",
        "audit_entries",
    ]
    with owner.connect() as conn:
        return {
            table: sorted(
                (tuple(map(str, row)) for row in conn.execute(text(f"SELECT * FROM {table}"))),  # noqa: S608
            )
            for table in tables
        }


# ---- create-operator --------------------------------------------------------------------------


def test_create_operator_refuses_an_email_not_on_the_allow_list(
    app: Flask, owner_engine: Engine, clean_db: None
) -> None:
    result = _run(
        app,
        "create-operator",
        "--email",
        "stranger@example.test",
        env={"BOS_OPERATOR_PASSWORD": STRONG},
    )

    assert result.exit_code != 0
    assert "allow-list" in result.output
    assert _rows(owner_engine, "SELECT id FROM operators") == []


def test_create_operator_needs_the_password_in_the_environment(
    app: Flask, owner_engine: Engine, clean_db: None
) -> None:
    result = _run(app, "create-operator", "--email", OPS_EMAIL)

    assert result.exit_code != 0
    assert "BOS_OPERATOR_PASSWORD" in result.output
    assert _rows(owner_engine, "SELECT id FROM operators") == []


def test_create_operator_has_no_password_option(app: Flask, clean_db: None) -> None:
    result = _run(app, "create-operator", "--email", OPS_EMAIL, "--password", STRONG)

    assert result.exit_code == 2  # usage error: the option does not exist


def test_create_operator_refuses_a_weak_password(
    app: Flask, owner_engine: Engine, clean_db: None
) -> None:
    result = _run(
        app, "create-operator", "--email", OPS_EMAIL, env={"BOS_OPERATOR_PASSWORD": "short"}
    )

    assert result.exit_code != 0
    assert "weak" in result.output.lower()
    assert "short" not in result.output
    assert _rows(owner_engine, "SELECT id FROM operators") == []


def test_create_operator_creates_then_updates_the_password(
    app: Flask, owner_engine: Engine, clean_db: None
) -> None:
    created = _run(
        app,
        "create-operator",
        "--email",
        "  Ops.Person@Example.TEST ",
        "--name",
        "Platform Person",
        env={"BOS_OPERATOR_PASSWORD": STRONG},
    )

    assert created.exit_code == 0, created.output
    [operator] = _rows(
        owner_engine, "SELECT id, email, name, password_hash, is_active FROM operators"
    )
    assert (operator.email, operator.name, operator.is_active) == (
        OPS_EMAIL,
        "Platform Person",
        True,
    )
    assert verify_password(operator.password_hash, STRONG)
    assert str(operator.id) in created.output
    assert "created" in created.output
    assert STRONG not in created.output

    updated = _run(
        app, "create-operator", "--email", OPS_EMAIL, env={"BOS_OPERATOR_PASSWORD": OTHER_STRONG}
    )

    assert updated.exit_code == 0, updated.output
    [after] = _rows(owner_engine, "SELECT id, name, password_hash FROM operators")
    assert after.id == operator.id
    assert after.name == "Platform Person"  # kept when --name is not given
    assert verify_password(after.password_hash, OTHER_STRONG)
    assert not verify_password(after.password_hash, STRONG)
    assert "updated" in updated.output
    assert OTHER_STRONG not in updated.output


# ---- maintenance ------------------------------------------------------------------------------


def _arrange_expired_and_live_rows(owner: Engine, worlds: TwoTenants) -> None:
    a, b = worlds.a, worlds.b
    with owner.begin() as conn:
        # A's invitation has expired; B's has not.
        conn.execute(
            text(
                "UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE tenant_id = :t"
            ),
            {"t": a.tenant_id},
        )
        # One ended session, one live one.
        for user, tenant, idle in (
            (a.user_id, a.tenant_id, "-1 minute"),
            (b.user_id, b.tenant_id, "1 day"),
        ):
            conn.execute(
                text(
                    "INSERT INTO sessions (id, user_id, tenant_id, token_hash, idle_expires_at, "
                    "absolute_expires_at) VALUES (:id, :u, :t, :h, now() + CAST(:idle AS interval), "
                    "now() + interval '9 days')"
                ),
                {"id": uuid.uuid4(), "u": user, "t": tenant, "h": uuid.uuid4().bytes, "idle": idle},
            )
        conn.execute(
            text(
                "INSERT INTO login_attempts (identifier_hash, success, at) VALUES "
                "('\\x01', false, now() - interval '31 days'), ('\\x02', false, now())"
            )
        )
        conn.execute(
            text(
                "UPDATE idempotency_keys SET created_at = now() - interval '25 hours' "
                "WHERE tenant_id = :t"
            ),
            {"t": a.tenant_id},
        )
        conn.execute(
            text(
                "UPDATE password_resets SET expires_at = now() - interval '31 days' "
                "WHERE tenant_id = :t"
            ),
            {"t": a.tenant_id},
        )


def test_maintenance_removes_only_what_has_expired_and_records_the_run(
    app: Flask, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    a, b = fresh_tenants.a, fresh_tenants.b
    _arrange_expired_and_live_rows(owner_engine, fresh_tenants)
    before = _snapshot(owner_engine)

    result = _run(app, "maintenance")

    assert result.exit_code == 0, result.output
    expected = {
        "invitations_expired": 1,
        "sessions_deleted": 1,
        "login_attempts_deleted": 1,
        "idempotency_keys_deleted": 1,
        "password_resets_deleted": 1,
    }
    for name, count in expected.items():
        assert f"{name}: {count}" in result.output
    after = _snapshot(owner_engine)

    # Business data is untouched.
    for table in ("operators", "tenants", "stores", "users", "user_stores", "files"):
        assert after[table] == before[table], table
    assert _rows(owner_engine, "SELECT tenant_id, status FROM invitations ORDER BY status") == [
        (a.tenant_id, "expired"),
        (b.tenant_id, "pending"),
    ]
    assert [r.user_id for r in _rows(owner_engine, "SELECT user_id FROM sessions")] == [b.user_id]
    assert [
        bytes(r.identifier_hash)
        for r in _rows(owner_engine, "SELECT identifier_hash FROM login_attempts")
    ] == [b"\x02"]
    assert [r.tenant_id for r in _rows(owner_engine, "SELECT tenant_id FROM idempotency_keys")] == [
        b.tenant_id
    ]
    assert [r.tenant_id for r in _rows(owner_engine, "SELECT tenant_id FROM password_resets")] == [
        b.tenant_id
    ]

    # History: the old entries are all still there, plus one platform-level run entry.
    assert set(before["audit_entries"]) <= set(after["audit_entries"])
    [run] = _rows(
        owner_engine,
        "SELECT tenant_id, actor_type, actor_id, data FROM audit_entries WHERE event = 'maintenance.run'",
    )
    assert (run.tenant_id, run.actor_type, run.actor_id) == (None, "system", None)
    # History refuses keys mentioning passwords, so that one count is recorded renamed.
    recorded = dict(expected)
    recorded["resets_deleted"] = recorded.pop("password_resets_deleted")
    assert run.data == recorded
    assert len(after["audit_entries"]) == len(before["audit_entries"]) + 1


def test_maintenance_with_nothing_to_do_still_records_the_run(
    app: Flask, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    before = _snapshot(owner_engine)

    result = _run(app, "maintenance")

    assert result.exit_code == 0, result.output
    after = _snapshot(owner_engine)
    for table, rows in before.items():
        if table != "audit_entries":
            assert after[table] == rows, table
    [run] = _rows(owner_engine, "SELECT data FROM audit_entries WHERE event = 'maintenance.run'")
    assert set(run.data.values()) == {0}


# ---- seed-demo --------------------------------------------------------------------------------


@pytest.mark.parametrize("allow", [None, "", "false", "1"], ids=["unset", "empty", "false", "one"])
def test_seed_demo_refuses_unless_explicitly_allowed(
    app: Flask, owner_engine: Engine, clean_db: None, allow: str | None
) -> None:
    env = {"BOS_DEMO_PASSWORD": STRONG}
    if allow is not None:
        env["BOS_ALLOW_DEMO_SEED"] = allow

    result = _run(app, "seed-demo", env=env)

    assert result.exit_code != 0
    assert "BOS_ALLOW_DEMO_SEED" in result.output
    assert "production" in result.output
    assert STRONG not in result.output
    assert _rows(owner_engine, "SELECT id FROM tenants") == []
    assert _rows(owner_engine, "SELECT id FROM operators") == []
    assert _rows(owner_engine, "SELECT id FROM users") == []


def test_seed_demo_accepts_true_in_any_case(
    app: Flask, owner_engine: Engine, clean_db: None
) -> None:
    result = _run(
        app, "seed-demo", env={"BOS_DEMO_PASSWORD": STRONG, "BOS_ALLOW_DEMO_SEED": "TRUE"}
    )

    assert result.exit_code == 0, result.output


@pytest.mark.parametrize("password", ["", "weak"], ids=["missing", "weak"])
def test_seed_demo_needs_a_strong_password_from_the_environment(
    app: Flask, owner_engine: Engine, clean_db: None, password: str
) -> None:
    result = _run(app, "seed-demo", env={**ALLOW_SEED, "BOS_DEMO_PASSWORD": password})

    assert result.exit_code != 0
    assert "BOS_DEMO_PASSWORD" in result.output
    assert _rows(owner_engine, "SELECT id FROM tenants") == []
    assert _rows(owner_engine, "SELECT id FROM operators") == []


def test_seed_demo_creates_exactly_the_documented_rows(
    app: Flask, owner_engine: Engine, clean_db: None
) -> None:
    result = _run(app, "seed-demo", env={**ALLOW_SEED, "BOS_DEMO_PASSWORD": STRONG})

    assert result.exit_code == 0, result.output
    assert STRONG not in result.output

    # The seed operator exists only to be the creator; it can never sign in.
    [operator] = _rows(owner_engine, "SELECT id, email, password_hash, is_active FROM operators")
    assert operator.email == seed.SEED_OPERATOR_EMAIL
    assert operator.email not in app.extensions["bos_config"].operator_emails
    assert operator.is_active is False
    assert not verify_password(operator.password_hash, STRONG)
    assert not verify_password(operator.password_hash, "")

    tenants = _rows(
        owner_engine,
        "SELECT id, name, edition, status, is_demo, usd_lbp_rate, created_by_operator_id "
        "FROM tenants ORDER BY name",
    )
    assert [(t.name, t.edition, t.status, t.is_demo, str(t.usd_lbp_rate)) for t in tenants] == [
        ("Demo Denim House Group", "commerce", "active", True, "89500.00"),
        ("Demo Second Shop", "social", "active", True, "89500.00"),
    ]
    assert {t.created_by_operator_id for t in tenants} == {operator.id}

    for demo in seed.DEMO_TENANTS:
        stores = _rows(
            owner_engine,
            "SELECT id, name, whatsapp_e164, status FROM stores WHERE tenant_id = :t ORDER BY name",
            t=demo.id,
        )
        assert [(s.name, s.whatsapp_e164, s.status) for s in stores] == [
            (s.name, s.whatsapp, "active") for s in sorted(demo.stores, key=lambda s: s.name)
        ]
        users = _rows(
            owner_engine,
            "SELECT id, name, email, phone_e164, roles, all_stores, status, locale, password_hash "
            "FROM users WHERE tenant_id = :t ORDER BY email",
            t=demo.id,
        )
        assert [(u.email, u.phone_e164, u.roles, u.all_stores, u.status) for u in users] == [
            (u.email, u.phone, [u.role], u.store is None, "active")
            for u in sorted(demo.users, key=lambda u: u.email)
        ]
        for user in users:
            assert verify_password(user.password_hash, STRONG)
            # Usable exactly as typed on the sign-in screen.
            assert normalize_email(user.email) == user.email
            assert normalize_phone(user.phone_e164) == user.phone_e164
            assert user.email in result.output
            assert user.phone_e164 in result.output
        for store in demo.stores:
            assert normalize_phone(store.whatsapp) == store.whatsapp
        history = _rows(
            owner_engine,
            "SELECT event, actor_type, actor_id, target_type, target_id FROM audit_entries "
            "WHERE tenant_id = :t ORDER BY event, target_id",
            t=demo.id,
        )
        assert sorted((h.event, h.target_id) for h in history) == sorted(
            [("tenant.created", demo.id)] + [("store.created", s.id) for s in stores]
        )
        assert {(h.actor_type, h.actor_id) for h in history} == {("system", None)}

    denim = seed.DEMO_TENANTS[0]
    limited = _rows(
        owner_engine,
        "SELECT u.email, s.name FROM user_stores us JOIN users u ON u.id = us.user_id "
        "JOIN stores s ON s.id = us.store_id",
    )
    assert [(row.email, row.name) for row in limited] == [
        ("sales-store-a@demo.bos.test", "Store A")
    ]
    assert sorted(u.role for u in denim.users) == sorted(
        ["owner", "manager", "sales", "packing", "dispatch", "sales"]
    )
    # Nothing else was created.
    for table in (
        "invitations",
        "invitation_codes",
        "password_resets",
        "files",
        "sessions",
        "idempotency_keys",
    ):
        assert _rows(owner_engine, f"SELECT 1 FROM {table}") == [], table  # noqa: S608
    assert _rows(owner_engine, "SELECT 1 FROM audit_entries WHERE tenant_id IS NULL") == []


def test_seed_demo_twice_changes_nothing_the_second_time(
    app: Flask, owner_engine: Engine, clean_db: None
) -> None:
    first = _run(app, "seed-demo", env={**ALLOW_SEED, "BOS_DEMO_PASSWORD": STRONG})
    assert first.exit_code == 0, first.output
    before = _snapshot(owner_engine)

    second = _run(app, "seed-demo", env={**ALLOW_SEED, "BOS_DEMO_PASSWORD": OTHER_STRONG})

    assert second.exit_code == 0, second.output
    assert "nothing changed" in second.output.lower()
    assert _snapshot(owner_engine) == before


def test_seed_demo_leaves_other_businesses_alone(
    app: Flask, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    before = _snapshot(owner_engine)

    result = _run(app, "seed-demo", env={**ALLOW_SEED, "BOS_DEMO_PASSWORD": STRONG})

    assert result.exit_code == 0, result.output
    after = _snapshot(owner_engine)
    for table, rows in before.items():
        assert set(rows) <= set(after[table]), table
    demo_ids = {str(t.id) for t in seed.DEMO_TENANTS}
    assert {row[0] for row in after["tenants"]} - {row[0] for row in before["tenants"]} == demo_ids
