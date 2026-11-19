"""Checking the API against every feature's ``contracts/openapi.yaml`` (M0 T032, M1 T027).

Endpoint tests anywhere in the suite call ``assert_matches_contract(response)`` on a Flask
test-client response; tests in ``tests/contract`` can use the ``contract`` fixture instead.
The response is checked against the contract file that defines its path
(``tests.paths.openapi_contract_for``: M0's file for M0 paths, including those M1 changes in
place; M1's for ``/catalog/...``), for its path, method and status: the status must be
documented for that operation and the body must match the documented schema, if one is
given. A path in neither file fails.

``undocumented_routes(app)`` lists every ``/api/v1`` route (method + rule) that no contract
has. Path parameters are compared by position only, because Flask's argument names
(``<uuid:store_id>``) and the contract's (``{storeId}``) follow different conventions.
"""

from __future__ import annotations

import functools
import re
from pathlib import Path
from typing import Any

from flask import Flask
from openapi_core import OpenAPI
from openapi_core.contrib.werkzeug import WerkzeugOpenAPIRequest, WerkzeugOpenAPIResponse
from openapi_core.exceptions import OpenAPIError

from tests.paths import OPENAPI_CONTRACTS, openapi_contract_for

API_PREFIX = "/api/v1"
_HTTP_METHODS = frozenset({"GET", "PUT", "POST", "DELETE", "PATCH"})
_FLASK_ARGUMENT = re.compile(r"<(?:[^<>:]+:)?[^<>]+>")
_CONTRACT_PARAMETER = re.compile(r"\{[^{}]+\}")


@functools.cache
def load_contract(path: Path = OPENAPI_CONTRACTS[0]) -> OpenAPI:
    return OpenAPI.from_file_path(str(path))


def assert_matches_contract(response: Any) -> None:
    """Fail unless a test-client response is documented for its path, method and status."""
    request = response.request
    contract = openapi_contract_for(request.path)
    if contract is None:
        raise AssertionError(
            f"{request.method} {request.path} -> {response.status_code} does not match any "
            "contract: the path is in no feature's openapi.yaml"
        )
    try:
        load_contract(contract).validate_response(
            WerkzeugOpenAPIRequest(request), WerkzeugOpenAPIResponse(response)
        )
    except OpenAPIError as exc:
        details = "; ".join(str(e) for e in getattr(exc, "schema_errors", ()) or ())
        raise AssertionError(
            f"{request.method} {request.path} -> {response.status_code} does not match "
            f"{contract.name} of {contract.parent.parent.name}: {exc}"
            + (f" ({details})" if details else "")
        ) from exc


def _shape(path: str, parameter: re.Pattern[str]) -> str:
    return parameter.sub("{}", path)


def contract_operations() -> frozenset[tuple[str, str]]:
    """(METHOD, path shape) of every operation in every contract, paths relative to /api/v1."""
    operations = set()
    for contract in OPENAPI_CONTRACTS:
        paths = load_contract(contract).spec / "paths"
        for path in paths.keys():  # noqa: SIM118 (SchemaPath is not a dict)
            for method in (paths / path).keys():  # noqa: SIM118
                if method.upper() in _HTTP_METHODS:
                    operations.add((method.upper(), _shape(path, _CONTRACT_PARAMETER)))
    return frozenset(operations)


def app_operations(app: Flask) -> frozenset[tuple[str, str, str]]:
    """(METHOD, path shape, Flask rule) for every registered /api/v1 route."""
    operations = set()
    for rule in app.url_map.iter_rules():
        if not rule.rule.startswith(API_PREFIX + "/"):
            continue
        shape = _shape(rule.rule[len(API_PREFIX) :], _FLASK_ARGUMENT)
        for method in (rule.methods or set()) & _HTTP_METHODS:
            operations.add((method, shape, rule.rule))
    return frozenset(operations)


def undocumented_routes(app: Flask) -> list[str]:
    documented = contract_operations()
    return sorted(
        f"{method} {rule}"
        for method, shape, rule in app_operations(app)
        if (method, shape) not in documented
    )
