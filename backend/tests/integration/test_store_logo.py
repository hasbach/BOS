"""T064 — store logos (``app.core.storage``, ``PUT/GET/DELETE /stores/{storeId}/logo``).

Every image is made in the test with Pillow. Uploads go to a temporary directory per test.
"""

from __future__ import annotations

import io
import re
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from PIL import Image
from sqlalchemy import Engine

from app.api import stores as stores_api
from app.config import Config
from app.core.storage import LocalDiskStorage, StorageError
from tests.dbsupport import TwoTenants
from tests.integration.us1_support import (
    CSRF,
    app_for,
    error,
    history,
    ok,
    owner_rows,
    owner_value,
    refused,
    shared_app_fixture,
)
from tests.integration.us3_support import (
    STORES,
    TWO_MB,
    huge_dimension_png,
    image_bytes,
    noise_png,
    stored_files,
    upload,
    with_upload_dir,
)

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def uploads(tmp_path: Path) -> Path:
    return tmp_path / "uploads"


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants, uploads: Path) -> Flask:
    return with_upload_dir(app_for(shared_app, worlds), uploads)


@pytest.fixture()
def owner(user_client: UserClient, worlds: TwoTenants) -> FlaskClient:
    return user_client(worlds.a.user_id, worlds.a.tenant_id)


def _logo_row(owner: Engine, store_id: Any) -> Any:
    rows = owner_rows(
        owner,
        "SELECT f.id, f.tenant_id, f.kind, f.storage_path, f.mime, f.size_bytes, "
        "f.created_by_user_id FROM stores s JOIN files f ON f.id = s.logo_file_id "
        "WHERE s.id = :s",
        s=store_id,
    )
    return rows[0] if rows else None


def _logo_files(owner: Engine, tenant_id: uuid.UUID) -> int:
    return int(
        owner_value(
            owner,
            "SELECT count(*) FROM files WHERE tenant_id = :t AND kind = 'store_logo' "
            "AND storage_path LIKE '%.webp' AND storage_path <> :fixture",
            t=tenant_id,
            fixture=f"tenant/{tenant_id}/logo.webp",
        )
    )


# ---- accepted images --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("fmt", "content_type"),
    [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")],
)
def test_png_jpeg_and_webp_are_accepted_and_stored_as_webp(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
    fmt: str,
    content_type: str,
) -> None:
    a = worlds.a

    body = ok(upload(owner, a.store_id, image_bytes(fmt), content_type=content_type))

    assert body["id"] == str(a.store_id) and body["has_logo"] is True
    row = _logo_row(owner_engine, a.store_id)
    assert (row.tenant_id, row.kind, row.mime, row.created_by_user_id) == (
        a.tenant_id,
        "store_logo",
        "image/webp",
        a.user_id,
    )
    assert re.fullmatch(rf"tenant/{a.tenant_id}/[A-Za-z0-9_-]{{20,}}\.webp", row.storage_path)
    [saved] = stored_files(uploads)
    assert saved == uploads / Path(row.storage_path)
    assert saved.stat().st_size == row.size_bytes
    with Image.open(saved) as image:
        assert (image.format, image.size) == ("WEBP", (64, 48))
    [entry] = history(owner_engine, a.tenant_id, "store.updated")
    assert entry.data == {"before": {"logo_file_id": None}, "after": {"logo_file_id": str(row.id)}}


def test_a_large_image_is_shrunk_to_fit_512_by_512(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path
) -> None:
    ok(upload(owner, worlds.a.store_id, image_bytes("JPEG", (1600, 900))))

    [saved] = stored_files(uploads)
    with Image.open(saved) as image:
        assert image.size == (512, 288)


def test_transparency_is_kept(owner: FlaskClient, worlds: TwoTenants, uploads: Path) -> None:
    ok(upload(owner, worlds.a.store_id, image_bytes("PNG", mode="RGBA")))

    [saved] = stored_files(uploads)
    with Image.open(saved) as image:
        assert image.mode == "RGBA"


def test_metadata_is_stripped(owner: FlaskClient, worlds: TwoTenants, uploads: Path) -> None:
    exif = Image.Exif()
    exif[0x010F] = "SpyCam"  # Make
    exif[0x8298] = "Secret Owner"  # Copyright
    data = image_bytes("JPEG", exif=exif.tobytes())
    assert b"SpyCam" in data

    ok(upload(owner, worlds.a.store_id, data, content_type="image/jpeg"))

    [saved] = stored_files(uploads)
    raw = saved.read_bytes()
    assert b"SpyCam" not in raw and b"Secret Owner" not in raw
    with Image.open(saved) as image:
        assert not image.getexif()
        assert "exif" not in image.info and "icc_profile" not in image.info


def test_the_client_file_name_and_type_never_reach_the_path(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path, tmp_path: Path
) -> None:
    a = worlds.a

    ok(
        upload(
            owner,
            a.store_id,
            image_bytes("PNG"),
            filename="../../../evil.php",
            content_type="application/x-php",
        )
    )

    row = _logo_row(owner_engine, a.store_id)
    assert "evil" not in row.storage_path and ".." not in row.storage_path
    assert [p for p in tmp_path.rglob("*") if p.is_file()] == stored_files(uploads)
    assert all("evil" not in str(p) for p in stored_files(uploads))


def test_replacing_a_logo_removes_the_old_file_after_the_change_is_saved(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path
) -> None:
    a = worlds.a
    ok(upload(owner, a.store_id, image_bytes("PNG")))
    first = _logo_row(owner_engine, a.store_id)

    ok(upload(owner, a.store_id, image_bytes("JPEG", (30, 30))))

    second = _logo_row(owner_engine, a.store_id)
    assert second.id != first.id
    assert stored_files(uploads) == [uploads / Path(second.storage_path)]
    assert owner_value(owner_engine, "SELECT count(*) FROM files WHERE id = :f", f=first.id) == 0
    entries = history(owner_engine, a.tenant_id, "store.updated")
    assert entries[-1].data == {
        "before": {"logo_file_id": str(first.id)},
        "after": {"logo_file_id": str(second.id)},
    }


def test_a_manager_can_upload_a_logo(
    user_client: UserClient, worlds: TwoTenants, uploads: Path
) -> None:
    a = worlds.a

    ok(upload(user_client(a.user("manager"), a.tenant_id), a.second_store_id, image_bytes("PNG")))


# ---- refused files ------------------------------------------------------------------------------


def test_a_file_over_2_mb_is_too_large(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path
) -> None:
    a = worlds.a
    big_image = noise_png((900, 800))
    assert TWO_MB < len(big_image) < 3 * 1024 * 1024

    refused(upload(owner, a.store_id, big_image), 400, "file_too_large")
    refused(upload(owner, a.store_id, b"\0" * (TWO_MB + 1)), 400, "file_too_large")

    assert stored_files(uploads) == []
    assert _logo_row(owner_engine, a.store_id) is None


def test_a_request_over_the_server_limit_is_too_large_too(
    owner: FlaskClient, worlds: TwoTenants, uploads: Path
) -> None:
    refused(upload(owner, worlds.a.store_id, b"\0" * (4 * 1024 * 1024)), 400, "file_too_large")

    assert stored_files(uploads) == []


def test_exactly_2_mb_is_not_refused_for_its_size(owner: FlaskClient, worlds: TwoTenants) -> None:
    # Not an image, so it is refused, but for that reason and not its size.
    refused(upload(owner, worlds.a.store_id, b"\0" * TWO_MB), 400, "file_not_image")


@pytest.mark.parametrize(
    ("data", "filename", "content_type"),
    [
        (b"hello, I am a text file", "logo.png", "image/png"),
        (image_bytes("GIF"), "logo.png", "image/png"),
        (image_bytes("BMP"), "logo.png", "image/png"),
        (
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            "logo.svg",
            "image/svg+xml",
        ),
        (b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "logo.jpg", "image/jpeg"),
        (image_bytes("PNG")[:60], "logo.png", "image/png"),  # truncated
        (b"", "logo.png", "image/png"),
    ],
    ids=["text", "gif", "bmp", "svg", "pdf", "truncated-png", "empty"],
)
def test_anything_that_is_not_a_png_jpeg_or_webp_image_is_refused(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
    data: bytes,
    filename: str,
    content_type: str,
) -> None:
    a = worlds.a

    response = upload(owner, a.store_id, data, filename=filename, content_type=content_type)

    refused(response, 400, "file_not_image")
    assert stored_files(uploads) == []
    assert _logo_row(owner_engine, a.store_id) is None
    assert history(owner_engine, a.tenant_id, "store.updated") == []


def test_an_image_with_enormous_dimensions_is_refused_without_decoding_it(
    owner: FlaskClient, worlds: TwoTenants, uploads: Path
) -> None:
    data = huge_dimension_png(60_000, 60_000)
    assert len(data) < 1024

    refused(upload(owner, worlds.a.store_id, data), 400, "file_too_large")
    assert stored_files(uploads) == []


def test_a_missing_file_field_is_a_validation_error(owner: FlaskClient, worlds: TwoTenants) -> None:
    response = owner.put(f"{STORES}/{worlds.a.store_id}/logo", json={"file": "x"}, headers=CSRF)

    refused(response, 400, "validation_failed")
    assert response.get_json()["error"]["fields"] == {"file": "required"}


# ---- reading and removing -----------------------------------------------------------------------


def test_the_logo_is_served_privately_as_webp(
    owner: FlaskClient,
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
) -> None:
    a = worlds.a
    ok(upload(owner, a.store_id, image_bytes("PNG")))
    row = _logo_row(owner_engine, a.store_id)

    for client in (owner, user_client(a.user("packing"), a.tenant_id)):
        response = client.get(f"{STORES}/{a.store_id}/logo")
        ok(response)
        assert response.mimetype == "image/webp"
        assert "private" in response.headers["Cache-Control"]
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.data == (uploads / Path(row.storage_path)).read_bytes()


def test_a_store_without_a_logo_answers_not_found(owner: FlaskClient, worlds: TwoTenants) -> None:
    refused(owner.get(f"{STORES}/{worlds.a.store_id}/logo"), 404, "not_found")


def test_removing_the_logo_deletes_the_file_and_is_recorded(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path
) -> None:
    a = worlds.a
    ok(upload(owner, a.store_id, image_bytes("PNG")))
    row = _logo_row(owner_engine, a.store_id)

    response = owner.delete(f"{STORES}/{a.store_id}/logo", headers=CSRF)

    assert response.status_code == 204
    assert stored_files(uploads) == []
    assert _logo_row(owner_engine, a.store_id) is None
    assert owner_value(owner_engine, "SELECT count(*) FROM files WHERE id = :f", f=row.id) == 0
    stores = ok(owner.get(STORES))
    assert next(s for s in stores if s["id"] == str(a.store_id))["has_logo"] is False
    refused(owner.get(f"{STORES}/{a.store_id}/logo"), 404, "not_found")
    entries = history(owner_engine, a.tenant_id, "store.updated")
    assert entries[-1].data == {
        "before": {"logo_file_id": str(row.id)},
        "after": {"logo_file_id": None},
    }


def test_removing_a_logo_that_is_not_there_changes_nothing(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    response = owner.delete(f"{STORES}/{worlds.a.store_id}/logo", headers=CSRF)

    assert response.status_code == 204
    assert history(owner_engine, worlds.a.tenant_id, "store.updated") == []


def test_each_store_keeps_its_own_logo(
    owner: FlaskClient, worlds: TwoTenants, uploads: Path
) -> None:
    a = worlds.a
    ok(upload(owner, a.store_id, image_bytes("PNG", (40, 40))))
    ok(upload(owner, a.second_store_id, image_bytes("PNG", (20, 10))))

    sizes = []
    for store_id in (a.store_id, a.second_store_id):
        with Image.open(io.BytesIO(owner.get(f"{STORES}/{store_id}/logo").data)) as image:
            sizes.append(image.size)
    assert sizes == [(40, 40), (20, 10)]


# ---- failures never leave a file behind --------------------------------------------------------


def test_a_request_that_fails_after_the_file_was_written_removes_it(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    a = worlds.a

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("database trouble")

    monkeypatch.setattr(stores_api.stores, "set_logo", broken)

    response = upload(owner, a.store_id, image_bytes("PNG"))

    assert response.status_code == 500
    assert stored_files(uploads) == []
    assert _logo_files(owner_engine, a.tenant_id) == 0


def test_a_replaced_file_is_kept_when_the_replacement_fails(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    a = worlds.a
    ok(upload(owner, a.store_id, image_bytes("PNG")))
    first = _logo_row(owner_engine, a.store_id)
    real = stores_api.stores.set_logo

    def then_fail(*args: Any, **kwargs: Any) -> Any:
        real(*args, **kwargs)
        raise RuntimeError("after the change")

    monkeypatch.setattr(stores_api.stores, "set_logo", then_fail)

    assert upload(owner, a.store_id, image_bytes("JPEG")).status_code == 500

    assert _logo_row(owner_engine, a.store_id).id == first.id
    assert stored_files(uploads) == [uploads / Path(first.storage_path)]


def test_a_missing_file_on_disk_answers_not_found(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path
) -> None:
    a = worlds.a
    ok(upload(owner, a.store_id, image_bytes("PNG")))
    (uploads / Path(_logo_row(owner_engine, a.store_id).storage_path)).unlink()

    assert error(owner.get(f"{STORES}/{a.store_id}/logo")) == "not_found"


# ---- the storage itself -------------------------------------------------------------------------


def test_storage_paths_are_generated_and_stay_inside_the_root(tmp_path: Path) -> None:
    storage = LocalDiskStorage(tmp_path / "root")
    tenant = uuid.uuid4()

    first = storage.save(tenant, b"one")
    second = storage.save(tenant, b"two")

    assert first != second
    assert first.startswith(f"tenant/{tenant}/") and first.endswith(".webp")
    with storage.open(first) as handle:
        assert handle.read() == b"one"
    storage.delete(first)
    storage.delete(first)  # already gone: nothing to do
    assert not (tmp_path / "root" / first).exists()
    for bad in (
        "../outside.webp",
        f"tenant/{tenant}/../../../outside.webp",
        "/etc/passwd",
        "C:/Windows/win.ini",
        f"tenant/{tenant}/x.png",
        "tenant/not-a-uuid/abcdefghijklmnopqrstuvwxyz.webp",
        f"tenant\\{tenant}\\abcdefghijklmnopqrstuvwxyz.webp",
    ):
        with pytest.raises(StorageError):
            storage.open(bad)
        with pytest.raises(StorageError):
            storage.delete(bad)
