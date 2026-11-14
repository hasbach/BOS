"""T029 — the mailer (research R8, R27).

A tiny SMTP server runs inside the test process, so a real ``smtplib`` conversation happens
without any extra dependency. History is committed, so the module uses ``fresh_tenants``.
"""

from __future__ import annotations

import dataclasses
import email
import email.policy
import socket
import socketserver
import threading
import uuid
from collections.abc import Iterator
from email.message import EmailMessage
from typing import Any, ClassVar

import pytest
from sqlalchemy import Engine, text

from app.config import Config
from app.core.mailer import SMTP_TIMEOUT_SECONDS, Mailer
from tests.dbsupport import TwoTenants

LINK = "https://bos.example.test/en/reset#not-a-real-token-but-secret"


class _SmtpHandler(socketserver.StreamRequestHandler):
    server: _SmtpSink

    def _reply(self, line: str) -> None:
        self.wfile.write(line.encode() + b"\r\n")

    def handle(self) -> None:
        self._reply("220 sink ESMTP")
        in_data = False
        lines: list[bytes] = []
        while True:
            line = self.rfile.readline()
            if not line:
                return
            if in_data:
                if line.rstrip(b"\r\n") == b".":
                    self.server.messages.append(
                        email.message_from_bytes(b"".join(lines), policy=email.policy.default)
                    )  # type: ignore[arg-type]
                    lines, in_data = [], False
                    self._reply("250 queued")
                else:
                    lines.append(line[1:] if line.startswith(b"..") else line)
                continue
            command = line[:4].upper()
            if command == b"EHLO":
                self._reply("250-sink")
                self._reply("250 8BITMIME")
            elif command == b"RCPT" and self.server.refuse_recipients:
                self._reply("550 no such user")
            elif command == b"DATA":
                in_data = True
                self._reply("354 go ahead")
            elif command == b"QUIT":
                self._reply("221 bye")
                return
            else:  # HELO, MAIL, RCPT, RSET, NOOP
                self._reply("250 ok")


class _SmtpSink(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _SmtpHandler)
        self.messages: list[EmailMessage] = []
        self.refuse_recipients = False

    @property
    def port(self) -> int:
        return int(self.server_address[1])


@pytest.fixture()
def sink() -> Iterator[_SmtpSink]:
    server = _SmtpSink()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


def _closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _config(config: Config, port: int, **overrides: Any) -> Config:
    return dataclasses.replace(
        config,
        smtp_host="127.0.0.1",
        smtp_port=port,
        smtp_user="",
        smtp_password="",
        smtp_from="BOS <no-reply@bos.example.test>",
        **overrides,
    )


def _history(owner: Engine, tenant_id: uuid.UUID | None = None) -> list[Any]:
    with owner.connect() as conn:
        return conn.execute(
            text(
                "SELECT tenant_id, actor_type, actor_id, event, target_type, target_id, data, ip "
                "FROM audit_entries WHERE event LIKE 'email.%' "
                "AND (CAST(:t AS uuid) IS NULL OR tenant_id = :t) ORDER BY at"
            ),
            {"t": tenant_id},
        ).all()


def test_a_sent_email_arrives_and_is_recorded_without_the_address(
    config: Config,
    app_engine: Engine,
    owner_engine: Engine,
    fresh_tenants: TwoTenants,
    sink: _SmtpSink,
) -> None:
    a = fresh_tenants.a
    mailer = Mailer(_config(config, sink.port), app_engine)

    sent = mailer.send(
        "Owner.Person@Example.Test",
        "Reset your password",
        f"Open {LINK}",
        f"<p><a href='{LINK}'>Reset</a></p>",
        tenant_id=a.tenant_id,
        purpose="password_reset",
    )

    assert sent is True
    [message] = sink.messages
    assert message["To"] == "Owner.Person@Example.Test"
    assert message["From"] == "BOS <no-reply@bos.example.test>"
    assert message["Subject"] == "Reset your password"
    plain = message.get_body(preferencelist=("plain",))
    html = message.get_body(preferencelist=("html",))
    assert plain is not None and LINK in plain.get_content()
    assert html is not None and LINK in html.get_content()

    [entry] = _history(owner_engine)
    assert entry.tenant_id == a.tenant_id
    assert (entry.actor_type, entry.actor_id, entry.event) == ("system", None, "email.sent")
    assert entry.data == {"purpose": "password_reset", "domain": "example.test"}
    recorded = repr(tuple(entry)).lower()
    assert "owner.person" not in recorded
    assert "not-a-real-token" not in recorded


def test_plain_text_only_email(
    config: Config, app_engine: Engine, fresh_tenants: TwoTenants, sink: _SmtpSink
) -> None:
    mailer = Mailer(_config(config, sink.port), app_engine)

    assert mailer.send(
        "a@example.test", "Hi", "Plain only", tenant_id=fresh_tenants.a.tenant_id, purpose="test"
    )

    [message] = sink.messages
    assert not message.is_multipart()
    assert message.get_content().strip() == "Plain only"


def test_an_unreachable_server_is_recorded_as_failed_and_never_raises(
    config: Config, app_engine: Engine, owner_engine: Engine, fresh_tenants: TwoTenants
) -> None:
    a = fresh_tenants.a
    mailer = Mailer(_config(config, _closed_port()), app_engine)

    sent = mailer.send(
        "someone@example.test", "Reset", LINK, tenant_id=a.tenant_id, purpose="password_reset"
    )

    assert sent is False
    [entry] = _history(owner_engine)
    assert entry.tenant_id == a.tenant_id
    assert entry.event == "email.failed"
    assert entry.actor_type == "system"
    assert entry.data == {
        "purpose": "password_reset",
        "domain": "example.test",
        "error": "ConnectionRefusedError",
    }
    assert _history(owner_engine, fresh_tenants.b.tenant_id) == []


def test_a_refused_recipient_is_recorded_as_failed(
    config: Config,
    app_engine: Engine,
    owner_engine: Engine,
    fresh_tenants: TwoTenants,
    sink: _SmtpSink,
) -> None:
    sink.refuse_recipients = True
    mailer = Mailer(_config(config, sink.port), app_engine)

    sent = mailer.send(
        "nobody@example.test", "Reset", "x", tenant_id=fresh_tenants.a.tenant_id, purpose="p"
    )

    assert sent is False
    assert sink.messages == []
    [entry] = _history(owner_engine)
    assert entry.event == "email.failed"
    assert entry.data["error"] == "SMTPRecipientsRefused"


def test_a_header_injection_attempt_is_a_failure_not_an_exception(
    config: Config,
    app_engine: Engine,
    owner_engine: Engine,
    fresh_tenants: TwoTenants,
    sink: _SmtpSink,
) -> None:
    mailer = Mailer(_config(config, sink.port), app_engine)

    sent = mailer.send(
        "victim@example.test\r\nBcc: attacker@evil.test",
        "Reset",
        "x",
        tenant_id=fresh_tenants.a.tenant_id,
        purpose="password_reset",
    )

    assert sent is False
    assert sink.messages == []
    [entry] = _history(owner_engine)
    assert entry.event == "email.failed"
    assert "attacker" not in repr(tuple(entry))


def test_a_failure_to_record_history_does_not_raise(
    config: Config,
    app_engine: Engine,
    owner_engine: Engine,
    fresh_tenants: TwoTenants,
    sink: _SmtpSink,
) -> None:
    mailer = Mailer(_config(config, sink.port), app_engine)

    # No such business: the history insert fails its foreign key; the caller is not told.
    sent = mailer.send("x@example.test", "Hi", "x", tenant_id=uuid.uuid4(), purpose="p")

    assert sent is True
    assert len(sink.messages) == 1
    assert _history(owner_engine) == []


class _RecordingSmtp:
    """Stands in for ``smtplib.SMTP`` to observe how the connection is made."""

    calls: ClassVar[list[tuple[str, Any]]] = []

    def __init__(self, host: str, port: int, *, local_hostname: str, timeout: float) -> None:
        self.calls.append(("connect", (host, port, local_hostname, timeout)))

    def __enter__(self) -> _RecordingSmtp:
        return self

    def __exit__(self, *exc: object) -> None:
        self.calls.append(("close", None))

    def starttls(self, context: Any = None) -> None:
        self.calls.append(("starttls", context is not None))

    def login(self, user: str, password: str) -> None:
        self.calls.append(("login", user))

    def send_message(self, message: EmailMessage) -> None:
        self.calls.append(("send", message["To"]))


@pytest.mark.parametrize("user", ["", "mailer-user"], ids=["no-login", "starttls-and-login"])
def test_starttls_and_login_only_with_a_user(
    config: Config, app_engine: Engine, fresh_tenants: TwoTenants, user: str
) -> None:
    _RecordingSmtp.calls = []
    cfg = dataclasses.replace(
        _config(config, 2525),
        smtp_user=user,
        smtp_password="pw" if user else "",
        public_base_url="https://bos.example.test",
    )
    mailer = Mailer(cfg, app_engine, smtp_factory=_RecordingSmtp)

    assert mailer.send("a@example.test", "s", "t", tenant_id=fresh_tenants.a.tenant_id, purpose="p")

    expected: list[tuple[str, Any]] = [
        ("connect", ("127.0.0.1", 2525, "bos.example.test", SMTP_TIMEOUT_SECONDS))
    ]
    if user:
        expected += [("starttls", True), ("login", "mailer-user")]
    expected += [("send", "a@example.test"), ("close", None)]
    assert _RecordingSmtp.calls == expected
    assert SMTP_TIMEOUT_SECONDS == 10


def test_a_development_outbox_folder_receives_the_message_instead_of_smtp(
    config: Config,
    app_engine: Engine,
    owner_engine: Engine,
    fresh_tenants: TwoTenants,
    sink: _SmtpSink,
    tmp_path: Any,
) -> None:
    folder = tmp_path / "outbox"
    mailer = Mailer(_config(config, sink.port, mail_outbox_dir=str(folder)), app_engine)

    sent = mailer.send(
        "a@example.test",
        "Code",
        "Your code: 123456",
        tenant_id=fresh_tenants.a.tenant_id,
        purpose="invitation_code",
    )

    assert sent is True
    assert sink.messages == []
    [written] = list(folder.iterdir())
    assert written.suffix == ".json"
    import json

    assert json.loads(written.read_text(encoding="utf-8")) == {
        "to": "a@example.test",
        "subject": "Code",
        "text": "Your code: 123456",
    }
    [entry] = _history(owner_engine)
    assert entry.event == "email.sent"


def test_the_outbox_still_refuses_a_header_injection(
    config: Config, app_engine: Engine, fresh_tenants: TwoTenants, tmp_path: Any
) -> None:
    folder = tmp_path / "outbox"
    mailer = Mailer(_config(config, 1, mail_outbox_dir=str(folder)), app_engine)

    assert not mailer.send(
        "a@example.test\nBcc: x@example.test",
        "Code",
        "x",
        tenant_id=fresh_tenants.a.tenant_id,
        purpose="invitation_code",
    )
    assert not folder.exists()
