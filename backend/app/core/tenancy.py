"""Tenant and operator context for database work (constitution Principle I).

The context is a transaction-local setting that the row-level security policies read. It
is used the same way by HTTP requests and by command-line or background code (FR-004).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.db import transaction

_SET_TENANT = text("SELECT set_config('app.tenant_id', :tenant_id, true)")
_SET_OPERATOR = text("SELECT set_config('app.operator', 'on', true)")


def enter_tenant(session: Session, tenant_id: uuid.UUID) -> None:
    """Scope the rest of this transaction to one tenant."""
    session.execute(_SET_TENANT, {"tenant_id": str(tenant_id)})


def enter_operator(session: Session) -> None:
    """Give the rest of this transaction operator context (tenants list and overview only)."""
    session.execute(_SET_OPERATOR)


def enter_tenant_from_operator(session: Session, tenant_id: uuid.UUID) -> None:
    """Let an operator transaction write inside one tenant.

    Only ``app.services.onboarding`` may call this (research R24): setting up a business,
    resending an owner activation and issuing an owner reset link. Each of those records an
    entry in the tenant's own history.
    """
    enter_tenant(session, tenant_id)


@contextmanager
def tenant_transaction(engine: Engine, tenant_id: uuid.UUID) -> Iterator[Session]:
    with transaction(engine) as session:
        enter_tenant(session, tenant_id)
        yield session


@contextmanager
def operator_transaction(engine: Engine) -> Iterator[Session]:
    with transaction(engine) as session:
        enter_operator(session)
        yield session
