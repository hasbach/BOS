"""Sending email over plain SMTP (research R8) and recording every attempt (R27).

Email is used for password-reset links and invitation codes in M0, and is sent in the API
process after the answer to the request has gone out (security.md F-04, F-09). ``Mailer.send`` never
raises: it returns whether the message was handed to the SMTP server, and writes
``email.sent`` or ``email.failed`` to the recipient business's history. The history holds the
purpose, the recipient's domain and, on failure, the error's class name: never the address,
the subject, the body or a link.

The history entry is written in its own transaction, because the email has been sent (or
not) whatever happens to the caller's transaction afterwards. Do not call ``send`` while
the caller's transaction holds a lock on the business's ``tenants`` row: the history insert
checks its foreign key against that row and would wait for it.

Development only: with ``BOS_MAIL_OUTBOX_DIR`` set, each message is written to that folder
as a JSON file (``to``, ``subject``, ``text``) instead of going to SMTP, so codes and
links can be read on a PC with no mail server (the end-to-end tests read codes this way).
"""

from __future__ import annotations

import json
import logging
import os
import re
import smtplib
import ssl
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from flask import Flask
from sqlalchemy import Engine

from app.config import Config
from app.core import audit
from app.core.tenancy import tenant_transaction

SMTP_TIMEOUT_SECONDS = 10

log = logging.getLogger("bos.mailer")

# One "@", no whitespace or control characters anywhere: header injection is refused before
# a message is built.
_ADDRESS_RE = re.compile(r"^[^@\s\x00-\x1f\x7f]+@([A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)$")


class InvalidRecipient(ValueError):
    """The recipient is not a single plain email address."""


class Mailer:
    def __init__(
        self,
        config: Config,
        engine: Engine,
        *,
        smtp_factory: Callable[..., Any] = smtplib.SMTP,
    ) -> None:
        self._config = config
        self._engine = engine
        self._smtp_factory = smtp_factory

    @classmethod
    def for_app(cls, app: Flask) -> Mailer:
        from app import get_config
        from app.core.db import engine_of

        return cls(get_config(app), engine_of(app))

    def send(
        self,
        to: str,
        subject: str,
        text: str,
        html: str | None = None,
        *,
        tenant_id: uuid.UUID,
        purpose: str,
    ) -> bool:
        """Send one message. True if the SMTP server accepted it. Never raises."""
        domain = _domain(to)
        error: str | None = None
        try:
            message = _message(self._config.smtp_from, to, subject, text, html)
            if self._config.mail_outbox_dir:
                _write_outbox(Path(self._config.mail_outbox_dir), to, subject, text)
            else:
                self._deliver(message)
        except Exception as exc:
            error = type(exc).__name__
            log.warning("email not sent: purpose=%s domain=%s error=%s", purpose, domain, error)
        self._record(tenant_id, purpose, domain, error)
        return error is None

    def _deliver(self, message: EmailMessage) -> None:
        cfg = self._config
        with self._smtp_factory(
            cfg.smtp_host,
            cfg.smtp_port,
            local_hostname=_ehlo_name(cfg),
            timeout=SMTP_TIMEOUT_SECONDS,
        ) as smtp:
            if cfg.smtp_user:
                smtp.starttls(context=ssl.create_default_context())
                smtp.login(cfg.smtp_user, cfg.smtp_password)
            smtp.send_message(message)

    def _record(self, tenant_id: uuid.UUID, purpose: str, domain: str, error: str | None) -> None:
        data: dict[str, str] = {"purpose": purpose, "domain": domain}
        if error is not None:
            data["error"] = error
        try:
            with tenant_transaction(self._engine, tenant_id) as db:
                audit.record(
                    db,
                    tenant_id=tenant_id,
                    actor_type="system",
                    actor_id=None,
                    event="email.failed" if error else "email.sent",
                    data=data,
                )
        except Exception:
            log.exception("could not record an email attempt: purpose=%s", purpose)


MAILER_EXTENSION = "bos_mailer"


def get_mailer(app: Flask) -> Mailer:
    """The application's mailer: one set in ``app.extensions`` (tests), else SMTP from config."""
    mailer = app.extensions.get(MAILER_EXTENSION)
    if isinstance(mailer, Mailer):
        return mailer
    return Mailer.for_app(app)


def _write_outbox(folder: Path, to: str, subject: str, text: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{datetime.now(UTC):%Y%m%dT%H%M%S%f}-{uuid.uuid4().hex[:8]}.json"
    partial = folder / (name + ".part")
    content = {"to": to, "subject": subject, "text": text}
    partial.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(partial, folder / name)  # a reader never sees half a file


def _ehlo_name(config: Config) -> str:
    # The name BOS greets the SMTP server with. Given explicitly because smtplib would
    # otherwise look up this machine's own name, which can take longer than the timeout.
    return urlsplit(config.public_base_url).hostname or "localhost"


def _domain(address: str) -> str:
    match = _ADDRESS_RE.match(address)
    return match.group(1).lower() if match else "invalid"


def _message(sender: str, to: str, subject: str, text: str, html: str | None) -> EmailMessage:
    if not _ADDRESS_RE.match(to):
        raise InvalidRecipient("recipient is not a single plain address")
    message = EmailMessage()
    message["From"] = sender
    message["To"] = to
    message["Subject"] = subject
    message.set_content(text)
    if html is not None:
        message.add_alternative(html, subtype="html")
    return message
