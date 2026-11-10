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


def _csv(name: str) -> frozenset[str]:
    raw = os.environ.get(name, "")
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())


@dataclass(frozen=True)
class Config:
    secret_key: str
    database_url: str
    migration_database_url: str
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
        )
