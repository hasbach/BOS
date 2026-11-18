"""T014 — password hashing and policy, link tokens, CSRF header (FR-007, FR-010, R4, R7)."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.core import security
from app.core.security import (
    MIN_PASSWORD_LENGTH,
    WeakPassword,
    code_hash,
    code_matches,
    csrf_ok,
    hash_password,
    hash_token,
    new_code,
    new_token,
    normalize_code,
    validate_password,
    verify_password,
)

GOOD_PASSWORD = "correct horse battery"


def test_password_hash_is_argon2id_and_not_the_password() -> None:
    hashed = hash_password(GOOD_PASSWORD)

    assert hashed.startswith("$argon2id$")
    assert GOOD_PASSWORD not in hashed


def test_same_password_hashes_differently_each_time() -> None:
    assert hash_password(GOOD_PASSWORD) != hash_password(GOOD_PASSWORD)


def test_verify_accepts_the_right_password_and_rejects_others() -> None:
    hashed = hash_password(GOOD_PASSWORD)

    assert verify_password(hashed, GOOD_PASSWORD) is True
    assert verify_password(hashed, GOOD_PASSWORD + "x") is False
    assert verify_password(hashed, "") is False


def test_verify_returns_false_for_a_malformed_stored_hash() -> None:
    assert verify_password("not-a-hash", GOOD_PASSWORD) is False


def test_minimum_length_is_ten() -> None:
    assert MIN_PASSWORD_LENGTH == 10
    validate_password("k7Rv2Lq9Xz")  # exactly 10: accepted ("a1b2c3d4e5" is a listed one)
    with pytest.raises(WeakPassword):
        validate_password("k7Rv2Lq9X")  # 9


@pytest.mark.parametrize(
    "password",
    [
        "1234567890",
        "0123456789",
        "password123",
        "Password123",
        "qwertyuiop",
        "aaaaaaaaaaaa",
        "1111111111",
        "passwordpassword",
    ],
)
def test_common_or_trivial_passwords_are_rejected(password: str) -> None:
    with pytest.raises(WeakPassword) as excinfo:
        validate_password(password)
    assert excinfo.value.code == "weak_password"


def test_absurdly_long_password_is_rejected_to_protect_the_server() -> None:
    with pytest.raises(WeakPassword):
        validate_password("x1" * 600)


def test_arabic_passphrase_is_accepted() -> None:
    validate_password("حصان بطارية صحيح")


def test_new_token_is_long_random_and_only_its_hash_is_meant_to_be_stored() -> None:
    token, digest = new_token()
    other_token, other_digest = new_token()

    assert token != other_token
    assert len(token) >= 43  # 32 random bytes, URL-safe base64 without padding
    assert digest == hashlib.sha256(token.encode()).digest()
    assert len(digest) == 32
    assert digest != other_digest
    assert token.encode() not in digest


def test_hash_token_matches_new_token_digest() -> None:
    token, digest = new_token()

    assert hash_token(token) == digest


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_read_only_methods_need_no_csrf_header(method: str) -> None:
    assert csrf_ok(method, {}) is True


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_state_changing_methods_require_the_csrf_header(method: str) -> None:
    assert csrf_ok(method, {}) is False
    assert csrf_ok(method, {"X-BOS-CSRF": "0"}) is False
    assert csrf_ok(method, {"X-BOS-CSRF": "1"}) is True


# ---- emailed codes (FR-012a, research R37) ----------------------------------------------------


def test_new_codes_are_six_digits_and_vary() -> None:
    codes = {new_code() for _ in range(200)}

    assert all(len(code) == 6 and code.isascii() and code.isdigit() for code in codes)
    assert len(codes) > 190


@pytest.mark.parametrize(
    ("typed", "expected"),
    [
        ("012345", "012345"),
        (" 012 345 ", "012345"),
        ("٠١٢٣٤٥", "012345"),
        ("۰۱۲۳۴۵", "012345"),
        ("12345", None),
        ("1234567", None),
        ("12a456", None),
        ("".join(chr(0xFF10 + d) for d in (1, 2, 3, 4, 5, 6)), None),  # full-width: refused
        ("", None),
        (123456, None),
        (None, None),
        ("1" * 40, None),
    ],
)
def test_typed_codes_are_normalized(typed: object, expected: str | None) -> None:
    assert normalize_code(typed) == expected


def test_a_code_hash_needs_the_key_and_is_tied_to_its_scope() -> None:
    stored = code_hash("key-one", "invitation-1", "123456")

    assert code_matches("key-one", "invitation-1", "123456", stored)
    assert not code_matches("key-two", "invitation-1", "123456", stored)
    assert not code_matches("key-one", "invitation-2", "123456", stored)
    assert not code_matches("key-one", "invitation-1", "123457", stored)
    assert stored != hashlib.sha256(b"123456").digest()


# ---- F-15: the common-password list (M1 T003, research R57) ------------------------------------

COMMON_PASSWORDS_FILE = (
    Path(security.__file__).resolve().parents[1] / "data" / "common_passwords.txt"
)
M0_ENTRIES = (
    "1234567890",
    "0123456789",
    "12345678910",
    "123456789a",
    "1q2w3e4r5t",
    "1qaz2wsx3edc",
    "abcdefghij",
    "administrator",
    "iloveyou123",
    "letmein123",
    "password12",
    "password123",
    "password1234",
    "passwordpassword",
    "qwerty12345",
    "qwertyuiop",
    "welcome123",
    "bospassword",
)


def _file_entries() -> list[str]:
    lines = COMMON_PASSWORDS_FILE.read_text(encoding="utf-8").splitlines()
    return [line for line in lines if line and not line.startswith("#")]


def test_the_list_file_names_its_source_and_licence_in_its_header() -> None:
    header = [
        line
        for line in COMMON_PASSWORDS_FILE.read_text(encoding="utf-8").splitlines()
        if line.startswith("#")
    ]
    text = "\n".join(header)
    assert "SecLists" in text
    assert "MIT" in text


def test_every_entry_is_lower_case_and_at_least_10_characters() -> None:
    entries = _file_entries()
    assert len(entries) > 1000
    assert all(entry == entry.lower() for entry in entries)
    assert all(len(entry) >= MIN_PASSWORD_LENGTH for entry in entries)
    assert all(entry == entry.strip() for entry in entries)


def test_the_list_is_loaded_once_from_the_file(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []
    real = security.load_common_passwords

    def counting() -> frozenset[str]:
        calls.append(None)
        return real()

    loaded = security.common_passwords()
    monkeypatch.setattr(security, "load_common_passwords", counting)
    for _ in range(3):
        assert security.common_passwords() is loaded
    assert calls == []
    assert set(_file_entries()) <= loaded
    assert not any(entry.startswith("#") for entry in loaded)


@pytest.mark.parametrize("password", ["usuckballz1", "4815162342", "q1w2e3r4t5", "12345qwert"])
def test_well_known_passwords_from_the_list_are_refused_in_any_case(password: str) -> None:
    for variant in (password, password.upper(), password.capitalize()):
        with pytest.raises(WeakPassword):
            validate_password(variant)


@pytest.mark.parametrize("password", M0_ENTRIES)
def test_the_m0_entries_are_still_refused(password: str) -> None:
    with pytest.raises(WeakPassword):
        validate_password(password)


def test_a_strong_password_is_still_accepted() -> None:
    validate_password("Correct-Horse-42")
