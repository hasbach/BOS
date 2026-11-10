"""T014 — password hashing and policy, link tokens, CSRF header (FR-007, FR-010, R4, R7)."""

from __future__ import annotations

import hashlib

import pytest

from app.core.security import (
    MIN_PASSWORD_LENGTH,
    WeakPassword,
    csrf_ok,
    hash_password,
    hash_token,
    new_token,
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
    validate_password("a1b2c3d4e5")  # exactly 10: accepted
    with pytest.raises(WeakPassword):
        validate_password("a1b2c3d4e")  # 9


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
