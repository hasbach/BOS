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
        "warehouses",
        "products",
        "product_stores",
        "product_options",
        "option_values",
        "variants",
        "inventory_items",
        "stock_balances",
        "stock_movements",
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
    recorded["staged_photos_deleted"] = 0  # M1: the per-business step (T051)
    recorded["expired_import_batches_deleted"] = 0  # M1: no import batches in this scenario
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
        # Every business has exactly one default warehouse (FR-011, research R39).
        warehouses = _rows(
            owner_engine, "SELECT name, is_default FROM warehouses WHERE tenant_id = :t", t=demo.id
        )
        assert [(w.name, w.is_default) for w in warehouses] == [("Main", True)]
        history = _rows(
            owner_engine,
            "SELECT event, actor_type, actor_id, target_type, target_id FROM audit_entries "
            "WHERE tenant_id = :t ORDER BY event, target_id",
            t=demo.id,
        )
        setup_history = [h for h in history if h.event != "product.created"]
        assert sorted((h.event, h.target_id) for h in setup_history) == sorted(
            [("tenant.created", demo.id)] + [("store.created", s.id) for s in stores]
        )
        assert {(h.actor_type, h.actor_id) for h in setup_history} == {("system", None)}
        products = _rows(owner_engine, "SELECT id FROM products WHERE tenant_id = :t", t=demo.id)
        owner = next(u for u in demo.users if u.role == "owner")
        assert [
            (h.target_id, h.actor_type, h.actor_id) for h in history if h.event == "product.created"
        ] == [(product.id, "user", owner.id) for product in sorted(products)]

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


@pytest.mark.usefixtures("integrity_check")
def test_seed_demo_catalog_shows_low_and_out_of_stock_across_both_stores(
    app: Flask, owner_engine: Engine, clean_db: None
) -> None:
    result = _run(app, "seed-demo", env={**ALLOW_SEED, "BOS_DEMO_PASSWORD": STRONG})
    assert result.exit_code == 0, result.output
    denim = seed.DEMO_TENANTS[0]
    [count] = _rows(owner_engine, "SELECT count(*) FROM products WHERE tenant_id = :t", t=denim.id)
    assert count[0] == 8
    assert set(_rows(owner_engine, "SELECT DISTINCT store_id FROM product_stores")) == {
        (store.id,) for store in denim.stores
    }
    stock = _rows(
        owner_engine,
        "SELECT b.on_hand, COALESCE(v.low_stock_level, t.low_stock_default) AS level, "
        "m.reason, m.quantity, m.on_hand_after FROM variants v "
        "JOIN tenants t ON t.id = v.tenant_id "
        "JOIN stock_balances b ON b.inventory_item_id = v.inventory_item_id "
        "LEFT JOIN stock_movements m ON m.inventory_item_id = b.inventory_item_id "
        "WHERE v.tenant_id = :t",
        t=denim.id,
    )
    assert sum(s.on_hand == 0 for s in stock) == 1
    assert sum(0 < s.on_hand <= s.level for s in stock) == 1
    assert any(s.on_hand > s.level for s in stock)
    for s in stock:
        assert (s.reason, s.quantity, s.on_hand_after) == (
            ("opening", s.on_hand, s.on_hand) if s.on_hand else (None, None, None)
        )


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


# ---- seed-catalog (M1 T104) --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("environment", "allow", "error"),
    [
        ("development", "", "BOS_ALLOW_DEMO_SEED=true"),
        ("development", "1", "BOS_ALLOW_DEMO_SEED=true"),
        ("staging", "true", "BOS_ENVIRONMENT=development"),
        ("production", "true", "BOS_ENVIRONMENT=development"),
    ],
)
def test_seed_catalog_refuses_without_both_development_guards(
    app: Flask, owner_engine: Engine, clean_db: None, environment: str, allow: str, error: str
) -> None:
    app.extensions["bos_config"] = dataclasses.replace(
        app.extensions["bos_config"], environment=environment
    )
    result = _run(
        app,
        "seed-catalog",
        "--variants",
        "5",
        "--tenant",
        str(seed.DEMO_TENANTS[0].id),
        env={"BOS_ALLOW_DEMO_SEED": allow},
    )
    assert result.exit_code != 0
    assert error in result.output
    assert _rows(owner_engine, "SELECT id FROM products") == []


@pytest.mark.usefixtures("integrity_check")
@pytest.mark.parametrize(("variants", "full_products", "remainder"), [(7, 1, 2), (5000, 1000, 0)])
def test_seed_catalog_creates_exact_variant_count_with_opening_stock(
    app: Flask,
    owner_engine: Engine,
    clean_db: None,
    variants: int,
    full_products: int,
    remainder: int,
) -> None:
    app.extensions["bos_config"] = dataclasses.replace(
        app.extensions["bos_config"], environment="development"
    )
    # The second demo business starts empty; the first already has its demo catalog.
    setup = _run(app, "seed-demo", env={**ALLOW_SEED, "BOS_DEMO_PASSWORD": STRONG})
    assert setup.exit_code == 0, setup.output
    other, target = seed.DEMO_TENANTS
    before = _rows(
        owner_engine, "SELECT id FROM products WHERE tenant_id = :t ORDER BY id", t=other.id
    )
    result = _run(
        app, "seed-catalog", "--variants", str(variants), "--tenant", str(target.id), env=ALLOW_SEED
    )
    assert result.exit_code == 0, result.output or repr(result.exception)
    assert str(variants) in result.output
    assert (
        _rows(owner_engine, "SELECT id FROM products WHERE tenant_id = :t ORDER BY id", t=other.id)
        == before
    )

    counts = _rows(
        owner_engine,
        "SELECT count(v.id) FROM products p LEFT JOIN variants v ON v.product_id = p.id "
        "WHERE p.tenant_id = :t GROUP BY p.id ORDER BY count(v.id)",
        t=target.id,
    )
    assert [n for (n,) in counts] == ([remainder] if remainder else []) + [5] * full_products
    assert _rows(
        owner_engine,
        "SELECT count(*) FROM variants v "
        "JOIN stock_balances b ON b.inventory_item_id = v.inventory_item_id "
        "JOIN stock_movements m ON m.inventory_item_id = v.inventory_item_id "
        "WHERE v.tenant_id = :t AND m.reason = 'opening' AND m.quantity = b.on_hand "
        "AND m.on_hand_after = b.on_hand AND b.on_hand > 0 AND b.allocated = 0",
        t=target.id,
    ) == [(variants,)]
    [store] = _rows(owner_engine, "SELECT id FROM stores WHERE tenant_id = :t", t=target.id)
    seeded = _rows(
        owner_engine,
        "SELECT p.id, p.code, count(v.id) AS variants, sum(b.on_hand) AS opening_units "
        "FROM products p JOIN variants v ON v.product_id = p.id "
        "JOIN stock_balances b ON b.inventory_item_id = v.inventory_item_id "
        "WHERE p.tenant_id = :t GROUP BY p.id ORDER BY p.id",
        t=target.id,
    )
    entries = _rows(
        owner_engine,
        "SELECT actor_type, actor_id, target_type, target_id, data FROM audit_entries "
        "WHERE tenant_id = :t AND event = 'product.created' ORDER BY target_id",
        t=target.id,
    )
    assert len(entries) == len(seeded)
    for entry, product in zip(entries, seeded, strict=True):
        assert (entry.actor_type, entry.actor_id) == ("system", None)
        assert (entry.target_type, entry.target_id) == ("product", product.id)
        assert entry.data == {
            "code": product.code,
            "source": "seed-catalog",
            "variants": product.variants,
            "store_ids": [str(store.id)],
            "opening_units": product.opening_units,
        }


@pytest.mark.parametrize(
    ("variants", "tenant", "error"),
    [
        ("0", "existing", "Invalid value for '--variants'"),
        ("5", "not-a-uuid", "not a business id"),
        ("5", str(uuid.UUID(int=7)), "No demo business"),
        ("5", "existing", "No demo business"),
    ],
)
def test_seed_catalog_refuses_invalid_arguments_or_non_demo_target(
    app: Flask,
    owner_engine: Engine,
    fresh_tenants: TwoTenants,
    variants: str,
    tenant: str,
    error: str,
) -> None:
    app.extensions["bos_config"] = dataclasses.replace(
        app.extensions["bos_config"], environment="development"
    )
    if tenant == "existing":
        tenant = str(fresh_tenants.a.tenant_id)
    before = _snapshot(owner_engine)
    result = _run(app, "seed-catalog", "--variants", variants, "--tenant", tenant, env=ALLOW_SEED)
    assert result.exit_code != 0
    assert error in result.output
    assert _snapshot(owner_engine) == before


# ---- stock-check (M1 T073, FR-022, R45) -----------------------------------------------------------


def _report_lines(output: str, tenant_id: uuid.UUID) -> list[str]:
    """The lines about one business: its summary line and the problems listed under it."""
    lines = output.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(f"business {tenant_id}"))
    block = [lines[start]]
    for line in lines[start + 1 :]:
        if not line.startswith("  "):
            break
        block.append(line)
    return block


def test_stock_check_reports_0_differences_for_every_business(
    app: Flask, owner_engine: Engine, fresh_catalog_tenants: TwoTenants
) -> None:
    worlds = fresh_catalog_tenants

    result = _run(app, "stock-check")

    assert result.exit_code == 0, result.output
    # Both businesses are found although row-level security is forced on ``tenants``.
    for world in (worlds.a, worlds.b):
        assert _report_lines(result.output, world.tenant_id) == [
            f"business {world.tenant_id} (Tenant {world.label}): 0 differences"
        ]


def test_stock_check_lists_each_difference_and_exits_non_zero(
    app: Flask, owner_engine: Engine, fresh_catalog_tenants: TwoTenants
) -> None:
    a, b = fresh_catalog_tenants.a, fresh_catalog_tenants.b
    item = a.catalog.item_id
    with owner_engine.begin() as conn:
        # On hand 5 -> 7 without a movement; allocated 1 -> 2 without an allocation line.
        conn.execute(
            text(
                "UPDATE stock_balances SET on_hand = 7, allocated = 2 WHERE inventory_item_id = :i"
            ),
            {"i": item},
        )

    result = _run(app, "stock-check")

    assert result.exit_code != 0
    assert _report_lines(result.output, a.tenant_id) == [
        f"business {a.tenant_id} (Tenant a): 3 differences",
        f"  rule 2 (on hand equals the sum of movements) broken for item {item}: "
        "expected 5, found 7",
        f"  rule 3 (on hand equals the latest movement's on hand after) broken for item {item}: "
        "expected 5, found 7",
        f"  rule 4 (allocated equals the active allocation lines) broken for item {item}: "
        "expected 1, found 2",
    ]
    assert _report_lines(result.output, b.tenant_id) == [
        f"business {b.tenant_id} (Tenant b): 0 differences"
    ]
    assert "1 business(es) with differences" in result.output


def test_stock_check_can_check_one_business(
    app: Flask, owner_engine: Engine, fresh_catalog_tenants: TwoTenants
) -> None:
    a, b = fresh_catalog_tenants.a, fresh_catalog_tenants.b
    with owner_engine.begin() as conn:
        conn.execute(
            text("UPDATE stock_balances SET on_hand = 9 WHERE inventory_item_id = :i"),
            {"i": b.catalog.item_id},
        )

    only_a = _run(app, "stock-check", "--tenant", str(a.tenant_id))
    only_b = _run(app, "stock-check", "--tenant", str(b.tenant_id))

    assert only_a.exit_code == 0, only_a.output
    assert f"business {a.tenant_id}" in only_a.output
    assert str(b.tenant_id) not in only_a.output
    assert only_b.exit_code != 0
    assert str(a.tenant_id) not in only_b.output


@pytest.mark.parametrize("tenant", ["not-a-uuid", str(uuid.UUID(int=7))])
def test_stock_check_refuses_an_unknown_business(
    app: Flask, fresh_catalog_tenants: TwoTenants, tenant: str
) -> None:
    result = _run(app, "stock-check", "--tenant", tenant)

    assert result.exit_code != 0
    assert "differences" not in result.output
