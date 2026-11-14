"""T093 — security.md F-09 / FR-012a: an employee invitation by email is accepted with a code.

The link holder (who may be the inviter) asks for a code, BOS emails it to the invitation's
address after answering, and acceptance runs only with the right code. Until then nothing
said depends on whether the address belongs to a BOS user in another business. Owner
activations and invitations by phone number are accepted without a code.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from typing import Any

import pytest
from flask import Flask
from sqlalchemy import Engine, event

from app.config import Config
from app.core.db import engine_of
from app.core.security import new_token
from app.services import invitations
from tests.dbsupport import TwoTenants, World, insert
from tests.integration.us1_support import (
    CSRF,
    PASSWORD,
    app_for,
    error,
    history,
    ok,
    outbox,
    owner_rows,
    owner_sql,
    owner_value,
    refused,
    shared_app_fixture,
    with_valid_phones,
)

UNREGISTERED = "fresh.person@example.test"


@pytest.fixture()
def worlds(fresh_tenants: TwoTenants, owner_engine: Engine) -> TwoTenants:
    return with_valid_phones(owner_engine, fresh_tenants)


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


def _invite(
    owner: Engine,
    world: World,
    *,
    email: str | None = UNREGISTERED,
    phone: str | None = None,
    kind: str = "employee",
) -> tuple[str, uuid.UUID]:
    token, hashed = new_token()
    invitation_id = uuid.uuid4()
    with owner.begin() as conn:
        insert(
            conn,
            "invitations",
            id=invitation_id,
            tenant_id=world.tenant_id,
            kind=kind,
            invitee_name="New Person",
            invitee_email=email,
            invitee_phone_e164=phone,
            roles=["owner"] if kind == "owner_activation" else ["sales"],
            all_stores=True,
            token_hash=hashed,
            created_by_user_id=world.user_id,
        )
    return token, invitation_id


def _post(app: Flask, path: str, body: dict[str, Any], **kwargs: Any) -> Any:
    return app.test_client().post(f"/api/v1{path}", json=body, headers=CSRF, **kwargs)


def _send_code(app: Flask, token: str, locale: str = "en", *, close: bool = True) -> Any:
    """Ask for a code. With ``close``, the answer is read and closed as a WSGI server does,
    which is when the email goes out."""
    return _post(app, "/invitations/send-code", {"token": token, "locale": locale}, buffered=close)


def _accept(app: Flask, token: str, code: Any = None, **extra: Any) -> Any:
    body: dict[str, Any] = {"token": token, "password": PASSWORD, "locale": "en", **extra}
    if code is not None:
        body["code"] = code
    return _post(app, "/invitations/accept", body)


def _code_in(message: EmailMessage) -> str:
    found = re.findall(r"\b(\d{6})\b", str(message.get_content()))
    assert len(found) == 1
    return str(found[0])


def _emailed_code(app: Flask, token: str, locale: str = "en") -> str:
    ok(_send_code(app, token, locale), 204)
    return _code_in(outbox(app).messages[-1])


def _wrong(code: str) -> str:
    return f"{(int(code) + 1) % 1_000_000:06d}"


def _users_with(owner: Engine, email: str) -> int:
    return int(owner_value(owner, "SELECT count(*) FROM users WHERE email = :e", e=email))


# ---- preview ------------------------------------------------------------------------------------


def test_preview_says_when_a_code_is_needed(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    by_email, _ = _invite(owner_engine, worlds.a)
    registered, _ = _invite(owner_engine, worlds.a, email=worlds.b.email)
    by_phone, _ = _invite(owner_engine, worlds.a, email=None, phone="+96171999888")
    both, _ = _invite(owner_engine, worlds.a, email="both@example.test", phone="+96171999777")

    previews = {
        name: ok(_post(app, "/invitations/preview", {"token": token}))
        for name, token in (
            ("email", by_email),
            ("registered", registered),
            ("phone", by_phone),
            ("both", both),
        )
    }

    assert previews["email"]["code_required"] is True
    assert previews["both"]["code_required"] is True
    assert previews["phone"]["code_required"] is False
    # Identical for a registered and an unregistered address.
    without_time = [
        {k: v for k, v in previews[n].items() if k != "expires_at"} for n in ("email", "registered")
    ]
    assert without_time[0] == without_time[1]


# ---- sending a code -----------------------------------------------------------------------------


def test_a_code_is_emailed_to_the_invitation_address_and_only_its_keyed_hash_is_stored(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, invitation_id = _invite(owner_engine, worlds.a)

    response = _send_code(app, token)

    assert response.status_code == 204
    assert response.get_data() == b""
    [message] = outbox(app).messages
    assert message["To"] == UNREGISTERED
    assert message["Subject"] == "Your BOS invitation code"
    code = _code_in(message)
    assert "15 minutes" in str(message.get_content())
    [row] = owner_rows(
        owner_engine,
        "SELECT code_hash, expires_at - created_at AS lifetime, failed_attempts, voided_at "
        "FROM invitation_codes WHERE invitation_id = :i",
        i=invitation_id,
    )
    assert row.lifetime == timedelta(minutes=15)
    assert (row.failed_attempts, row.voided_at) == (0, None)
    stored = bytes(row.code_hash)
    assert code.encode() not in stored
    assert stored != hashlib.sha256(code.encode()).digest()
    [sent] = history(owner_engine, worlds.a.tenant_id, "invitation.code_sent")
    assert (sent.actor_type, sent.actor_id, sent.target_id) == ("anonymous", None, invitation_id)
    assert sent.data == {"kind": "employee"}
    assert code not in str(history(owner_engine, worlds.a.tenant_id))
    [email] = history(owner_engine, worlds.a.tenant_id, "email.sent")
    assert email.data == {"purpose": "invitation_code", "domain": "example.test"}


def test_the_code_email_is_in_the_language_of_the_page(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _invite(owner_engine, worlds.a)

    _emailed_code(app, token, "ar")

    [message] = outbox(app).messages
    assert message["Subject"] == "رمز دعوتك إلى BOS"
    assert "مرحباً New Person" in str(message.get_content())


def test_the_email_waits_until_the_answer_is_sent(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _invite(owner_engine, worlds.a)
    answered: list[bool] = []
    response: Any = None
    outbox(app).on_send.append(lambda _message: answered.append(response is not None))

    response = _send_code(app, token, close=False)
    assert response.status_code == 204
    assert answered == []
    response.close()

    assert answered == [True]


def test_a_failed_email_is_recorded_and_logged_without_the_code(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, caplog: pytest.LogCaptureFixture
) -> None:
    token, _ = _invite(owner_engine, worlds.a)
    outbox(app).fail = True
    caplog.set_level(logging.INFO)

    ok(_send_code(app, token), 204)

    [failed] = history(owner_engine, worlds.a.tenant_id, "email.failed")
    assert failed.data["purpose"] == "invitation_code"
    assert UNREGISTERED not in caplog.text
    assert not re.search(r"\b\d{6}\b", caplog.text)


def test_links_that_need_no_code_refuse_to_send_one(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    by_phone, _ = _invite(owner_engine, worlds.a, email=None, phone="+96171999888")
    owner, _ = _invite(owner_engine, worlds.a, email="boss@example.test", kind="owner_activation")

    refused(_send_code(app, by_phone), 409, "code_not_required")
    refused(_send_code(app, owner), 409, "code_not_required")
    refused(_send_code(app, "not-a-real-token"), 410, "link_invalid")
    refused(
        _post(app, "/invitations/send-code", {"token": by_phone, "locale": "fr"}),
        400,
        "validation_failed",
    )
    assert outbox(app).messages == []


def test_no_code_is_sent_for_a_closed_invitation(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, invitation_id = _invite(owner_engine, worlds.a)
    owner_sql(
        owner_engine, "UPDATE invitations SET status = 'revoked' WHERE id = :i", i=invitation_id
    )

    refused(_send_code(app, token), 410, "link_invalid")
    assert outbox(app).messages == []


def test_at_most_five_codes_per_invitation_per_hour(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, invitation_id = _invite(owner_engine, worlds.a)
    for _ in range(invitations.MAX_CODES_PER_HOUR):
        ok(_send_code(app, token), 204)

    refused(_send_code(app, token), 429, "too_many_requests")
    assert len(outbox(app).messages) == 5

    # An hour later the invitation may have codes again.
    owner_sql(
        owner_engine,
        "UPDATE invitation_codes SET created_at = created_at - interval '61 minutes' "
        "WHERE invitation_id = :i",
        i=invitation_id,
    )
    ok(_send_code(app, token), 204)


def test_at_most_ten_code_emails_per_address_per_hour_across_invitations(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    in_a, _ = _invite(owner_engine, worlds.a, email="target@example.test")
    in_b, _ = _invite(owner_engine, worlds.b, email="target@example.test")
    for token in (in_a, in_b):
        for _ in range(5):
            ok(_send_code(app, token), 204)
    owner_sql(owner_engine, "UPDATE invitation_codes SET created_at = now() - interval '2 hours'")

    refused(_send_code(app, in_a), 429, "too_many_requests")
    assert len(outbox(app).messages) == 10


# ---- the same answers before the code -------------------------------------------------------------


def test_until_the_right_code_registered_and_unregistered_addresses_get_the_same_answers(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    """The inviter holds the link: nothing before the right code may tell them whether the
    address belongs to someone in another business (status, body, headers, the work done)."""
    tokens = {
        "registered": _invite(owner_engine, worlds.a, email=worlds.b.email)[0],
        "unregistered": _invite(owner_engine, worlds.a)[0],
    }
    statements: list[str] = []

    def seen(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        statements.append(statement)

    engine = engine_of(app)
    work: dict[str, list[list[str]]] = {name: [] for name in tokens}
    answers: dict[str, list[Any]] = {name: [] for name in tokens}
    event.listen(engine, "before_cursor_execute", seen)
    try:
        for name, token in tokens.items():
            for step in (
                lambda t=token: _accept(app, t),  # no code yet
                lambda t=token: _send_code(app, t),
                lambda t=token: _accept(app, t),  # code missing
                lambda t=token: _accept(app, t, "000000"),  # wrong code
                lambda t=token: _accept(app, t, "12"),  # malformed code
            ):
                statements.clear()
                answers[name].append(step())
                work[name].append(list(statements))
    finally:
        event.remove(engine, "before_cursor_execute", seen)

    registered, unregistered = answers["registered"], answers["unregistered"]
    for mine, theirs in zip(registered, unregistered, strict=True):
        assert (mine.status_code, mine.get_data()) == (theirs.status_code, theirs.get_data())
        assert _headers(mine) == _headers(theirs)
    assert [r.status_code for r in registered] == [400, 204, 400, 400, 400]
    assert {error(r) for r in registered if r.status_code == 400} == {"code_invalid"}
    assert work["registered"] == work["unregistered"]
    assert _users_with(owner_engine, UNREGISTERED) == 0


def _headers(response: Any) -> dict[str, str]:
    return {k: v for k, v in response.headers.items() if k != "X-Request-ID"}


def test_after_the_right_code_a_registered_address_is_refused_neutrally(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, invitation_id = _invite(owner_engine, worlds.a, email=worlds.b.email)
    code = _emailed_code(app, token)

    refused(_accept(app, token, code), 409, "identifier_unavailable")

    assert (
        owner_value(owner_engine, "SELECT status FROM invitations WHERE id = :i", i=invitation_id)
        == "pending"
    )
    assert _users_with(owner_engine, worlds.b.email) == 1


def test_the_right_code_accepts_and_signs_in(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, invitation_id = _invite(owner_engine, worlds.a)
    code = _emailed_code(app, token)

    me = ok(_accept(app, token, code))

    assert me["user"]["email"] == UNREGISTERED
    assert me["user"]["roles"] == ["sales"]
    assert (
        owner_value(owner_engine, "SELECT status FROM invitations WHERE id = :i", i=invitation_id)
        == "accepted"
    )
    refused(_accept(app, token, code), 410, "link_already_used")


@pytest.mark.parametrize("typed", ["{c}", " {c} ", "{c3} {c3b}", "{arabic}", "{persian}"])
def test_the_code_may_be_typed_with_spaces_or_arabic_digits(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, typed: str
) -> None:
    token, _ = _invite(owner_engine, worlds.a)
    code = _emailed_code(app, token)
    entered = typed.format(
        c=code,
        c3=code[:3],
        c3b=code[3:],
        arabic=code.translate(str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")),
        persian=code.translate(str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")),
    )

    ok(_accept(app, token, entered))


def test_a_weak_password_with_the_right_code_keeps_the_code_usable(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, _ = _invite(owner_engine, worlds.a)
    code = _emailed_code(app, token)

    refused(_accept(app, token, code, password="short"), 400, "weak_password")
    ok(_accept(app, token, code))


# ---- expiry, replacement, attempts -----------------------------------------------------------------


def test_an_expired_code_is_refused(app: Flask, owner_engine: Engine, worlds: TwoTenants) -> None:
    token, invitation_id = _invite(owner_engine, worlds.a)
    code = _emailed_code(app, token)
    owner_sql(
        owner_engine,
        "UPDATE invitation_codes SET expires_at = now() - interval '1 second' "
        "WHERE invitation_id = :i",
        i=invitation_id,
    )

    refused(_accept(app, token, code), 400, "code_invalid")
    ok(_accept(app, token, _emailed_code(app, token)))


def test_a_new_code_replaces_the_previous_one(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, invitation_id = _invite(owner_engine, worlds.a)
    first = _emailed_code(app, token)
    second = _emailed_code(app, token)
    if first == second:  # one in a million: the old row is still voided
        second = _emailed_code(app, token)

    refused(_accept(app, token, first), 400, "code_invalid")
    open_codes = owner_value(
        owner_engine,
        "SELECT count(*) FROM invitation_codes WHERE invitation_id = :i AND voided_at IS NULL",
        i=invitation_id,
    )
    assert open_codes == 1
    ok(_accept(app, token, second))


def test_five_wrong_entries_void_the_code(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    token, invitation_id = _invite(owner_engine, worlds.a)
    code = _emailed_code(app, token)

    _accept(app, token)  # nothing entered: not counted
    for _ in range(invitations.MAX_CODE_ATTEMPTS - 1):
        refused(_accept(app, token, _wrong(code)), 400, "code_invalid")
    assert history(owner_engine, worlds.a.tenant_id, "invitation.code_failed") == []
    refused(_accept(app, token, _wrong(code)), 400, "code_invalid")

    # Voided: even the right code no longer works.
    refused(_accept(app, token, code), 400, "code_invalid")
    [failed] = history(owner_engine, worlds.a.tenant_id, "invitation.code_failed")
    assert (failed.actor_type, failed.target_id) == ("anonymous", invitation_id)
    assert failed.data == {"kind": "employee", "attempts": 5}
    assert _users_with(owner_engine, UNREGISTERED) == 0

    ok(_accept(app, token, _emailed_code(app, token)))


def test_a_code_works_only_for_its_own_invitation(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    mine, _ = _invite(owner_engine, worlds.a)
    other, _ = _invite(owner_engine, worlds.b, email="someone.else@example.test")
    code = _emailed_code(app, mine)
    _emailed_code(app, other)

    refused(_accept(app, other, code), 400, "code_invalid")


# ---- flows without a code are unchanged -------------------------------------------------------------


def test_phone_invitations_and_owner_activations_need_no_code(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    by_phone, _ = _invite(owner_engine, worlds.a, email=None, phone="+96171999888")
    registered_phone, _ = _invite(owner_engine, worlds.a, email=None, phone=worlds.b.phone)

    ok(_accept(app, by_phone))
    refused(_accept(app, registered_phone), 409, "identifier_unavailable")

    pending_tenant = uuid.uuid4()
    token, hashed = new_token()
    with owner_engine.begin() as conn:
        insert(
            conn,
            "tenants",
            id=pending_tenant,
            name="Pending Shop",
            edition="commerce",
            status="pending",
            usd_lbp_rate="89500",
            created_by_operator_id=worlds.operator_id,
        )
        insert(conn, "stores", id=uuid.uuid4(), tenant_id=pending_tenant, name="First")
        insert(
            conn,
            "invitations",
            id=uuid.uuid4(),
            tenant_id=pending_tenant,
            kind="owner_activation",
            invitee_name="Pending Owner",
            invitee_email="pending.owner@example.test",
            roles=["owner"],
            all_stores=True,
            token_hash=hashed,
            created_by_operator_id=worlds.operator_id,
        )
    assert ok(_post(app, "/invitations/preview", {"token": token}))["code_required"] is False
    ok(_accept(app, token))
    assert outbox(app).messages == []


def test_codes_expire_with_the_clock_of_the_database(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    """The code's lifetime is the server's 15 minutes, not anything the client says."""
    token, invitation_id = _invite(owner_engine, worlds.a)
    _emailed_code(app, token)
    [row] = owner_rows(
        owner_engine,
        "SELECT expires_at FROM invitation_codes WHERE invitation_id = :i",
        i=invitation_id,
    )
    now = datetime.now(UTC)
    assert now + timedelta(minutes=14) < row.expires_at <= now + timedelta(minutes=16)
