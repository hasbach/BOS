"""Platform foundation: tenants, stores, users, invitations, sessions, audit, isolation.

Revision ID: 0001
Revises:
Create Date: 2026-11-10

Implements specs/001-platform-foundation/data-model.md (revision 2).

Isolation model
---------------
* Every tenant-owned table has row-level security ENABLED and FORCED, with a policy that
  compares the row's tenant to the transaction-local setting ``app.tenant_id``. With no
  tenant set, nothing matches.
* The running API connects as the application role, which owns nothing and cannot bypass
  row-level security. Migrations run as the owner role, which must be able to bypass it
  (a superuser in development and CI; a role with BYPASSRLS in production).
* Data needed before a tenant is known is reachable only through the five SECURITY DEFINER
  functions at the end of this file.
* ``app.tenant_id`` and ``app.operator`` are set by the application itself. Row-level
  security therefore protects against application bugs (a forgotten filter, a wrong id); it
  is not a defence against someone who can already run arbitrary SQL as the application.

Rollback: ``flask db downgrade base`` drops every object created here. All data in these
tables is lost, so take a backup first on any database that holds real data.
"""

from __future__ import annotations

import os
import re

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

ROLES = "ARRAY['owner','manager','sales','packing','dispatch']::text[]"


def _app_role() -> str:
    role = os.environ.get("BOS_APP_DB_USER", "bos_app")
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise RuntimeError("BOS_APP_DB_USER is not a valid role name")
    return role


def _tenant_policies() -> str:
    statements = []
    for table in ("stores", "users", "user_stores", "invitations", "password_resets", "files"):
        statements.append(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
        statements.append(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;")
        statements.append(
            f"CREATE POLICY tenant_isolation ON {table} "
            "USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());"
        )
    return "\n".join(statements)


TENANT_POLICIES = _tenant_policies()

SCHEMA = f"""
-- ---------------------------------------------------------------------------------------
-- Context helpers
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION app_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_is_operator() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(current_setting('app.operator', true), '') = 'on' $$;

-- ---------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------
CREATE TABLE operators (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = lower(email)),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    password_hash text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    edition text NOT NULL CHECK (edition IN ('social', 'commerce')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
    is_demo boolean NOT NULL DEFAULT false,
    default_currency text NOT NULL DEFAULT 'USD' CHECK (default_currency IN ('USD', 'LBP')),
    usd_lbp_rate numeric(18, 2) NOT NULL CHECK (usd_lbp_rate > 0),
    default_delivery_fee numeric(12, 2) NOT NULL DEFAULT 0 CHECK (default_delivery_fee >= 0),
    default_delivery_fee_currency text NOT NULL DEFAULT 'USD'
        CHECK (default_delivery_fee_currency IN ('USD', 'LBP')),
    created_by_operator_id uuid NOT NULL REFERENCES operators (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    phone_e164 text UNIQUE CHECK (phone_e164 ~ '^\\+[1-9][0-9]{{6,14}}$'),
    email text UNIQUE CHECK (email = lower(email) AND char_length(email) <= 254),
    password_hash text NOT NULL,
    locale text NOT NULL CHECK (locale IN ('en', 'ar')),
    roles text[] NOT NULL CHECK (cardinality(roles) > 0 AND roles <@ {ROLES}),
    all_stores boolean NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    CONSTRAINT users_need_an_identifier CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL),
    CONSTRAINT management_has_all_stores
        CHECK (all_stores OR NOT (roles && ARRAY['owner', 'manager']::text[]))
);
CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TABLE files (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    kind text NOT NULL CHECK (kind IN ('store_logo')),
    storage_path text NOT NULL UNIQUE,
    mime text NOT NULL,
    size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
    created_by_user_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE stores (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    whatsapp_e164 text CHECK (whatsapp_e164 ~ '^\\+[1-9][0-9]{{6,14}}$'),
    logo_file_id uuid,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, logo_file_id) REFERENCES files (tenant_id, id)
);
CREATE UNIQUE INDEX stores_active_name_uq ON stores (tenant_id, lower(name)) WHERE status = 'active';
CREATE UNIQUE INDEX stores_active_whatsapp_uq ON stores (tenant_id, whatsapp_e164)
    WHERE status = 'active' AND whatsapp_e164 IS NOT NULL;

CREATE TABLE user_stores (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    store_id uuid NOT NULL,
    PRIMARY KEY (user_id, store_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);
CREATE INDEX user_stores_tenant_idx ON user_stores (tenant_id);

CREATE TABLE invitations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    kind text NOT NULL CHECK (kind IN ('owner_activation', 'employee')),
    invitee_name text NOT NULL CHECK (char_length(invitee_name) BETWEEN 1 AND 120),
    invitee_phone_e164 text CHECK (invitee_phone_e164 ~ '^\\+[1-9][0-9]{{6,14}}$'),
    invitee_email text CHECK (invitee_email = lower(invitee_email) AND char_length(invitee_email) <= 254),
    roles text[] NOT NULL CHECK (cardinality(roles) > 0 AND roles <@ {ROLES}),
    all_stores boolean NOT NULL,
    store_ids uuid[] NOT NULL DEFAULT '{{}}',
    token_hash bytea NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
    created_by_user_id uuid,
    created_by_operator_id uuid REFERENCES operators (id),
    accepted_user_id uuid,
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invitations_need_an_identifier
        CHECK (invitee_phone_e164 IS NOT NULL OR invitee_email IS NOT NULL),
    CONSTRAINT invitations_one_creator
        CHECK (num_nonnulls(created_by_user_id, created_by_operator_id) = 1),
    FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id),
    FOREIGN KEY (tenant_id, accepted_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id);
CREATE UNIQUE INDEX invitations_pending_phone_uq ON invitations (tenant_id, invitee_phone_e164)
    WHERE status = 'pending' AND invitee_phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX invitations_pending_email_uq ON invitations (tenant_id, invitee_email)
    WHERE status = 'pending' AND invitee_email IS NOT NULL;
CREATE UNIQUE INDEX invitations_one_pending_owner_activation_uq ON invitations (tenant_id)
    WHERE status = 'pending' AND kind = 'owner_activation';

CREATE TABLE password_resets (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
    used_at timestamptz,
    issued_by_user_id uuid,
    issued_by_operator_id uuid REFERENCES operators (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX password_resets_tenant_idx ON password_resets (tenant_id);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES users (id) ON DELETE CASCADE,
    tenant_id uuid REFERENCES tenants (id),
    operator_id uuid REFERENCES operators (id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    user_agent text NOT NULL DEFAULT '' CHECK (char_length(user_agent) <= 255),
    ip inet,
    CONSTRAINT sessions_user_or_operator CHECK (
        (user_id IS NOT NULL AND tenant_id IS NOT NULL AND operator_id IS NULL)
        OR (user_id IS NULL AND tenant_id IS NULL AND operator_id IS NOT NULL)
    )
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE login_attempts (
    id bigserial PRIMARY KEY,
    identifier_hash bytea NOT NULL,
    ip inet,
    success boolean NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_identifier_idx ON login_attempts (identifier_hash, at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at);

CREATE TABLE idempotency_keys (
    key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
    scope text NOT NULL,
    actor_id uuid NOT NULL,
    tenant_id uuid REFERENCES tenants (id),
    request_hash bytea NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key, scope, actor_id)
);

CREATE TABLE audit_entries (
    id uuid PRIMARY KEY,
    tenant_id uuid REFERENCES tenants (id),
    actor_type text NOT NULL CHECK (actor_type IN ('user', 'operator', 'system', 'anonymous')),
    actor_id uuid,
    event text NOT NULL,
    target_type text,
    target_id uuid,
    data jsonb NOT NULL DEFAULT '{{}}',
    ip inet,
    at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entries_tenant_at_idx ON audit_entries (tenant_id, at DESC);

-- ---------------------------------------------------------------------------------------
-- History is append-only, for every role
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION audit_entries_are_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'audit_entries is append-only' USING ERRCODE = '42501'; END $$;

CREATE TRIGGER audit_entries_no_change
    BEFORE UPDATE OR DELETE ON audit_entries
    FOR EACH ROW EXECUTE FUNCTION audit_entries_are_append_only();

-- ---------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------
{TENANT_POLICIES}

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_reads_itself ON tenants FOR SELECT USING (id = app_tenant_id());
CREATE POLICY tenant_updates_itself ON tenants FOR UPDATE
    USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
CREATE POLICY operator_reads_tenants ON tenants FOR SELECT USING (app_is_operator());
CREATE POLICY operator_creates_tenants ON tenants FOR INSERT WITH CHECK (app_is_operator());
CREATE POLICY operator_updates_tenants ON tenants FOR UPDATE
    USING (app_is_operator()) WITH CHECK (app_is_operator());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_operator_keys ON idempotency_keys
    USING (tenant_id = app_tenant_id() OR (tenant_id IS NULL AND app_is_operator()))
    WITH CHECK (tenant_id = app_tenant_id() OR (tenant_id IS NULL AND app_is_operator()));

ALTER TABLE audit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_reads_history ON audit_entries FOR SELECT USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_adds_history ON audit_entries FOR INSERT WITH CHECK (tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------------------------
-- Narrowly scoped functions for data needed before a tenant is known (data-model.md)
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION auth_lookup_identifier(p_kind text, p_value text)
    RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, user_status text, tenant_status text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
        SELECT u.id, u.tenant_id, u.password_hash, u.status, t.status
        FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE (p_kind = 'phone' AND u.phone_e164 = p_value)
           OR (p_kind = 'email' AND u.email = p_value)
        LIMIT 1
    $$;

CREATE FUNCTION auth_lookup_token(p_kind text, p_token_hash bytea)
    RETURNS TABLE (tenant_id uuid, row_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
        SELECT i.tenant_id, i.id FROM invitations i
        WHERE p_kind = 'invitation' AND i.token_hash = p_token_hash
        UNION ALL
        SELECT r.tenant_id, r.id FROM password_resets r
        WHERE p_kind = 'password_reset' AND r.token_hash = p_token_hash
        LIMIT 1
    $$;

CREATE FUNCTION ops_business_overview()
    RETURNS TABLE (
        id uuid, name text, edition text, status text, is_demo boolean, created_at timestamptz,
        store_count bigint, user_count bigint, owners jsonb, pending_owner_contact text
    )
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    BEGIN
        IF NOT app_is_operator() THEN
            RAISE EXCEPTION 'operator context required' USING ERRCODE = '42501';
        END IF;
        RETURN QUERY
        SELECT t.id, t.name, t.edition, t.status, t.is_demo, t.created_at,
               (SELECT count(*) FROM stores s WHERE s.tenant_id = t.id),
               (SELECT count(*) FROM users u WHERE u.tenant_id = t.id),
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                              'user_id', u.id,
                              'name', u.name,
                              'contact', COALESCE(u.phone_e164, u.email),
                              'has_email', u.email IS NOT NULL) ORDER BY u.created_at)
                   FROM users u
                   WHERE u.tenant_id = t.id AND u.status = 'active' AND 'owner' = ANY (u.roles)
               ), '[]'::jsonb),
               (SELECT COALESCE(i.invitee_phone_e164, i.invitee_email)
                FROM invitations i
                WHERE i.tenant_id = t.id AND i.kind = 'owner_activation'
                  AND i.status IN ('pending', 'expired')
                ORDER BY i.created_at DESC LIMIT 1)
        FROM tenants t
        ORDER BY t.created_at DESC;
    END
    $$;

CREATE FUNCTION platform_maintenance() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
        v_invitations integer; v_sessions integer; v_attempts integer; v_keys integer; v_resets integer;
    BEGIN
        UPDATE invitations SET status = 'expired' WHERE status = 'pending' AND expires_at < now();
        GET DIAGNOSTICS v_invitations = ROW_COUNT;
        DELETE FROM sessions
            WHERE absolute_expires_at < now() OR idle_expires_at < now()
               OR revoked_at < now() - interval '1 day';
        GET DIAGNOSTICS v_sessions = ROW_COUNT;
        DELETE FROM login_attempts WHERE at < now() - interval '30 days';
        GET DIAGNOSTICS v_attempts = ROW_COUNT;
        DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';
        GET DIAGNOSTICS v_keys = ROW_COUNT;
        DELETE FROM password_resets WHERE expires_at < now() - interval '30 days';
        GET DIAGNOSTICS v_resets = ROW_COUNT;
        RETURN jsonb_build_object(
            'invitations_expired', v_invitations, 'sessions_deleted', v_sessions,
            'login_attempts_deleted', v_attempts, 'idempotency_keys_deleted', v_keys,
            'password_resets_deleted', v_resets);
    END
    $$;

CREATE FUNCTION audit_platform_event(
        p_actor_type text, p_actor_id uuid, p_event text, p_data jsonb, p_ip inet)
    RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE v_id uuid := gen_random_uuid();
    BEGIN
        INSERT INTO audit_entries (id, tenant_id, actor_type, actor_id, event, data, ip)
        VALUES (v_id, NULL, p_actor_type, p_actor_id, p_event, COALESCE(p_data, '{{}}'::jsonb), p_ip);
        RETURN v_id;
    END
    $$;

REVOKE ALL ON FUNCTION auth_lookup_identifier(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_token(text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_business_overview() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_maintenance() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_platform_event(text, uuid, text, jsonb, inet) FROM PUBLIC;
"""


def _grants(role: str) -> str:
    return f"""
GRANT USAGE ON SCHEMA public TO {role};
GRANT SELECT, INSERT, UPDATE ON operators, tenants, stores, users, invitations TO {role};
GRANT SELECT, INSERT, DELETE ON user_stores, login_attempts TO {role};
GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets, sessions, idempotency_keys, files TO {role};
GRANT SELECT, INSERT ON audit_entries TO {role};
GRANT USAGE ON SEQUENCE login_attempts_id_seq TO {role};
GRANT EXECUTE ON FUNCTION app_tenant_id(), app_is_operator() TO {role};
GRANT EXECUTE ON FUNCTION auth_lookup_identifier(text, text) TO {role};
GRANT EXECUTE ON FUNCTION auth_lookup_token(text, bytea) TO {role};
GRANT EXECUTE ON FUNCTION ops_business_overview() TO {role};
GRANT EXECUTE ON FUNCTION platform_maintenance() TO {role};
GRANT EXECUTE ON FUNCTION audit_platform_event(text, uuid, text, jsonb, inet) TO {role};
"""


DROP = """
DROP FUNCTION IF EXISTS audit_platform_event(text, uuid, text, jsonb, inet);
DROP FUNCTION IF EXISTS platform_maintenance();
DROP FUNCTION IF EXISTS ops_business_overview();
DROP FUNCTION IF EXISTS auth_lookup_token(text, bytea);
DROP FUNCTION IF EXISTS auth_lookup_identifier(text, text);
DROP TABLE IF EXISTS audit_entries, idempotency_keys, login_attempts, sessions, password_resets,
    invitations, user_stores, stores, files, users, tenants, operators CASCADE;
DROP FUNCTION IF EXISTS audit_entries_are_append_only();
DROP FUNCTION IF EXISTS app_is_operator();
DROP FUNCTION IF EXISTS app_tenant_id();
"""


def upgrade() -> None:
    bind = op.get_bind()
    bind.exec_driver_sql(SCHEMA)
    bind.exec_driver_sql(_grants(_app_role()))


def downgrade() -> None:
    op.get_bind().exec_driver_sql(DROP)
