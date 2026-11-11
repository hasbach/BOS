"""Helpers shared by the API blueprints: request bodies, field checks, response shapes."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from flask import Response, current_app, request

from app.core import sessions
from app.errors import ApiError
from app.services.common import IssuedLink


def json_body() -> dict[str, Any]:
    """The JSON object sent with the request; anything else is a validation error."""
    body = request.get_json(silent=True)
    if body is None and not request.get_data(cache=True):
        return {}
    if not isinstance(body, dict):
        raise ApiError(400, "validation_failed", "The request body must be a JSON object")
    return body


def validation_failed(fields: dict[str, str]) -> ApiError:
    return ApiError(400, "validation_failed", "Some fields are not valid", fields=fields)


def text_field(
    body: dict[str, Any],
    name: str,
    max_length: int,
    errors: dict[str, str],
    *,
    required: bool = True,
) -> str | None:
    """A trimmed text field of 1 to ``max_length`` characters; problems go into ``errors``."""
    value = body.get(name)
    if value is None:
        if required:
            errors[name] = "required"
        return None
    if not isinstance(value, str):
        errors[name] = "invalid"
        return None
    value = value.strip()
    if not value:
        errors[name] = "required"
        return None
    if len(value) > max_length:
        errors[name] = "too_long"
        return None
    return value


def iso(moment: datetime) -> str:
    """ISO 8601 in UTC, as the contract requires."""
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return iso(value)
    if isinstance(value, dict):
        return {key: jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [jsonable(item) for item in value]
    return value


def link_result(link: IssuedLink) -> dict[str, str]:
    """A one-time link, for the one response that creates it."""
    return {"link": link.url, "expires_at": iso(link.expires_at)}


def client_ip() -> str | None:
    return request.remote_addr


def user_agent() -> str:
    return request.headers.get("User-Agent", "")


def set_cookie(response: Response, token: str, *, operator: bool) -> None:
    from app import get_config

    sessions.set_session_cookie(response, token, operator=operator, config=get_config(current_app))


def clear_cookie(response: Response, *, operator: bool) -> None:
    from app import get_config

    sessions.clear_session_cookie(response, operator=operator, config=get_config(current_app))
