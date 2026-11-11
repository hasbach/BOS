"""Password hashing and policy, one-time link tokens, and the CSRF header check."""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Mapping

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from werkzeug.datastructures import Headers

MIN_PASSWORD_LENGTH = 10
# Upper bound so that hashing an enormous input cannot be used to exhaust the server.
MAX_PASSWORD_LENGTH = 256

CSRF_HEADER = "X-BOS-CSRF"
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

_hasher = PasswordHasher()  # Argon2id with the library's recommended parameters

# Passwords of ten or more characters that attackers try first. Compared lower-cased.
_COMMON_PASSWORDS = frozenset(
    {
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
    }
)


class WeakPassword(ValueError):
    code = "weak_password"

    def __init__(self) -> None:
        super().__init__(self.code)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    """True only if the password matches. Never raises for a wrong or malformed input."""
    try:
        return _hasher.verify(stored_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def password_needs_rehash(stored_hash: str) -> bool:
    return _hasher.check_needs_rehash(stored_hash)


def validate_password(password: str) -> None:
    """Raise ``WeakPassword`` unless the password meets the policy (FR-010)."""
    if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
        raise WeakPassword
    if len(set(password)) < 4:  # e.g. "aaaaaaaaaaaa", "1111111111", "abababababab"
        raise WeakPassword
    if password.lower() in _COMMON_PASSWORDS:
        raise WeakPassword


def hash_token(token: str) -> bytes:
    """What is stored for a link or session token. The token itself is never stored."""
    return hashlib.sha256(token.encode()).digest()


def new_token() -> tuple[str, bytes]:
    """A fresh random token (given to the person once) and its hash (stored)."""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def csrf_ok(method: str, headers: Mapping[str, str] | Headers) -> bool:
    """State-changing requests must carry a header that a cross-site form cannot set."""
    if method.upper() in _SAFE_METHODS:
        return True
    return headers.get(CSRF_HEADER) == "1"
