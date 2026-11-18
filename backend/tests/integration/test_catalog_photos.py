"""T039 — product photos: staged upload, attaching, serving and file clean-up (FR-010, R50).

``POST /api/v1/catalog/photos`` and ``GET /api/v1/catalog/photos/{photoId}/{size}``. Images are
made in the test; uploads go to a temporary directory per test.
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

from app.config import Config
from app.errors import ApiError
from tests.dbsupport import TwoTenants
from tests.integration.catalog_support import (
    PHOTOS,
    as_update,
    count,
    create,
    created,
    put,
    simple,
    upload_photo,
)
from tests.integration.us1_support import (
    app_for,
    ok,
    owner_rows,
    owner_value,
    refused,
    shared_app_fixture,
)
from tests.integration.us3_support import (
    huge_dimension_png,
    image_bytes,
    noise_png,
    stored_files,
    with_upload_dir,
)

pytestmark = pytest.mark.usefixtures("integrity_check")

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]
FIVE_MB = 5 * 1024 * 1024


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


def _staged(client: FlaskClient, colour: tuple[int, int, int] = (10, 20, 30)) -> str:
    image = Image.new("RGB", (640, 480), color=colour)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    body = ok(upload_photo(client, buffer.getvalue()), 201)
    return str(body["id"])


def _photo_files(owner: Engine, photo_id: str) -> list[Any]:
    return owner_rows(
        owner,
        "SELECT f.id, f.kind, f.storage_path, f.mime FROM product_photos p "
        "JOIN files f ON f.id IN (p.thumb_file_id, p.large_file_id) WHERE p.id = :p",
        p=photo_id,
    )


# ---- staged upload --------------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP"])
def test_an_upload_is_staged_and_stored_as_two_webp_files(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path, fmt: str
) -> None:
    a = worlds.a

    body = ok(upload_photo(owner, image_bytes(fmt, (2000, 1500))), 201)

    assert (body["width"], body["height"]) == (1080, 810)
    row = owner_rows(
        owner_engine,
        "SELECT product_id, position, created_by_user_id, "
        "staged_expires_at BETWEEN now() + interval '23 hours' AND now() + interval '25 hours' "
        "AS expires_in_a_day FROM product_photos WHERE id = :p",
        p=body["id"],
    )[0]
    assert (row.product_id, row.position, row.created_by_user_id) == (None, None, a.user_id)
    assert row.expires_in_a_day
    files = _photo_files(owner_engine, body["id"])
    assert {(f.kind, f.mime) for f in files} == {("product_photo", "image/webp")}
    assert len(stored_files(uploads)) == 2


def test_a_photo_of_almost_5_mb_reaches_the_route_and_is_accepted(owner: FlaskClient) -> None:
    data = noise_png((1280, 1300))
    assert 4 * 1024 * 1024 < len(data) <= FIVE_MB

    body = ok(upload_photo(owner, data), 201)

    assert body["width"] == 1063 and body["height"] == 1080


@pytest.mark.parametrize(
    ("data", "code"),
    [
        (noise_png((1400, 1300)), "file_too_large"),
        (huge_dimension_png(8000, 6000), "file_too_large"),
        (b"%PDF-1.4 not an image", "file_not_image"),
        (image_bytes("GIF"), "file_not_image"),
    ],
    ids=["over-5-mb", "over-40-megapixels", "not-an-image", "gif"],
)
def test_refused_uploads_store_nothing(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
    data: bytes,
    code: str,
) -> None:
    refused(upload_photo(owner, data), 400, code)

    assert stored_files(uploads) == []
    assert count(owner_engine, "product_photos", worlds.a.tenant_id) == 0


def test_a_request_without_a_file_is_refused(owner: FlaskClient) -> None:
    from tests.integration.us1_support import CSRF

    response = owner.post(PHOTOS, data={}, content_type="multipart/form-data", headers=CSRF)

    assert refused(response, 400, "validation_failed")["error"]["fields"] == {"file": "required"}


def test_file_paths_cannot_be_influenced_by_the_client(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path
) -> None:
    body = ok(
        upload_photo(
            owner, image_bytes("PNG"), filename="../../../evil.png", content_type="text/html"
        ),
        201,
    )

    paths = [f.storage_path for f in _photo_files(owner_engine, body["id"])]
    pattern = re.compile(rf"tenant/{worlds.a.tenant_id}/[A-Za-z0-9_-]{{20,64}}\.webp")
    assert all(pattern.fullmatch(p) for p in paths), paths
    assert all(p.is_relative_to(uploads) for p in stored_files(uploads))
    assert not any("evil" in str(p) for p in stored_files(uploads))


def test_a_failed_upload_deletes_the_files_it_wrote(
    owner: FlaskClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    uploads: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import photos

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise ApiError(500, "internal_error", "Internal error")

    monkeypatch.setattr(photos, "stage", broken)

    response = upload_photo(owner, image_bytes("PNG"))

    assert response.status_code == 500
    assert stored_files(uploads) == []
    assert count(owner_engine, "files", worlds.a.tenant_id, "kind = 'product_photo'") == 0


# ---- attaching -----------------------------------------------------------------------------------


def test_up_to_8_photos_are_attached_in_display_order_and_a_9th_is_too_many(
    owner: FlaskClient,
) -> None:
    ids = [_staged(owner, (i * 20, 0, 0)) for i in range(9)]

    product = ok(create(owner, simple("PH-1", photo_ids=ids[:8])), 201)
    body = as_update(product)
    body["photo_ids"] = ids

    assert [p["id"] for p in product["photos"]] == ids[:8]
    error = refused(put(owner, product["id"], body), 400, "validation_failed")
    assert error["error"]["fields"] == {"photo_ids": "too_many"}


def test_photos_can_be_reordered_and_a_variant_can_use_one(owner: FlaskClient) -> None:
    first, second = _staged(owner), _staged(owner, (90, 90, 90))
    product = created(owner, simple("PH-2", photo_ids=[first, second]))
    body = as_update(product)
    body["photo_ids"] = [second, first]
    body["variants"][0]["photo_id"] = first

    updated = ok(put(owner, product["id"], body))

    assert [p["id"] for p in updated["photos"]] == [second, first]
    assert updated["variants"][0]["photo_id"] == first


def test_photos_of_another_product_cannot_be_used(owner: FlaskClient) -> None:
    photo = _staged(owner)
    other = created(owner, simple("PH-3", photo_ids=[photo]))
    product = created(owner, simple("PH-4"))
    listed = as_update(product)
    listed["photo_ids"] = [photo]
    pointed = as_update(product)
    pointed["variants"][0]["photo_id"] = photo

    first = refused(put(owner, product["id"], listed), 400, "validation_failed")
    second = refused(put(owner, product["id"], pointed), 400, "validation_failed")

    assert first["error"]["fields"] == {"photo_ids": "invalid"}
    assert second["error"]["fields"] == {"variants.0.photo_id": "invalid"}
    assert other["photos"][0]["id"] == photo


def test_another_business_staged_photo_cannot_be_attached(
    user_client: UserClient, owner: FlaskClient, worlds: TwoTenants
) -> None:
    foreign = _staged(user_client(worlds.b.user_id, worlds.b.tenant_id))

    error = refused(create(owner, simple("PH-5", photo_ids=[foreign])), 400, "validation_failed")

    assert error["error"]["fields"] == {"photo_ids": "invalid"}


def test_removing_a_photo_deletes_its_files_after_the_commit(
    owner: FlaskClient, owner_engine: Engine, worlds: TwoTenants, uploads: Path
) -> None:
    keep, drop = _staged(owner), _staged(owner, (1, 2, 3))
    product = created(owner, simple("PH-6", photo_ids=[keep, drop]))
    dropped_paths = {f.storage_path for f in _photo_files(owner_engine, drop)}
    body = as_update(product)
    body["photo_ids"] = [keep]

    ok(put(owner, product["id"], body))

    remaining = {str(p.relative_to(uploads).as_posix()) for p in stored_files(uploads)}
    assert remaining == {f.storage_path for f in _photo_files(owner_engine, keep)}
    assert not dropped_paths & remaining
    assert (
        owner_value(owner_engine, "SELECT count(*) FROM product_photos WHERE id = :p", p=drop) == 0
    )
    assert count(owner_engine, "files", worlds.a.tenant_id, "kind = 'product_photo'") == 2


def test_a_refused_save_keeps_the_photos_and_their_files(owner: FlaskClient, uploads: Path) -> None:
    keep, drop = _staged(owner), _staged(owner, (1, 2, 3))
    product = created(owner, simple("PH-7", photo_ids=[keep, drop]))
    body = as_update(product)
    body["photo_ids"] = [keep]
    body["code"] = "bad code"
    before = stored_files(uploads)

    refused(put(owner, product["id"], body), 400, "validation_failed")

    assert stored_files(uploads) == before


# ---- serving --------------------------------------------------------------------------------------


@pytest.mark.parametrize(("size", "side"), [("thumb", 320), ("large", 1080)])
def test_photos_are_served_privately_with_an_etag(
    owner: FlaskClient, worlds: TwoTenants, size: str, side: int
) -> None:
    photo = _staged(owner)
    created(owner, simple("PH-8", photo_ids=[photo], store_ids=[worlds.a.store_id]))

    response = owner.get(f"{PHOTOS}/{photo}/{size}")

    assert response.status_code == 200
    assert response.mimetype == "image/webp"
    assert response.headers["Cache-Control"] == "private, no-cache"
    etag = response.headers["ETag"]
    assert etag
    with Image.open(io.BytesIO(response.get_data())) as image:
        assert image.format == "WEBP" and max(image.size) <= side
    again = owner.get(f"{PHOTOS}/{photo}/{size}", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.get_data() == b""
    assert again.headers["Cache-Control"] == "private, no-cache"


def test_an_unknown_size_or_photo_is_not_found(owner: FlaskClient) -> None:
    photo = _staged(owner)

    refused(owner.get(f"{PHOTOS}/{photo}/huge"), 404, "not_found")
    refused(owner.get(f"{PHOTOS}/{uuid.uuid4()}/thumb"), 404, "not_found")


def test_staged_photos_are_readable_only_with_catalog_manage(
    owner: FlaskClient, user_client: UserClient, worlds: TwoTenants
) -> None:
    a = worlds.a
    photo = _staged(owner)
    manager = user_client(a.user("manager"), a.tenant_id)
    sales = user_client(a.user("sales"), a.tenant_id)

    assert manager.get(f"{PHOTOS}/{photo}/thumb").status_code == 200
    refused(sales.get(f"{PHOTOS}/{photo}/thumb"), 404, "not_found")

    created(owner, simple("PH-9", photo_ids=[photo], store_ids=[a.store_id]))
    assert sales.get(f"{PHOTOS}/{photo}/thumb").status_code == 200
