"""One error shape for every failed request.

``{"error": {"code": "...", "message": "...", "fields": {"name": "code"}}}``

``code`` values are stable and are what the web app translates into Arabic or English.
``message`` is an English fallback for developers; it is not shown to users.
"""

from __future__ import annotations

import logging
from typing import Any

from flask import Flask, jsonify
from flask.typing import ResponseReturnValue
from werkzeug.exceptions import HTTPException

log = logging.getLogger("bos.errors")


class ApiError(Exception):
    """Raise anywhere in a request to return a structured error."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str = "",
        *,
        fields: dict[str, str] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message or code)
        self.status = status
        self.code = code
        self.message = message or code
        self.fields = fields or {}
        self.extra = extra or {}


def error_body(
    code: str,
    message: str,
    fields: dict[str, str] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message, "fields": fields or {}}
    if extra:
        error.update(extra)
    return {"error": error}


_HTTP_CODES = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "file_too_large",
    415: "unsupported_media_type",
    429: "too_many_requests",
}


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(ApiError)
    def _api_error(exc: ApiError) -> ResponseReturnValue:
        return jsonify(error_body(exc.code, exc.message, exc.fields, exc.extra)), exc.status

    @app.errorhandler(HTTPException)
    def _http_error(exc: HTTPException) -> ResponseReturnValue:
        status = exc.code or 500
        code = _HTTP_CODES.get(status, "error")
        return jsonify(error_body(code, exc.name)), status

    @app.errorhandler(Exception)
    def _unexpected(exc: Exception) -> ResponseReturnValue:
        # Never leak internals to the client; the request ID links to the server log.
        log.exception("Unhandled error")
        return jsonify(error_body("internal_error", "Internal error")), 500
