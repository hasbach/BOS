"""T012 — phone numbers and emails are normalized once, at the edge (FR-006, FR-006a)."""

from __future__ import annotations

import pytest

from app.core.identifiers import (
    Identifier,
    InvalidIdentifier,
    normalize_email,
    normalize_phone,
    parse_identifier,
)

E164 = "+96170123456"


@pytest.mark.parametrize(
    "typed",
    [
        "70 123 456",
        "70123456",
        "070123456",
        "070 123 456",
        "+96170123456",
        "+961 70 123 456",
        "0096170123456",
        "00961 70 123 456",
        "  +961-70-123-456  ",
    ],
)
def test_lebanese_number_in_any_common_format_becomes_one_e164_value(typed: str) -> None:
    assert normalize_phone(typed) == E164


def test_foreign_number_with_country_code_is_kept() -> None:
    assert normalize_phone("+33 6 12 34 56 78") == "+33612345678"


@pytest.mark.parametrize("typed", ["", "   ", "abc", "123", "70 123", "+961 70 123 456 789 000"])
def test_invalid_phone_is_rejected(typed: str) -> None:
    with pytest.raises(InvalidIdentifier) as excinfo:
        normalize_phone(typed)
    assert excinfo.value.code == "invalid_phone"


def test_email_is_trimmed_and_lower_cased() -> None:
    assert normalize_email("  Rana.Khoury@Example.COM ") == "rana.khoury@example.com"


@pytest.mark.parametrize(
    "typed", ["", "rana", "rana@", "@example.com", "ra na@example.com", "rana@example", "a@b@c.com"]
)
def test_invalid_email_is_rejected(typed: str) -> None:
    with pytest.raises(InvalidIdentifier) as excinfo:
        normalize_email(typed)
    assert excinfo.value.code == "invalid_email"


def test_email_longer_than_254_characters_is_rejected() -> None:
    with pytest.raises(InvalidIdentifier):
        normalize_email("a" * 250 + "@example.com")


def test_input_containing_at_sign_is_treated_as_email() -> None:
    assert parse_identifier("Dana@Example.com") == Identifier(
        kind="email", value="dana@example.com"
    )


def test_input_without_at_sign_is_treated_as_phone() -> None:
    assert parse_identifier("070 123 456") == Identifier(kind="phone", value=E164)


def test_something_that_is_neither_is_rejected_as_a_phone() -> None:
    with pytest.raises(InvalidIdentifier) as excinfo:
        parse_identifier("hello")
    assert excinfo.value.code == "invalid_phone"
