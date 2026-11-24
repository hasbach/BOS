"""T001 â€” F-11: refuse a weak secret key and the development mail outbox outside development.

Outside testing, building the configuration refuses a ``BOS_SECRET_KEY`` shorter than 32
characters or starting with ``CHANGE_ME``, and a non-empty ``BOS_MAIL_OUTBOX_DIR`` unless
``BOS_ENVIRONMENT=development``. ``BOS_ENVIRONMENT`` is ``development | staging |
production`` and defaults to ``production`` (R57).
"""

from __future__ import annotations

import pytest

from app.config import Config, ConfigError

STRONG_KEY = "k" * 31 + "Z"  # exactly 32 characters
DATABASE_URL = "postgresql+psycopg://user:pw@127.0.0.1:1/none"
OUTBOX = "outbox-folder"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("BOS_ENVIRONMENT", "BOS_MAIL_OUTBOX_DIR", "BOS_MIGRATION_DATABASE_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BOS_DATABASE_URL", DATABASE_URL)
    monkeypatch.setenv("BOS_SECRET_KEY", STRONG_KEY)


def test_strong_key_is_accepted_and_environment_defaults_to_production() -> None:
    config = Config.from_env()

    assert config.environment == "production"
    assert config.mail_outbox_dir == ""


@pytest.mark.parametrize("value", ["development", "staging", "production", " Development "])
def test_environment_accepts_the_three_names(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("BOS_ENVIRONMENT", value)

    assert Config.from_env().environment == value.strip().lower()


def test_empty_environment_means_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOS_ENVIRONMENT", "  ")

    assert Config.from_env().environment == "production"


@pytest.mark.parametrize("value", ["dev", "prod", "test", "testing", "local"])
def test_environment_refuses_other_names(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("BOS_ENVIRONMENT", value)

    with pytest.raises(ConfigError, match="BOS_ENVIRONMENT"):
        Config.from_env()


@pytest.mark.parametrize("environment", ["development", "staging", "production"])
def test_short_secret_key_is_refused_in_every_environment(
    monkeypatch: pytest.MonkeyPatch, environment: str
) -> None:
    short = "s3cr3t-value-that-is-too-short"  # 30 characters
    monkeypatch.setenv("BOS_ENVIRONMENT", environment)
    monkeypatch.setenv("BOS_SECRET_KEY", short)

    with pytest.raises(ConfigError, match="BOS_SECRET_KEY") as raised:
        Config.from_env()

    assert short not in str(raised.value)


@pytest.mark.parametrize(
    "key", ["CHANGE_ME_long_random_string_padding_padding", "CHANGE_ME" + "x" * 40]
)
def test_change_me_secret_key_is_refused(monkeypatch: pytest.MonkeyPatch, key: str) -> None:
    monkeypatch.setenv("BOS_ENVIRONMENT", "development")
    monkeypatch.setenv("BOS_SECRET_KEY", key)

    with pytest.raises(ConfigError, match="BOS_SECRET_KEY") as raised:
        Config.from_env()

    assert key not in str(raised.value)


def test_secret_key_is_checked_after_trimming(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOS_SECRET_KEY", "  " + "a" * 30 + "  ")

    with pytest.raises(ConfigError, match="BOS_SECRET_KEY"):
        Config.from_env()


@pytest.mark.parametrize("environment", [None, "staging", "production"])
def test_mail_outbox_is_refused_outside_development(
    monkeypatch: pytest.MonkeyPatch, environment: str | None
) -> None:
    if environment is not None:
        monkeypatch.setenv("BOS_ENVIRONMENT", environment)
    monkeypatch.setenv("BOS_MAIL_OUTBOX_DIR", OUTBOX)

    with pytest.raises(ConfigError, match="BOS_MAIL_OUTBOX_DIR"):
        Config.from_env()


def test_mail_outbox_is_allowed_in_development(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOS_ENVIRONMENT", "development")
    monkeypatch.setenv("BOS_MAIL_OUTBOX_DIR", OUTBOX)

    config = Config.from_env()

    assert config.environment == "development"
    assert config.mail_outbox_dir == OUTBOX


def test_blank_mail_outbox_counts_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOS_MAIL_OUTBOX_DIR", "   ")

    assert Config.from_env().mail_outbox_dir == ""


def test_testing_mode_keeps_working_with_a_weak_test_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BOS_TEST_DATABASE_URL", DATABASE_URL)
    monkeypatch.setenv("BOS_TEST_MIGRATION_DATABASE_URL", DATABASE_URL)
    monkeypatch.setenv("BOS_SECRET_KEY", "CHANGE_ME_test")
    monkeypatch.setenv("BOS_MAIL_OUTBOX_DIR", OUTBOX)

    config = Config.from_env(testing=True)

    assert config.testing is True
    assert config.mail_outbox_dir == ""


def test_secret_key_stays_out_of_repr() -> None:
    assert STRONG_KEY not in repr(Config.from_env())
