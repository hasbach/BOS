"""T007 — ``local_api.py purge-test-businesses`` (R57, development database clean-up).

Only non-demo businesses named ``E2E Business …`` are selected; the command refuses any
database but ``POSTGRES_DB`` on 127.0.0.1 (the test database included), only lists what it
would remove unless given ``--yes``, and prints what it removed. A fake connection stands in
for PostgreSQL: these tests never touch a database.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import pytest

from scripts import local_api

ENV = {
    "POSTGRES_USER": "bos_owner",
    "POSTGRES_PASSWORD": "owner-pw",
    "POSTGRES_DB": "bos",
    "BOS_APP_DB_USER": "bos_app",
    "BOS_APP_DB_PASSWORD": "app-pw",
    "BOS_TEST_DB": "bos_test",
    "BOS_LOCAL_DB_PORT": "55433",
    "BOS_SECRET_KEY": "x" * 40,
}

E2E_1 = uuid.uuid4()
E2E_2 = uuid.uuid4()
DEMO_E2E = uuid.uuid4()
DEMO = uuid.uuid4()
OTHER = uuid.uuid4()

TENANTS = [
    (E2E_1, "E2E Business 1731", False),
    (E2E_2, "E2E Business abc-def", False),
    (DEMO_E2E, "E2E Business demo", True),  # a demo business is never selected
    (DEMO, "Demo Boutique", True),
    (OTHER, "T090 Warm 12", False),  # other test leftovers are not this command's job
    (uuid.uuid4(), "My E2E Business", False),
    (uuid.uuid4(), "E2E Businesses", False),
    (uuid.uuid4(), "e2e business 5", False),
]

TENANT_TABLES = ["audit_entries", "users", "stores", "files", "sessions", "idempotency_keys"]
# M1 (migration 0003): every catalog and stock table has a tenant_id column too.
CATALOG_TABLES = [
    "warehouses",
    "import_batches",
    "products",
    "product_stores",
    "product_options",
    "option_values",
    "product_photos",
    "inventory_items",
    "variants",
    "stock_balances",
    "allocations",
    "allocation_lines",
    "stock_movements",
]
TENANT_TABLES += CATALOG_TABLES


class FakeResult:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows
        self.rowcount = len(rows)

    def all(self) -> list[tuple[Any, ...]]:
        return self._rows


class FakeConnection:
    """Answers the purge's queries the way PostgreSQL would and records every statement."""

    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any]]] = []

    def execute(self, statement: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(statement).split())
        self.statements.append((sql, dict(params or {})))
        if "FROM tenants" in sql and sql.startswith("SELECT"):
            # Mirrors the LIKE filter; the Python check is tested on top of it.
            pattern = params["pattern"] if params else ""
            prefix = pattern.rstrip("%")
            return FakeResult([row for row in TENANTS if row[1].startswith(prefix)])
        if sql.startswith("SELECT count"):
            return FakeResult([(3,)])
        if "information_schema.columns" in sql:
            return FakeResult([(name,) for name in TENANT_TABLES])
        if sql.startswith("DELETE"):
            ids = (params or {}).get("ids", [])
            return FakeResult([(i,) for i in ids])
        return FakeResult([])

    def deletes(self) -> list[tuple[str, dict[str, Any]]]:
        return [(sql, p) for sql, p in self.statements if sql.startswith("DELETE")]


# --- Selection -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "is_demo", "selected"),
    [
        ("E2E Business 1", False, True),
        ("E2E Business x y z", False, True),
        ("E2E Business 1", True, False),
        ("Demo Boutique", True, False),
        ("Demo Boutique", False, False),
        ("My E2E Business 1", False, False),
        ("E2E Businesses", False, False),
        ("E2E Business", False, False),
        ("e2e business 1", False, False),
    ],
)
def test_only_non_demo_e2e_businesses_are_test_businesses(
    name: str, is_demo: bool, selected: bool
) -> None:
    assert local_api.is_test_business(name, is_demo) is selected


def test_selection_returns_only_non_demo_e2e_businesses() -> None:
    conn = FakeConnection()

    selected = local_api.select_test_businesses(conn)

    assert [business.id for business in selected] == [E2E_1, E2E_2]


# --- Which database ----------------------------------------------------------------------


def test_purge_url_is_the_development_database_as_the_owner() -> None:
    url = local_api.purge_database_url(ENV)

    local_api.check_purge_target(url, ENV)  # does not raise
    assert "@127.0.0.1:55433/bos" in url
    assert url.startswith("postgresql+psycopg://bos_owner:")


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+psycopg://bos_owner:pw@127.0.0.1:55433/bos_test",  # the test database
        "postgresql+psycopg://bos_owner:pw@127.0.0.1:55433/postgres",
        "postgresql+psycopg://bos_owner:pw@localhost:55433/bos",
        "postgresql+psycopg://bos_owner:pw@db:5432/bos",
        "postgresql+psycopg://bos_owner:pw@10.0.0.5:5432/bos",
        "postgresql+psycopg://bos_owner:pw@127.0.0.1/bos?host=10.0.0.5",
        "postgresql+psycopg://bos_app:pw@127.0.0.1:55433/bos",  # not the owner role
        "sqlite:///bos",
    ],
)
def test_any_other_database_is_refused(url: str) -> None:
    with pytest.raises(SystemExit, match="Refusing"):
        local_api.check_purge_target(url, ENV)


def test_development_database_named_like_the_test_database_is_refused() -> None:
    env = {**ENV, "POSTGRES_DB": "bos_test"}

    with pytest.raises(SystemExit, match="Refusing"):
        local_api.check_purge_target(local_api.purge_database_url(env), env)


# --- The command ------------------------------------------------------------------------


@pytest.fixture()
def run(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[FakeConnection, list[str], Path]:
    """Point the command at a fake .env, a fake database and a temporary upload folder."""
    conn = FakeConnection()
    connected: list[str] = []
    uploads = tmp_path / "bos-dev" / "uploads"
    monkeypatch.setattr(local_api, "read_env_file", lambda _path: dict(ENV))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    class FakeTransaction:
        def __enter__(self) -> FakeConnection:
            return conn

        def __exit__(self, *exc: object) -> None:
            return None

    def owner_transaction(url: str) -> FakeTransaction:
        connected.append(url)
        return FakeTransaction()

    monkeypatch.setattr(local_api, "owner_transaction", owner_transaction)
    for tenant_id in (E2E_1, E2E_2, DEMO_E2E, DEMO, OTHER):
        folder = uploads / "tenant" / str(tenant_id)
        folder.mkdir(parents=True)
        (folder / "logo.webp").write_bytes(b"x")
    return conn, connected, uploads


def test_without_yes_it_lists_and_removes_nothing(
    run: tuple[FakeConnection, list[str], Path], capsys: pytest.CaptureFixture[str]
) -> None:
    conn, _connected, uploads = run

    code = local_api.main(["purge-test-businesses"])

    out = capsys.readouterr().out
    assert code == 0
    assert conn.deletes() == []
    assert not any("session_replication_role" in sql for sql, _ in conn.statements)
    assert "E2E Business 1731" in out and "E2E Business abc-def" in out
    assert "Demo Boutique" not in out and "E2E Business demo" not in out
    assert "--yes" in out
    for tenant_id in (E2E_1, E2E_2):
        assert (uploads / "tenant" / str(tenant_id)).is_dir()


def test_with_yes_it_removes_only_the_selected_businesses_and_their_files(
    run: tuple[FakeConnection, list[str], Path], capsys: pytest.CaptureFixture[str]
) -> None:
    conn, connected, uploads = run

    code = local_api.main(["purge-test-businesses", "--yes"])

    out = capsys.readouterr().out
    assert code == 0
    assert connected == [local_api.purge_database_url(ENV)]
    # Triggers and foreign-key checks are off for this one transaction, before any delete.
    replica = [i for i, (sql, _) in enumerate(conn.statements) if "replica" in sql]
    first_delete = next(i for i, (sql, _) in enumerate(conn.statements) if sql.startswith("DELETE"))
    assert replica and replica[0] < first_delete
    assert "SET LOCAL" in conn.statements[replica[0]][0]

    deleted_tables = set()
    for sql, params in conn.deletes():
        assert set(params["ids"]) == {E2E_1, E2E_2}
        deleted_tables.add(sql.split()[2])
    assert deleted_tables >= {*TENANT_TABLES, "tenants"}
    # History rows go too: this is the only code allowed to remove them.
    assert "audit_entries" in deleted_tables

    for tenant_id in (E2E_1, E2E_2):
        assert not (uploads / "tenant" / str(tenant_id)).exists()
    for tenant_id in (DEMO_E2E, DEMO, OTHER):
        assert (uploads / "tenant" / str(tenant_id) / "logo.webp").is_file()

    assert "E2E Business 1731" in out and "E2E Business abc-def" in out
    assert "Removed 2" in out


def test_catalog_rows_ledger_included_and_product_photo_files_are_removed_too(
    run: tuple[FakeConnection, list[str], Path], capsys: pytest.CaptureFixture[str]
) -> None:
    """T034: the M1 tables and the product photos stored beside the logo go with the business."""
    conn, _connected, uploads = run
    for tenant_id in (E2E_1, DEMO):
        folder = uploads / "tenant" / str(tenant_id)
        (folder / "photo-thumb.webp").write_bytes(b"t")
        (folder / "photo-large.webp").write_bytes(b"l")

    code = local_api.main(["purge-test-businesses", "--yes"])

    assert code == 0
    deleted = {sql.split()[2] for sql, _ in conn.deletes()}
    assert set(CATALOG_TABLES) <= deleted
    # The append-only ledger can only be emptied with triggers switched off first.
    replica = next(i for i, (sql, _) in enumerate(conn.statements) if "replica" in sql)
    ledger = next(
        i
        for i, (sql, _) in enumerate(conn.statements)
        if sql.startswith("DELETE FROM stock_movements")
    )
    assert replica < ledger
    assert not (uploads / "tenant" / str(E2E_1)).exists()
    assert (uploads / "tenant" / str(DEMO) / "photo-thumb.webp").is_file()
    assert (uploads / "tenant" / str(DEMO) / "photo-large.webp").is_file()
    out = capsys.readouterr().out
    assert "stock_movements" in out and "products" in out


def test_with_nothing_to_remove_it_says_so(
    run: tuple[FakeConnection, list[str], Path],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    conn, _connected, _uploads = run
    monkeypatch.setattr(local_api, "select_test_businesses", lambda _conn: [])

    code = local_api.main(["purge-test-businesses", "--yes"])

    assert code == 0
    assert conn.deletes() == []
    assert "No test businesses" in capsys.readouterr().out


def test_the_test_database_is_refused_before_connecting(
    run: tuple[FakeConnection, list[str], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    conn, connected, _uploads = run
    monkeypatch.setattr(
        local_api, "read_env_file", lambda _path: {**ENV, "POSTGRES_DB": ENV["BOS_TEST_DB"]}
    )

    with pytest.raises(SystemExit, match="Refusing"):
        local_api.main(["purge-test-businesses", "--yes"])

    assert connected == []
    assert conn.statements == []


def test_environment_variables_cannot_redirect_the_purge(
    run: tuple[FakeConnection, list[str], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    _conn, connected, _uploads = run
    elsewhere = "postgresql+psycopg://bos_owner:pw@10.0.0.5:5432/bos"
    monkeypatch.setenv("BOS_DATABASE_URL", elsewhere)
    monkeypatch.setenv("BOS_MIGRATION_DATABASE_URL", elsewhere)

    local_api.main(["purge-test-businesses"])

    assert connected == [local_api.purge_database_url(ENV)]


def test_printed_output_holds_no_password(
    run: tuple[FakeConnection, list[str], Path], capsys: pytest.CaptureFixture[str]
) -> None:
    local_api.main(["purge-test-businesses", "--yes"])

    out = capsys.readouterr().out
    assert ENV["POSTGRES_PASSWORD"] not in out
    assert ENV["BOS_APP_DB_PASSWORD"] not in out
