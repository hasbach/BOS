"""Catalog and inventory: products, variants, inventory items, balances, the ledger, allocations.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-15

Implements specs/002-native-catalog-inventory/data-model.md ("Migration 0003_catalog_inventory")
and research R38-R53. Every new table follows M0's isolation model (0001): row-level security
enabled and forced with the ``tenant_isolation`` policy, and composite foreign keys
``(tenant_id, parent_id)`` so no row can point into another business.

What the database itself guarantees, even if application code is wrong:

* one default warehouse per business, and no second warehouse (R39);
* SKUs and product codes unique per business ignoring ASCII case, archived ones included
  (generated ``*_key`` columns, R46);
* one active variant per option combination (``NULLS NOT DISTINCT``, R47);
* ``0 <= allocated <= on_hand <= 1,000,000`` on every balance, as two named CHECKs that the
  application answers by name (R40, R42);
* the stock ledger is append-only for every role (trigger, like ``audit_entries``), every
  movement's sign matches its reason, and ``source`` agrees with the reason, the allocation
  and the import batch (R41);
* an inventory item with history cannot be deleted (movements and allocation lines reference
  it without ``ON DELETE``).

``pg_trgm`` is a trusted extension: the owner role creates it wherever it has ``CREATE`` on
the database (development, CI and Compose).

Rollback: ``flask db downgrade 0002`` drops the thirteen tables, deletes the ``product_photo``
rows of ``files`` (their files on disk are orphaned, like logos in M0), restores M0's
``files`` CHECKs and drops ``tenants.low_stock_default``. ``pg_trgm`` stays installed (it may
predate BOS and is harmless). Every product, variant, balance, movement, allocation, photo
record and import batch is lost, so take a backup (``pg_dump`` as the owner) first on any
database that holds real data. History entries about the catalog remain (append-only).
"""

from __future__ import annotations

import os
import re

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

# In dependency order; the downgrade drops them in reverse.
TABLES = (
    "warehouses",
    "import_batches",
    "products",
    "product_stores",
    "product_options",
    "option_values",
    "product_photos",
    "inventory_items",
    "variants",
    "stock_balances",
    "allocations",
    "allocation_lines",
    "stock_movements",
)

# SKUs and product codes: ASCII letters and digits plus - _ . /, starting with a letter or digit.
CODE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._/-]*$"


def _app_role() -> str:
    role = os.environ.get("BOS_APP_DB_USER", "bos_app")
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise RuntimeError("BOS_APP_DB_USER is not a valid role name")
    return role


def _tenant_policies() -> str:
    statements = []
    for table in TABLES:
        statements.append(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
        statements.append(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;")
        statements.append(
            f"CREATE POLICY tenant_isolation ON {table} "
            "USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());"
        )
    return "\n".join(statements)


SCHEMA = f"""
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------------------
-- Changed M0 tables
-- ---------------------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN low_stock_default integer NOT NULL DEFAULT 2
    CONSTRAINT tenants_low_stock_default_range CHECK (low_stock_default BETWEEN 0 AND 1000000);

ALTER TABLE files DROP CONSTRAINT files_kind_check;
ALTER TABLE files DROP CONSTRAINT files_size_bytes_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN ('store_logo', 'product_photo'));
ALTER TABLE files ADD CONSTRAINT files_size_bytes_check
    CHECK (size_bytes > 0 AND size_bytes <= 5242880);

-- ---------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------
CREATE TABLE warehouses (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    -- M1 has exactly one warehouse per business, so a non-default one cannot exist.
    is_default boolean NOT NULL DEFAULT true CONSTRAINT warehouses_only_default CHECK (is_default),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX warehouses_one_default_uq ON warehouses (tenant_id) WHERE is_default;

CREATE TABLE import_batches (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    created_by_user_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('previewed', 'failed', 'committed')),
    file_name text NOT NULL CHECK (char_length(file_name) <= 255),
    file_sha256 bytea NOT NULL,
    row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 2000),
    product_count integer NOT NULL DEFAULT 0 CHECK (product_count >= 0),
    variant_count integer NOT NULL DEFAULT 0 CHECK (variant_count >= 0),
    opening_units bigint NOT NULL DEFAULT 0 CHECK (opening_units >= 0),
    errors jsonb NOT NULL DEFAULT '[]',
    payload jsonb,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    committed_at timestamptz,
    committed_by_user_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id),
    FOREIGN KEY (tenant_id, committed_by_user_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE products (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    code text NOT NULL
        CHECK (char_length(code) BETWEEN 1 AND 32 AND code ~ '{CODE_PATTERN}'),
    code_key text GENERATED ALWAYS AS (lower(btrim(code))) STORED,
    name_en text CHECK (char_length(name_en) BETWEEN 1 AND 120),
    name_ar text CHECK (char_length(name_ar) BETWEEN 1 AND 120),
    description_en text CHECK (char_length(description_en) <= 2000),
    description_ar text CHECK (char_length(description_ar) <= 2000),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    import_batch_id uuid,
    created_by_user_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    UNIQUE (tenant_id, id),
    CONSTRAINT products_need_a_name CHECK (name_en IS NOT NULL OR name_ar IS NOT NULL),
    FOREIGN KEY (tenant_id, import_batch_id) REFERENCES import_batches (tenant_id, id),
    FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id)
);
-- Not partial: an archived product keeps its code reserved.
CREATE UNIQUE INDEX products_code_key_uq ON products (tenant_id, code_key);
CREATE INDEX products_tenant_created_idx ON products (tenant_id, created_at DESC, id DESC);
CREATE INDEX products_name_en_trgm_idx ON products USING gin (lower(name_en) gin_trgm_ops);
CREATE INDEX products_name_ar_trgm_idx ON products USING gin (name_ar gin_trgm_ops);
CREATE INDEX products_code_key_trgm_idx ON products USING gin (code_key gin_trgm_ops);

CREATE TABLE product_stores (
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    store_id uuid NOT NULL,
    PRIMARY KEY (product_id, store_id),
    FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);
CREATE INDEX product_stores_tenant_store_idx ON product_stores (tenant_id, store_id);

CREATE TABLE product_options (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    position smallint NOT NULL CHECK (position IN (1, 2)),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    UNIQUE (product_id, position),
    UNIQUE (tenant_id, product_id, id),
    FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE TABLE option_values (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    option_id uuid NOT NULL,
    position smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
    label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    UNIQUE (tenant_id, product_id, id),
    FOREIGN KEY (tenant_id, product_id, option_id)
        REFERENCES product_options (tenant_id, product_id, id)
);
CREATE UNIQUE INDEX option_values_active_label_uq ON option_values (option_id, lower(label))
    WHERE status = 'active';

CREATE TABLE product_photos (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    product_id uuid,
    position smallint CHECK (position BETWEEN 0 AND 7),
    thumb_file_id uuid NOT NULL,
    large_file_id uuid NOT NULL,
    width integer NOT NULL CHECK (width > 0),
    height integer NOT NULL CHECK (height > 0),
    staged_expires_at timestamptz,
    created_by_user_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Staged (uploaded, not yet saved with a product) exactly when it has no position.
    CONSTRAINT product_photos_position_when_attached
        CHECK ((product_id IS NULL) = (position IS NULL)),
    -- Deferred, so a save can reorder photos in one transaction.
    CONSTRAINT product_photos_position_uq UNIQUE (product_id, position)
        DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (tenant_id, product_id, id),
    FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
    FOREIGN KEY (tenant_id, thumb_file_id) REFERENCES files (tenant_id, id),
    FOREIGN KEY (tenant_id, large_file_id) REFERENCES files (tenant_id, id),
    FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE inventory_items (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE TABLE variants (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL UNIQUE,
    sku text NOT NULL CHECK (char_length(sku) BETWEEN 1 AND 64 AND sku ~ '{CODE_PATTERN}'),
    sku_key text GENERATED ALWAYS AS (lower(btrim(sku))) STORED,
    option1_value_id uuid,
    option2_value_id uuid,
    price numeric(14, 2) NOT NULL CHECK (price BETWEEN 0 AND 99999999999.99),
    currency text NOT NULL CHECK (currency IN ('USD', 'LBP')),
    low_stock_level integer CHECK (low_stock_level BETWEEN 0 AND 1000000),
    photo_id uuid,
    position integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    UNIQUE (tenant_id, id),
    CONSTRAINT variants_option2_needs_option1
        CHECK (option2_value_id IS NULL OR option1_value_id IS NOT NULL),
    CONSTRAINT variants_lbp_price_whole CHECK (currency = 'USD' OR price = trunc(price)),
    FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
    FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items (tenant_id, id),
    FOREIGN KEY (tenant_id, product_id, option1_value_id)
        REFERENCES option_values (tenant_id, product_id, id),
    FOREIGN KEY (tenant_id, product_id, option2_value_id)
        REFERENCES option_values (tenant_id, product_id, id),
    -- Only a photo of the same product.
    FOREIGN KEY (tenant_id, product_id, photo_id)
        REFERENCES product_photos (tenant_id, product_id, id)
);
-- Not partial: an archived variant keeps its SKU reserved.
CREATE UNIQUE INDEX variants_sku_key_uq ON variants (tenant_id, sku_key);
-- One active variant per combination of option values; a product without options has one.
CREATE UNIQUE INDEX variants_active_combination_uq
    ON variants (product_id, option1_value_id, option2_value_id) NULLS NOT DISTINCT
    WHERE status = 'active';
CREATE INDEX variants_tenant_product_idx ON variants (tenant_id, product_id);
CREATE INDEX variants_sku_key_trgm_idx ON variants USING gin (sku_key gin_trgm_ops);

CREATE TABLE stock_balances (
    tenant_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    on_hand integer NOT NULL DEFAULT 0,
    allocated integer NOT NULL DEFAULT 0,
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (warehouse_id, inventory_item_id),
    UNIQUE (tenant_id, warehouse_id, inventory_item_id),
    -- Answered by name (R42). CHECKs run in name order, so a negative on hand (allocated
    -- being >= 0) always fails stock_balances_not_oversold first: not_enough_stock.
    CONSTRAINT stock_balances_not_oversold CHECK (allocated >= 0 AND on_hand >= allocated),
    CONSTRAINT stock_balances_on_hand_range CHECK (on_hand BETWEEN 0 AND 1000000),
    FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
    FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items (tenant_id, id)
);

CREATE TABLE allocations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 200),
    request_hash bytea NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
    actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
    actor_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz,
    consumed_at timestamptz,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, request_key),
    CONSTRAINT allocations_released_at CHECK ((status = 'released') = (released_at IS NOT NULL)),
    CONSTRAINT allocations_consumed_at CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
    CONSTRAINT allocations_actor CHECK ((actor_type = 'user') = (actor_id IS NOT NULL)),
    FOREIGN KEY (tenant_id, actor_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE allocation_lines (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
    UNIQUE (allocation_id, inventory_item_id),
    FOREIGN KEY (tenant_id, allocation_id) REFERENCES allocations (tenant_id, id),
    FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
    -- No ON DELETE: an item with allocation history cannot be deleted.
    FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items (tenant_id, id)
);
CREATE INDEX allocation_lines_tenant_item_idx ON allocation_lines (tenant_id, inventory_item_id);

CREATE TABLE stock_movements (
    id uuid PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    quantity integer NOT NULL
        CONSTRAINT stock_movements_quantity_range CHECK (quantity BETWEEN -1000000 AND 1000000),
    reason text NOT NULL CHECK (reason IN ('opening', 'received', 'found', 'damaged', 'lost',
        'count_correction', 'other', 'allocation_consumed')),
    counted_quantity integer CHECK (counted_quantity BETWEEN 0 AND 1000000),
    on_hand_after integer NOT NULL,
    allocation_id uuid,
    import_batch_id uuid,
    source text NOT NULL,
    actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
    actor_id uuid,
    note text CHECK (char_length(note) <= 500),
    request_key text CHECK (char_length(request_key) <= 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stock_movements_quantity_sign CHECK (
        (reason IN ('opening', 'received', 'found') AND quantity > 0)
        OR (reason IN ('damaged', 'lost', 'allocation_consumed') AND quantity < 0)
        OR (reason = 'other' AND quantity <> 0)
        OR reason = 'count_correction'
    ),
    CONSTRAINT stock_movements_other_needs_a_note
        CHECK (reason <> 'other' OR (note IS NOT NULL AND note <> '')),
    CONSTRAINT stock_movements_counted_quantity
        CHECK ((reason = 'count_correction') = (counted_quantity IS NOT NULL)),
    CONSTRAINT stock_movements_allocation
        CHECK ((reason = 'allocation_consumed') = (allocation_id IS NOT NULL)),
    -- Answered as quantity: too_large (R42).
    CONSTRAINT stock_movements_on_hand_after_range CHECK (on_hand_after BETWEEN 0 AND 1000000),
    -- Where the movement came from, set by the code path that writes it (R41).
    CONSTRAINT stock_movements_source CHECK (
        source IN ('manual', 'product_form', 'import', 'allocation')
        AND (source = 'allocation') = (reason = 'allocation_consumed')
        AND (source = 'import') = (import_batch_id IS NOT NULL)
        AND (source <> 'import' OR reason = 'opening')
        AND (source <> 'product_form' OR reason = 'opening')
    ),
    CONSTRAINT stock_movements_actor CHECK ((actor_type = 'user') = (actor_id IS NOT NULL)),
    FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
    -- No ON DELETE: an item with movements cannot be deleted.
    FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items (tenant_id, id),
    FOREIGN KEY (tenant_id, allocation_id) REFERENCES allocations (tenant_id, id),
    FOREIGN KEY (tenant_id, import_batch_id) REFERENCES import_batches (tenant_id, id),
    FOREIGN KEY (tenant_id, actor_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX stock_movements_item_seq_idx
    ON stock_movements (tenant_id, inventory_item_id, seq DESC);

-- ---------------------------------------------------------------------------------------
-- The ledger is append-only, for every role (like audit_entries)
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION stock_movements_are_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'stock_movements is append-only' USING ERRCODE = '42501'; END $$;

CREATE TRIGGER stock_movements_no_change
    BEFORE UPDATE OR DELETE ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION stock_movements_are_append_only();

-- ---------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------
{_tenant_policies()}

-- ---------------------------------------------------------------------------------------
-- Backfill: every existing business gets its one default warehouse. Runs as the owner
-- role, which is not subject to row-level security. New businesses get theirs from
-- services/onboarding.create_business and the demo seed (R39).
-- ---------------------------------------------------------------------------------------
INSERT INTO warehouses (id, tenant_id, name, is_default)
    SELECT gen_random_uuid(), id, 'Main', true FROM tenants;
"""


def _grants(role: str) -> str:
    return f"""
GRANT SELECT, INSERT ON warehouses TO {role};
GRANT SELECT, INSERT, UPDATE, DELETE ON import_batches, products, product_options, option_values,
    product_photos, variants, stock_balances TO {role};
GRANT SELECT, INSERT, DELETE ON product_stores, inventory_items TO {role};
GRANT SELECT, INSERT ON allocations, allocation_lines, stock_movements TO {role};
GRANT UPDATE (status, released_at, consumed_at) ON allocations TO {role};
"""


DROP = f"""
DROP TRIGGER IF EXISTS stock_movements_no_change ON stock_movements;
DROP FUNCTION IF EXISTS stock_movements_are_append_only();
DROP TABLE IF EXISTS {", ".join(reversed(TABLES))};

DELETE FROM files WHERE kind = 'product_photo';
ALTER TABLE files DROP CONSTRAINT files_kind_check;
ALTER TABLE files DROP CONSTRAINT files_size_bytes_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN ('store_logo'));
ALTER TABLE files ADD CONSTRAINT files_size_bytes_check
    CHECK (size_bytes > 0 AND size_bytes <= 2097152);

ALTER TABLE tenants DROP COLUMN IF EXISTS low_stock_default;
-- pg_trgm is left installed on purpose.
"""


def upgrade() -> None:
    bind = op.get_bind()
    bind.exec_driver_sql(SCHEMA)
    bind.exec_driver_sql(_grants(_app_role()))


def downgrade() -> None:
    op.get_bind().exec_driver_sql(DROP)
