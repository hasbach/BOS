# Tasks: Native Catalog and Inventory (M1)

**Input**: Design documents from `/specs/002-native-catalog-inventory/`

**Prerequisites**: plan.md, spec.md (incl. clarifications of 2026-11-14 and 2026-11-15), research.md (R38–R58), data-model.md, contracts/openapi.yaml (0.1.0), contracts/permissions.md, quickstart.md

**Tests**: Included. The constitution (Principle IV) requires tests to be written first and seen to fail; Principle I requires cross-tenant and cross-store tests for every route; Principle II requires concurrency tests on real separate connections for stock. The M1 exit gate is "SKU and allocation integrity tests pass".

**Organization**: Tasks are grouped by user story so each story can be built, tested and demonstrated on its own. Task numbers restart at T001 for M1.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: Which user story the task belongs to (US1–US5); Setup, Foundational and Polish tasks carry no story label
- Every task names the file(s) it touches; FR-/SC- numbers refer to spec.md

## Path Conventions

Web application: `backend/` (Flask API, plain SQL through SQLAlchemy `text()`, no ORM models) and `frontend/` (Next.js PWA) at the repository root, as defined in plan.md. Message files are `frontend/messages/en.json` and `frontend/messages/ar.json`. Backend helper scripts are `backend/scripts/local_api.py` and `backend/scripts/local_tests.py`; the database script is `scripts/local_db.py` at the repository root. Phase evidence goes to `specs/002-native-catalog-inventory/checklists/`.

---

## Phase 1: Setup (Carried forward from M0)

**Purpose**: Close the items M0's exit gate assigned to M1 (`specs/001-platform-foundation/checklists/exit-gate.md`, research R57) so M1 starts on a clean base. Each item is one task, with tests first where code changes.

- [X] T001 [P] Write unit tests for F-11 in `backend/tests/unit/test_config_f11.py`: outside testing, building the config refuses a `BOS_SECRET_KEY` shorter than 32 characters or starting with `CHANGE_ME`; refuses a non-empty `BOS_MAIL_OUTBOX_DIR` unless `BOS_ENVIRONMENT=development`; `BOS_ENVIRONMENT` accepts only `development | staging | production` and defaults to `production` when unset; testing mode keeps working with the test secret; error messages never print the secret
- [X] T002 Implement F-11 in `backend/app/config.py` (new `environment` setting, secret-key and outbox checks at start-up); set `BOS_ENVIRONMENT=development` in `backend/scripts/local_api.py` and in the `api` service of `docker-compose.yml`; document it in `.env.example` (default `production`, why forgetting it is the safe side)
- [ ] T003 [P] Extend `backend/tests/unit/test_security.py` for F-15: the common-password list is loaded once from `backend/app/data/common_passwords.txt`; every entry is lower-case and 10+ characters; the file header names its source and licence; several well-known 10+ character passwords are refused, case-insensitively; the M0 entries still refused
- [ ] T004 Implement F-15: add `backend/app/data/common_passwords.txt` (a published list such as SecLists' top 100,000, MIT licence, filtered to entries of 10 or more characters and lower-cased; source and licence in the header; ask the product owner before downloading the source list), load it once in `backend/app/core/security.py` replacing the 18-entry set, and make sure the data file ships with the package (`backend/pyproject.toml`, `backend/Dockerfile`)
- [X] T005 [P] Write component tests for store lists using the refreshed `me.stores` in `frontend/tests/shell/me-refresh.test.tsx`. M0's `useMeRefresh` in `frontend/src/components/SessionGuard.tsx` already re-reads `GET /me` on every screen change and when the window returns to view; do not re-test that. Test only what fails today: after a refresh removes a store from the user, `StoresProvider`'s fallback list (`useStoreChoices` while `GET /stores` has not answered or failed) and a store-pill list fed from the session context no longer show it on the next screen change; a failed refresh keeps the last `me` and shows no error banner
- [X] T006 Make store lists use the refreshed `me.stores`: `frontend/src/components/StoresProvider.tsx` falls back to the current `me` from the session context rather than the list read when the session started, and export the hook the catalog store pills (T053) will use; keep `useMeRefresh` in `frontend/src/components/SessionGuard.tsx` as it is (change `frontend/src/lib/session.ts` only if the hook needs it)
- [X] T007 [P] Write unit tests for `purge-test-businesses` in `backend/tests/unit/test_purge_test_businesses.py`: only non-demo businesses named `E2E Business …` are selected; the command refuses without `--yes`, refuses any database other than `POSTGRES_DB` on `127.0.0.1` (including the test database), and prints what it would remove and what it removed
- [X] T008 Implement `purge-test-businesses` in `backend/scripts/local_api.py` (new subcommand; runs as the owner role; deletes the selected businesses' rows, including their history rows — the only code allowed to — using the owner's `SET LOCAL session_replication_role = replica` approach of `backend/tests/dbsupport.py` `truncate_all`, and their files under `BOS_UPLOAD_DIR/tenant/<id>/`; development database only; prints what it removed)
- [X] T009 [P] Write component tests for History filter arrow keys (M0 exit-gate note "F12") in `frontend/tests/components/roving-radio.test.tsx` (helper: arrow keys move and select, Home/End, wrap-around, one Tab stop, RTL arrow direction) and extend `frontend/tests/account/history.test.tsx` (each radio group of the filter sheet behaves this way)
- [X] T010 Implement the shared roving-focus helper `frontend/src/components/useRovingRadio.ts` and use it for every `role="radiogroup"` in `frontend/src/app/[locale]/(shell)/more/history/HistoryScreen.tsx`
- [X] T011 [P] Write tests for Arabic-Indic digits in `frontend/tests/lib/digits.test.ts` (`٠–٩` and `۰–۹` to ASCII, `٫` to `.`, `٬` removed as a thousands separator, other characters untouched, mixed input) and extend `frontend/tests/stores/settings.test.tsx` (exchange rate and delivery fee typed as `٨٩٬٥٠٠` and `٢٫٥` are accepted and sent as ASCII decimal strings; the hint no longer says "Digits 0–9 only")
- [X] T012 Implement `frontend/src/lib/digits.ts` and apply it in `frontend/src/app/[locale]/(shell)/more/settings/SettingsForm.tsx` before `parseMoney`; `frontend/src/lib/money.ts` keeps its ASCII-only rule (the API still accepts ASCII only, R48) and its comment is updated to say callers normalise first; change `rateHint` and the fee hint in `frontend/messages/en.json` and `frontend/messages/ar.json` to accept both digit sets
- [X] T013 [P] Close M0 task T021 in `specs/001-platform-foundation/tasks.md` as "not built by design: plain SQL through SQLAlchemy `text()` throughout" and correct the `models/` line in the Project Structure of `specs/001-platform-foundation/plan.md`; remove the empty `backend/app/models/` package only if nothing imports it (check with a search first)

**Checkpoint**: All M0 suites still pass; the seven carried-forward items are closed with tests.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, isolation, permissions, contract wiring, integrity checking, lock-error handling and photo storage that every story depends on; the screen designs that every new screen waits for.

**⚠️ CRITICAL**: No user story work starts until this phase is complete. No task that builds or changes a screen starts until T035 is approved by the product owner.

### Tests first (write, run, confirm they fail)

- [X] T014 [P] Write migration and schema tests in `backend/tests/integration/test_migration_0003.py`: starting at `0002` with M0 data (two tenants), `upgrade 0003` gives each tenant exactly one default warehouse named `Main` and `low_stock_default = 2`; `pg_trgm` exists; all thirteen tables exist with RLS enabled and forced; each CHECK, unique index and partial unique index of data-model.md rejects a bad row (one assertion per rule, incl. SKU and code keys differing only in case and surrounding spaces, an archived variant's SKU still reserved, one active variant per option combination with `NULLS NOT DISTINCT`, LBP price with decimals, a second warehouse, `on_hand < allocated` failing `stock_balances_not_oversold`, `on_hand > 1000000` failing `stock_balances_on_hand_range`, each movement reason's sign rule, and `stock_movements_source`: `allocation` only with `allocation_consumed`, `import` exactly with `import_batch_id` and reason `opening`, `product_form` only with `opening`, a `manual` `opening` accepted); `downgrade 0002` drops the tables, deletes `product_photo` file rows, restores M0's `files` CHECKs and drops `low_stock_default`; `upgrade head` again succeeds
- [X] T015 [P] Extend `backend/tests/isolation/test_rls.py` to the thirteen new tables (`warehouses`, `import_batches`, `products`, `product_stores`, `product_options`, `option_values`, `product_photos`, `inventory_items`, `variants`, `stock_balances`, `allocations`, `allocation_lines`, `stock_movements`): with tenant A set, rows of tenant B are invisible and cannot be inserted, updated or deleted; with no tenant, zero rows; `UPDATE` and `DELETE` on `stock_movements` are refused for the application role and the owner role; composite FKs refuse a variant pointing at another tenant's inventory item and a variant `photo_id` of another product
- [X] T016 [P] Extend `backend/tests/unit/test_permissions.py`: every cell of the M1 permissions table in `specs/002-native-catalog-inventory/contracts/permissions.md`, whose rows override the same permissions' rows in M0's "Reserved for later milestones" table; `STORE_SCOPED` equals the union of the store-scoped rows of M0's enforced table and M1's table (`test_store_scoped_permissions_match_the_contract` updated accordingly); `catalog.view` is store-scoped and `catalog.manage`, `stock.adjust` are not; `require("catalog.view", store_filtered=True)` is accepted; `store_filtered=True` with a permission that is not store-scoped raises; `store.view` keeps its `store_param` behaviour
- [X] T017 [P] Extend `backend/tests/isolation/test_route_coverage.py`: a route declared `store_filtered=True` without a registered `cross_store` case is reported missing (synthetic app), exactly as for `store_param` routes today
- [X] T018 [P] Extend `backend/tests/integration/test_health_and_errors.py`: a request whose database work raises SQLSTATE `55P03` (lock timeout) or `40P01` (deadlock), in the handler or at commit, answers 503 `try_again` with `Retry-After: 1` in M0's error envelope, its transaction is rolled back (nothing applied, `on_rollback` callbacks run) and no stack trace is returned
- [X] T019 [P] Write unit tests for the generalised photo pipeline in `backend/tests/unit/test_photo_prepare.py`: `prepare_product_photo` accepts PNG, JPEG and WebP decided by the decoded format (never extension or MIME type); refuses over 5 MB (`file_too_large`) and over 40 megapixels from the header alone; refuses non-images and disguised files (`file_not_image`); applies EXIF orientation; output carries no metadata; returns two WebP images fitting 320×320 and 1080×1080 at quality 80 plus the large image's width and height; `prepare_logo` keeps its 2 MB / 512 px behaviour (`backend/tests/integration/test_store_logo.py` stays green)
- [X] T020 [P] Write integrity-report tests in `backend/tests/integration/test_integrity.py`: a consistent business gives an empty report; breaking each rule of data-model.md "Integrity rules" with owner-role SQL (variant without balance, balance `on_hand` ≠ Σ movements, `on_hand` ≠ latest `on_hand_after`, `allocated` ≠ Σ active allocation lines, missing default warehouse) is reported with the item and the expected and actual numbers (FR-022)
- [X] T021 [P] Extend `backend/tests/integration/test_ops.py` (an operator-created business gets exactly one default warehouse in the same transaction) and `backend/tests/integration/test_cli.py` (`seed-demo` gives both demo tenants one default warehouse and is still safe to run twice) (FR-011)

### Implementation

- [X] T022 Write migration `backend/migrations/versions/0003_catalog_inventory.py` (`down_revision = "0002"`, plain SQL like 0001/0002) exactly as data-model.md "Migration 0003": `CREATE EXTENSION IF NOT EXISTS pg_trgm`; `tenants.low_stock_default integer NOT NULL DEFAULT 2 CHECK (low_stock_default BETWEEN 0 AND 1000000)`; `files` CHECKs become `kind IN ('store_logo', 'product_photo')` and `size_bytes > 0 AND <= 5242880`; the thirteen tables in dependency order with `UNIQUE (tenant_id, id)` and composite FKs, quoting these rules: `warehouses.name` 1–80, `CHECK (is_default)`, unique `(tenant_id) WHERE is_default`; `products.code` 1–32 `^[A-Za-z0-9][A-Za-z0-9._/-]*$`, `code_key GENERATED ALWAYS AS (lower(btrim(code))) STORED` unique `(tenant_id, code_key)` (archived included), names 1–120 with `CHECK (name_en IS NOT NULL OR name_ar IS NOT NULL)`, descriptions ≤ 2,000, `status` `active`/`archived`, `version` integer starting at 1, index `(tenant_id, created_at DESC, id DESC)`, GIN `gin_trgm_ops` on `lower(name_en)`, `name_ar` and `code_key`; `product_stores` PK `(product_id, store_id)`, index `(tenant_id, store_id)`; `product_options.position` 1 or 2 unique `(product_id, position)`, `name` 1–40, unique `(tenant_id, product_id, id)`; `option_values.position` 1–20, `label` 1–40, `status` `active`/`archived`, unique `(option_id, lower(label)) WHERE status = 'active'`, unique `(tenant_id, product_id, id)`, FK `(tenant_id, product_id, option_id)`; `product_photos.position` 0–7 null exactly when `product_id` is null, unique `(product_id, position) DEFERRABLE INITIALLY DEFERRED`, unique `(tenant_id, product_id, id)`, `staged_expires_at`; `variants.inventory_item_id` NOT NULL UNIQUE, `sku` 1–64 `^[A-Za-z0-9][A-Za-z0-9._/-]*$`, `sku_key GENERATED ALWAYS AS (lower(btrim(sku))) STORED` unique `(tenant_id, sku_key)` (archived included), `CHECK (option2_value_id IS NULL OR option1_value_id IS NOT NULL)`, `price numeric(14,2)` 0 – 99,999,999,999.99, `currency` `USD`/`LBP` with `CHECK (currency = 'USD' OR price = trunc(price))`, `low_stock_level` 0–1,000,000 nullable, `photo_id` FK `(tenant_id, product_id, photo_id)` → `product_photos (tenant_id, product_id, id)`, unique `(product_id, option1_value_id, option2_value_id) NULLS NOT DISTINCT WHERE status = 'active'`, index `(tenant_id, product_id)`, GIN `gin_trgm_ops` on `sku_key`; `stock_balances` PK `(warehouse_id, inventory_item_id)`, unique `(tenant_id, warehouse_id, inventory_item_id)`, named CHECKs `stock_balances_not_oversold CHECK (allocated >= 0 AND on_hand >= allocated)` and `stock_balances_on_hand_range CHECK (on_hand BETWEEN 0 AND 1000000)`, `version bigint` starting at 1; `stock_movements` `seq GENERATED ALWAYS AS IDENTITY`, reasons `opening`, `received`, `found`, `damaged`, `lost`, `count_correction`, `other`, `allocation_consumed` with the sign CHECKs (`opening`, `received`, `found` → `quantity > 0`; `damaged`, `lost`, `allocation_consumed` → `quantity < 0`; `other` → `quantity <> 0` and note present; `count_correction` → `counted_quantity IS NOT NULL`; `counted_quantity` null for every other reason; `allocation_id IS NOT NULL` exactly when the reason is `allocation_consumed`; `|quantity| <= 1000000`; `on_hand_after` 0–1,000,000 named `stock_movements_on_hand_after_range`; `note` ≤ 500; `actor_type` `user`/`system`), `source` `manual`/`product_form`/`import`/`allocation` with the named CHECK `stock_movements_source` of data-model.md, no `ON DELETE` on its item FK, index `(tenant_id, inventory_item_id, seq DESC)`, trigger `stock_movements_no_change` (`BEFORE UPDATE OR DELETE`, function `stock_movements_are_append_only()`) raising for every role; `allocations.request_key` 1–200 unique `(tenant_id, request_key)`, `request_hash bytea`, `status` `active`/`released`/`consumed` with `released_at` / `consumed_at` set exactly in those states; `allocation_lines.quantity` 1–1,000,000, unique `(allocation_id, inventory_item_id)`, index `(tenant_id, inventory_item_id)`, no `ON DELETE` on its item FK; `import_batches.status` `previewed`/`failed`/`committed`, `file_name` ≤ 255, `row_count` 0–2,000, `errors jsonb`, `payload jsonb` nullable, `expires_at`; RLS enabled and forced with `tenant_isolation` on all thirteen; grants per table as listed in data-model.md for `BOS_APP_DB_USER` (plus `USAGE` on the identity sequence only if T014 shows it is needed); backfill one `Main` default warehouse per existing tenant; written `downgrade()` in reverse order that leaves `pg_trgm` installed (FR-004, FR-005, FR-006, FR-011, FR-012, FR-018)
- [X] T023 Update test helpers in `backend/tests/dbsupport.py` and `backend/tests/conftest.py`: `ALL_TABLES` / `truncate_all` include the new tables; `World` creates each tenant's default warehouse; direct-SQL catalog fixtures that do not depend on the US1 service (insert a product with N variants, inventory items, balances and opening movements; insert an active allocation with lines; read a balance) so US2 and US3 tests can run before US1's service exists
- [X] T024 Create the default warehouse in `backend/app/services/onboarding.py` (`create_business`, inside the tenant context it already enters, R39) and in `backend/app/services/seed.py` for both demo tenants (safe to run twice) (FR-011)
- [X] T025 Make `catalog.view` store-scoped in `backend/app/core/permissions.py` (`STORE_SCOPED` becomes `{"store.view", "catalog.view"}`; `require(permission, store_param=None, store_filtered=False)`; `Policy.store_filtered`; refuse `store_filtered` for permissions not in `STORE_SCOPED`), and add `not_found_in_scope(target_type, target_id, permission)` to `backend/app/core/request_context.py` (404 `not_found`, `access.denied_store` recorded with the permission and target, identical body to a missing record) (FR-030, R52)
- [X] T026 Add the `store_filtered` rule to `backend/tests/isolation/coverage.py`: a route declared `store_filtered=True` requires `cross_tenant`, `missing_permission` and `cross_store` cases (R52, R56)
- [X] T027 Wire the backend contract tests to both features (R56): `backend/tests/paths.py` lists the feature folders (`001-platform-foundation`, `002-native-catalog-inventory`) and a helper that returns the OpenAPI file defining a request path; `backend/tests/contract/support.py` validates each response against that file and fails for a registered route found in neither; `backend/tests/unit/test_permissions.py` reads the role tables of both `permissions.md` files; its rows of M1's table override the same permissions' rows of M0's reserved table and `STORE_SCOPED` is compared with the union of both files' store-scoped rows (contracts/permissions.md); the events check in `backend/tests/integration/test_tenancy_and_audit.py` reads each data model's "Events:" section up to the next `##` heading (it currently stops at `## State transitions`, which in M1's data-model.md comes before the events) and compares the union with `EVENTS`
- [X] T028 [P] Wire the frontend contract tests to both features and add every M1 name they require, so `npm test` passes at T036 and at each story checkpoint: `frontend/tests/errors.test.ts` runs the unchanged `codesIn()` over both `openapi.yaml` files and asserts that M1's file yields exactly the error codes `validation_failed`, `forbidden`, `not_found`, `product_code_in_use`, `sku_in_use`, `idempotency_conflict`, `product_changed`, `product_archived`, `options_locked`, `variant_has_allocations`, `combination_in_use`, `value_in_use`, `has_history`, `file_too_large`, `file_not_image`, `stock_changed`, `not_enough_stock`, `try_again`, `file_not_csv`, `too_many_rows`, `missing_columns`, `unknown_columns`, `import_has_errors`, `import_conflict`, `import_expired` and the field codes `required`, `invalid`, `too_long`, `too_large`, `too_many`, `duplicate`, `not_whole`, `in_use`; `frontend/tests/lib/devices-audit.test.ts` reads the events of both data models (today both read M0 only); in the same task add `en` and `ar` texts for all those codes and every `ImportError` code to `frontend/messages/en.json` and `frontend/messages/ar.json` and to `ERROR_CODES` / `FIELD_ERROR_CODES` in `frontend/src/lib/errors.ts`, and names, icons and the "Catalog and stock" group for all ten M1 events (`product.*`, `stock.*`, `catalog.imported`) to both message files and `frontend/src/lib/audit.ts`; later story tasks only use these
- [X] T029 [P] Apply the M0 contract delta in `specs/001-platform-foundation/contracts/openapi.yaml` with a version note: `GET/PATCH /business` gain `low_stock_default` (integer 0–1000000, default 2, `settings.manage` to change); `GET /audit` `target_type` adds `product`, `variant`, `allocation`, `import_batch` with their `target_name` rules
- [X] T030 Map lock timeouts and deadlocks in `backend/app/errors.py` and the commit path of `backend/app/core/request_context.py`: SQLSTATE `55P03` / `40P01` anywhere in a request → 503 `try_again`, `Retry-After: 1`, request transaction rolled back, `on_rollback` callbacks run; M0's `lock_timeout=10000` in `backend/app/core/db.py` unchanged (R42)
- [X] T031 Generalise the upload pipeline in `backend/app/core/storage.py` and its caller `backend/app/api/stores.py` (which imports `MAX_UPLOAD_BYTES` and reads the logo upload with it): replace the module-wide `MAX_UPLOAD_BYTES = 2 * 1024 * 1024` with per-kind limits and update the logo route to the store-logo limit (store logo 2 MB, product photo 5 MB, both 40 megapixels), share one decode / orientation / metadata-stripping path, add `prepare_product_photo(data)` returning thumbnail (fit 320×320) and large (fit 1080×1080) WebP at quality 80 with the large size's width and height; `prepare_logo` behaviour unchanged (FR-010, R50)
- [X] T032 Register M1 history events in `backend/app/core/audit.py` (`product.created`, `product.updated`, `product.archived`, `product.restored`, `product.deleted`, `stock.adjusted`, `stock.allocated`, `stock.released`, `stock.consumed`, `catalog.imported`) and the new target types in `backend/app/api/audit.py` (`target_name`: product English name else Arabic, variant SKU, allocation request key, import file name), so every story can record its events (FR-017, FR-020, FR-028, R54)
- [X] T033 Implement the inventory core in `backend/app/services/inventory.py`: `default_warehouse_id(db)` (fails closed: 500, logged, when missing), `lock_balances(db, item_ids)` (`SELECT … FOR UPDATE` in ascending `inventory_item_id`, R42) and `integrity_report(db)` (the six rules of data-model.md, one business); add the fixture `integrity_check` in `backend/tests/conftest.py` that runs the report for every business after a test and fails on any difference, enabled with `pytestmark = pytest.mark.usefixtures("integrity_check")` in every catalog, stock, allocation and import test module (FR-013, FR-018, FR-022, SC-003)
- [X] T034 Extend `purge-test-businesses` in `backend/scripts/local_api.py` to the new tables and to product photo files, with a case added to `backend/tests/unit/test_purge_test_businesses.py`
- [ ] T035 Design the new M1 screens in `design/bos-screens.html` (new section "M1 additions"), in English and Arabic at 360 px with M0's loading, empty, error and offline states: product form for create and edit (options and values, variant grid with SKU, one price applied to all by default, currency with "≈" approximate amount, opening quantity on create, photos with per-photo upload state and retry, stores), variant stock history, Low stock list, CSV import (upload, preview with row errors and counts, result), catalog filter sheet (stock, archived, no photo), and the placement of the low-stock row on the owner's and manager's start tab; confirm with the product owner the deliberate changes to screens 12–14 recorded in research R55 ("Reserved" wording on screen, Low stock list as its own screen, "Add variant" folded into options editing, the dashboard low-stock row). **Present to the product owner for approval. Every task that builds or changes a screen (T053, T054, T055, T056, T067, T068, T069, T085, T086, T087, T101) waits for this approval.** After approval, record the approved deviations from screens 02, 12–14 (R55) and the start-tab low-stock row for owners and managers as a dated entry under "Clarifications" in `specs/002-native-catalog-inventory/spec.md` (constitution Principle III: a spec records each deliberate change) (FR-031, SC-001)
- [X] T036 Run T014–T021 and all existing suites (`uv run python scripts/local_tests.py` from `backend/`, `npm test` from `frontend/`); confirm they pass; record output in `specs/002-native-catalog-inventory/checklists/phase2.md`

**Checkpoint (approval point)**: Migration 0003 applies and rolls back; the database alone refuses cross-tenant rows, negative availability, duplicate SKUs and ledger edits; contract, permission and events tests read both features; the integrity fixture is ready; designs presented.

---

## Phase 3: User Story 1 - Build the catalog on the phone (Priority: P1) 🎯 MVP

**Goal**: Owners and managers create, edit, archive, restore and delete products with photos, options, variants, prices, stores and opening stock; everyone searches and browses the catalog of the stores they may see.

**Independent Test**: The owner of a fresh business creates a jeans product with sizes 30/32/34 and colours blue/black, two photos, a USD price and opening quantities, listed in Store A only; a Store A sales agent finds it by part of the name or code and sees six variants with available quantities; a Store B agent does not; a packing agent has no edit controls and direct edit requests are refused and recorded (quickstart scenario 1).

### Tests for User Story 1 (write first, confirm they fail)

- [ ] T037 [P] [US1] Write unit tests for SKU and code rules in `backend/tests/unit/test_skus.py`: code 1–32 and SKU 1–64 characters, `^[A-Za-z0-9][A-Za-z0-9._/-]*$`, trimming, key = lower-case of the trimmed value; suggestion `JN-SLIM` + `32` + `Blue` → `JN-SLIM-32-BLUE`; spaces inside values become `-`; characters outside the set dropped; an Arabic value contributes its 1-based position; cut to 64; `-2`, `-3` appended (base shortened to fit) when taken in the business or earlier in the same request (FR-005, SC-004)
- [ ] T038 [P] [US1] Write integration tests for products in `backend/tests/integration/test_catalog_products.py`: create with two options (3 × 2) gives six variants, six inventory items, six balances and one `opening` movement per quantity above 0 (none for 0), one `product.created` with `opening_units`; no options gives exactly one variant (FR-003); every validation field code of the contract (`code`, names, descriptions, `store_ids`, `photo_ids`, `options` ≤ 2, values ≤ 20 and `duplicate` ignoring ASCII case, `variants` `invalid` when combinations do not match exactly, `too_many` over 100, `variants.N.sku`, `price` `not_whole` / `too_large`, `currency`, `low_stock_level`, `opening_quantity`); SKU uniqueness by case, surrounding spaces, archived variants and products, and allowed in another business, each 409 `sku_in_use` with `conflicts` naming the product (SC-004); `product_code_in_use`; `store_ids` with an inactive store refused `store_ids: invalid` on create and when newly added on update, while a listing in a store deactivated after it was listed is kept when the product is saved again (data-model.md `product_stores`); price stored exactly with its currency and unchanged after `PATCH /business` changes the rate (FR-006); repeat create with the same `Idempotency-Key` creates nothing new; two `POST /catalog/products` with the same `Idempotency-Key` sent at once (one connection per thread from the application engine, aligned on a `threading.Barrier`) → one product and one set of `opening` movements, both answers the same product (constitution Principle IV, SC-002); edit with a stale `version` → 409 `product_changed` with `current` (FR-008); renaming options, values, SKU and price keeps every `inventory_item_id` (FR-004); adding a value creates zero-stock variants; removing a value archives variants with history and deletes those without; `options_locked`; `combination_in_use` on restore; `value_in_use` when restoring a variant whose archived option value's label (ASCII case ignored) is now used by an active value of the same option, with nothing written; opening movements carry `source = 'product_form'`; `variant_has_allocations` when archiving a variant or product with `allocated > 0` (allocation inserted by the T023 fixture); `product_archived` on editing an archived product; archive and restore are idempotent and recorded; delete refused with `has_history`, allowed without history and removes items and balances; one `product.updated` per save with the variant lists of data-model.md (FR-001–FR-008)
- [ ] T039 [P] [US1] Write integration tests for photos in `backend/tests/integration/test_catalog_photos.py`: staged upload returns an id; over 5 MB, over 40 megapixels and non-images refused with the contract codes; attach up to 8 in display order, a 9th refused `too_many`; a variant `photo_id` of another product refused; staged photos readable only by `catalog.manage`; `GET /catalog/photos/{id}/{thumb|large}` sends `Cache-Control: private, no-cache` and an `ETag`, and `If-None-Match` answers 304; a failed save deletes the files it wrote (`on_rollback`); removing a photo deletes its files after commit (`on_commit`); file paths cannot be influenced by the client (FR-010)
- [ ] T040 [P] [US1] Write integration tests for search in `backend/tests/integration/test_catalog_search.py`: `q` (1–100 characters) matches English and Arabic names, product code and any SKU, partially and ignoring ASCII case; `%`, `_` and `\` in `q` are literal; `store_id` filter (another store → 404 + `access.denied_store`); `stock=in_stock|low|out` product-level filters (R49); `status=archived` and `no_photo=true` need `catalog.manage` (403 + `access.denied_permission` otherwise); 20 per page newest first with a stable keyset `next_cursor` while products are added; `counts` (`all`, `in_stock`, `low`, `out`) on the first page only; staff see only active products listed in at least one active store they may work in, so an unlisted product, a product of an inactive store and an archived product are invisible to them but visible to owners and managers, and a product of a store that is reactivated is visible to that store's staff again; `ProductSummary` prices give min and max per currency (FR-009, FR-029, FR-030)
- [ ] T041 [P] [US1] Write tests for the staged-photo purge in `backend/tests/integration/test_maintenance_catalog.py`: `flask bos maintenance` deletes staged photos older than 24 hours and their files (files only after the tenant's transaction commits), runs per tenant in that tenant's own transaction, never touches attached photos, and records what it purged
- [ ] T042 [P] [US1] Write isolation cases for every US1 route in `backend/tests/isolation/test_m1_routes.py` (`GET/POST /catalog/products`, `GET/PUT/DELETE /catalog/products/{id}`, `/archive`, `/restore`, `POST /catalog/photos`, `GET /catalog/photos/{id}/{size}`): cross-tenant answers 404 identical to a made-up id with `access.denied_tenant`; sales, packing and dispatch refused on every manage route with `access.denied_permission`; `missing_permission` for every `catalog.view` route (`GET /catalog/products`, `GET /catalog/products/{id}`, `GET /catalog/photos/{id}/{size}`), removing `catalog.view` from a role with `monkeypatch` as M0's `test_view_routes_enforce_the_permission_they_declare` does in `backend/tests/isolation/test_us3_routes.py`, answered 403 with `access.denied_permission`, as the `store_filtered` rule of T026 requires; cross-store for every `catalog.view` route (a Store B agent asking for a Store A product or its photo gets 404 with `access.denied_store`) (FR-030, SC-007)
- [ ] T043 [P] [US1] Write frontend tests in `frontend/tests/catalog/catalog-list.test.tsx` (search, store pills from the fresh `me.stores`, stock filter radios using `useRovingRadio`, archived and no-photo filters only for `catalog.manage`, load more, empty and error states), `frontend/tests/catalog/product-detail.test.tsx` (variants with on hand / reserved / available, "Low" and "Out" chips with text, no edit or adjust controls without permission, an LBP price of 89500000 shown with thousands separators in `en` and `ar`) and `frontend/tests/catalog/product-form.test.tsx` (field errors from the server next to their field incl. dotted paths, Arabic-Indic digits in price and quantities, one price applied to all variants, variant grid follows option values, SKU left empty is allowed, photo upload failure keeps the form and offers retry, a refused photo blocks saving, `product_changed` shows the current version, nothing shown as saved before the server confirms), extend `frontend/tests/lib/money.test.ts` (approximate conversion USD → LBP whole pounds, LBP → USD cents, labelled approximate; large LBP amounts such as 89,500,000 formatted with thousands separators in both languages) and extend `frontend/tests/shell/more-menu.test.tsx` (the Catalog entry is shown to every `catalog.view` holder and links to the catalog) (FR-006, FR-031)
- [ ] T044 [P] [US1] Write Playwright scenario `frontend/e2e/m1-catalog.spec.ts` (`en` and `ar`, 360 px): owner creates `JN-TEST` with sizes 30/32/34 and colours Blue/Black, quantities typed with `٥`, photos, Store A only; Store A agent finds it by `test`, `jn-te` and `32-BLU`; Store B agent does not, and its address shows "not found"; packing agent sees no edit controls; archive hides it from the Store A agent; no horizontal scroll on any catalog screen

### Implementation for User Story 1

- [ ] T045 [P] [US1] Implement SKU and code rules and suggestions in `backend/app/services/skus.py` (R46)
- [ ] T046 [US1] Implement the catalog service in `backend/app/services/catalog.py`: `visible_products(access)` as one SQL predicate used by every catalog query (R52); create (product, options, values, variants with SKUs suggested by `skus.py`, one inventory item and one balance per variant, `opening` movements with `on_hand_after` and `source = 'product_form'` through a `create_item(...)` helper added to `backend/app/services/inventory.py`, which takes the source so import can pass `import`); `store_ids` limited to active stores of the business, except stores the product is already listed in, whose listings are kept; read with stock numbers, `stock_state`, `has_history`; update by `id` reconciliation under the product row lock with `version` check, then balance locks in ascending order when variants are archived or deleted (R42, R47); variant restore refused with `combination_in_use` or `value_in_use` before anything is written (R47); archive (refused while any variant has `allocated > 0`), restore, delete (only without history); unique-index violations on `sku_key` / `code_key` become 409 with field errors; one `product.created` / `product.updated` / `product.archived` / `product.restored` / `product.deleted` entry per operation (FR-001–FR-008, FR-011, FR-012)
- [ ] T047 [P] [US1] Implement photos in `backend/app/services/photos.py`: staging with two `files` rows (kind `product_photo`) per photo and `staged_expires_at` = 24 hours, attaching and ordering under the product row lock (≤ 8), removal with `on_commit` file deletion, `on_rollback` deletion of files written by a failed request (R50)
- [ ] T048 [US1] Implement search in `backend/app/services/catalog_search.py`: escaped `ILIKE` on `name_en`, `name_ar`, `code_key` and any `sku_key`; `store_id`, `stock`, `status` and `no_photo` filters; keyset cursor over `(created_at DESC, id DESC)`, 20 per page; first-page `counts`; per-product prices min/max per currency and `available_total` (FR-009, FR-029)
- [ ] T049 [US1] Implement the catalog API in `backend/app/api/catalog.py` and register it in `backend/app/api/__init__.py`: `GET/POST /catalog/products` (POST idempotent), `GET/PUT/DELETE /catalog/products/{productId}`, `POST /catalog/products/{productId}/archive`, `POST /catalog/products/{productId}/restore`, request-shape validation with the contract's field codes, `require("catalog.view", store_filtered=True)` on reads and `require("catalog.manage")` on writes; `status=archived` / `no_photo` checked inside the search view (a view has exactly one policy) and refused with `request_context.refuse()` (403 `forbidden`, `access.denied_permission` with `catalog.manage`) without the permission; out-of-scope records via `not_found_in_scope()`; register each route's isolation cases (T042) in the same change; raise `MAX_CONTENT_LENGTH` in `backend/app/__init__.py` (3 MB today) so a 5 MB photo plus form overhead reaches the route, and test a 5 MB photo end to end
- [ ] T050 [US1] Implement the photo API in `backend/app/api/catalog_photos.py` and register it: `POST /catalog/photos` (`catalog.manage`, multipart, M0 upload size guard raised to 5 MB for this route only) and `GET /catalog/photos/{photoId}/{size}` (`catalog.view`, store-filtered like its product; staged only for `catalog.manage`; `ETag`, 304, `Cache-Control: private, no-cache`) (FR-010)
- [ ] T051 [US1] Implement `backend/app/services/maintenance.py` (per-tenant step: list tenant ids in one transaction in operator context with `app.core.tenancy.enter_operator` (policy `operator_reads_tenants` on `tenants`), then each tenant in its own `app.core.tenancy.tenant_transaction(engine, tenant_id)`, not `enter_tenant_from_operator` (R24, R50); deleting expired staged photos and then their files) and call it from `flask bos maintenance` in `backend/app/cli.py`, adding the counts to `maintenance.run`
- [ ] T052 [P] [US1] Frontend catalog plumbing: API calls and types in `frontend/src/lib/catalog.ts`; `approximate(price, currency, rate)` in `frontend/src/lib/money.ts`; catalog screen strings in `frontend/messages/en.json` and `frontend/messages/ar.json` (error codes, field codes and event names already added by T028 are used, not added again); the "Catalog and stock" group (added to `frontend/src/lib/audit.ts` by T028) offered in the History filter of `frontend/src/app/[locale]/(shell)/more/history/HistoryScreen.tsx`
- [ ] T053 [US1] Add the Catalog entry for `catalog.view` holders to `frontend/src/app/[locale]/(shell)/more/MoreMenu.tsx` and build screen 12 in `frontend/src/app/[locale]/(shell)/more/catalog/page.tsx`, `CatalogList.tsx`, `parts.tsx` and `catalog.module.css`: search field (Arabic-Indic digits converted by `lib/digits.ts`), store pills from the fresh `me.stores`, stock pills with counts, filter sheet (stock with `useRovingRadio`; archived and no photo for `catalog.manage`), thumbnails, chips with text, load more, M0 states (needs T035 approval)
- [ ] T054 [US1] Build screen 13 in `frontend/src/app/[locale]/(shell)/more/catalog/[productId]/page.tsx` and `ProductDetail.tsx`: photos (large size), variants with option values, SKU, price with "≈" approximate amount in the other currency, on hand / "Reserved" / available, "Low" / "Out" chips; Edit, Archive, Restore and Delete (only when `has_history` is false) for `catalog.manage` holders only (needs T035 approval)
- [ ] T055 [P] [US1] Build `frontend/src/components/PhotoPicker.tsx`: uploads each photo as soon as it is picked through `apiUpload`, per-photo progress, retry and remove, client-side type and 5 MB pre-check, reordering, shows refusals as field errors (needs T035 approval)
- [ ] T056 [US1] Build the product form in `frontend/src/app/[locale]/(shell)/more/catalog/new/page.tsx`, `ProductForm.tsx`, `validation.ts` and `[productId]/edit/page.tsx`: code, names, descriptions, up to 2 options with values, variant grid generated from values (SKU, price with currency, low-stock level, photo, opening quantity on create only, archive/restore per variant on edit), one price for all by default, stores, photos via `PhotoPicker`; Arabic-Indic digits accepted in number fields; sends `version` on edit and shows the current product on `product_changed`; creates one `Idempotency-Key` when the form opens and reuses it for every save of that form (R44); success only after the server confirms (FR-002–FR-008, SC-001) (needs T035 approval)
- [ ] T057 [US1] Run T037–T044 with the route-coverage and contract tests (`uv run python scripts/local_tests.py` from `backend/`; `npm test` and `npm run e2e` from `frontend/`); confirm all pass with the integrity fixture active; record output in `specs/002-native-catalog-inventory/checklists/us1.md`

**Checkpoint (approval point)**: The catalog works end to end on a phone in both languages; SKU tests (SC-004 part 1) and US1 isolation cases pass. Demonstrate quickstart scenario 1.

---

## Phase 4: User Story 2 - Trustworthy stock with a ledger and adjustments (Priority: P2)

**Goal**: Owners and managers record stock changes with a reason; every change is an immutable movement; on hand always equals the sum of movements; each variant's stock history is readable by owners and managers.

**Independent Test**: From opening quantity 10, a manager records received +5, damaged −1 and a count correction to 12; on hand shows 12, the history shows four movements summing to 12 with reasons and names, each change appears in History; a packing agent's direct request is refused and recorded (quickstart scenario 2).

### Tests for User Story 2 (write first, confirm they fail)

- [ ] T058 [P] [US2] Write integration tests for adjustments in `backend/tests/integration/test_stock_adjustments.py`: each reason with its sign (`opening`, `received`, `found` increase; `damaged`, `lost` decrease; `other` needs `direction` `in` / `out`, which sets the sign, and `note`, with `direction: required` / `invalid` otherwise; `direction` ignored for every other reason; `count_correction` records the difference, 0 allowed, with `counted_quantity`); a manual `opening` is recorded with `source = 'manual'`; quantity 1–1,000,000 JSON integers only (strings, decimals, booleans refused); a stale `balance_version` → 409 `stock_changed` with the current `balance`, nothing recorded (FR-015, US2 scenario 2); below zero or below allocated → 409 `not_enough_stock` with `balance` (allocation from the T023 fixture); on hand above 1,000,000 → `quantity: too_large`; with the service's own limit checks bypassed, a violation of `stock_balances_not_oversold` answers `not_enough_stock` and of `stock_balances_on_hand_range` answers `quantity: too_large`, never 500; the same `Idempotency-Key` twice → one movement and the replay returns the first movement with the balance as it is now; same key with another body → `idempotency_conflict` (FR-016); allowed on archived variants; `stock.adjusted` with `sku`, `reason`, signed `quantity`, `counted_quantity`, `on_hand_before`, `on_hand_after`, `note`; balance `version` +1 per change; earlier movements never change (FR-012–FR-017)
- [ ] T059 [P] [US2] Write integration tests for stock history in `backend/tests/integration/test_stock_movements.py`: newest first, 50 per page with cursor; each movement has reason, signed quantity, counted quantity, `on_hand_after`, actor type, the actor's current name (null for system), note and `source` (`manual`, `product_form`, `import`, `allocation`) read from the stored `stock_movements.source`, so a manual `opening` shows `manual` and product-form opening stock shows `product_form`; movements sum to on hand; a manager (who has no `audit.view`) can read it through `stock.adjust`, which is how managers see stock history (FR-017)
- [ ] T060 [P] [US2] Write concurrency tests in `backend/tests/integration/test_stock_concurrency.py` using one connection per thread from the application engine, aligned with `threading.Barrier`: two adjustments with the same `balance_version` → exactly one recorded, the other `stock_changed`; N parallel decrements of 1 on N units → never negative, on hand ends at 0, no lost update; the same `Idempotency-Key` sent by several threads at once → one movement; a lock held longer than the lock timeout answers 503 `try_again` and records nothing (FR-021, SC-002)
- [ ] T061 [P] [US2] Add isolation cases for `POST /catalog/variants/{id}/adjustments` and `GET /catalog/variants/{id}/movements` to `backend/tests/isolation/test_m1_routes.py`: cross-tenant 404 + `access.denied_tenant`; sales, packing and dispatch refused with `access.denied_permission` (FR-014, SC-007)
- [ ] T062 [P] [US2] Write frontend tests in `frontend/tests/catalog/adjust-stock.test.tsx` (Add / Remove / Set count modes with the reasons of R41 per mode, "Other" asks for a note and is sent with `direction` `in` under Add and `out` under Remove, `Stepper` with Arabic-Indic digits, live preview of on hand and available, one `Idempotency-Key` per opened sheet reused on retry, `stock_changed` shows the new numbers and lets the person repeat, `not_enough_stock` message, success only after the server confirms) and `frontend/tests/catalog/stock-history.test.tsx` (rows with reason, signed quantity, person, Beirut time, running on hand; load more; empty state)
- [ ] T063 [P] [US2] Write Playwright scenario `frontend/e2e/m1-stock.spec.ts` (`en` and `ar`, 360 px): manager records received +5, damaged −1 and Set count 12; history lists four movements summing to 12; two sheets open, second save refused with new numbers; Remove 20 refused; double tap records one movement; packing agent's direct POST answers 403

### Implementation for User Story 2

- [ ] T064 [US2] Implement adjustments and history in `backend/app/services/inventory.py`: `adjust(db, actor, variant, input)` (resolve the variant in scope → `lock_balances` → version check → limits, with `direction` setting the sign for `other` → insert movement with `on_hand_after`, `request_key` and `source = 'manual'` → update balance, `version + 1` → `stock.adjusted`); CHECK violations answered by constraint name (`stock_balances_not_oversold` → `not_enough_stock`; `stock_balances_on_hand_range` and `stock_movements_on_hand_after_range` → `quantity: too_large`), never 500; `movements_page(db, variant, cursor)` returning the stored `source` (FR-012–FR-017, R41–R44)
- [ ] T065 [US2] Implement the stock API in `backend/app/api/stock.py` and register it: `POST /catalog/variants/{variantId}/adjustments` (`require("stock.adjust")`, M0 `idempotent()` with resource type `stock_movement`, contract field codes) and `GET /catalog/variants/{variantId}/movements` (`stock.adjust`); register isolation cases (T061) in the same change
- [ ] T066 [P] [US2] Frontend stock plumbing: `frontend/src/lib/stock.ts` (API calls, types, Idempotency-Key per sheet, `direction` from the sheet's mode for `other`); stock screen strings in `frontend/messages/en.json` and `frontend/messages/ar.json` (stock error codes and the `stock.adjusted` name come from T028 and are used, not added again)
- [ ] T067 [P] [US2] Build `frontend/src/components/Stepper.tsx` (quantity stepper of screen 14; 44 px targets; accepts Arabic-Indic digits through `lib/digits.ts`; 0–1,000,000) (needs T035 approval)
- [ ] T068 [US2] Build screen 14 in `frontend/src/app/[locale]/(shell)/more/catalog/[productId]/AdjustStockSheet.tsx`, opened from each variant of `ProductDetail.tsx` for `stock.adjust` holders only (needs T035 approval)
- [ ] T069 [US2] Build the variant stock history screen in `frontend/src/app/[locale]/(shell)/more/catalog/[productId]/variants/[variantId]/history/page.tsx` and `StockHistory.tsx`, linked from each variant for `stock.adjust` holders (needs T035 approval)
- [ ] T070 [US2] Run T058–T063 with the route-coverage and contract tests; confirm all pass with the integrity fixture active; record output in `specs/002-native-catalog-inventory/checklists/us2.md`

**Checkpoint (approval point)**: Stock changes are exact, explained, idempotent and safe against stale screens and races. Demonstrate quickstart scenario 2.

---

## Phase 5: User Story 3 - Availability that cannot oversell (Priority: P3)

**Goal**: An all-or-nothing, idempotent allocation service with release and consume, proven by concurrent tests, plus an integrity command. No HTTP endpoint in M1 (R45).

**Independent Test**: Through the test harness, two allocations race for the last unit and exactly one wins; a request with one short line reserves nothing; a repeated request key returns the first result; release restores availability; the integrity check reports zero differences after every scenario (quickstart scenario 3).

### Tests for User Story 3 (write first, confirm they fail)

- [ ] T071 [P] [US3] Write integration tests for the service in `backend/tests/integration/test_allocation.py`: all lines reserved or none (`insufficient_stock` lists every short line with its available number) (US3 scenario 2); unknown item refused `unknown_item` (the whole request, nothing reserved); archived variant or variant of an archived product refused `variant_archived` (FR-007); 1–100 lines, quantity ≥ 1, no item twice, key 1–200 characters; same key and same contents returns the original allocation whatever its state, nothing reserved again; same key with different contents → `allocation_key_conflict` (FR-019); release returns quantity to available and is repeatable; consume lowers on hand and allocated and writes one `allocation_consumed` movement per line with `source = 'allocation'`; release after consume and consume after release → `allocation_closed`; `stock.allocated`, `stock.released`, `stock.consumed` recorded with `request_key` and lines (FR-018–FR-020); balance versions +1 on every change
- [ ] T072 [P] [US3] Write concurrency tests in `backend/tests/integration/test_allocation_concurrency.py` (one connection per thread from the application engine, `threading.Barrier`, exact outcomes): two allocations for the last unit → exactly one succeeds and available is 0; 20 threads racing for 5 units → exactly 5 succeed; the same request key from several threads → one allocation (the savepoint loser returns the winner's); allocations racing adjustments and racing variant archiving → never negative availability, no lost update, archive refused while allocated; multi-item requests in opposite item order → no deadlock (ascending lock order) (FR-021, SC-002, SC-003)
- [ ] T073 [P] [US3] Extend `backend/tests/integration/test_cli.py` for `flask bos stock-check [--tenant ID]`: prints "0 differences" for every business and exits 0 on consistent data; after an owner-role corruption, lists the item with expected and actual numbers and exits non-zero; each business checked in its own tenant transaction, and every business is found although row-level security is forced (tenants listed in operator context) (FR-022)

### Implementation for User Story 3

- [ ] T074 [US3] Implement `backend/app/services/allocation.py`: `allocate(db, actor, request_key, lines)` (validate, compute `request_hash` = SHA-256 of the sorted `(inventory_item_id, quantity)` list, insert the allocation under a savepoint and on a unique-key race read and return the winner's, `lock_balances` in ascending order, check every line, increase `allocated`, bump versions, insert lines, `stock.allocated`), `release(db, actor, allocation_id)` and `consume(db, actor, allocation_id)` per the state rules of data-model.md (consume writes its movements with `source = 'allocation'`; unknown items refused `unknown_item`), all in the caller's transaction; no HTTP route (R44, R45; FR-018–FR-021)
- [ ] T075 [US3] Add `flask bos stock-check [--tenant ID]` to `backend/app/cli.py` (uses `inventory.integrity_report`; lists tenant ids in one transaction in operator context with `app.core.tenancy.enter_operator` (policy `operator_reads_tenants`), then checks each business in its own `app.core.tenancy.tenant_transaction(engine, tenant_id)`, not `enter_tenant_from_operator` (R24, R45)) and a `stock-check` subcommand to `backend/scripts/local_api.py` (FR-022)
- [ ] T076 [US3] Show the `allocation` source in `frontend/src/app/[locale]/(shell)/more/catalog/[productId]/variants/[variantId]/history/StockHistory.tsx` ("Reserved" wording stays on screen), using the `stock.allocated`, `stock.released` and `stock.consumed` names added by T028; needs T069 (US2), which creates `StockHistory.tsx`
- [ ] T077 [US3] Run the exit-gate tests (`uv run python scripts/local_tests.py -k "allocation or concurrency" -v` and `tests/integration/test_integrity.py`) and the full backend suite; confirm all pass; record the captured output in `specs/002-native-catalog-inventory/checklists/us3.md`

**Checkpoint (approval point)**: The allocation path M2 will call is proven under real concurrency; `stock-check` gives a repair-finding path.

---

## Phase 6: User Story 4 - Low-stock warnings (Priority: P4)

**Goal**: A business default and per-variant low-stock levels; variants at or below their level are flagged on catalog screens and listed, most urgent first, for owners and managers.

**Independent Test**: Set a variant's level to 3 with 5 available; record damaged −2; it shows "Low" and appears in the Low stock list; record received +4 and it leaves the list (quickstart scenario 4).

### Tests for User Story 4 (write first, confirm they fail)

- [ ] T078 [P] [US4] Extend `backend/tests/integration/test_business_settings.py`: `GET /business` returns `low_stock_default` (2 for new businesses); `PATCH /business` changes it for owners and managers (`settings.manage`), refuses non-integers and values outside 0–1,000,000 (`invalid`, `too_large`), records `tenant.settings_changed` with before and after (FR-023)
- [ ] T079 [P] [US4] Write integration tests in `backend/tests/integration/test_low_stock.py`: effective level = variant level, else business default; 0 disables the warning but "out" still shows; states `out` (available 0), `low` (level > 0 and 0 < available ≤ level), `ok`; `GET /catalog/low-stock` lists active variants of active products only, out of stock first, then available ascending, then SKU, 20 per page with cursor, `total` on the first page, `store_id` filter; stock changes move a variant in and out of the list; product-level `stock=low` search filter matches the same rule (FR-023, FR-024)
- [ ] T080 [P] [US4] Add isolation cases for `GET /catalog/low-stock` to `backend/tests/isolation/test_m1_routes.py`: cross-tenant (another business's `store_id` → 404 + `access.denied_tenant`); sales, packing and dispatch refused with `access.denied_permission` (US4 scenario 3, SC-007)
- [ ] T081 [P] [US4] Write frontend tests in `frontend/tests/catalog/low-stock.test.tsx` (list rows with product, variant, available, on hand and level; out first; empty state; load more), extend `frontend/tests/stores/settings.test.tsx` (low-stock default field, Arabic-Indic digits, validation) and `frontend/tests/shell/seeded-screens.test.tsx` (start-tab low-stock row shown to owners and managers only, with the count and first names, linking to the list)
- [ ] T082 [P] [US4] Extend `frontend/e2e/m1-stock.spec.ts` with quickstart scenario 4 (`en` and `ar`): level 3, damaged −2 → "Low" chip and in the list; received +4 → gone; level 0 at 0 available → "Out" but not listed; Store A agent sees chips and the Low stock pill but no list

### Implementation for User Story 4

- [ ] T083 [US4] Add `low_stock_default` to `backend/app/services/settings.py` and `backend/app/api/business.py` (read, validate as integer 0–1,000,000, change through `PATCH /business`, part of `tenant.settings_changed`) (FR-023, R49)
- [ ] T084 [US4] Implement `low_stock_page(db, store_id, cursor)` in `backend/app/services/inventory.py` and `GET /catalog/low-stock` in `backend/app/api/stock.py` (`require("stock.adjust")`, contract ordering and paging, `total` on the first page); register isolation cases (T080) in the same change (FR-024)
- [ ] T085 [US4] Add the low-stock default field to `frontend/src/app/[locale]/(shell)/more/settings/SettingsForm.tsx` (Arabic-Indic digits via `lib/digits.ts`, "0 turns warnings off" hint) and its strings to both message files (needs T035 approval)
- [ ] T086 [US4] Build the Low stock list in `frontend/src/app/[locale]/(shell)/more/catalog/low-stock/page.tsx` and `LowStockList.tsx`, reached from the Catalog app bar in `CatalogList.tsx` for `stock.adjust` holders (needs T035 approval)
- [ ] T087 [US4] Add the low-stock row for owners and managers to `frontend/src/app/[locale]/(shell)/sales/page.tsx` (their start tab, `start_tab_for` in `backend/app/core/permissions.py`) at the placement approved in T035 and recorded by T035 in spec.md "Clarifications" (the row's spec anchor; do not start before that entry exists) (count and first names from `GET /catalog/low-stock` first page; hidden when there is nothing low) (needs T035 approval)
- [ ] T088 [US4] Run T078–T082 with the route-coverage and contract tests; confirm all pass; record output in `specs/002-native-catalog-inventory/checklists/us4.md`

**Checkpoint (approval point)**: Low stock is visible where it matters, out of stock first. Demonstrate quickstart scenario 4.

---

## Phase 7: User Story 5 - Import a catalog from a spreadsheet (Priority: P5)

**Goal**: Owners and managers download a template, upload a CSV, see every problem with row and column before anything is saved, and confirm to create everything at once with opening stock as ledger movements.

**Independent Test**: A file of 40 valid rows and 3 faulty ones lists exactly those three rows and saves nothing; after fixing, confirming creates everything with opening movements and one history entry; uploading the same file again reports every row as already in use (quickstart scenario 5).

### Tests for User Story 5 (write first, confirm they fail)

- [ ] T089 [P] [US5] Write unit tests for number normalisation in `backend/tests/unit/test_numbers.py`: Arabic-Indic and Eastern Arabic-Indic digits, `٫` decimal separator, `٬` and `,` thousands separators in prices (`89,500`), whole-number quantities, rejection of signs, exponents and stray characters
- [ ] T090 [P] [US5] Write unit tests for CSV rules in `backend/tests/unit/test_csv_rules.py`: headers matched ignoring ASCII case and surrounding spaces; required columns `product_code`, at least one of `name_en`/`name_ar`, `price`, `currency`; empty `opening_quantity` = 0 and empty `low_stock_level` → null (the variant follows the business default, also after it changes); later rows inherit empty product-level columns and a differing non-empty value is `inconsistent_product`; stores separated by `|`, known active stores matched case-insensitively (`unknown_store`); SKU and code character rules; `duplicate_in_file`; `duplicate_combination`; `missing_option_value`; `too_many_options` / `too_many_values` / `too_many_variants`; `negative`, `not_whole`, `invalid_currency`; empty SKUs suggested uniquely across the file; row numbers count the header as row 1; every error collected, not the first (FR-026)
- [ ] T091 [P] [US5] Write integration tests in `backend/tests/integration/test_catalog_import.py`: file-level refusals before any row check — over 2 MB `file_too_large`, not UTF-8 / empty / not CSV (incl. a renamed `.xlsx`) `file_not_csv`, over 2,000 data rows `too_many_rows`, `missing_columns` and `unknown_columns` (incl. `image_url`) with `columns`; UTF-8 with and without BOM, Arabic cells intact; a file with a duplicate SKU, a missing price and a negative quantity gives a `failed` batch listing exactly those rows with `{row, column, code}` and the catalog unchanged (FR-027); a valid file gives `previewed` with product, variant and opening-unit counts; confirm creates every product, variant, inventory item, balance and one `opening` movement per quantity > 0 with `import_batch_id` and `source = 'import'`, and exactly one `catalog.imported` (FR-028); `import_has_errors`; `import_expired` (410) after 24 hours; confirming a committed batch again returns it unchanged; two confirms of the same batch sent at once (one connection per thread from the application engine, aligned on a `threading.Barrier`) → one import, one `catalog.imported`, both answers return the committed batch (constitution Principle IV, SC-002); a SKU created between preview and confirm → 409 `import_conflict` with the rows, nothing saved; a forced failure mid-confirm leaves no partial import (SC-005); the same file uploaded again reports every row as `sku_in_use` or `product_code_in_use` (FR-029); imported products have no photos and appear under `no_photo=true`; payload cleared after commit; `GET /catalog/imports/{id}` reads the preview again; template is UTF-8 with BOM, the header row and one example product with two variants (FR-025); `test_500_rows_preview_within_budget` times a 500-row upload to preview under 30 seconds and prints the time (SC-005)
- [ ] T092 [P] [US5] Extend `backend/tests/integration/test_maintenance_catalog.py`: expired uncommitted batches are deleted per tenant; committed batches are kept
- [ ] T093 [P] [US5] Add isolation cases for `GET /catalog/imports/template`, `POST /catalog/imports`, `GET /catalog/imports/{id}` and `POST /catalog/imports/{id}/confirm` to `backend/tests/isolation/test_m1_routes.py`: another business's batch id → 404 + `access.denied_tenant`; sales, packing and dispatch refused with `access.denied_permission` (SC-007)
- [ ] T094 [P] [US5] Write frontend tests in `frontend/tests/catalog/import.test.tsx`: template download link; upload with progress; file-level errors as one clear message; preview counts; every row error with row, column and a translated reason; Confirm not offered while errors exist; `import_conflict` shows the new errors; result screen
- [ ] T095 [P] [US5] Write Playwright scenario `frontend/e2e/m1-import.spec.ts` (`en` and `ar`, 360 px): download template; upload a file with three faulty rows → exactly three errors, nothing created; fixed file → counts → Confirm → products visible with opening stock; same file again → every row already in use

### Implementation for User Story 5

- [ ] T096 [P] [US5] Implement `backend/app/core/numbers.py` (Arabic-Indic digit and separator normalisation for CSV cells, R48, R53)
- [ ] T097 [US5] Implement `backend/app/services/catalog_import.py`: file checks in the order of R53, parsing with Python's `csv`, row validation collecting every error, product grouping and inheritance, SKU suggestions through `skus.py`, catalog lookups for SKUs and codes (archived included), `import_batches` row with SHA-256, counts, errors and validated payload (24-hour expiry); confirm under the batch row lock, re-validation against the catalog, creation through the same helpers as `catalog.py` in one transaction (opening movements with `source = 'import'` and `import_batch_id`), unique-index conflict → `import_conflict` with everything rolled back, one `catalog.imported`, payload cleared; template generation (FR-025–FR-029)
- [ ] T098 [US5] Implement the import API in `backend/app/api/catalog_import.py` and register it: `GET /catalog/imports/template`, `POST /catalog/imports` (multipart, 2 MB guard for this route), `GET /catalog/imports/{batchId}`, `POST /catalog/imports/{batchId}/confirm` (410 `import_expired`, 503 `try_again`), all `require("catalog.manage")`; register isolation cases (T093) in the same change
- [ ] T099 [US5] Add the expired-batch step to `backend/app/services/maintenance.py` (per tenant, through the same operator-listed `tenant_transaction` loop as T051; committed batches kept) and its count to `maintenance.run` in `backend/app/cli.py`
- [ ] T100 [P] [US5] Frontend import plumbing: `frontend/src/lib/imports.ts` (template download, upload through `apiUpload`, preview, confirm); import screen strings in both message files (import error codes, every `ImportError` code and the `catalog.imported` name come from T028 and are used, not added again)
- [ ] T101 [US5] Build the import screens in `frontend/src/app/[locale]/(shell)/more/catalog/import/page.tsx` and `ImportScreen.tsx` (upload, preview with row errors, confirm, result), reached from the Catalog app bar for `catalog.manage` holders (needs T035 approval)
- [ ] T102 [US5] Run T089–T095 with the route-coverage and contract tests; confirm all pass with the integrity fixture active; record output (incl. the 500-row timing) in `specs/002-native-catalog-inventory/checklists/us5.md`

**Checkpoint (approval point)**: A merchant's spreadsheet becomes a catalog in one step or not at all. Demonstrate quickstart scenario 5.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Demo data, measurements, accessibility, documentation, rollback rehearsal and the M1 exit gate.

- [ ] T103 Add a small demo catalog to `backend/app/services/seed.py` (about 8 products across both demo stores, including one low and one out of stock, opening stock as movements; safe to run twice) with a test in `backend/tests/integration/test_cli.py` (R58)
- [ ] T104 Add the development-only `flask bos seed-catalog --variants N --tenant ID` to `backend/app/cli.py` and `backend/app/services/seed.py` (guarded by `BOS_ALLOW_DEMO_SEED`, 5,000 variants = 1,000 products × 5), with a test in `backend/tests/integration/test_cli.py` that it refuses without the guard and creates consistent stock with it (R58, SC-006)
- [ ] T105 [P] Extend `backend/tests/integration/test_audit_completeness.py` to M1: run one of every M1 action (create, update, archive, restore and delete a product; adjust; allocate, release, consume; import; change the low-stock default) and assert each M1 event of data-model.md appears exactly once with the right actor, target and data shape (FR-017, FR-020, FR-028)
- [ ] T106 [P] Accessibility and RTL pass over every new screen at 360 px in `en` and `ar`: extend `frontend/e2e/a11y.spec.ts` and `frontend/tests/a11y/a11y-pass.test.tsx` to the catalog list, product, product form, adjust sheet, stock history, Low stock list, import screens and the start-tab row (labels, focus order, visible focus, 44 px targets, contrast ≥ 4.5:1 light and dark, chips with text, no horizontal scroll); record findings and fixes in `specs/002-native-catalog-inventory/checklists/ux-pass.md` (FR-031, SC-008)
- [ ] T107 [P] Measure performance on the simulated mobile profile of `specs/001-platform-foundation/checklists/performance.md`: catalog search on a business seeded with `seed-catalog --variants 5000` (under 1 s, SC-006) and every new screen (under 3 s, SC-008); quote the 500-row import timing from T102 (SC-005); record results in `specs/002-native-catalog-inventory/checklists/performance.md`; fix anything over budget
- [ ] T108 [P] Security review of M1 in `specs/002-native-catalog-inventory/checklists/security.md`: photos served only through the authorised route with no public URL; client file names never used as paths; uploads decoded by content; no secrets in history `data`; every M1 write refused without its permission and recorded; RLS forced on all thirteen tables; F-11 and F-15 verified
- [ ] T109 [P] Update `README.md`: M1 commands (`stock-check`, `seed-catalog`, `purge-test-businesses`, maintenance steps), `BOS_ENVIRONMENT`, the demo catalog, the import template and its columns, where photos are stored
- [ ] T110 [P] Update `backend/migrations/README.md`: migration `0003`, the `pg_trgm` requirement (trusted extension, owner needs `CREATE` on the database), the downgrade steps and what a rollback loses (data-model.md "What a rollback loses"), backup first on real data, and a note for M7 that production and staging databases should use a UTF-8 locale (e.g. `C.UTF-8`) because `pg_trgm` extracts no Arabic trigrams under the `C` locale (R51)
- [ ] T111 Rehearse the migration rollback on a throwaway database: `upgrade head` on seeded M0 data plus the demo catalog, `downgrade 0002`, `upgrade head`; write down what was left behind (orphaned photo files, history entries pointing at removed records); record in `specs/002-native-catalog-inventory/checklists/exit-gate.md` (Principle VIII)
- [ ] T112 Run the full quickstart (`specs/002-native-catalog-inventory/quickstart.md`): all automated suites with captured output, `stock-check` on the development database, then manual scenarios 1–6 in English and Arabic at 360 px, timing SC-001 (6-variant product with a photo and opening stock in under 3 minutes); record each step in `specs/002-native-catalog-inventory/checklists/exit-gate.md`
- [ ] T113 M1 exit gate in `specs/002-native-catalog-inventory/checklists/exit-gate.md`, mirroring M0's: (1) SKU integrity tests (SC-004) pass with output captured; (2) allocation integrity and concurrency tests (SC-002) pass with output captured; (3) the integrity fixture reported zero differences in every catalog, stock, allocation and import test (SC-003); (4) every FR-001–FR-031 and SC-001–SC-008 mapped to its evidence; (5) review against the constitution's Definition of Done (contracts, rollback documented and rehearsed, permission-enforced endpoints with no cross-tenant leakage, both languages demonstrated, states handled, audit events for stock changes, README, scope kept to M1); (6) open findings listed with their target milestone. Present to the product owner for exit-gate approval

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; each item is independent of the others
- **Foundational (Phase 2)**: needs Phase 1 (T002's `BOS_ENVIRONMENT` and T008's purge are extended here); blocks every user story
- **Screen-design approval (T035)**: written in Phase 2; **every task that builds or changes a screen waits for the product owner's approval**: T053, T054, T055, T056, T067, T068, T069, T085, T086, T087, T101. Tests and backend work do not wait for it
- **US1 (Phase 3)**: needs Phase 2
- **US2 (Phase 4)**: needs Phase 2 for its backend (tests use the direct-SQL fixtures of T023); its screens (T068, T069) are reached from US1's product screen (T054)
- **US3 (Phase 5)**: needs Phase 2 for its backend and tests (T023 fixtures); T076 waits for T069 (US2), which creates `StockHistory.tsx`
- **US4 (Phase 6)**: needs Phase 2 for its backend; T086 links from US1's `CatalogList.tsx`; T087 needs the low-stock API (T084)
- **US5 (Phase 7)**: needs US1's `skus.py` and catalog creation helpers (T045, T046); T101 links from `CatalogList.tsx`
- **Polish (Phase 8)**: needs all stories; T113 needs every other task

### User Story Dependencies

```text
Setup → Foundational (+ T035 design approval for screens)
          ├→ US1 ─┬→ US5 ─────────┐
          │       ├→ US2 screens  │
          │       └→ US4 screens  ├→ Polish → Exit gate (T113)
          ├→ US2 backend ─────────┤
          ├→ US3 ─────────────────┤
          └→ US4 backend ─────────┘
```

### Within Each User Story

1. Tests written and seen to fail
2. Services → API (isolation cases registered with each new route) → frontend plumbing → screens (after T035 approval)
3. Run the story's tests plus route-coverage and contract tests, with the integrity fixture active; capture output in the story's checklist

### Parallel Opportunities

- Phase 1: T001, T003, T005, T007, T009, T011, T013 together; then each implementation after its own test
- Phase 2: T014–T021 together; then T028, T029 alongside the backend implementation; T035 (design) alongside everything
- Each story: all its test tasks together
- Backend of US2 and US3 can proceed in parallel with US1 after Phase 2 (different services, fixtures from T023); `backend/app/services/inventory.py` is touched by T033, T046, T064 and T084, and `backend/tests/isolation/test_m1_routes.py` by T042, T061, T080 and T093, so those tasks are **not** parallel with each other
- `frontend/messages/*.json` are edited by T012, T028, T052, T066, T085 and T100, and `frontend/src/lib/errors.ts` / `frontend/src/lib/audit.ts` by T028: those tasks are not parallel with each other (T028 adds every M1 code and event name; later tasks add screen strings only)

---

## Parallel Example: User Story 1

```text
# Write all US1 tests together:
T037 backend/tests/unit/test_skus.py
T038 backend/tests/integration/test_catalog_products.py
T039 backend/tests/integration/test_catalog_photos.py
T040 backend/tests/integration/test_catalog_search.py
T041 backend/tests/integration/test_maintenance_catalog.py
T042 backend/tests/isolation/test_m1_routes.py
T043 frontend/tests/catalog/*.test.tsx, frontend/tests/lib/money.test.ts
T044 frontend/e2e/m1-catalog.spec.ts

# Then, in parallel:
T045 backend/app/services/skus.py
T047 backend/app/services/photos.py
T052 frontend/src/lib/catalog.ts (+ messages, errors, audit)
```

## Parallel Example: User Story 2

```text
T058 backend/tests/integration/test_stock_adjustments.py
T059 backend/tests/integration/test_stock_movements.py
T060 backend/tests/integration/test_stock_concurrency.py
T061 backend/tests/isolation/test_m1_routes.py
T062 frontend/tests/catalog/adjust-stock.test.tsx, stock-history.test.tsx
T063 frontend/e2e/m1-stock.spec.ts
# Then T066 (frontend/src/lib/stock.ts) and T067 (Stepper.tsx) alongside T064/T065
```

## Parallel Example: User Story 3

```text
T071 backend/tests/integration/test_allocation.py
T072 backend/tests/integration/test_allocation_concurrency.py
T073 backend/tests/integration/test_cli.py
# Then T074 (services/allocation.py) and T075 (cli.py, local_api.py); T076 (StockHistory.tsx) once T069 is done
```

## Parallel Example: User Story 4

```text
T078 backend/tests/integration/test_business_settings.py
T079 backend/tests/integration/test_low_stock.py
T080 backend/tests/isolation/test_m1_routes.py
T081 frontend/tests/catalog/low-stock.test.tsx (+ settings, seeded-screens tests)
T082 frontend/e2e/m1-stock.spec.ts
# Then T083 and T084 (backend) alongside T085 (SettingsForm.tsx; not alongside other tasks editing the message files)
```

## Parallel Example: User Story 5

```text
T089 backend/tests/unit/test_numbers.py
T090 backend/tests/unit/test_csv_rules.py
T091 backend/tests/integration/test_catalog_import.py
T092 backend/tests/integration/test_maintenance_catalog.py
T093 backend/tests/isolation/test_m1_routes.py
T094 frontend/tests/catalog/import.test.tsx
T095 frontend/e2e/m1-import.spec.ts
# Then T096 (core/numbers.py) and T100 (frontend plumbing) in parallel
```

---

## Implementation Strategy

### MVP First (Setup + Foundational + User Story 1)

1. Phase 1: close the carried-forward M0 items
2. Phase 2: migration, isolation, permissions, contract wiring, integrity fixture — do not skip; this is where integrity is built into the database and proven
3. T035 design approval (in parallel with Phase 2 and the US1 backend)
4. Phase 3: US1
5. **Stop and validate**: quickstart scenario 1 in both languages; SKU and isolation tests green
6. Demonstrate: a merchant builds a catalog on the phone; staff see only their stores

### Incremental Delivery

1. Setup + Foundational → schema and integrity proven at the database level
2. + US1 → catalog on the phone (demo)
3. + US2 → stock ledger and adjustments (demo)
4. + US3 → allocation service proven by concurrency tests (exit-gate evidence)
5. + US4 → low-stock warnings (demo)
6. + US5 → CSV import (demo)
7. Polish → exit gate; M1 complete, M2 may start

### Approval points

- After Phase 2 (T036): migration, RLS, wiring and integrity fixture shown passing; screen designs (T035) approved before any screen is built
- After each story: demonstrate in both languages before starting the next
- After T113: product owner approves the M1 exit gate

---

## Notes

- [P] tasks touch different files and have no unfinished dependency
- New API routes must be registered with the isolation harness and exist in a contract in the same task that adds them, or the suites fail
- Never claim a test passed without running it and capturing the output (Principle IV)
- Backend tests only through `uv run python scripts/local_tests.py` from `backend/`; never run two database test suites at once
- Local PostgreSQL on port 55433: `uv run python ..\scripts\local_db.py start` and `stop` from `backend/`; never Docker on the development PC
- Node 24 from `%LOCALAPPDATA%\bos-dev\node24`; the API runs on 5100 through `local_api.py serve`; never use port 8000; leave port 3100 alone unless the person running the session started it
- Never print `.env`, cookies, passwords, invitation codes or links
- Agents stop any server they started and do not commit
- Out of scope for every task here: orders, customers, an allocation HTTP endpoint, WooCommerce, WhatsApp, AI, job queue, object storage, multi-warehouse, per-store prices, photos in CSV files
- Open points found while writing these tasks were settled by the lead on 2026-11-15 and written into the design documents:
  - `stock_balances` CHECK includes `on_hand <= 1000000` (data-model.md now matches R40) (T014, T022)
  - `POST /catalog/products` is idempotent through `core/idempotency.py`, resource type `product` (R44) (T038, T049, T056)
  - Reason `other` requires `direction` `in` / `out`, which sets the sign (R41, data-model.md validation) (T058, T064)
  - `GET /catalog/low-stock` takes an optional `store_id` filter (R49) (T079, T084)
  - New store listings, from the form or import, accept active stores only; a listing in a store deactivated later is kept (data-model.md `product_stores`) (T090, T097)
  - `purge-test-businesses` may use `SET LOCAL session_replication_role = replica` like `dbsupport.truncate_all`, development database only (T008)
- Fixes from the cross-artifact analysis of 2026-11-15, settled by the lead and written into the design documents:
  - Concurrent duplicate tests for product create (T038) and import confirm (T091) (constitution Principle IV)
  - `direction` is `in` / `out` in the contract too; M1 contract descriptions follow M0's pattern so `codesIn()` reads exactly the M1 codes; T028 adds all M1 code and event names up front
  - Product form: one `Idempotency-Key` per opened form, reused for every save (R44, T056)
  - `stock_movements.source` is stored, with the CHECK `stock_movements_source` (data-model.md, R41) (T014, T022, T046, T059, T064, T074, T091, T097)
  - Balance CHECKs are two named constraints answered by name: `stock_balances_not_oversold` → `not_enough_stock`; `stock_balances_on_hand_range` / `stock_movements_on_hand_after_range` → `quantity: too_large` (R40, R42) (T014, T022, T058, T064)
  - Restoring a variant whose option value label is now taken → 409 `value_in_use` (R47) (T038, T046); allocation of an unknown item → `unknown_item` (R45) (T071, T074)
  - Commands visiting every business list tenants with `enter_operator` and run each in `tenant_transaction` (R45, R50) (T051, T075, T099)
  - The approved screen deviations and the start-tab low-stock row are recorded in spec.md Clarifications after T035 (T035, T087)
