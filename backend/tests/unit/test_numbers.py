# ruff: noqa: RUF001 — intentionally test non-ASCII digits and separators.
import pytest

from app.core.numbers import normalise_number


@pytest.mark.parametrize(
    ("raw", "whole", "expected"),
    [
        ("٨٩٬٥٠٠٫٢٥", False, "89500.25"),
        ("۸۹,۵۰۰", False, "89500"),
        (" ٢۳ ", True, "23"),
        ("0002", True, "0002"),
    ],
)
def test_normalise_localised_numbers(raw: str, whole: bool, expected: str) -> None:
    assert normalise_number(raw, whole=whole) == expected


@pytest.mark.parametrize("raw", ["+2", "-2", "1e2", "12,34", "1 2", "٢٫٣٫٤", "NaN", "２"])
def test_reject_non_decimal_syntax(raw: str) -> None:
    with pytest.raises(ValueError):
        normalise_number(raw)


@pytest.mark.parametrize("raw", ["2.0", "٢٫٥", "1,000"])
def test_quantity_accepts_only_whole_digit_cells(raw: str) -> None:
    with pytest.raises(ValueError):
        normalise_number(raw, whole=True)
