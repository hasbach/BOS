"""T041 — ``flask bos maintenance`` purges staged product photos older than 24 hours (R50).

Each business is purged in its own tenant transaction, files are deleted only after that
transaction commits, attached photos are never touched, and the run records its counts.
"""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from click.testing import Result
from flask import Flask
from sqlalchemy import Engine, text

from app import create_app
from app.config import Config
from app.core.db import engine_of
from tests.dbsupport import TwoTenants, insert
from tests.integration.us1_support import owner_rows

pytestmark = pytest.mark.usefixtures("integrity_check")


@pytest.fixture()
def uploads(tmp_path: Path) -> Path:
    return tmp_path / "uploads"


@pytest.fixture()
def app(config: Config, uploads: Path) -> Iterator[Flask]:
    application = create_app(dataclasses.replace(config, upload_dir=str(uploads)))
    yield application
    engine_of(application).dispose()


def _run(app: Flask) -> Result:
    return app.test_cli_runner().invoke(args=["bos", "maintenance"])


def _staged_photo(
    owner: Engine, uploads: Path, tenant_id: uuid.UUID, user_id: uuid.UUID, *, expired: bool
) -> tuple[uuid.UUID, list[Path]]:
    """A staged photo with both files written to disk; expired = older than 24 hours."""
    photo_id = uuid.uuid4()
    paths: list[Path] = []
    with owner.begin() as conn:
        file_ids = []
        for _ in range(2):
            file_id = uuid.uuid4()
            relative = f"tenant/{tenant_id}/{uuid.uuid4().hex}{uuid.uuid4().hex[:8]}.webp"
            insert(
                conn,
                "files",
                id=file_id,
                tenant_id=tenant_id,
                kind="product_photo",
                storage_path=relative,
                mime="image/webp",
                size_bytes=4,
                created_by_user_id=user_id,
            )
            full = uploads / relative
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_bytes(b"webp")
            paths.append(full)
            file_ids.append(file_id)
        conn.execute(
            text(
                "INSERT INTO product_photos (id, tenant_id, thumb_file_id, large_file_id, width, "
                "height, staged_expires_at, created_by_user_id, created_at) VALUES (:id, :t, :th, "
                ":lg, 10, 10, now() + CAST(:expires AS interval), :u, "
                "now() + CAST(:expires AS interval) - interval '24 hours')"
            ),
            {
                "id": photo_id,
                "t": tenant_id,
                "th": file_ids[0],
                "lg": file_ids[1],
                "expires": "-1 minute" if expired else "23 hours",
                "u": user_id,
            },
        )
    return photo_id, paths


def _photo_ids(owner: Engine) -> set[uuid.UUID]:
    return {row.id for row in owner_rows(owner, "SELECT id FROM product_photos")}


def _run_entry(owner: Engine) -> Any:
    [run] = owner_rows(owner, "SELECT data FROM audit_entries WHERE event = 'maintenance.run'")
    return run.data


def test_expired_staged_photos_and_their_files_are_purged_in_every_business(
    app: Flask, owner_engine: Engine, fresh_catalog_tenants: TwoTenants, uploads: Path
) -> None:
    a, b = fresh_catalog_tenants.a, fresh_catalog_tenants.b
    old_a, old_a_files = _staged_photo(owner_engine, uploads, a.tenant_id, a.user_id, expired=True)
    new_a, new_a_files = _staged_photo(owner_engine, uploads, a.tenant_id, a.user_id, expired=False)
    old_b, old_b_files = _staged_photo(owner_engine, uploads, b.tenant_id, b.user_id, expired=True)
    attached = {a.catalog.photo_id, b.catalog.photo_id}

    result = _run(app)

    assert result.exit_code == 0, result.output
    assert "staged_photos_deleted: 2" in result.output
    assert _photo_ids(owner_engine) == attached | {new_a}
    assert not any(p.exists() for p in old_a_files + old_b_files)
    assert all(p.exists() for p in new_a_files)
    files_left = {row.id for row in owner_rows(owner_engine, "SELECT id FROM files")}
    assert {a.catalog.thumb_file_id, a.catalog.large_file_id} <= files_left
    assert len(files_left) == 2 + 4 + 2  # logos, attached photos, the live staged photo
    assert _run_entry(owner_engine)["staged_photos_deleted"] == 2
    assert old_a not in _photo_ids(owner_engine) and old_b not in _photo_ids(owner_engine)


def test_expired_uncommitted_batches_are_purged_but_results_are_kept(
    app: Flask, owner_engine: Engine, fresh_catalog_tenants: TwoTenants
) -> None:
    a, b = fresh_catalog_tenants.a, fresh_catalog_tenants.b
    with owner_engine.begin() as conn:
        remaining = {a.catalog.import_batch_id, b.catalog.import_batch_id}
        for world in (a, b):
            for status, expired in (("previewed", True), ("failed", True), ("previewed", False)):
                batch_id = uuid.uuid4()
                if not expired:
                    remaining.add(batch_id)
                conn.execute(
                    text(
                        "INSERT INTO import_batches (id, tenant_id, created_by_user_id, status, "
                        "file_name, file_sha256, row_count, expires_at) VALUES "
                        "(:id, :t, :u, :status, 'test.csv', :digest, 1, now() + CAST(:age AS interval))"
                    ),
                    {
                        "id": batch_id,
                        "t": world.tenant_id,
                        "u": world.user_id,
                        "status": status,
                        "digest": b"test",
                        "age": "-1 hour" if expired else "1 hour",
                    },
                )
        conn.execute(
            text(
                "UPDATE import_batches SET expires_at = now() - interval '1 hour' "
                "WHERE status = 'committed'"
            )
        )
    result = _run(app)
    assert result.exit_code == 0, result.output
    assert "expired_import_batches_deleted: 4" in result.output
    assert _run_entry(owner_engine)["expired_import_batches_deleted"] == 4
    assert {
        row.id for row in owner_rows(owner_engine, "SELECT id FROM import_batches")
    } == remaining


def test_nothing_to_purge_is_recorded_as_zero(
    app: Flask, owner_engine: Engine, fresh_catalog_tenants: TwoTenants
) -> None:
    result = _run(app)

    assert result.exit_code == 0, result.output
    assert _run_entry(owner_engine)["staged_photos_deleted"] == 0
    assert len(_photo_ids(owner_engine)) == 2


def test_each_business_runs_in_its_own_transaction_and_files_wait_for_its_commit(
    app: Flask,
    owner_engine: Engine,
    fresh_catalog_tenants: TwoTenants,
    uploads: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, b = fresh_catalog_tenants.a, fresh_catalog_tenants.b
    old_a, old_a_files = _staged_photo(owner_engine, uploads, a.tenant_id, a.user_id, expired=True)
    old_b, old_b_files = _staged_photo(owner_engine, uploads, b.tenant_id, b.user_id, expired=True)

    from app.services import maintenance, photos

    real = photos.purge_staged

    def fail_for_b(db: Any) -> Any:
        paths = real(db)
        tenant = db.execute(text("SELECT current_setting('app.tenant_id')")).scalar_one()
        if tenant == str(b.tenant_id):
            raise RuntimeError("business b fails after its rows were deleted")
        return paths

    monkeypatch.setattr(maintenance.photos, "purge_staged", fail_for_b)

    result = _run(app)

    assert result.exit_code != 0
    remaining = _photo_ids(owner_engine)
    assert old_a not in remaining  # a's transaction committed
    assert old_b in remaining  # b's rolled back
    assert not any(p.exists() for p in old_a_files)
    assert all(p.exists() for p in old_b_files)
