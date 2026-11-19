"""SKU and product code rules, and SKU suggestions (research R46, FR-005).

* Both are stored as typed after trimming; the database keeps a generated key
  ``lower(btrim(value))`` with a unique index per business, archived records included.
* Allowed: ASCII letters and digits plus ``-``, ``_``, ``.`` and ``/``, starting with a letter
  or digit. Product codes 1-32 characters, SKUs 1-64. ASCII only, so "ignoring letter case"
  means the same thing on every database cluster whatever its locale.
* ``suggest`` builds a SKU for a variant left without one: the product code and the
  variant's option values joined with ``-``, spaces inside values turned into ``-``,
  characters outside the allowed set dropped, upper-cased, cut to 64 characters. A value
  with nothing left (an Arabic colour name, say) contributes its 1-based position in its
  option instead. A suggestion already taken (in the business or earlier in the same
  request) gets ``-2``, ``-3``... with the base shortened so the whole fits.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Set

CODE_MAX = 32
SKU_MAX = 64
_ALLOWED = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]*", re.ASCII)
_DROPPED = re.compile(r"[^A-Za-z0-9._/-]", re.ASCII)
_EDGES = "-._/"


class InvalidCode(ValueError):
    """A product code or SKU that breaks the rules; ``code`` is the field error code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _check(value: str, max_length: int) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise InvalidCode("required")
    if len(trimmed) > max_length:
        raise InvalidCode("too_long")
    if not _ALLOWED.fullmatch(trimmed):
        raise InvalidCode("invalid")
    return trimmed


def check_code(value: str) -> str:
    """A product code as stored (trimmed), or ``InvalidCode``."""
    return _check(value, CODE_MAX)


def check_sku(value: str) -> str:
    """A SKU as stored (trimmed), or ``InvalidCode``."""
    return _check(value, SKU_MAX)


def key(value: str) -> str:
    """What uniqueness is decided on: the same as the database's generated ``*_key`` column."""
    return value.strip().lower()


def _part(label: str, position: int) -> str:
    cleaned = _DROPPED.sub("", "-".join(label.split())).strip(_EDGES)
    return cleaned if cleaned else str(position)


def _fit(text: str, length: int) -> str:
    return text[:length].rstrip(_EDGES)


def suggest(code: str, values: Iterable[tuple[str, int]], taken: Set[str]) -> str:
    """A free SKU for a variant: ``values`` are its option values as (label, position).

    ``taken`` holds keys (``key(sku)``) already used in the business or in this request.
    """
    parts = [code.strip(), *(_part(label, position) for label, position in values)]
    base = _fit("-".join(parts).upper(), SKU_MAX)
    if key(base) not in taken:
        return base
    number = 2
    while True:
        suffix = f"-{number}"
        candidate = _fit(base, SKU_MAX - len(suffix)) + suffix
        if key(candidate) not in taken:
            return candidate
        number += 1
