"""Where tests find the written contracts they check the code against (research R56).

Every feature keeps its own contracts under ``specs/<feature>/``; nothing is merged or copied.
Tests read the files of every feature listed in ``FEATURES``, in milestone order:

* ``PERMISSIONS_CONTRACTS`` — each feature's ``contracts/permissions.md``;
* ``DATA_MODELS`` — each feature's ``data-model.md`` (the history events);
* ``openapi_contract_for(path)`` — the ``contracts/openapi.yaml`` that defines a request path.
  A path defined by several features (an M0 endpoint that a later milestone changes in
  place, such as ``/business``) belongs to the earliest one, whose file carries the change
  with a version note.
"""

from __future__ import annotations

import functools
import os
import re
from pathlib import Path

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]

SPECS_DIR = Path(os.environ.get("BOS_SPECS_DIR") or _REPO_ROOT / "specs")
FEATURES = ("001-platform-foundation", "002-native-catalog-inventory")
FEATURE_DIRS = [SPECS_DIR / feature for feature in FEATURES]

PERMISSIONS_CONTRACTS = [folder / "contracts" / "permissions.md" for folder in FEATURE_DIRS]
OPENAPI_CONTRACTS = [folder / "contracts" / "openapi.yaml" for folder in FEATURE_DIRS]
DATA_MODELS = [folder / "data-model.md" for folder in FEATURE_DIRS]

API_PREFIX = "/api/v1"


def documented_events(data_model: Path) -> set[str]:
    """The event names of a data model's "Events:" section (up to the next ``##`` heading)."""
    text = data_model.read_text(encoding="utf-8")
    section = re.split(r"\n## ", text.split("Events:", 1)[1], maxsplit=1)[0]
    return set(re.findall(r"`([a-z_]+\.[a-z_]+)`", section))


def feature_file(feature: str, relative: str) -> Path:
    """A file of one feature, e.g. ``feature_file("001-platform-foundation", "data-model.md")``."""
    if feature not in FEATURES:
        raise ValueError(f"unknown feature {feature!r}")
    return SPECS_DIR / feature / relative


@functools.cache
def _path_patterns(contract: Path) -> tuple[re.Pattern[str], ...]:
    document = yaml.safe_load(contract.read_text(encoding="utf-8"))
    patterns = []
    for template in document.get("paths", {}):
        parts = re.split(r"(\{[^{}/]+\})", template)
        regex = "".join("[^/]+" if part.startswith("{") else re.escape(part) for part in parts)
        patterns.append(re.compile(regex))
    return tuple(patterns)


def openapi_contract_for(path: str) -> Path | None:
    """The OpenAPI file of the earliest feature that defines ``path``, or None.

    ``path`` is a request path, with or without the ``/api/v1`` prefix
    (``/api/v1/catalog/products/3f2c...`` or ``/catalog/products/{productId}``).
    """
    relative = path[len(API_PREFIX) :] if path.startswith(API_PREFIX + "/") else path
    for contract in OPENAPI_CONTRACTS:
        if any(pattern.fullmatch(relative) for pattern in _path_patterns(contract)):
            return contract
    return None
