"""Manager-only CSV previews, downloads and confirmation."""

from __future__ import annotations

from uuid import UUID

from flask import Blueprint, Response, jsonify, request
from flask.typing import ResponseReturnValue
from werkzeug.exceptions import RequestEntityTooLarge

from app.api.common import client_ip, validation_failed
from app.core.permissions import require
from app.core.request_context import current_user, not_found_in_tenant, request_db
from app.errors import ApiError
from app.services import catalog_import
from app.services.catalog import Actor

bp = Blueprint("catalog_import", __name__, url_prefix="/api/v1/catalog/imports")


def _actor() -> Actor:
    user = current_user()
    return Actor(user_id=user.user_id, tenant_id=user.tenant_id, ip=client_ip())


@bp.get("/template")
@require("catalog.manage")
def template() -> ResponseReturnValue:
    return Response(
        catalog_import.template(),
        mimetype="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="catalog-template.csv"',
        },
    )


@bp.post("")
@require("catalog.manage")
def preview() -> ResponseReturnValue:
    # Bound the multipart envelope as well as the file itself. Allow normal multipart
    # metadata without rejecting a valid file at the exact 2 MiB limit.
    request.max_content_length = catalog_import.MAX_BYTES + 64 * 1024
    try:
        file = request.files.get("file")
    except RequestEntityTooLarge:
        raise ApiError(400, "file_too_large", "Choose a CSV file of 2 MB or less") from None
    if file is None or not file.filename:
        raise validation_failed({"file": "required"})
    data = file.stream.read(catalog_import.MAX_BYTES + 1)
    return jsonify(catalog_import.preview(request_db(), _actor(), file.filename, data)), 201


@bp.get("/<uuid:batch_id>")
@require("catalog.manage")
def get_batch(batch_id: UUID) -> ResponseReturnValue:
    batch = catalog_import.get_batch(request_db(), batch_id)
    if batch is None:
        not_found_in_tenant("import_batch", batch_id)
    return jsonify(batch)


@bp.post("/<uuid:batch_id>/confirm")
@require("catalog.manage")
def confirm(batch_id: UUID) -> ResponseReturnValue:
    batch = catalog_import.confirm(request_db(), _actor(), batch_id)
    if batch is None:
        not_found_in_tenant("import_batch", batch_id)
    return jsonify(batch)
