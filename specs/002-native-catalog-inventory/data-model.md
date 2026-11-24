# Data Model: Native Catalog and Inventory (M1)

Logical model for M1, added to M0's (`specs/001-platform-foundation/data-model.md`), which
still applies in full. Conventions are M0's: timestamps `timestamptz` in UTC, random UUID
primary keys, every tenant-owned table has `tenant_id`, row-level security **enabled and
forced** with the `tenant_isolation` policy (`tenant_id = app_tenant_id()` for reading and
writing), and child tables reference parents through composite foreign keys
`(tenant_id, parent_id)` so no row can point into another business. Decisions are in
[research.md](research.md) (R38–R58). Everything here is created by migration
`0003_catalog_inventory`.

## Overview

```text
Tenant ──1── Warehouse (default; exactly one in M1)
  │
  ├──< Product ──< ProductStore >── Store            (store listings)
  │       ├──< ProductOption (≤ 2) ──< OptionValue (≤ 20 each)
  │       ├──< ProductPhoto (≤ 8) ──> File ×2 (thumb, large)
  │       └──< Variant ──1── InventoryItem
  │                │              │
  │                │              ├──1── StockBalance (per warehouse)
  │                │              ├──< StockMovement   (append-only ledger)
  │                │              └──< AllocationLine >── Allocation
  │                └── option1/option2 value, photo
  └──< ImportBatch
```

Available = `on_hand − allocated`; it is never stored.

## Changed M0 tables

### tenants

| Field | Type | Rules |
|---|---|---|
| low_stock_default | integer | **new**; NOT NULL DEFAULT 2; 0–1,000,000; 0 disables warnings (FR-023). Existing tenants get 2 from the default. Changed through `PATCH /business` (`settings.manage`), recorded as `tenant.settings_changed`. |

### files

| Field | Change |
|---|---|
| kind | CHECK becomes `kind IN ('store_logo', 'product_photo')` |
| size_bytes | CHECK becomes `> 0 AND <= 5242880` (stored, re-encoded size; uploads are limited to 5 MB before re-encoding) |

## New tables

All new tables are under RLS with the `tenant_isolation` policy, and each has
`UNIQUE (tenant_id, id)` (or the composite key shown) so children can reference it.

### warehouses

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | FK tenants |
| name | text | 1–80; `'Main'`; not shown or editable in M1 |
| is_default | boolean | `CHECK (is_default)` in M1, so a second warehouse cannot exist |
| created_at | timestamptz | |

Indexes: unique `(tenant_id) WHERE is_default`. Grants: `SELECT, INSERT`.

### products

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | FK tenants |
| code | text | as typed, trimmed; 1–32; `^[A-Za-z0-9][A-Za-z0-9._/-]*$` |
| code_key | text | `GENERATED ALWAYS AS (lower(btrim(code))) STORED`; unique `(tenant_id, code_key)`, archived included |
| name_en | text, nullable | 1–120 |
| name_ar | text, nullable | 1–120; `CHECK (name_en IS NOT NULL OR name_ar IS NOT NULL)` |
| description_en | text, nullable | ≤ 2,000 |
| description_ar | text, nullable | ≤ 2,000 |
| status | text | `active` / `archived` |
| version | integer | starts at 1; +1 on every product change (FR-008); stock changes do not change it |
| import_batch_id | uuid, nullable | FK `(tenant_id, import_batch_id)` → import_batches; the import that created it |
| created_by_user_id | uuid | FK `(tenant_id, id)` → users |
| created_at, updated_at | timestamptz | |
| archived_at | timestamptz, nullable | set while archived |

Indexes: `(tenant_id, created_at DESC, id DESC)` for paging; GIN `gin_trgm_ops` on
`lower(name_en)`, `name_ar` and `code_key` (R51). Grants: `SELECT, INSERT, UPDATE, DELETE`
(delete only for a product that never had history, R47).

### product_stores

| Field | Type | Rules |
|---|---|---|
| tenant_id | uuid | part of both composite FKs |
| product_id | uuid | FK `(tenant_id, product_id)` → products |
| store_id | uuid | FK `(tenant_id, store_id)` → stores; a store of the business; new listings (form and import) accept active stores only, existing listings in a store deactivated later are kept |

PK `(product_id, store_id)`; index `(tenant_id, store_id)`. Grants: `SELECT, INSERT, DELETE`.
A product with no rows is listed in no store and is visible only to owners and managers.

### product_options

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | |
| product_id | uuid | FK `(tenant_id, product_id)` → products |
| position | smallint | 1 or 2; unique `(product_id, position)` |
| name | text | 1–40, as typed (e.g. "Size", "المقاس") |

Unique `(tenant_id, product_id, id)`. Grants: `SELECT, INSERT, UPDATE, DELETE`.

### option_values

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | |
| product_id | uuid | repeated from the option so variants can reference values with a composite key |
| option_id | uuid | FK `(tenant_id, product_id, option_id)` → product_options `(tenant_id, product_id, id)` |
| position | smallint | display order, 1–20 |
| label | text | 1–40, as typed |
| status | text | `active` / `archived` (archived when removed while its variants have history) |

Indexes: unique `(option_id, lower(label)) WHERE status = 'active'`; unique
`(tenant_id, product_id, id)`. At most 20 active values per option (service rule).
Grants: `SELECT, INSERT, UPDATE, DELETE`.

### inventory_items

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK; the stable inventory identity (FR-004); never reused or changed |
| tenant_id | uuid | FK tenants |
| created_at | timestamptz | |

Unique `(tenant_id, id)`. Grants: `SELECT, INSERT, DELETE`. Deletion is possible only for a
variant that never had history: `stock_movements` and `allocation_lines` reference the item
without `ON DELETE`, so the database itself refuses to delete an item with history.

### variants

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | |
| product_id | uuid | FK `(tenant_id, product_id)` → products |
| inventory_item_id | uuid | NOT NULL, UNIQUE; FK `(tenant_id, inventory_item_id)` → inventory_items |
| sku | text | as typed, trimmed; 1–64; `^[A-Za-z0-9][A-Za-z0-9._/-]*$` |
| sku_key | text | `GENERATED ALWAYS AS (lower(btrim(sku))) STORED`; unique `(tenant_id, sku_key)`, archived included (FR-005) |
| option1_value_id | uuid, nullable | FK `(tenant_id, product_id, option1_value_id)` → option_values |
| option2_value_id | uuid, nullable | FK `(tenant_id, product_id, option2_value_id)` → option_values; `CHECK (option2_value_id IS NULL OR option1_value_id IS NOT NULL)` |
| price | numeric(14,2) | 0 – 99,999,999,999.99 |
| currency | text | `USD` / `LBP`; `CHECK (currency = 'USD' OR price = trunc(price))` (LBP whole) |
| low_stock_level | integer, nullable | 0–1,000,000; null = business default; 0 = no warning |
| photo_id | uuid, nullable | FK `(tenant_id, product_id, photo_id)` → product_photos `(tenant_id, product_id, id)`: only a photo of the same product |
| position | integer | display order |
| status | text | `active` / `archived` |
| created_at, updated_at | timestamptz | |
| archived_at | timestamptz, nullable | |

Indexes: unique `(product_id, option1_value_id, option2_value_id) NULLS NOT DISTINCT WHERE
status = 'active'` (one active variant per combination, R47); `(tenant_id, product_id)`;
GIN `gin_trgm_ops` on `sku_key`. Grants: `SELECT, INSERT, UPDATE, DELETE`.

### stock_balances

| Field | Type | Rules |
|---|---|---|
| tenant_id | uuid | |
| warehouse_id | uuid | FK `(tenant_id, warehouse_id)` → warehouses |
| inventory_item_id | uuid | FK `(tenant_id, inventory_item_id)` → inventory_items |
| on_hand | integer | 0–1,000,000 |
| allocated | integer | ≥ 0 |
| version | bigint | starts at 1; +1 on every change (R43) |
| updated_at | timestamptz | |

PK `(warehouse_id, inventory_item_id)`; unique `(tenant_id, warehouse_id, inventory_item_id)`
(FR-011, one authoritative balance). Together the balance CHECKs enforce
`allocated >= 0 AND on_hand >= allocated AND on_hand <= 1000000` (R40), as two named
constraints so a violation can be answered by name (R42): `stock_balances_not_oversold
CHECK (allocated >= 0 AND on_hand >= allocated)` → 409 `not_enough_stock`;
`stock_balances_on_hand_range CHECK (on_hand BETWEEN 0 AND 1000000)` → 400
`quantity: too_large`. PostgreSQL checks CHECK constraints in name order, so a negative on
hand always fails `stock_balances_not_oversold` first (since `allocated >= 0`) and is
answered `not_enough_stock`.
Grants: `SELECT, INSERT, UPDATE, DELETE` (delete only with a history-less variant).

### stock_movements (append-only)

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| seq | bigint | `GENERATED ALWAYS AS IDENTITY`; orders the movements of an item |
| tenant_id | uuid | |
| warehouse_id | uuid | FK `(tenant_id, warehouse_id)` → warehouses |
| inventory_item_id | uuid | FK `(tenant_id, inventory_item_id)` → inventory_items (no cascade) |
| quantity | integer | signed; see reason rules |
| reason | text | `opening`, `received`, `found`, `damaged`, `lost`, `count_correction`, `other`, `allocation_consumed` |
| counted_quantity | integer, nullable | 0–1,000,000; required for `count_correction`, null otherwise |
| on_hand_after | integer | the balance's on hand right after this movement |
| allocation_id | uuid, nullable | FK `(tenant_id, allocation_id)` → allocations; required for `allocation_consumed` |
| import_batch_id | uuid, nullable | FK `(tenant_id, import_batch_id)` → import_batches |
| source | text | `manual` (a stock adjustment), `product_form` (opening stock from the product form), `import` (opening stock from a CSV import), `allocation` (an allocation consumed); set by the code path that writes the movement, never derived later |
| actor_type | text | `user` / `system` |
| actor_id | uuid, nullable | the user when `actor_type = 'user'` (FK `(tenant_id, actor_id)` → users) |
| note | text, nullable | ≤ 500; required for `other` |
| request_key | text, nullable | the Idempotency-Key or allocation key that caused it (traceability; not unique) |
| created_at | timestamptz | |

Checks: `opening`, `received`, `found` → `quantity > 0`; `damaged`, `lost`,
`allocation_consumed` → `quantity < 0`; `other` → `quantity <> 0` and note present;
`count_correction` → `counted_quantity IS NOT NULL` (quantity may be 0); `counted_quantity`
null for every other reason; `allocation_id IS NOT NULL` exactly when the reason is
`allocation_consumed`; `|quantity| <= 1000000`; `on_hand_after` 0–1,000,000 (named
`stock_movements_on_hand_after_range`, answered as `quantity: too_large`). Source CHECK
(`stock_movements_source`): `source IN ('manual', 'product_form', 'import', 'allocation')`;
`source = 'allocation'` exactly when `reason = 'allocation_consumed'` (and so when
`allocation_id` is set); `source = 'import'` exactly when `import_batch_id IS NOT NULL`, and
then `reason = 'opening'`; `source = 'product_form'` only with `reason = 'opening'`. A manual
adjustment with reason `opening` (FR-014) is `manual`.

Index: `(tenant_id, inventory_item_id, seq DESC)`. Trigger `stock_movements_no_change`
(`BEFORE UPDATE OR DELETE`, function `stock_movements_are_append_only()`) raises for every
role, like `audit_entries`. Grants: `SELECT, INSERT` (plus `USAGE` on the identity sequence
if the migration test shows the application role needs it).

### allocations

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | |
| request_key | text | 1–200; unique `(tenant_id, request_key)`; never expires (R44) |
| request_hash | bytea | SHA-256 of the sorted `(inventory_item_id, quantity)` list |
| status | text | `active` / `released` / `consumed` |
| actor_type | text | `user` / `system` |
| actor_id | uuid, nullable | FK `(tenant_id, actor_id)` → users when a user |
| created_at | timestamptz | |
| released_at | timestamptz, nullable | set exactly when `released` |
| consumed_at | timestamptz, nullable | set exactly when `consumed` |

Grants: `SELECT, INSERT, UPDATE` (status and its timestamp only).

### allocation_lines

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | |
| allocation_id | uuid | FK `(tenant_id, allocation_id)` → allocations |
| warehouse_id | uuid | FK `(tenant_id, warehouse_id)` → warehouses |
| inventory_item_id | uuid | FK `(tenant_id, inventory_item_id)` → inventory_items (no cascade) |
| quantity | integer | 1–1,000,000 |

Unique `(allocation_id, inventory_item_id)`; index `(tenant_id, inventory_item_id)`. At most
100 lines per allocation (service rule). Grants: `SELECT, INSERT`.

### product_photos

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | |
| product_id | uuid, nullable | FK `(tenant_id, product_id)` → products; null while staged (uploaded, not yet saved with a product) |
| position | smallint, nullable | 0–7; null exactly when `product_id` is null; unique `(product_id, position)` DEFERRABLE INITIALLY DEFERRED (reordering in one save) |
| thumb_file_id | uuid | FK `(tenant_id, thumb_file_id)` → files; WebP fitting 320×320 |
| large_file_id | uuid | FK `(tenant_id, large_file_id)` → files; WebP fitting 1080×1080 |
| width, height | integer | of the large image |
| staged_expires_at | timestamptz, nullable | created + 24 h while staged; null once attached |
| created_by_user_id | uuid | FK `(tenant_id, id)` → users |
| created_at | timestamptz | |

Unique `(tenant_id, product_id, id)` (target of `variants.photo_id`). At most 8 per product
(service rule, under the product row lock). Grants: `SELECT, INSERT, UPDATE, DELETE`.

### import_batches

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | |
| created_by_user_id | uuid | FK `(tenant_id, id)` → users |
| status | text | `previewed` / `failed` / `committed` |
| file_name | text | ≤ 255, display only, control characters removed; never used as a path |
| file_sha256 | bytea | |
| row_count | integer | 0–2,000 |
| product_count, variant_count | integer | what confirming would create (or created) |
| opening_units | bigint | sum of opening quantities |
| errors | jsonb | `[{row, column, code}]`; empty for `previewed` and `committed` |
| payload | jsonb, nullable | the validated rows; cleared at commit |
| expires_at | timestamptz | created + 24 h; confirm refused after it |
| committed_at | timestamptz, nullable | |
| committed_by_user_id | uuid, nullable | |
| created_at | timestamptz | |

Grants: `SELECT, INSERT, UPDATE, DELETE` (delete of expired, uncommitted batches by
maintenance).

## Integrity rules (FR-013, FR-018, FR-022)

Checked by `services/inventory.integrity_report(db)` per business, by `flask bos
stock-check`, and after every catalog and stock test:

1. Every variant has an inventory item, and every inventory item has exactly one balance in
   the default warehouse (and is used by exactly one variant).
2. `on_hand = Σ stock_movements.quantity` for the item.
3. `on_hand = on_hand_after` of the item's latest movement (when it has any).
4. `allocated = Σ allocation_lines.quantity` over the item's lines whose allocation is
   `active`.
5. `on_hand − allocated ≥ 0` (also guaranteed by the CHECK).
6. Every business has exactly one warehouse, and it is the default.

The report lists each failing item with the expected and actual numbers; an empty report
means the business is consistent.

## Validation rules (service layer; the database repeats what it can)

| Field | Rule | Error |
|---|---|---|
| product code | 1–32, allowed characters (R46), unique in business incl. archived | `validation_failed` (`code: required/too_long/invalid`), 409 `product_code_in_use` (`code: in_use`) |
| names | at least one of `name_en`, `name_ar`; each 1–120 | `name_en: required` when both missing; `too_long` |
| descriptions | ≤ 2,000 each | `too_long` |
| stores | ids of this business's active stores (a store already listed and later deactivated may stay, and its listing is kept); same rule for import (`unknown_store`) | `store_ids: invalid` |
| photos | ≤ 8 ids, each a staged photo of this business or already this product's | `photo_ids: too_many / invalid` |
| options | 0–2 types; name 1–40; 1–20 values each, label 1–40, no duplicate labels (ASCII case ignored) | `options: too_many`, `options.0.values: too_many / duplicate` |
| variants | exactly the combinations of the active values, ≤ 100 | `variants: invalid / too_many` |
| SKU | empty → suggested; else 1–64, allowed characters, unique in business and in the request | `variants.N.sku: too_long / invalid / duplicate`, 409 `sku_in_use` (`variants.N.sku: in_use`) |
| variant restore | reactivating its archived option value must not clash with an active value's label of the same option (ASCII case ignored); checked before writing | 409 `value_in_use` |
| price | decimal string ≤ 2 decimals, 0–99,999,999,999.99; LBP whole | `variants.N.price: required / invalid / too_large / not_whole` |
| currency | `USD` / `LBP` | `invalid` |
| low-stock level | integer 0–1,000,000 or null | `invalid / too_large` |
| opening quantity | integer 0–1,000,000 (create, and new variants have 0) | `invalid / too_large` |
| adjustment quantity | integer 1–1,000,000; counted quantity 0–1,000,000 | `quantity: required / invalid / too_large` |
| adjustment result | 0 ≤ on hand after ≤ 1,000,000 and on hand after ≥ allocated | 409 `not_enough_stock` (below zero or allocated), `quantity: too_large` (above 1,000,000); the database CHECKs are answered by constraint name the same way |
| note | ≤ 500; required for `other` | `note: required / too_long` |
| direction | `in` / `out`; required for `other`, ignored for every other reason (each has a fixed sign) | `direction: required / invalid` |

Text fields are trimmed; an empty string counts as missing. Field paths in
`validation_failed.fields` use dots for nesting (`variants.2.sku`).

## State transitions

**Product**: `active` ⇄ `archived` (archive refused while any variant has `allocated > 0`).
Archiving a product leaves its variants' own status unchanged; a variant counts as archived
(hidden from sales search, refused for allocation) when it **or** its product is archived,
so restoring the product brings back exactly the variants that were active.
An archived product cannot be edited until restored (409 `product_archived`). A product is
deleted (rows gone) only when none of its variants ever had a movement or allocation line
(otherwise 409 `has_history`).

**Variant**: `active` ⇄ `archived` through the product form. Archiving refused while
`allocated > 0`; restoring refused when an active variant has the same combination
(`combination_in_use`). Removed from the form without history: deleted with its inventory
item and balance.

**Option value**: `active` → `archived` when removed while one of its variants has history;
back to `active` when one of those variants is restored. That restore is refused with 409
`value_in_use`, before anything is written, when an active value of the same option now
has the same label (ASCII case ignored), which the partial unique index would otherwise
reject.

**Allocation**: `active` → `released` | `consumed`. Terminal states never change; repeating
the same transition returns the allocation unchanged; the other transition is refused
(`allocation_closed`).

**Product photo**: staged (no product) → attached (saved with a product) → deleted (removed
from the product, or the product deleted). Staged photos older than 24 h are deleted by
maintenance.

**Import batch**: `previewed` → `committed`; `failed` is terminal; a `previewed` batch past
`expires_at` cannot be confirmed and is deleted by maintenance.

## History (audit) events

Events: added to M0's fixed list. Change events use `{"before", "after"}` with
same-shaped sides. Money is represented as decimal strings. The table describes newly
written entries; historical payloads are not rewritten.

| Event | Target | `data` |
|---|---|---|
| `product.created` | product | `code`, `variants` (count), `store_ids`, `opening_units`; bulk `seed-catalog` also includes fixed `source: "seed-catalog"` |
| `product.updated` | product | `before` and `after` for changed `code`, `store_ids`, and `photos` count; `changed_fields` lists changed text fields using only `name_en`, `name_ar`, `description_en`, `description_ar`, `options` (option names or values), or `[]` if none changed. Variant diffs are `variants_added`, `variants_archived`, `variants_restored`, `variants_deleted` (lists of SKUs) and `variants_changed` (`[{sku, before, after}]` over `sku`, `price`, `currency`, `low_stock_level`, `photo`). |
| `product.archived` | product | change; sides are status strings |
| `product.restored` | product | change; sides are status strings |
| `product.deleted` | product | `code` |
| `stock.adjusted` | variant | `sku`, `reason`, `quantity` (signed), `counted_quantity` (count corrections), `on_hand_before`, `on_hand_after` |
| `stock.allocated` | allocation (ID in `target_id`) | `lines`: `[{sku, inventory_item_id, quantity}]` |
| `stock.released` | allocation (ID in `target_id`) | `lines` as above |
| `stock.consumed` | allocation (ID in `target_id`) | `lines` as above |
| `catalog.imported` | import_batch (ID in `target_id`) | `products`, `variants`, `opening_units` |

Minimization applies to `data` only. Stock movement notes, allocation request keys and import
filenames remain in their operational records. The History API still resolves `target_name`
from current records (product English name or Arabic fallback, variant SKU, allocation
request key, import filename); those labels and retained identifiers are not value-redacted.

Opening quantities entered in the product form are covered by `product.created`
(`opening_units`) and by their ledger movements; an import is one `catalog.imported` entry
whatever its size (FR-028). Refusals reuse `access.denied_permission`,
`access.denied_tenant` and `access.denied_store` (for catalog records out of the caller's
stores: `permission: catalog.view`, target the product). The low-stock default is part of
`tenant.settings_changed`.

## Migration `0003_catalog_inventory`

**Upgrade** (one revision, `down_revision = "0002"`, plain SQL like 0001/0002):

1. `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (trusted extension; the owner role needs
   `CREATE` on the database, which it has in development, CI and Compose).
2. `ALTER TABLE tenants ADD COLUMN low_stock_default integer NOT NULL DEFAULT 2 CHECK
   (low_stock_default BETWEEN 0 AND 1000000);` — every existing tenant gets 2.
3. Replace the `files` CHECKs on `kind` and `size_bytes`.
4. Create, in dependency order: `warehouses`, `import_batches`, `products`,
   `product_stores`, `product_options`, `option_values`, `product_photos`,
   `inventory_items`, `variants`, `stock_balances`, `allocations`, `allocation_lines`,
   `stock_movements`, their indexes, the append-only function and trigger on
   `stock_movements`, RLS (enable, force, `tenant_isolation`) on all thirteen, and the
   grants above for the application role (`BOS_APP_DB_USER`).
5. Backfill: `INSERT INTO warehouses (id, tenant_id, name, is_default) SELECT
   gen_random_uuid(), id, 'Main', true FROM tenants;` — runs as the owner role, which
   bypasses RLS, so every existing business gets exactly one default warehouse. New
   businesses get theirs from `services/onboarding.create_business` and the demo seed (R39).

**Downgrade** (`flask db downgrade 0002`), in reverse:

1. Drop the trigger and `stock_movements_are_append_only()`; drop the thirteen tables
   (`stock_movements`, `allocation_lines`, `allocations`, `stock_balances`, `variants`,
   `inventory_items`, `product_photos`, `option_values`, `product_options`,
   `product_stores`, `products`, `import_batches`, `warehouses`).
2. `DELETE FROM files WHERE kind = 'product_photo';` then restore M0's two CHECKs.
3. `ALTER TABLE tenants DROP COLUMN low_stock_default;`
4. Leave `pg_trgm` installed (it may have existed before BOS and is harmless).

**What a rollback loses**: every product, variant, stock balance, movement, allocation,
photo record and import batch, and the low-stock default. Product photo files on disk
(`BOS_UPLOAD_DIR/tenant/<id>/`) are orphaned, as for logos in M0. History entries about
catalog and stock remain (audit is append-only) but point at records that no longer exist.
On a database holding real data, take a backup (`pg_dump` as the owner) first
(Principle VIII). The migration test applies `0003` on a database with M0 data (two
tenants), checks one default warehouse per tenant and `low_stock_default = 2`, then runs
`downgrade 0002` and `upgrade head` again; the test session's `downgrade base` / `upgrade
head` covers the full chain.

## Requirement coverage

| Requirement | Where enforced |
|---|---|
| FR-002/003 product, options, variants | services + unique combination index |
| FR-004 stable identity | `inventory_items`, `variants.inventory_item_id` UNIQUE NOT NULL, ledger keyed by item |
| FR-005 SKU uniqueness | `sku_key` generated column + unique index incl. archived |
| FR-006 money | `numeric(14,2)` + currency CHECK + LBP whole CHECK; no stored conversion |
| FR-007 archive not delete | FKs without cascade from movements and allocation lines; service rules |
| FR-008 product concurrency | `products.version` |
| FR-011 one warehouse, one balance | `warehouses` partial unique + CHECK; balances unique per item and warehouse |
| FR-012/013 ledger | append-only `stock_movements` + trigger; same-transaction balance write; integrity rule 2 |
| FR-015 stale or impossible change | `stock_balances.version`; CHECKs `stock_balances_not_oversold` and `stock_balances_on_hand_range` |
| FR-017 movement origin in stock history | `stock_movements.source` + `stock_movements_source` CHECK |
| FR-018 available ≥ 0 | CHECK; derived, never stored |
| FR-019 idempotent all-or-nothing allocation | `allocations (tenant_id, request_key)` unique + `request_hash`; one transaction |
| FR-021 concurrency | ordered row locks (R42) + CHECK |
| FR-022 integrity check | integrity rules above |
| FR-023/024 low stock | `tenants.low_stock_default`, `variants.low_stock_level`, computed states |
| FR-025–029 import | `import_batches`, single-transaction confirm |
| FR-030 isolation | RLS on all new tables, composite FKs, store-filtered catalog predicate |
