"""Product photos, ``/api/v1/catalog/photos`` (M1 User Story 1, FR-010, R50).

* ``POST /catalog/photos`` (``catalog.manage``): the upload (at most 5 MB, this route only;
  the application's request limit leaves room for it) is decoded and re-encoded in memory
  (``prepare_product_photo``), both WebP files are written to storage under server-made
  paths with an ``on_rollback`` that removes them, and the photo is recorded as staged
  (``app.services.photos.stage``). A request that fails after writing leaves no file.
* ``GET /catalog/photos/{photoId}/{size}`` (``catalog.view``, store-filtered): allowed when
  the caller may see the photo's product; a staged photo only for ``catalog.manage``
  holders. Answers ``Cache-Control: private, no-cache`` with an ``ETag`` (the file's id,
  files never change), so every view is re-authorised and an unchanged photo costs a 304.
"""

from __future__ import annotations

import logging
import uuid

from flask import Blueprint, Response, current_app, jsonify, request
from flask.typing import ResponseReturnValue
from werkzeug.exceptions import RequestEntityTooLarge

from app.api.common import validation_failed
from app.core.permissions import require
from app.core.request_context import (
    current_user,
    not_found_in_scope,
    not_found_in_tenant,
    on_rollback,
    request_db,
)
from app.core.storage import (
    PRODUCT_PHOTO_MAX_BYTES,
    Storage,
    StorageError,
    UploadRejected,
    prepare_product_photo,
    storage_for,
)
from app.errors import ApiError
from app.services import catalog, photos

bp = Blueprint("catalog_photos", __name__, url_prefix="/api/v1")

log = logging.getLogger("bos.photos")

SIZES = ("thumb", "large")
CACHE_CONTROL = "private, no-cache"


def _not_found() -> ApiError:
    return ApiError(404, "not_found", "Not Found")


@bp.post("/catalog/photos")
@require("catalog.manage")
def upload_photo() -> ResponseReturnValue:
    try:
        upload = request.files.get("file")
    except RequestEntityTooLarge:
        upload = None
        too_large = True
    else:
        too_large = False
    if too_large:
        raise ApiError(400, "file_too_large", "The file is larger than 5 MB")
    if upload is None:
        raise validation_failed({"file": "required"})
    try:
        prepared = prepare_product_photo(upload.stream.read(PRODUCT_PHOTO_MAX_BYTES + 1))
    except UploadRejected as rejected:
        message = (
            "The file is larger than 5 MB or 40 megapixels"
            if rejected.code == "file_too_large"
            else "The file is not a PNG, JPEG or WebP image"
        )
        raise ApiError(400, rejected.code, message) from None

    user = current_user()
    storage = storage_for(current_app)
    stored = []
    for data in (prepared.thumb, prepared.large):
        path = storage.save(user.tenant_id, data)
        _delete_on_rollback(storage, path)  # registered at once: no file outlives a failure
        stored.append(photos.StoredImage(path, len(data)))
    body = photos.stage(
        request_db(),
        tenant_id=user.tenant_id,
        user_id=user.user_id,
        thumb=stored[0],
        large=stored[1],
        width=prepared.width,
        height=prepared.height,
    )
    return jsonify(body), 201


def _delete_on_rollback(storage: Storage, path: str) -> None:
    on_rollback(lambda: storage.delete(path))


@bp.get("/catalog/photos/<uuid:photo_id>/<size>")
@require("catalog.view", store_filtered=True)
def get_photo(photo_id: uuid.UUID, size: str) -> ResponseReturnValue:
    if size not in SIZES:
        raise _not_found()
    user = current_user()
    db = request_db()
    found = photos.find(db, photo_id)
    if found is None:
        not_found_in_tenant("product_photo", photo_id)
    if found.product_id is None:
        if not catalog.is_manager(user.access):
            not_found_in_scope("product_photo", photo_id, "catalog.view")
    else:
        try:
            catalog.check_visible(db, found.product_id, user.access)
        except catalog.OutOfScope:
            not_found_in_scope("product", found.product_id, "catalog.view")

    file_id, path = (
        (found.thumb_file_id, found.thumb_path)
        if size == "thumb"
        else (found.large_file_id, found.large_path)
    )
    if request.if_none_match.contains(str(file_id)):
        response = Response(status=304)
    else:
        response = Response(_read(path, user.tenant_id), mimetype="image/webp")
        response.headers["Content-Security-Policy"] = "default-src 'none'"
    response.set_etag(str(file_id))
    response.headers["Cache-Control"] = CACHE_CONTROL
    return response


def _read(path: str, tenant_id: uuid.UUID) -> bytes:
    if not path.startswith(f"tenant/{tenant_id}/"):
        log.error("product photo path of another tenant refused")
        raise _not_found()
    try:
        with storage_for(current_app).open(path) as stored:
            return stored.read()
    except FileNotFoundError:
        log.warning("product photo file is missing from storage")
        raise _not_found() from None
    except StorageError:
        log.error("product photo has an invalid storage path")
        raise _not_found() from None
