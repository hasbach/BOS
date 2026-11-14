"""Brute-force protection and the reset-email limit (research R6, FR-007).

Both are counted in ``login_attempts``, which is not business data: it is used outside any
tenant context and holds no identifier, only a keyed hash of it.

* Sign-in: blocked while 5 failures for one identifier fall within 15 minutes of each other
  and the last of them is under 15 minutes old (so the block lasts 15 minutes from the 5th
  failure), or while 30 failures from one address do the same. A success erases nothing.
  The caller should not record an attempt that was refused because of a block (the password
  was never checked), and must answer it exactly like a wrong password.
* Password-reset emails: at most 3 accepted requests per address in any hour, and at most 10
  requests from one client address in any hour (so one client cannot have reset mail sent to
  many addresses). These rows live in their own hash namespaces (the per-client rows hold a
  keyed hash of the client address) and are stored as ``success = true``, so they never count
  towards a sign-in block, by identifier or by address.

Identifiers are hashed with HMAC-SHA-256 keyed by the application secret, so the stored
value cannot be turned back into a phone number by trying every number. Pass the normalized
identifier (``identifiers.Identifier.value``); it is also trimmed and lower-cased here.
"""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from flask import Flask
from sqlalchemy import text
from sqlalchemy.orm import Session

SIGN_IN_WINDOW = timedelta(minutes=15)
MAX_FAILURES_PER_IDENTIFIER = 5
MAX_FAILURES_PER_IP = 30
RESET_EMAIL_WINDOW = timedelta(hours=1)
MAX_RESET_EMAILS = 3
MAX_RESET_REQUESTS_PER_IP = 10

_SIGN_IN = "sign_in"
_RESET_EMAIL = "password_reset_email"
_RESET_IP = "password_reset_ip"

_INSERT = text(
    "INSERT INTO login_attempts (identifier_hash, ip, success, at) "
    "VALUES (:hash, CAST(:ip AS inet), :success, :at)"
)


def _blocked_sql(column: str) -> str:
    # True when some failure under a window old closes a run of :count failures that all fit
    # in one window. ``column`` is one of two constants below, never user input.
    return (
        "SELECT EXISTS (SELECT 1 FROM ("  # noqa: S608
        "  SELECT at, lag(at, :back) OVER (ORDER BY at) AS earlier FROM login_attempts"
        f"  WHERE {column} AND NOT success"
        "    AND at > CAST(:now AS timestamptz) - 2 * CAST(:window AS interval)"
        "    AND at <= CAST(:now AS timestamptz)"
        ") runs WHERE earlier IS NOT NULL"
        "  AND at - earlier <= CAST(:window AS interval)"
        "  AND at > CAST(:now AS timestamptz) - CAST(:window AS interval))"
    )


_BLOCKED_BY_IDENTIFIER = text(_blocked_sql("identifier_hash = :hash"))
_BLOCKED_BY_IP = text(_blocked_sql("ip = CAST(:ip AS inet)"))
_LOCK = text("SELECT pg_advisory_xact_lock(:lock)")
_RECENT = text(
    "SELECT count(*) FROM login_attempts WHERE identifier_hash = :hash "
    "AND at > CAST(:now AS timestamptz) - CAST(:window AS interval) "
    "AND at <= CAST(:now AS timestamptz)"
)


def _utcnow() -> datetime:
    return datetime.now(UTC)


class RateLimiter:
    def __init__(self, secret_key: str, *, clock: Callable[[], datetime] = _utcnow) -> None:
        if not secret_key:
            raise ValueError("a secret key is required")
        self._key = secret_key.encode()
        self._clock = clock

    @classmethod
    def for_app(cls, app: Flask) -> RateLimiter:
        from app import get_config

        return cls(get_config(app).secret_key)

    def identifier_hash(self, identifier: str) -> bytes:
        """What is stored for a sign-in identifier."""
        return self._hash(_SIGN_IN, identifier)

    def record_sign_in(
        self, db: Session, identifier: str, ip: str | None, *, success: bool
    ) -> None:
        db.execute(
            _INSERT,
            {
                "hash": self.identifier_hash(identifier),
                "ip": ip,
                "success": success,
                "at": self._clock(),
            },
        )

    def sign_in_blocked(self, db: Session, identifier: str, ip: str | None) -> bool:
        now = self._clock()
        params = {"now": now, "window": SIGN_IN_WINDOW}
        if db.execute(
            _BLOCKED_BY_IDENTIFIER,
            {
                **params,
                "hash": self.identifier_hash(identifier),
                "back": MAX_FAILURES_PER_IDENTIFIER - 1,
            },
        ).scalar_one():
            return True
        if ip is None:
            return False
        return bool(
            db.execute(
                _BLOCKED_BY_IP, {**params, "ip": ip, "back": MAX_FAILURES_PER_IP - 1}
            ).scalar_one()
        )

    def take_reset_email(self, db: Session, email: str, ip: str | None) -> bool:
        """True if a reset email may be sent to ``email`` now; the request is then counted.

        Serialised per address for the rest of the transaction, so two simultaneous
        requests cannot both take the last slot.
        """
        return self._take(db, self._hash(_RESET_EMAIL, email), ip, MAX_RESET_EMAILS)

    def take_reset_request_from(self, db: Session, ip: str) -> bool:
        """True if the client at ``ip`` may make another reset request now; it is then counted.

        Every request that gets this far counts, whatever happens to it afterwards (an
        address over its own limit, an unknown address). Serialised per client address.
        """
        return self._take(db, self._hash(_RESET_IP, ip), ip, MAX_RESET_REQUESTS_PER_IP)

    def _take(self, db: Session, hashed: bytes, ip: str | None, limit: int) -> bool:
        now = self._clock()
        db.execute(_LOCK, {"lock": int.from_bytes(hashed[:8], "big", signed=True)})
        recent = db.execute(
            _RECENT, {"hash": hashed, "now": now, "window": RESET_EMAIL_WINDOW}
        ).scalar_one()
        if recent >= limit:
            return False
        db.execute(_INSERT, {"hash": hashed, "ip": ip, "success": True, "at": now})
        return True

    def _hash(self, namespace: str, identifier: str) -> bytes:
        message = f"{namespace}\0{identifier.strip().lower()}".encode()
        return hmac.new(self._key, message, hashlib.sha256).digest()
