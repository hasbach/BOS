"""Small pieces shared by the services: one-time links and "no such record"."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from flask import current_app
from sqlalchemy import text
from sqlalchemy.orm import Session

# The web pages that read a token from the URL fragment (research R26). The fragment is never
# sent to a server, so tokens never reach request logs. No locale in the path: the web app's
# language redirect keeps the fragment.
LinkPage = Literal["activate", "reset"]


@dataclass(frozen=True)
class IssuedLink:
    """A one-time link token, given to the caller once. Only its hash is stored."""

    token: str
    expires_at: datetime
    page: LinkPage

    @property
    def url(self) -> str:
        from app import get_config

        return f"{get_config(current_app).public_base_url}/{self.page}#{self.token}"


class NotFound(LookupError):
    """The record does not exist in the current context (or belongs to another business)."""

    def __init__(self, target_type: str, target_id: uuid.UUID | None) -> None:
        super().__init__(target_type)
        self.target_type = target_type
        self.target_id = target_id


@dataclass(frozen=True)
class IdentifierOwner:
    user_id: uuid.UUID
    tenant_id: uuid.UUID
    password_hash: str
    user_status: str
    tenant_status: str


def lookup_identifier(db: Session, kind: str, value: str) -> IdentifierOwner | None:
    """Who, anywhere in BOS, has this normalized phone number or email.

    Goes through the narrowly scoped ``auth_lookup_identifier`` function, so it works before
    a tenant is known and returns nothing but the sign-in essentials.
    """
    row: Any = db.execute(
        text(
            "SELECT user_id, tenant_id, password_hash, user_status, tenant_status "
            "FROM auth_lookup_identifier(:kind, :value)"
        ),
        {"kind": kind, "value": value},
    ).one_or_none()
    if row is None:
        return None
    return IdentifierOwner(
        user_id=row.user_id,
        tenant_id=row.tenant_id,
        password_hash=row.password_hash,
        user_status=row.user_status,
        tenant_status=row.tenant_status,
    )
