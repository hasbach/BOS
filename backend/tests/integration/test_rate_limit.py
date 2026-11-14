"""T028 — brute-force and reset-email limits over ``login_attempts`` (research R6).

``login_attempts`` is not business data and is used outside any tenant context. Every test
works in a transaction that is rolled back, with its own identifiers and addresses, and moves
an injected clock instead of waiting.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.rate_limit import (
    MAX_FAILURES_PER_IDENTIFIER,
    MAX_FAILURES_PER_IP,
    MAX_RESET_EMAILS,
    MAX_RESET_REQUESTS_PER_IP,
    RateLimiter,
)
from app.core.tenancy import enter_tenant

START = datetime(2026, 11, 11, 9, 0, tzinfo=UTC)


class Clock:
    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


@pytest.fixture()
def clock() -> Clock:
    return Clock()


@pytest.fixture()
def limiter(clock: Clock) -> RateLimiter:
    return RateLimiter("test-secret-key", clock=clock)


@pytest.fixture()
def db(app_engine: Engine) -> Iterator[Session]:
    """A transaction as the application role with no tenant context, always rolled back."""
    session = Session(app_engine)
    session.begin()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _phone() -> str:
    return f"+9617{uuid.uuid4().int % 10_000_000:07d}"


def _ip() -> str:
    n = uuid.uuid4().int
    return f"10.{n % 256}.{(n >> 8) % 256}.{(n >> 16) % 256}"


def _fail(limiter: RateLimiter, db: Session, identifier: str, ip: str | None, times: int) -> None:
    for _ in range(times):
        limiter.record_sign_in(db, identifier, ip, success=False)


# ---- per identifier ---------------------------------------------------------------------------


def test_five_failures_in_fifteen_minutes_block_the_identifier(
    limiter: RateLimiter, db: Session, clock: Clock
) -> None:
    phone = _phone()
    for _ in range(MAX_FAILURES_PER_IDENTIFIER - 1):
        limiter.record_sign_in(db, phone, _ip(), success=False)
        clock.advance(minutes=2)
    assert not limiter.sign_in_blocked(db, phone, _ip())

    limiter.record_sign_in(db, phone, _ip(), success=False)

    assert limiter.sign_in_blocked(db, phone, _ip())
    assert limiter.sign_in_blocked(db, phone, None)
    assert not limiter.sign_in_blocked(db, _phone(), _ip())  # other identifiers unaffected


def test_the_block_lasts_until_the_fifth_failure_is_fifteen_minutes_old(
    limiter: RateLimiter, db: Session, clock: Clock
) -> None:
    phone = _phone()
    for _ in range(MAX_FAILURES_PER_IDENTIFIER):
        limiter.record_sign_in(db, phone, None, success=False)
        clock.advance(minutes=3)
    fifth = clock.now - timedelta(minutes=3)

    clock.now = fifth + timedelta(minutes=14, seconds=59)
    # The first failure is already more than 15 minutes old; the block still holds.
    assert limiter.sign_in_blocked(db, phone, None)

    clock.now = fifth + timedelta(minutes=15, seconds=1)
    assert not limiter.sign_in_blocked(db, phone, None)


def test_failures_spread_over_more_than_fifteen_minutes_do_not_block(
    limiter: RateLimiter, db: Session, clock: Clock
) -> None:
    phone = _phone()
    for _ in range(MAX_FAILURES_PER_IDENTIFIER * 2):
        limiter.record_sign_in(db, phone, None, success=False)
        assert not limiter.sign_in_blocked(db, phone, None)
        clock.advance(minutes=4)


def test_a_success_does_not_erase_earlier_failures(
    limiter: RateLimiter, db: Session, clock: Clock
) -> None:
    phone = _phone()
    _fail(limiter, db, phone, None, MAX_FAILURES_PER_IDENTIFIER - 1)
    limiter.record_sign_in(db, phone, None, success=True)
    assert not limiter.sign_in_blocked(db, phone, None)

    limiter.record_sign_in(db, phone, None, success=False)

    assert limiter.sign_in_blocked(db, phone, None)


def test_the_identifier_is_compared_normalized(limiter: RateLimiter, db: Session) -> None:
    email = f"person-{uuid.uuid4().hex[:8]}@example.test"
    _fail(limiter, db, f"  {email.upper()} ", None, MAX_FAILURES_PER_IDENTIFIER)

    assert limiter.sign_in_blocked(db, email, None)


# ---- per address ------------------------------------------------------------------------------


def test_thirty_failures_from_one_address_block_that_address(
    limiter: RateLimiter, db: Session, clock: Clock
) -> None:
    ip = _ip()
    for _ in range(MAX_FAILURES_PER_IP - 1):
        limiter.record_sign_in(db, _phone(), ip, success=False)
        clock.advance(seconds=20)
    assert not limiter.sign_in_blocked(db, _phone(), ip)

    limiter.record_sign_in(db, _phone(), ip, success=False)

    assert limiter.sign_in_blocked(db, _phone(), ip)
    assert not limiter.sign_in_blocked(db, _phone(), _ip())
    assert not limiter.sign_in_blocked(db, _phone(), None)

    clock.advance(minutes=15, seconds=1)
    assert not limiter.sign_in_blocked(db, _phone(), ip)


def test_successes_from_an_address_do_not_count(limiter: RateLimiter, db: Session) -> None:
    ip = _ip()
    for _ in range(MAX_FAILURES_PER_IP + 5):
        limiter.record_sign_in(db, _phone(), ip, success=True)

    assert not limiter.sign_in_blocked(db, _phone(), ip)


# ---- what is stored ---------------------------------------------------------------------------


def test_only_a_keyed_hash_of_the_identifier_is_stored(
    limiter: RateLimiter, db: Session, clock: Clock
) -> None:
    phone = _phone()
    ip = _ip()

    limiter.record_sign_in(db, phone, ip, success=False)

    [row] = db.execute(
        text(
            "SELECT identifier_hash, host(ip) AS ip, success, at FROM login_attempts "
            "WHERE ip = CAST(:ip AS inet)"
        ),
        {"ip": ip},
    ).all()
    stored = bytes(row.identifier_hash)
    assert len(stored) == 32
    assert phone.encode() not in stored
    # Not a plain SHA-256 either: phone numbers are few enough to be guessed from one.
    assert stored != hashlib.sha256(phone.encode()).digest()
    assert stored == limiter.identifier_hash(phone)
    assert stored != RateLimiter("another-key").identifier_hash(phone)
    assert (row.ip, row.success, row.at) == (ip, False, START)


def test_it_works_without_any_tenant_context(limiter: RateLimiter, db: Session) -> None:
    phone = _phone()
    _fail(limiter, db, phone, None, MAX_FAILURES_PER_IDENTIFIER)
    assert db.execute(text("SELECT app_tenant_id()")).scalar_one() is None
    assert limiter.sign_in_blocked(db, phone, None)


def test_tenant_context_does_not_change_what_is_counted(limiter: RateLimiter, db: Session) -> None:
    phone = _phone()
    _fail(limiter, db, phone, None, MAX_FAILURES_PER_IDENTIFIER)

    enter_tenant(db, uuid.uuid4())

    assert limiter.sign_in_blocked(db, phone, None)


# ---- password-reset emails --------------------------------------------------------------------


def test_reset_emails_are_limited_to_three_per_address_per_hour(
    limiter: RateLimiter, db: Session, clock: Clock
) -> None:
    email = f"reset-{uuid.uuid4().hex[:8]}@example.test"
    for _ in range(MAX_RESET_EMAILS):
        assert limiter.take_reset_email(db, email, _ip())
        clock.advance(minutes=10)

    assert not limiter.take_reset_email(db, email, _ip())
    assert not limiter.take_reset_email(db, email.upper(), _ip())
    assert limiter.take_reset_email(db, f"other-{email}", _ip())

    # Refused requests do not extend the hour: it runs from the first accepted one.
    clock.now = START + timedelta(hours=1, seconds=1)
    assert limiter.take_reset_email(db, email, _ip())
    assert not limiter.take_reset_email(db, email, _ip())  # requests at 10 and 20 min remain


def test_reset_window_slides(limiter: RateLimiter, db: Session, clock: Clock) -> None:
    email = f"slide-{uuid.uuid4().hex[:8]}@example.test"
    for _ in range(MAX_RESET_EMAILS):
        assert limiter.take_reset_email(db, email, None)
        clock.advance(minutes=20)
    # Requests at 0, 20 and 40 minutes; now 60 minutes: the first is exactly an hour old.
    clock.advance(seconds=1)
    assert limiter.take_reset_email(db, email, None)
    assert not limiter.take_reset_email(db, email, None)


def test_reset_requests_never_count_as_sign_in_failures(limiter: RateLimiter, db: Session) -> None:
    email = f"both-{uuid.uuid4().hex[:8]}@example.test"
    ip = _ip()
    for _ in range(MAX_FAILURES_PER_IP + 1):
        limiter.take_reset_email(db, email, ip)

    assert not limiter.sign_in_blocked(db, email, ip)
    # ...and sign-in failures never use up reset emails.
    _fail(limiter, db, email, ip, MAX_FAILURES_PER_IDENTIFIER)
    other = f"fresh-{uuid.uuid4().hex[:8]}@example.test"
    _fail(limiter, db, other, None, MAX_FAILURES_PER_IDENTIFIER)
    assert limiter.take_reset_email(db, other, None)


def test_reset_requests_are_limited_to_ten_per_client_address_per_hour(
    limiter: RateLimiter, db: Session, clock: Clock
) -> None:
    ip = _ip()
    for _ in range(MAX_RESET_REQUESTS_PER_IP):
        assert limiter.take_reset_request_from(db, ip)
        clock.advance(minutes=5)

    assert not limiter.take_reset_request_from(db, ip)
    assert limiter.take_reset_request_from(db, _ip())

    # Requests at 0..45 minutes; at 60 minutes and a second the first one has expired.
    clock.now = START + timedelta(hours=1, seconds=1)
    assert limiter.take_reset_request_from(db, ip)
    assert not limiter.take_reset_request_from(db, ip)


def test_client_and_address_reset_limits_are_counted_apart(
    limiter: RateLimiter, db: Session
) -> None:
    ip = _ip()
    email = f"apart-{uuid.uuid4().hex[:8]}@example.test"
    for _ in range(MAX_RESET_REQUESTS_PER_IP):
        assert limiter.take_reset_request_from(db, ip)

    # A client over its limit has not used up any address's emails, and an address over its
    # limit has not used up any client's requests.
    for _ in range(MAX_RESET_EMAILS):
        assert limiter.take_reset_email(db, email, ip)
    assert not limiter.take_reset_email(db, email, _ip())
    assert limiter.take_reset_request_from(db, _ip())
    # Neither counts towards a sign-in block for the client address.
    assert not limiter.sign_in_blocked(db, email, ip)
