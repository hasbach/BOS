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


ENVIRONMENTS = ("development", "staging", "production")
MIN_SECRET_KEY_LENGTH = 32


def _environment() -> str:
    # Unset means production: forgetting the setting keeps the strict checks on (R57).
    value = os.environ.get("BOS_ENVIRONMENT", "").strip().lower() or "production"
    if value not in ENVIRONMENTS:
        raise ConfigError("BOS_ENVIRONMENT must be one of " + ", ".join(ENVIRONMENTS))
    return value


def _check_secret_key(key: str) -> None:
    # The messages never include the key itself.
    if key.startswith("CHANGE_ME"):
        raise ConfigError("BOS_SECRET_KEY still has the CHANGE_ME placeholder from .env.example")
    if len(key) < MIN_SECRET_KEY_LENGTH:
        raise ConfigError(
            f"BOS_SECRET_KEY must be at least {MIN_SECRET_KEY_LENGTH} characters long"
        )


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
    # development | staging | production (BOS_ENVIRONMENT; unset = production).
    environment: str = "production"

    @classmethod
    def from_env(cls, *, testing: bool = False) -> Config:
        """Read the configuration; outside testing, refuse unsafe values at start-up (F-11).

        Testing mode skips the secret-key and outbox checks: the test suite runs with the
        development .env key and never sends mail.
        """
        environment = _environment()
        secret_key = _required("BOS_SECRET_KEY")
        mail_outbox_dir = "" if testing else os.environ.get("BOS_MAIL_OUTBOX_DIR", "").strip()
        if not testing:
            _check_secret_key(secret_key)
            if mail_outbox_dir and environment != "development":
                raise ConfigError(
                    "BOS_MAIL_OUTBOX_DIR is for development only: unset it, or set "
                    "BOS_ENVIRONMENT=development on a development computer"
                )
        if testing:
            database_url = _required("BOS_TEST_DATABASE_URL")
            migration_url = _required("BOS_TEST_MIGRATION_DATABASE_URL")
        else:
            database_url = _required("BOS_DATABASE_URL")
            migration_url = os.environ.get("BOS_MIGRATION_DATABASE_URL", "").strip() or database_url
        return cls(
            secret_key=secret_key,
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
            mail_outbox_dir=mail_outbox_dir,
            environment=environment,
        )
