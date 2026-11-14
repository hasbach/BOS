"""Configuration read from environment variables.

Every setting has the prefix ``BOS_``. Nothing here has a production-safe default for
secrets: a missing secret fails at startup rather than running with a guessable value.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


class ConfigError(RuntimeError):
    """Raised at startup when required configuration is missing or invalid."""


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"Missing required environment variable {name}")
    return value


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _hops(name: str) -> int:
    raw = os.environ.get(name, "").strip() or "0"
    if not raw.isdigit() or int(raw) > 5:
        raise ConfigError(f"{name} must be a number of proxies from 0 to 5")
    return int(raw)


def _csv(name: str) -> frozenset[str]:
    raw = os.environ.get(name, "")
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())


@dataclass(frozen=True)
class Config:
    # Secrets (and URLs holding database passwords) stay out of repr(), so a logged or
    # printed Config, or a test failure showing it, does not reveal them.
    secret_key: str = field(repr=False)
    database_url: str = field(repr=False)
    migration_database_url: str = field(repr=False)
    public_base_url: str
    cookie_secure: bool
    operator_emails: frozenset[str]
    upload_dir: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str = field(repr=False)
    smtp_from: str
    testing: bool = False
    # How many reverse proxies in front of the API may be trusted to set X-Forwarded-For
    # (the Next.js rewrite or the production proxy: 1). 0 = use the connecting address.
    trusted_proxy_hops: int = 0
    # Development only: when set, email is written to this folder as JSON files instead of
    # being sent over SMTP (the PC without Docker has no mail server; see README).
    mail_outbox_dir: str = ""

    @classmethod
    def from_env(cls, *, testing: bool = False) -> Config:
        if testing:
            database_url = _required("BOS_TEST_DATABASE_URL")
            migration_url = _required("BOS_TEST_MIGRATION_DATABASE_URL")
        else:
            database_url = _required("BOS_DATABASE_URL")
            migration_url = os.environ.get("BOS_MIGRATION_DATABASE_URL", "").strip() or database_url
        return cls(
            secret_key=_required("BOS_SECRET_KEY"),
            database_url=database_url,
            migration_database_url=migration_url,
            public_base_url=os.environ.get("BOS_PUBLIC_BASE_URL", "http://localhost:3000").rstrip(
                "/"
            ),
            cookie_secure=_bool("BOS_COOKIE_SECURE", True),
            operator_emails=_csv("BOS_OPERATOR_EMAILS"),
            upload_dir=os.environ.get("BOS_UPLOAD_DIR", "/data/uploads"),
            smtp_host=os.environ.get("BOS_SMTP_HOST", "localhost"),
            smtp_port=int(os.environ.get("BOS_SMTP_PORT", "1025")),
            smtp_user=os.environ.get("BOS_SMTP_USER", ""),
            smtp_password=os.environ.get("BOS_SMTP_PASSWORD", ""),
            smtp_from=os.environ.get("BOS_SMTP_FROM", "BOS <no-reply@example.test>"),
            testing=testing,
            trusted_proxy_hops=_hops("BOS_TRUSTED_PROXY_HOPS"),
            mail_outbox_dir="" if testing else os.environ.get("BOS_MAIL_OUTBOX_DIR", "").strip(),
        )
