"""Sign-in identifiers: phone numbers and emails, normalized once at the edge.

A phone number typed as ``70 123 456``, ``070123456`` or ``+961 70 123 456`` must be the same
identifier, so it is stored in E.164 and compared in that form (FR-006a).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

import phonenumbers

DEFAULT_REGION = "LB"
MAX_EMAIL_LENGTH = 254

# Deliberately simple: one "@", no spaces, a dot in the domain. Real validation of an email
# is whether a message arrives; this only rejects obvious typing mistakes.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$")


class InvalidIdentifier(ValueError):
    """The text is not a usable phone number or email. ``code`` is the stable error code."""

    def __init__(self, code: Literal["invalid_phone", "invalid_email"]) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Identifier:
    kind: Literal["phone", "email"]
    value: str


def normalize_phone(raw: str, region: str = DEFAULT_REGION) -> str:
    """Return the number in E.164, or raise ``InvalidIdentifier('invalid_phone')``."""
    text = raw.strip()
    if not text:
        raise InvalidIdentifier("invalid_phone")
    try:
        parsed = phonenumbers.parse(text, region)
    except phonenumbers.NumberParseException as exc:
        raise InvalidIdentifier("invalid_phone") from exc
    if not phonenumbers.is_valid_number(parsed):
        raise InvalidIdentifier("invalid_phone")
    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)


def normalize_email(raw: str) -> str:
    """Return the email trimmed and lower-cased, or raise ``InvalidIdentifier('invalid_email')``."""
    text = raw.strip().lower()
    if not text or len(text) > MAX_EMAIL_LENGTH or not _EMAIL_RE.match(text):
        raise InvalidIdentifier("invalid_email")
    return text


def parse_identifier(raw: str) -> Identifier:
    """Decide whether one typed field is an email or a phone number, and normalize it."""
    if "@" in raw:
        return Identifier(kind="email", value=normalize_email(raw))
    return Identifier(kind="phone", value=normalize_phone(raw))
