"""Invitation codes: email employee invitations are accepted with a code sent to the address.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-14

Implements FR-012a as revised on 2026-11-14 (security.md F-09, research R37). One row per
code sent; only an HMAC of the code is stored. A code is open while ``voided_at`` is null
and ``expires_at`` is in the future; sending a new code, or the fifth wrong entry, voids it.
Rows belong to the invitation's business and follow the same row-level security as
``invitations``. The application role may read, add and update rows, never delete them.

Rollback: ``flask db downgrade 0001`` drops the table (and with it every code sent). Email
invitations then go back to being accepted without a code.
"""

from __future__ import annotations

import os
import re

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def _app_role() -> str:
    role = os.environ.get("BOS_APP_DB_USER", "bos_app")
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise RuntimeError("BOS_APP_DB_USER is not a valid role name")
    return role


SCHEMA = """
ALTER TABLE invitations ADD CONSTRAINT invitations_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE invitation_codes (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    invitation_id uuid NOT NULL,
    code_hash bytea NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
    voided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, invitation_id) REFERENCES invitations (tenant_id, id)
);
CREATE INDEX invitation_codes_tenant_idx ON invitation_codes (tenant_id);
CREATE INDEX invitation_codes_invitation_idx ON invitation_codes (invitation_id, created_at);

ALTER TABLE invitation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitation_codes
    USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
"""


def _grants(role: str) -> str:
    return f"GRANT SELECT, INSERT, UPDATE ON invitation_codes TO {role};"


DROP = """
DROP TABLE IF EXISTS invitation_codes;
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_tenant_id_id_key;
"""


def upgrade() -> None:
    bind = op.get_bind()
    bind.exec_driver_sql(SCHEMA)
    bind.exec_driver_sql(_grants(_app_role()))


def downgrade() -> None:
    op.get_bind().exec_driver_sql(DROP)
