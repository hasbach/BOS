"""The business's stores and their logos, ``/api/v1/stores`` (T069, User Story 3).

Listing needs ``store.view`` and shows only the stores the caller may see
(``app.services.stores.list_stores``). Every change needs ``store.manage`` (owners and
managers). Reading a logo needs ``store.view`` for that store: a store-limited user asking for
another store's logo, or for one of their stores that has been deactivated, gets 404
``not_found``, recorded as ``access.denied_store``. A store of another business is 404
``not_found``, identical to a made-up id, recorded as ``access.denied_tenant``.

Logo files and the transaction (no orphan referenced, none left behind if avoidable):

1. the upload is checked and re-encoded in memory (``app.core.storage.prepare_logo``);
2. the new file is written to storage under a new server-generated path, and an
   ``on_rollback`` callback is registered that deletes it again;
3. the store is pointed at it and the old ``files`` row deleted, in the transaction;
4. the old file is deleted from storage by an ``on_commit`` callback.

So a request that fails at any point after step 2 (an error, an exception, a failed commit)
removes its new file, and the old file stays in place for the old, still committed,
reference. A file can only be left behind if the process dies between writing it and the
end of the request, or if deleting a file fails (both are logged); such a file is never
referenced and never served. The reverse order (commit first, write after) could leave a
committed reference to a file that does not exist, which is worse.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Literal, cast

from flask import Blueprint, Response, current_app, jsonify, request
from flask.typing import ResponseReturnValue
from werkzeug.exceptions import RequestEntityTooLarge

from app.api.common import (
    client_ip,
    identifier_field,
    json_body,
    text_field,
    validation_failed,
)
from app.core.identifiers import normalize_phone
from app.core.permissions import require
from app.core.request_context import (
    current_user,
    not_found_in_store,
    not_found_in_tenant,
    on_commit,
    on_rollback,
    request_db,
)
from app.core.storage import (
    LOGO_MAX_BYTES,
    StorageError,
    UploadRejected,
    prepare_logo,
    storage_for,
)
from app.errors import ApiError
from app.services import stores
from app.services.common import NotFound

bp = Blueprint("stores", __name__, url_prefix="/api/v1")

log = logging.getLogger("bos.stores")

STATUSES = ("active", "inactive")
NAME_MAX = 80


def _actor() -> stores.Actor:
    user = current_user()
    return stores.Actor(user_id=user.user_id, tenant_id=user.tenant_id, ip=client_ip())


@contextmanager
def _store_outcomes() -> Iterator[None]:
    try:
        yield
    except NotFound as missing:
        not_found_in_tenant(missing.target_type, missing.target_id)


def _not_found() -> ApiError:
    return ApiError(404, "not_found", "Not Found")


# ---- stores ---------------------------------------------------------------------------------


@bp.get("/stores")
@require("store.view")
def list_stores() -> ResponseReturnValue:
    user = current_user()
    return jsonify(stores.list_stores(request_db(), user.user_id, user.access))


@bp.post("/stores")
@require("store.manage")
def create_store() -> ResponseReturnValue:
    body = json_body()
    errors: dict[str, str] = {}
    name = text_field(body, "name", NAME_MAX, errors)
    whatsapp = identifier_field(body, "whatsapp_number", normalize_phone, errors)
    if errors:
        raise validation_failed(errors)
    assert name is not None
    return jsonify(stores.create_store(request_db(), _actor(), name, whatsapp)), 201


@bp.patch("/stores/<uuid:store_id>")
@require("store.manage")
def update_store(store_id: uuid.UUID) -> ResponseReturnValue:
    # Found in this business first, so an invalid body cannot tell a made-up id from another
    # business's (see the staff routes).
    with _store_outcomes():
        stores.get_store(request_db(), store_id)
    body = json_body()
    errors: dict[str, str] = {}
    name = text_field(body, "name", NAME_MAX, errors) if "name" in body else None
    whatsapp = identifier_field(body, "whatsapp_number", normalize_phone, errors)
    status = body.get("status")
    if status is not None and status not in STATUSES:
        errors["status"] = "invalid"
    confirm = body.get("confirm", False)
    if not isinstance(confirm, bool):
        errors["confirm"] = "invalid"
    if errors:
        raise validation_failed(errors)
    change = stores.StoreChange(
        name=name,
        set_whatsapp="whatsapp_number" in body,
        whatsapp=whatsapp,
        status=cast(Literal["active", "inactive"] | None, status),
        confirm=confirm,
    )
    with _store_outcomes():
        return jsonify(stores.update_store(request_db(), _actor(), store_id, change))


# ---- logos ----------------------------------------------------------------------------------


def _uploaded_bytes() -> bytes:
    try:
        upload = request.files.get("file")
    except RequestEntityTooLarge:
        # Beyond the server's hard limit for a whole request: answered like any large file.
        raise UploadRejected("file_too_large") from None
    if upload is None:
        raise validation_failed({"file": "required"})
    return upload.stream.read(LOGO_MAX_BYTES + 1)


@bp.put("/stores/<uuid:store_id>/logo")
@require("store.manage")
def put_logo(store_id: uuid.UUID) -> ResponseReturnValue:
    db = request_db()
    with _store_outcomes():
        stores.get_store(db, store_id)  # 404 before looking at the file
    try:
        webp = prepare_logo(_uploaded_bytes())
    except UploadRejected as rejected:
        message = (
            "The file is larger than 2 MB"
            if rejected.code == "file_too_large"
            else ("The file is not a PNG, JPEG or WebP image")
        )
        raise ApiError(400, rejected.code, message) from None

    storage = storage_for(current_app)
    actor = _actor()
    path = storage.save(actor.tenant_id, webp)
    on_rollback(lambda: storage.delete(path))
    with _store_outcomes():
        old_path = stores.set_logo(db, actor, store_id, path, len(webp))
    if old_path is not None:
        on_commit(lambda: storage.delete(old_path))
    return jsonify(stores.store(db, store_id))


@bp.get("/stores/<uuid:store_id>/logo")
@require("store.view", store_param="store_id")
def get_logo(store_id: uuid.UUID) -> ResponseReturnValue:
    user = current_user()
    with _store_outcomes():
        found = stores.logo(request_db(), store_id)
    if found.store_status != "active" and "store.manage" not in user.access.permissions:
        not_found_in_store(store_id, "store.view")
    if found.storage_path is None:
        raise _not_found()
    data = _read(found.storage_path, user.tenant_id)
    response = Response(data, mimetype="image/webp")
    response.headers["Cache-Control"] = "private, no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "default-src 'none'"
    return response


def _read(path: str, tenant_id: uuid.UUID) -> bytes:
    if not path.startswith(f"tenant/{tenant_id}/"):
        log.error("store logo path of another tenant refused")
        raise _not_found()
    try:
        with storage_for(current_app).open(path) as stored:
            return stored.read()
    except FileNotFoundError:
        log.warning("store logo file is missing from storage")
        raise _not_found() from None
    except StorageError:
        log.error("store logo has an invalid storage path")
        raise _not_found() from None


@bp.delete("/stores/<uuid:store_id>/logo")
@require("store.manage")
def delete_logo(store_id: uuid.UUID) -> ResponseReturnValue:
    with _store_outcomes():
        old_path = stores.remove_logo(request_db(), _actor(), store_id)
    if old_path is not None:
        storage = storage_for(current_app)
        on_commit(lambda: storage.delete(old_path))
    return Response(status=204)
