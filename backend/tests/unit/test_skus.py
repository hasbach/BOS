"""T037 — SKU and product code rules and suggestions (``app.services.skus``, research R46).

FR-005, SC-004: codes are 1-32 and SKUs 1-64 characters of ``[A-Za-z0-9._/-]`` starting with
a letter or digit, trimmed; the key that decides uniqueness is the lower-cased trimmed value.
An empty SKU is suggested from the product code and the variant's option values.
"""

from __future__ import annotations

import pytest

from app.services import skus
from app.services.skus import InvalidCode


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("JN-SLIM", "JN-SLIM"),
        ("  jn-slim  ", "jn-slim"),
        ("A", "A"),
        ("a" * 32, "a" * 32),
        ("x1._/-y", "x1._/-y"),
        ("0abc", "0abc"),
    ],
)
def test_valid_codes_are_trimmed_and_kept_as_typed(raw: str, expected: str) -> None:
    assert skus.check_code(raw) == expected


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("", "required"),
        ("   ", "required"),
        ("a" * 33, "too_long"),
        ("-abc", "invalid"),
        (".abc", "invalid"),
        ("ab c", "invalid"),
        ("جينز", "invalid"),
        ("ÉTÉ", "invalid"),
        ("a+b", "invalid"),
        ("a\nb", "invalid"),
    ],
)
def test_invalid_codes_are_refused_with_their_field_code(raw: str, code: str) -> None:
    with pytest.raises(InvalidCode) as refused:
        skus.check_code(raw)
    assert refused.value.code == code


def test_sku_allows_64_characters_and_refuses_65() -> None:
    assert skus.check_sku(" " + "S" * 64 + " ") == "S" * 64
    with pytest.raises(InvalidCode) as refused:
        skus.check_sku("S" * 65)
    assert refused.value.code == "too_long"
    with pytest.raises(InvalidCode) as refused:
        skus.check_sku("/S")
    assert refused.value.code == "invalid"


@pytest.mark.parametrize(
    ("raw", "key"),
    [("JN-SLIM-32", "jn-slim-32"), ("  Jn-Slim-32 ", "jn-slim-32"), ("abc", "abc")],
)
def test_the_key_is_the_lower_cased_trimmed_value(raw: str, key: str) -> None:
    assert skus.key(raw) == key


def test_keys_of_values_differing_only_in_case_and_spaces_are_equal() -> None:
    assert skus.key("SKU-1") == skus.key(" sku-1 ") == skus.key("Sku-1")


# ---- suggestions -------------------------------------------------------------------------------


def test_suggestion_joins_code_and_values_upper_cased() -> None:
    assert skus.suggest("JN-SLIM", [("32", 1), ("Blue", 1)], set()) == "JN-SLIM-32-BLUE"


def test_suggestion_for_a_product_without_options_is_the_code() -> None:
    assert skus.suggest("tee-01", [], set()) == "TEE-01"


def test_spaces_inside_values_become_dashes() -> None:
    assert skus.suggest("TS", [("Navy Blue", 1)], set()) == "TS-NAVY-BLUE"


def test_characters_outside_the_set_are_dropped() -> None:
    assert skus.suggest("TS", [("XL+", 1), ("Red!", 2)], set()) == "TS-XL-RED"


def test_an_arabic_value_contributes_its_position() -> None:
    assert skus.suggest("JN", [("32", 1), ("أزرق", 2)], set()) == "JN-32-2"
    assert skus.suggest("JN", [("كبير", 3)], set()) == "JN-3"


def test_suggestion_is_cut_to_64_characters() -> None:
    suggestion = skus.suggest("A" * 32, [("B" * 40, 1), ("C" * 40, 1)], set())
    assert len(suggestion) == 64
    assert suggestion.startswith("A" * 32 + "-")
    assert skus.check_sku(suggestion) == suggestion


def test_a_taken_suggestion_gets_a_number() -> None:
    taken = {"jn-slim-32-blue"}
    assert skus.suggest("JN-SLIM", [("32", 1), ("Blue", 1)], taken) == "JN-SLIM-32-BLUE-2"
    taken.add("jn-slim-32-blue-2")
    assert skus.suggest("JN-SLIM", [("32", 1), ("Blue", 1)], taken) == "JN-SLIM-32-BLUE-3"


def test_taken_is_compared_ignoring_case() -> None:
    assert skus.suggest("ts", [], {"ts"}) == "TS-2"


def test_the_base_is_shortened_so_the_number_fits() -> None:
    base = skus.suggest("A" * 32, [("B" * 40, 1)], set())
    assert len(base) == 64
    numbered = skus.suggest("A" * 32, [("B" * 40, 1)], {skus.key(base)})
    assert len(numbered) == 64
    assert numbered.endswith("-2")
    assert skus.check_sku(numbered) == numbered


def test_suggestions_earlier_in_the_same_request_count_as_taken() -> None:
    taken: set[str] = set()
    first = skus.suggest("TS", [("أحمر", 1)], taken)
    taken.add(skus.key(first))
    second = skus.suggest("TS", [("1", 1)], taken)
    assert (first, second) == ("TS-1", "TS-1-2")
