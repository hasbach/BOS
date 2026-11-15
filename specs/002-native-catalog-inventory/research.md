# Research: Native Catalog and Inventory (M1)

Decisions that resolve every open point in the plan's Technical Context. Numbering continues
from M0 (`specs/001-platform-foundation/research.md`, R1–R37); every M0 decision still
applies unless a decision below says otherwise. Each lists what was chosen, why, and what was
rejected.

## R38. Stable inventory identity

- **Decision**: An `inventory_items` row is created in the same transaction as its variant,
  1:1 (`variants.inventory_item_id` is `NOT NULL UNIQUE`). Its UUID is random, never reused
  and never changed. Balances, movements and allocation lines reference the inventory item,
  never the variant. SKU, price, names and option values live on the variant and product and
  can change freely. A variant without history can be deleted, which deletes its inventory
  item and balance; the UUID is simply gone (random UUIDs are never reissued).
- **Rationale**: FR-004 and brief 6.1 (one canonical sellable unit). M2 order lines and M4
  website mappings point at the inventory item, so renaming or re-coding a variant can never
  move stock or break a mapping. Keeping the ledger keyed by the item, not the variant,
  means a later "kit" or "custom item" never has to pretend to be a variant.
- **Alternatives considered**: Using the variant id as the inventory identity (simpler, but
  couples stock to catalog presentation; the brief names `InventoryItem` separately). SKU as
  identity (SKUs are edited, so it is not stable).

## R39. One default warehouse per business

- **Decision**: A `warehouses` table with a partial unique index allowing one
  `is_default` row per tenant, plus `CHECK (is_default)` in M1 so no second warehouse can
  exist at all. It is created by: migration `0003` for every existing tenant; the operator's
  business setup (`services/onboarding.create_business`, in the tenant context it already
  enters, R24); the demo seed; and the test helpers that insert tenants. Stock code looks the
  warehouse up with `SELECT id FROM warehouses WHERE is_default` and fails closed (500,
  logged) if it is missing. Not shown to users in M1.
- **Rationale**: FR-011, brief 6.1 rule 1. Explicit creation in the two places that create
  tenants keeps all writes in tenant context and adds no `SECURITY DEFINER` function.
- **Alternatives considered**: A trigger on `tenants` insert (would have to be `SECURITY
  DEFINER`, because tenants are inserted in operator context where the warehouse policy
  refuses the row; M0 keeps those functions to the five listed in data-model.md). Storing
  balances without a warehouse column (multi-warehouse later would mean rewriting every
  balance and movement).

## R40. Balances: on hand and allocated, available derived

- **Decision**: `stock_balances(tenant_id, warehouse_id, inventory_item_id)` unique, with
  `on_hand`, `allocated` and `version`. `CHECK (allocated >= 0 AND on_hand >= allocated AND
  on_hand <= 1000000)`. Available (`on_hand − allocated`) is computed in queries and never
  stored. `version` (bigint) increases by one on every change of the row: adjustment,
  allocation, release, consumption. A balance row is created with its variant (on hand 0, or
  the opening quantity).
- **Rationale**: FR-011, FR-013, FR-018, Principle II. The CHECK makes negative
  availability impossible even if application code is wrong; storing available would allow
  it to drift from the two numbers it is made of.
- **Alternatives considered**: Computing on hand from the ledger on every read (correct but
  slow for search over 5,000 variants and impossible to lock). Storing `available` as a
  column (a third number that can disagree).

## R41. The stock ledger

- **Decision**: `stock_movements` is append-only: the application role gets `SELECT,
  INSERT` only and a trigger refuses `UPDATE` and `DELETE` for every role, exactly like
  `audit_entries` (R11). Each row: inventory item, warehouse, signed integer `quantity`,
  `reason`, `counted_quantity` (count corrections only), `on_hand_after`, actor (`user` with
  id, or `system`), optional `note` (≤ 500), optional `request_key` (the Idempotency-Key or
  allocation key that caused it), optional `allocation_id` / `import_batch_id`, `created_at`
  and an identity `seq` that orders movements of one item. Reasons and their sign rules
  (enforced by CHECK):

  | Reason | Who | Sign |
  |---|---|---|
  | `opening` | person, product form or import | > 0 |
  | `received` | person | > 0 |
  | `found` | person | > 0 |
  | `damaged` | person | < 0 |
  | `lost` | person | < 0 |
  | `count_correction` | person | any, 0 allowed; `counted_quantity` required |
  | `other` | person, note required | ≠ 0 |
  | `allocation_consumed` | system path (M3 dispatch) | < 0, `allocation_id` required |

  The balance row and the movement are written in the same transaction, after the balance row
  is locked. An opening quantity of 0 writes no movement (nothing changed).
- **Rationale**: FR-012, FR-013, FR-017, Principle II ("corrections are new entries").
  `on_hand_after` lets the history screen show the running balance without summing, and lets
  the integrity check spot a movement written without its balance. A count of 0 difference
  is still recorded, because "we counted and it was right" is useful history.
- **Alternatives considered**: A separate `stock_adjustments` table beside movements (the
  brief lists one; in M1 every adjustment is exactly one movement, so a second table would
  only duplicate it). Storing only signed quantities with no reason (unexplainable numbers).

## R42. Concurrency: lock order and failing closed

- **Decision**: Every operation that changes stock locks the affected balance rows with
  `SELECT … FOR UPDATE`, **always in ascending `inventory_item_id` order**, before reading the
  numbers it decides on. Stock operations never lock product or variant rows. Operations
  that touch both (archiving a variant, deleting a history-less variant, archiving a product)
  lock the product row first, then the balances in the same ascending order. The CHECK of
  R40 is the final guard: a violation is answered as `not_enough_stock`, never a 500. M0's
  connection settings stay (`lock_timeout = 10s`); a lock timeout or a detected deadlock is
  answered **503 `try_again`** with `Retry-After: 1`, and nothing is applied. The client
  retries with the same Idempotency-Key, so a retry can never apply twice.
- **Rationale**: FR-021, Principle II (fail closed). A single global order makes deadlocks
  between stock operations impossible; row locks (not table locks) keep unrelated variants
  independent; the CHECK catches any path that forgets to lock.
- **Alternatives considered**: `SERIALIZABLE` isolation with automatic retries (works, but
  retries inside a request hide contention and complicate idempotency). Optimistic
  `UPDATE … WHERE on_hand - allocated >= :q` without locks (correct for single-item
  decrements but not for all-or-nothing multi-item allocation). Advisory locks per tenant
  (serialises unrelated variants).

## R43. Stale screens: balance version and product version

- **Decision**: An adjustment carries `balance_version`, the version the person saw. Under
  the row lock, a different current version is refused with 409 `stock_changed`, and the
  error body carries the current `on_hand`, `allocated`, `available` and `version`, so the
  sheet can show the new numbers and let the person repeat the change knowingly (FR-015,
  US2 scenario 2). Products carry `version`; a product edit, archive, restore or delete
  sends it and is refused with 409 `product_changed` (body carries the current product) when
  it differs (FR-008). Stock changes do not change the product version, so a stock
  adjustment never invalidates someone's open product form.
- **Rationale**: Principle II forbids lost updates; showing current values is required by
  the spec. Integer versions are simpler to compare than timestamps.
- **Alternatives considered**: Comparing the expected on-hand number instead of a version
  (an allocation and a release in between leave the same numbers but a different reality the
  person never saw; versions are stricter and still cheap). Last-write-wins (forbidden).

## R44. Idempotency of stock changes and allocations

- **Decision**:
  - **Adjustments** use M0's `core/idempotency.py` unchanged (`Idempotency-Key` header,
    resource type `stock_movement`, key kept 24 hours). The replay returns the original
    movement and the balance as it is now. The adjustment sheet creates one key when it opens
    and reuses it for every retry of that save.
  - **Allocations** have their own durable key, because the M2 caller is an order and must
    be replayable forever: `allocations(tenant_id, request_key)` is unique, and
    `request_hash` is SHA-256 of the canonical list of `(inventory_item_id, quantity)` sorted
    by item. Same key and same contents: the original allocation is returned and nothing is
    reserved again, whatever its state now. Same key, different contents: refused
    (`allocation_key_conflict`). Keys never expire. A race between two identical requests is
    resolved like M0's idempotency: the insert runs under a savepoint and the loser reads
    and returns the winner's allocation.
- **Rationale**: FR-016, FR-019, SC-002, brief section 6 ("unique reservation source /
  idempotency key"). Reusing the M0 mechanism for person-driven changes avoids a second
  implementation; allocations are a different lifetime (an order may be retried days later
  by a job) so they cannot share the 24-hour table.
- **Alternatives considered**: A unique `request_key` on `stock_movements` (a count
  correction can be legitimately repeated by the same person with a new key; the M0 table
  already scopes keys by endpoint and actor). Expiring allocation keys (an old order replayed
  after expiry would reserve twice).

## R45. Allocation in M1: a service, proven by tests

- **Decision**: `services/allocation.py` offers `allocate(db, actor, request_key, lines)`,
  `release(db, actor, allocation_id)` and `consume(db, actor, allocation_id)`. There is **no
  HTTP endpoint in M1**; M2 adds one with orders. Rules:
  - `allocate`: lines are `(inventory_item_id, quantity ≥ 1)`, at most 100, no item twice.
    Locks the balances (R42), refuses the whole request if any item is unknown, belongs to an
    archived variant (`variant_archived`) or has `available < quantity`
    (`insufficient_stock`, listing every short line with its available number). Otherwise
    increases `allocated`, bumps versions, inserts the allocation (`active`) and its lines,
    and records `stock.allocated` — all in the caller's transaction.
  - `release`: `active` → `released`, `allocated` decreases. Releasing an already released
    allocation returns it unchanged; releasing a consumed one is refused
    (`allocation_closed`).
  - `consume`: `active` → `consumed`; `on_hand` and `allocated` both decrease and one
    `allocation_consumed` movement per line is written. Consuming a consumed allocation
    returns it unchanged; consuming a released one is refused (`allocation_closed`).
  - State is per allocation (all lines together); partial release and partial consumption
    are M2/M3 concerns and are not built now.
  - The integrity check (FR-022) is `services/inventory.integrity_report(db)` (one business)
    and the command `flask bos stock-check [--tenant ID]` (every business, each in its own
    tenant transaction). A pytest fixture runs the same check after every test of the
    catalog and stock suites and fails the test on any difference (SC-003).
  - Concurrency tests use real separate connections from the application engine, one per
    thread, started together on a `threading.Barrier` (not sequential calls), as Principle
    IV requires.
- **Rationale**: US3 and the M1 exit gate need the allocation path, but with no orders an
  endpoint would be an untested surface nobody uses (Principle V). Building the service now
  is the point of the milestone, not speculation: M2's confirmation calls exactly these
  functions.
- **Alternatives considered**: An internal HTTP endpoint for tests (needs a permission and
  isolation cases for something no user can do). Deferring allocation to M2 (contradicts
  the M1 exit gate).

## R46. SKUs and product codes

- **Decision**:
  - Both are stored as typed (trimmed) plus a generated column `lower(btrim(...))` with a
    unique index per tenant (`variants (tenant_id, sku_key)`, `products (tenant_id,
    code_key)`). The indexes are not partial, so archived variants and products keep their
    SKU and code reserved (FR-005). The application checks first to give a field-level 409
    naming the conflicting product; the unique index decides races.
  - Allowed characters: ASCII letters and digits plus `-`, `_`, `.` and `/`, starting with a
    letter or digit. SKU 1–64 characters, product code 1–32.
  - Suggestion when the SKU is left empty: product code and the variant's option values
    joined with `-`, spaces inside values turned into `-`, characters outside the allowed set
    dropped, upper-cased, cut to 64 characters; a value with nothing left (for example an
    Arabic colour name) contributes its 1-based position in its option instead. If the
    result is taken (in the business or earlier in the same request), `-2`, `-3`, … is
    appended (the base is shortened to fit). `JN-SLIM` + `32` + `Blue` → `JN-SLIM-32-BLUE`.
- **Rationale**: FR-005, SC-004. A generated column cannot drift from the typed value.
  Verified on the development cluster: it is initialised with `--locale=C`, where `lower()`
  folds only ASCII letters (`lower('ÉTÉ')` leaves `É` unchanged). Restricting SKUs and codes
  to ASCII makes "ignoring letter case" exact on every cluster whatever its locale; it also
  keeps SKUs typeable on any keyboard, safe in CSV files and printable as barcodes later.
- **Alternatives considered**: Normalising only in Python (a second path such as the import
  or a script could skip it; the database would not enforce it). ICU nondeterministic
  collations (unique indexes on them are not supported for case-insensitive comparison in
  the way needed, and add a locale dependency). Allowing any script in SKUs (case folding of
  non-ASCII letters would depend on the cluster's locale).

## R47. Options and variants

- **Decision**:
  - A product has 0, 1 or 2 option types (`product_options`, position 1 or 2, a name as
    typed, e.g. "Size" / "المقاس"), each with 1–20 ordered values (`option_values`, label as
    typed, unique among the option's active values ignoring ASCII case). Names and labels are
    shown exactly as typed, never translated (R34).
  - Variants hold `option1_value_id` / `option2_value_id`. Every combination of active
    values must have exactly one active variant: the service requires the full cartesian
    product in every save, and a partial unique index `(product_id, option1_value_id,
    option2_value_id) NULLS NOT DISTINCT WHERE status = 'active'` enforces it in the
    database. At most 100 variants per product. A product with no options has exactly one
    variant with both value ids null.
  - Editing: option types and values can be renamed at any time (variants keep identity,
    since they reference value ids). Adding a value creates the new combinations as variants
    with zero stock. Removing a value archives its variants that have history (any movement
    or allocation line) and its value, and deletes variants without history. The **number**
    of option types can change only while no variant of the product has history (otherwise
    409 `options_locked`); a merchant who needs a new dimension creates a new product.
  - Restoring an archived variant is refused with 409 `combination_in_use` if an active
    variant now has the same combination; restoring it reactivates its archived value.
  - Archiving a variant (or its product) with `allocated > 0` is refused with 409
    `variant_has_allocations` (checked under the balance lock, so it cannot race an
    allocation).
- **Rationale**: FR-002, FR-003, FR-007, edge cases in the spec. The database index makes
  "one variant per combination" impossible to break; storing the two value ids on the variant
  is enough for the two-option limit and needs no join table.
- **Alternatives considered**: A generic `variant_option_values` join table (needed only for
  an unlimited number of option types). Free-form variants without the cartesian rule (the
  spec says each combination is a variant; sparse matrices can come later).

## R48. Prices and numbers typed by people

- **Decision**:
  - `price numeric(14,2)` from 0 to 99,999,999,999.99 and `currency` `USD | LBP` on each
    variant; LBP prices must be whole (`CHECK (currency = 'USD' OR price = trunc(price))`).
    The API carries prices as M0 decimal strings (R36: ASCII digits, at most one dot, at
    most two decimals). A price of 0 is allowed (samples, gifts).
  - The approximate amount in the other currency is computed for display only, in the web
    app, from the business rate it already reads (`GET /business`): USD → LBP rounded to whole
    pounds, LBP → USD rounded to cents, always labelled "≈" / approximate. Nothing converted
    is stored, so changing the rate never changes a price (FR-006).
  - Quantities are JSON integers in the API (0 to 1,000,000; strings, decimals and booleans
    are refused).
  - **Change from M0**: on the new catalog and stock fields the web app converts
    Arabic-Indic (٠–٩) and Eastern Arabic-Indic (۰–۹) digits, the Arabic decimal separator
    `٫` and thousands separator `٬` to ASCII before validating, as the spec's edge case
    requires. The API itself still accepts ASCII only, exactly as in M0. The M0 Settings
    screen (exchange rate, delivery fee) is aligned in M1 so every number field in BOS
    behaves the same; its hint changes from "digits 0-9 only" to accept both digit sets
    (lead decision 2026-11-15, one shared helper in `lib/digits.ts`).
- **Rationale**: FR-006, Principle II (exact decimals, explicit currency, nothing
  recalculated). Normalising digits in one client place keeps the server's money rule
  unambiguous.
- **Alternatives considered**: Storing both currencies per variant (two numbers that drift
  when the rate changes; rejected in the 2026-11-14 clarification). Converting on the
  server (still display-only; the client already has the rate and formats money).

## R49. Low stock

- **Decision**:
  - `tenants.low_stock_default` (integer, default **2**, 0 to 1,000,000) is a business
    setting changed through M0's `PATCH /business` (`settings.manage`, owners and managers),
    so it is recorded as M0's `tenant.settings_changed` like every other setting. Each
    variant has a nullable `low_stock_level` override. The effective level is
    `coalesce(variant level, business default)`; **0 disables** the warning.
  - States, computed in queries: **out** when available = 0; **low** when the effective
    level > 0 and 0 < available ≤ level. Labels are text chips ("Out", "Low"), never colour
    alone.
  - The Low stock list (`GET /catalog/low-stock`, permission `stock.adjust`) lists active
    variants of active products whose effective level > 0 and available ≤ level, out of
    stock first, then by available ascending, then SKU. A variant with level 0 is never in
    the list but still shows "Out" when it has nothing available.
  - Product-level search filter (everyone, FR-009): `in_stock` = some active variant has
    available > 0; `out` = none has; `low` = some active variant is low or out with a level
    > 0.
- **Rationale**: FR-023, FR-024, US4. Using the existing settings path avoids a second
  settings endpoint and a second audit event for one more setting.
- **Alternatives considered**: A separate `settings.low_stock_default_changed` event and
  endpoint (the lead's example name; M0 already records every business setting as
  `tenant.settings_changed` with before/after, which the History screen renders). Storing a
  low flag on the balance (would need updating on every stock change and every default
  change).

## R50. Product photos

- **Decision**:
  - **Staged uploads**: the product form uploads each photo as soon as it is picked
    (`POST /catalog/photos`, `catalog.manage`), getting back a photo id; the product save
    lists `photo_ids` in display order. A photo that fails to upload can be retried on its
    own while the rest of the form is kept; a refused photo (too large, not an image) is a
    field error the form must resolve before saving (spec edge case). An attached photo
    belongs to one product. Unattached uploads expire after 24 hours.
  - **Pipeline**: M0's logo pipeline generalised in `core/storage.py`: at most **5 MB**,
    decoded with Pillow restricted to PNG/JPEG/WebP (the decoded format decides, never the
    extension or client MIME type), refused over 40 megapixels from the header alone, EXIF
    orientation applied, pixels copied into a fresh image so no metadata survives,
    re-encoded to WebP twice: **thumbnail fitting 320×320** and **large fitting 1080×1080**
    (quality 80). Each size is a `files` row (kind `product_photo`) at a server-generated
    path `tenant/<tenant_id>/<random>.webp`.
  - **Serving**: only through `GET /catalog/photos/{photoId}/{size}`, which checks the
    tenant and the product's store scope like the product itself; staged photos are visible
    only to `catalog.manage` holders. `Cache-Control: private, no-cache` plus an `ETag`, so
    every view is re-authorised but an unchanged photo costs a 304.
  - Up to **8** photos per product (counted under the product row lock); a variant may point
    at one of its own product's photos (composite foreign key, so a photo of another product
    is impossible).
  - Files: new files are written before the database change and removed by an `on_rollback`
    callback; files of removed photos are deleted by an `on_commit` callback (M0 R36).
    Unattached uploads older than 24 hours are removed by `flask bos maintenance`, which
    gains a per-tenant step run in each tenant's own transaction (FR-004), deleting files
    only after that transaction commits.
  - **Storage stays on local disk** behind M0's `Storage` interface in M1. The brief's
    object storage is introduced with deployment hardening (M7) without touching callers.
- **Rationale**: FR-010, spec edge cases, Principle I (no public URLs), M0 R14 and R36.
  Two sizes keep catalog lists fast on weak connections (a 320 px thumbnail is a few
  kilobytes) and product photos sharp on a phone.
- **Alternatives considered**: Uploading photos to a product only after it is saved (a
  refused photo could not block the save as the spec asks, and a new product would be saved
  without its photos on a weak connection). Signed URLs from object storage now (no object
  storage exists yet; Principle V). Keeping originals (more storage and metadata risk for no
  M1 use).

## R51. Search, filters and paging

- **Decision**:
  - Matching: `ILIKE '%' || q || '%'` (with `%`, `_` and `\` in `q` escaped) on
    `name_en`, `name_ar`, the product code and any variant's SKU, case-insensitive for ASCII.
    `q` is 1–100 characters after trimming; Arabic-Indic digits in `q` are converted to
    ASCII by the web app.
  - Indexes: `pg_trgm` GIN indexes (`gin_trgm_ops`) on `lower(name_en)`, `name_ar`,
    `code_key` and `sku_key`. **Verified on the development cluster** (PostgreSQL 17.4 under
    `%LOCALAPPDATA%\bos-dev`, `pg_trgm` 1.6 installed with the server and marked
    `trusted = true`, so the owner role can create it without being a superuser wherever it
    has `CREATE` on the database; the Compose `postgres:16` image ships it too). Migration
    `0003` runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` and its downgrade leaves the
    extension installed (harmless, and it may predate BOS).
  - **Finding**: the development cluster uses the `C` locale, where `pg_trgm` extracts no
    trigrams from Arabic text (`show_trgm('أزرق جينز')` returns `{}`), so the Arabic-name
    index cannot narrow a search there; correctness is unaffected because the `ILIKE`
    condition is always evaluated. At the target scale (5,000 variants, roughly 1,000–2,000
    products per business, already narrowed by `tenant_id`) a scan of one business's
    products takes milliseconds, so SC-006 does not depend on the index. Production and
    staging databases should be created with a UTF-8 locale (for example `C.UTF-8`), noted
    for M7.
  - **Paging**: keyset cursor, 20 products per page, newest first (`created_at DESC, id
    DESC`), returned as an opaque `next_cursor` like M0's `/audit`. Newest first suits a
    merchant building a catalog on the phone and makes the cursor trivially stable while
    products are added; search narrows everything else. The first page also returns
    `counts` (`all`, `in_stock`, `low`, `out`) for the same query and store filter, for the
    filter pills.
  - Filters: `store_id` (one of the caller's stores), `stock` (`in_stock`, `low`, `out`),
    `status=archived` and `no_photo=true` (both only with `catalog.manage`, FR-029).
- **Rationale**: FR-009, SC-006. Trigram indexes make Latin-script partial matching
  index-backed; plain `ILIKE` remains the semantics, so the index is purely an
  optimisation.
- **Alternatives considered**: Full-text search (`tsvector`; stems words, does not match
  partial codes like `SLIM-3`). Offset paging (simpler, but repeats or skips rows while
  products are added during scrolling). Alphabetical order (mixed Arabic and English names
  sort poorly under the `C` collation).

## R52. Store scope for the catalog

- **Decision**:
  - `catalog.view` becomes **store-scoped** (contracts/permissions.md). Owners and managers
    (all stores) see every product, including products listed in no store and archived ones
    (archived only when asked). Sales, packing and dispatch staff see a product only when it
    is **active** and listed in at least one **active** store they may work in — one SQL
    predicate (`services/catalog.visible_products(access)`) used by every catalog query.
  - A product (or its photo, or one of its variants) outside the caller's scope answers 404
    `not_found`, identical to one that does not exist. If the record exists in the business
    but is out of the caller's stores, the refusal is recorded as `access.denied_store`
    (`permission: catalog.view`, target the product), otherwise `access.denied_tenant`, as
    in M0. A `store_id` filter naming a store the caller may not work in is refused the same
    way as M0's store check (404, `access.denied_store`).
  - The permission decorator gains a declaration `require("catalog.view",
    store_filtered=True)` for routes whose store scope is applied to the data rather than
    to a path argument; the route-coverage harness then requires a `cross_store` isolation
    case for them, as it already does for `store_param` routes. `catalog.manage` and
    `stock.adjust` are held only by roles with all stores, so they stay not store-scoped
    (like `store.manage` in M0).
- **Rationale**: FR-030, US1 scenario 4, edge cases on unlisted products and deactivated
  stores, Principle I ("tests that attempt cross-store access"). Data-level filtering is
  needed because a product belongs to several stores, so no single store id exists to check.
- **Alternatives considered**: Checking store scope only in the frontend (forbidden).
  Answering 403 for out-of-store products (reveals that the product exists).

## R53. CSV import

- **Decision**: synchronous, no job queue (≤ 2,000 rows, ≤ 2 MB).
  1. `POST /catalog/imports` (multipart `file`): file-level checks first, each answered
     400 with one code before any row is read: over 2 MB `file_too_large`; not valid UTF-8
     (with or without BOM), empty, or not parseable by Python's `csv` module
     `file_not_csv`; more than 2,000 data rows `too_many_rows`; required header missing
     `missing_columns`; any header not in the template (including photo or image columns)
     `unknown_columns`. Header names are matched ignoring ASCII case and surrounding spaces.
  2. Every row is validated (all errors collected, not the first): required fields, lengths,
     SKU and code character rules (R46), product-level consistency, duplicate SKUs within
     the file and against the catalog (archived included), product codes already in the
     catalog, prices (R48), non-negative whole quantities, known **active** store names
     (case-insensitive, separated by `|`), option rules (R47: at most 2 option types, 20
     values, 100 variants, no repeated combination). Arabic-Indic digits in numeric cells are
     normalised to ASCII first; thousands separators in prices are accepted
     (`89,500`). Empty SKUs get suggestions (R46), unique across the file.
  3. Rows of one product share a `product_code`. Product-level columns (names,
     descriptions, stores, option names) may be left empty on later rows of the same
     product (they inherit the first row's); a non-empty value that differs is
     `inconsistent_product`.
  4. An `import_batches` row is stored with status `previewed` (no errors) or `failed`, the
     SHA-256 of the file, counts, the error list and the validated payload (JSON). The
     response is the preview: counts of products, variants and opening units, and every
     error as `{row, column, code}`; row numbers are spreadsheet rows (header = row 1).
     The web app translates the codes.
  5. `POST /catalog/imports/{batchId}/confirm` locks the batch row, refuses a `failed`
     batch (`import_has_errors`) or one older than **24 hours** (`import_expired`), and
     re-validates the payload against the catalog inside one transaction that creates
     everything or nothing: products, options, variants, inventory items, balances, an
     `opening` movement per variant with quantity > 0 (actor the confirming person,
     `import_batch_id` set) and **one** `catalog.imported` history entry. A unique-index
     conflict (someone created the same SKU meanwhile) rolls everything back and answers
     409 `import_conflict` with the new errors. Confirming a committed batch again returns
     its result (no second import). The payload is cleared after commit.
  6. Template: `GET /catalog/imports/template` returns a UTF-8 CSV with BOM (so spreadsheet
     programs open Arabic correctly), the header row and one example product with two
     variants.
  7. Columns: `product_code`*, `name_en`, `name_ar` (at least one name)*, `description_en`,
     `description_ar`, `stores`, `option1_name`, `option1_value`, `option2_name`,
     `option2_value`, `sku`, `price`*, `currency`*, `opening_quantity` (empty = 0),
     `low_stock_level` (empty = business default). No photo columns (FR-029).
  8. Expired batches are deleted by the maintenance step of R50; committed batches are kept
     (movements and products reference them).
- **Rationale**: FR-025–FR-029, SC-005, US5. Validation of 2,000 rows is pure Python plus
  two indexed lookups for SKUs and codes, well under a second; a queue would be speculative
  (Principle V, M0 R9). Storing the validated payload means confirm does not need the file
  again and a weak connection cannot upload a different file between preview and confirm.
- **Alternatives considered**: Celery job with progress polling (no other M1 need for a
  queue). Committing valid rows and skipping bad ones (forbidden by FR-028). Re-uploading
  the file at confirm (doubles mobile data; the hash would still have to be compared).

## R54. History (audit) events added in M1

- **Decision**: new events, in M0's style (data-model.md lists target and data for each):
  `product.created`, `product.updated`, `product.archived`, `product.restored`,
  `product.deleted`, `stock.adjusted`, `stock.allocated`, `stock.released`,
  `stock.consumed`, `catalog.imported`. Variant-level changes made through the product form
  (added, archived, restored, deleted, changed SKU/price/level) are part of
  `product.updated`, so one save is one entry. Refused attempts use M0's
  `access.denied_permission`, `access.denied_tenant` and `access.denied_store`; the low-stock
  default uses M0's `tenant.settings_changed` (R49). The History screen gets a "Catalog and
  stock" filter group and names for the new events in both languages. `audit.view` stays
  owner-only (M0); managers read stock changes in the variant's stock history (FR-017).
- **Rationale**: FR-017, FR-020, FR-028, FR-030, Principle VI.
- **Alternatives considered**: One entry per variant change (a 6-variant product edit would
  flood the History screen). Recording stale-version refusals (they are normal conflicts,
  not access refusals; the person sees them and repeats knowingly).

## R55. Screens

- **Decision**: Catalog lives under More (`/[locale]/more/catalog/...`), shown to everyone
  with `catalog.view`, as in screens 18, 74 and 107. Screens follow `design/bos-screens.html`
  12 (Catalog), 13 (Product and variants) and 14 (Adjust stock). Deliberate changes, to be
  confirmed with the product owner when the new screens are designed:
  - The design's "Reserved" wording is kept on screen (it is what merchants say); the API
    and data model call the same number `allocated`.
  - The Catalog store pills come from the caller's stores; the "Low stock" pill is the
    product filter `stock=low` for everyone (FR-009); the separate **Low stock list**
    (variant rows, out of stock first; FR-024) is a new screen for owners and managers,
    reached from the dashboard row below and from the Catalog app bar.
  - The dashboard's low-stock row (screen 02, "2 items low on stock" with the first names)
    is shown to owners and managers at the top of their start tab, where the home dashboard
    will be; the rest of screen 02 needs orders and arrives later.
  - Screen 13's "Add variant" becomes "Edit product" options editing (variants come from
    option values, R47); screen 14 keeps Add / Remove / Set count, with the reasons of R41
    offered per mode ("Other" asks for a note).
  - New screens need approved designs before they are built, as in M0: product form
    (create and edit, options, variant grid with price and opening quantity, photos, stores),
    variant stock history, Low stock list, CSV import (upload, preview with errors, result),
    and the catalog filter sheet (archived, no photo).
  - All screens: 360 px, Arabic and English, M0 loading/empty/error/offline states, no
    success shown before the server confirms, chips with text.
- **Rationale**: Principle III; FR-031; SC-001 (one form creates a 6-variant product with
  opening stock in under 3 minutes: one price applied to all variants by default, a
  quantity grid, photos uploading while the person types).
- **Alternatives considered**: A Catalog bottom tab (the brief and the approved designs put
  it under More; five tabs are already used).

## R56. Contracts and tests across two features

- **Decision**: `tests/paths.py` lists the contracts of every feature. The permission test
  reads the role tables of both `permissions.md` files; the audit-events test reads the
  "Events:" lists of both data models; the OpenAPI contract test validates each response
  against the file that defines its path (M0's file for M0 paths, this feature's for
  `/catalog/...`). Endpoints M1 changes in place (`/business` gains `low_stock_default`;
  `/audit` target types gain `product`, `variant`, `allocation`, `import_batch`) are
  updated in M0's `openapi.yaml` with a version note and described as a delta in this
  feature's contract. The route-coverage harness gains the `store_filtered` rule of R52.
- **Rationale**: Principle IV: contracts stay the source of truth the code is tested
  against; nothing is copied into a third place.
- **Alternatives considered**: Merging all contracts into one file (loses the per-feature
  history Spec Kit relies on). Copying M0 schemas into the M1 file (two copies drift). This
  feature's `openapi.yaml` repeats only the tiny shared definitions it needs to stand alone
  as a valid document (`Money`, `Currency`, `Error`), marked "same as M0".

## R57. Items carried forward from M0

- **Decision**: done in M1 as small, separate tasks:
  - **F-11**: outside testing, the API refuses to start when `BOS_SECRET_KEY` is shorter
    than 32 characters or starts with `CHANGE_ME`, and when `BOS_MAIL_OUTBOX_DIR` is set
    while the new `BOS_ENVIRONMENT` is not `development`. `BOS_ENVIRONMENT`
    (`development | staging | production`, default `production`, so forgetting it is the
    safe side) is set to `development` by `local_api.py` and the Compose file and documented
    in `.env.example` and the README.
  - **F-15**: the common-password list becomes a data file
    (`backend/app/data/common_passwords.txt`): a published list (for example SecLists'
    100,000 most common passwords, MIT licence) filtered to entries of 10 or more
    characters, lower-cased; source and licence in the file header. Loaded once at start.
  - **`me.stores` staleness**: the web app re-reads `GET /me` on every screen change and
    when the app returns to the foreground (it already re-reads permissions on the server
    for every request); catalog store pills use the fresh list, so a store-access change
    shows on the next screen change (spec edge case).
  - **Development database clean-up**: `backend/scripts/local_api.py
    purge-test-businesses` deletes non-demo businesses created by the end-to-end and
    run-through tests (`E2E Business …` names), with their files, from the development
    database only. It refuses any database but `POSTGRES_DB` on 127.0.0.1, asks for
    `--yes`, runs as the owner role and is the only code that deletes history rows
    (development data only); it prints what it removed.
  - **History filter arrow keys (F12)**: the filter sheet's radio options get roving focus
    (arrow keys move and select, Home/End, one Tab stop), through one shared keyboard helper
    also used by the catalog's stock filter.
  - **T021**: closed in M0's tasks.md as "not built by design: plain SQL through
    SQLAlchemy `text()` throughout", and the `models/` line in M0's plan.md corrected. M1
    adds no ORM models either.
- **Rationale**: listed as "[M1]" in M0's exit gate (`checklists/exit-gate.md`).

## R58. Scale and timing targets

- **Decision**: SC-006 is measured on a business seeded with 5,000 variants (1,000
  products × 5) by a development-only command `flask bos seed-catalog --variants 5000
  --tenant <demo>` (guarded by `BOS_ALLOW_DEMO_SEED`, like `seed-demo`), on the simulated
  mobile profile used for M0 (`checklists/performance.md`). SC-005 is a 500-row file timed
  from upload to preview by an integration test (budget 30 s; expected well under 2 s).
  The demo seed gains a small catalog (about 8 products across both stores, including one
  low and one out of stock) so demos and end-to-end tests have data.
- **Rationale**: SC-005, SC-006, SC-008; the M0 approach to timing claims (measured, output
  captured).
