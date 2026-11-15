# Implementation Plan: Native Catalog and Inventory (M1)

**Branch**: `002-native-catalog-inventory` | **Date**: 2026-11-15 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-native-catalog-inventory/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

M1 gives each business a native catalog and trustworthy stock: products with photos, codes,
up to two option types and one variant per combination, each variant with its own SKU,
USD or LBP price and a stable inventory identity; one default warehouse with one balance per
item; an append-only ledger of stock movements; manual adjustments with reasons and
protection against stale screens and double submissions; an all-or-nothing, idempotent
allocation service that M2's orders will call; low-stock warnings; and a CSV import that
checks every row before saving anything.

Technical approach: the M0 stack and patterns, extended rather than repeated. Plain SQL
through SQLAlchemy `text()` in the request transaction, PostgreSQL row-level security
forced on thirteen new tables with composite foreign keys, the `require()` permission
declarations (with a new store-filtered form for the catalog), `core/idempotency.py` for
stock adjustments, `core/audit.py` for history, and M0's storage interface and Pillow
pipeline for photos. Integrity lives in the database first: a unique balance per item and
warehouse, `CHECK (allocated >= 0 AND on_hand >= allocated)`, an append-only movements
trigger, generated normalised SKU keys with unique indexes, and a unique index that allows
one active variant per option combination. Every stock change locks its balance rows in a
fixed order. Allocation is a service proven by concurrent tests on real separate
connections, with an integrity check run after every test (the M1 exit gate). Decisions and
rejected alternatives are in [research.md](research.md) (R38–R58).

## Technical Context

**Language/Version**: Python 3.12 (backend); TypeScript on Node 24 LTS (frontend) — as M0

**Primary Dependencies**: Flask, SQLAlchemy 2 (Core and `text()`; no ORM models), Alembic
(hand-written migrations), Pillow, Python's `csv` module (backend); Next.js 16 (App
Router), React 19, next-intl 4 (frontend). No new runtime dependency; versions stay pinned in
the lock files.

**Storage**: PostgreSQL (16 in Compose, 17 on the development PC) with forced RLS; the
`pg_trgm` extension for search indexes (verified available and trusted, R51); product
photos on local disk behind M0's `Storage` interface (object storage deferred to M7, R50)

**Testing**: pytest against real PostgreSQL (unit, integration, isolation with the
route-coverage harness, contract against both features' OpenAPI files), including threaded
concurrency tests on separate connections and an integrity check after every catalog and
stock test; Vitest + Testing Library; Playwright at 360 px in `en` and `ar`

**Target Platform**: as M0 — low-cost Android phones first (installable PWA), desktop
second; the API on Linux containers in production, plain processes on the development PC

**Project Type**: Web application (backend API + frontend PWA), the existing `backend/` and
`frontend/` trees

**Performance Goals**: catalog search under 1 s for 5,000 variants on the simulated mobile
profile (SC-006); 500-row CSV preview under 30 s (SC-005; expected under 2 s); new screens
under 3 s (SC-008); API reads for catalog screens within 300 ms at the 95th percentile on
the pilot server, as M0

**Constraints**: inventory integrity is non-negotiable (Principle II): no negative
availability, all-or-nothing allocation, idempotent stock changes, append-only ledger, fail
closed on lock timeouts; no orders, customers, WooCommerce, WhatsApp, AI or multi-warehouse;
no job queue; no allocation endpoint; nothing shown as saved before the server confirms

**Scale/Scope**: pilot businesses with up to about 5,000 variants each; 5 user stories,
about 8 screens (3 already designed), 18 API operations (16 new, 2 changed), 13 new tables

**Concrete values fixed here** (left open in the spec):

| Item | Value |
|---|---|
| Page size (catalog search, Low stock list) | 20; stock history 50 (as M0 History) |
| Search query length | 1–100 characters |
| Product code / SKU | 1–32 / 1–64 characters; ASCII letters, digits, `-` `_` `.` `/` (R46) |
| Product names / descriptions | 1–120 each language / ≤ 2,000 each language |
| Option type name / value label | 1–40 / 1–40 characters |
| Option types / values per type / variants per product | ≤ 2 / ≤ 20 / ≤ 100 |
| Adjustment note | ≤ 500 characters; required for reason "other" |
| Quantities | integers 0–1,000,000 (on hand capped at 1,000,000) |
| Price | 0 – 99,999,999,999.99, `numeric(14,2)`; LBP whole numbers |
| Low-stock default / per-variant level | 2 / null (= default); 0–1,000,000; 0 disables |
| Photos | ≤ 8 per product; PNG/JPEG/WebP ≤ 5 MB and ≤ 40 megapixels; WebP 320 px and 1080 px, quality 80 |
| Staged (unsaved) photo lifetime | 24 hours |
| CSV import | ≤ 2 MB, ≤ 2,000 data rows, UTF-8 with or without BOM; batch lifetime 24 hours |
| Allocation request | ≤ 100 lines; key 1–200 characters, never expires |
| Stock-change idempotency key | M0's: 1–200 characters, 24 hours |
| Lock wait before "busy" | M0's `lock_timeout` 10 s → 503 `try_again`, `Retry-After: 1` |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How this plan complies | Status |
|---|---|---|
| I. Tenant isolation and least privilege | RLS enabled and forced on all 13 new tables with `tenant_isolation`; composite FKs on every reference (a variant's photo must be its own product's); 404 for foreign or out-of-store records with `access.denied_tenant` / `access.denied_store`; `catalog.view` becomes store-scoped and filtered in one SQL predicate; packing/sales/dispatch cannot change prices or stock (server-checked, recorded); route-coverage harness requires cross-tenant, missing-permission and cross-store cases for every new route (R52, R56) | Pass |
| II. Inventory and money integrity | One balance per item per warehouse (unique); available derived; `CHECK (allocated >= 0 AND on_hand >= allocated)`; all-or-nothing allocation in one transaction with ordered row locks; idempotent adjustments (M0 keys) and allocations (durable keys + content hash); append-only movements enforced by trigger; on hand = Σ movements checked after every test; exact decimals with explicit currency, LBP whole, nothing converted or stored at a rate; lock timeouts and deadlocks fail closed (R40–R45, R48) | Pass |
| III. Mobile-first, bilingual UX | Screens 12–14 from the approved designs; the new screens are designed and approved before they are built (R55); 360 px, `en` and `ar`, M0 states; "Low"/"Out" chips with text; no success before the server confirms; Arabic-Indic digits accepted in catalog inputs (R48) | Pass |
| IV. Contracts and tests before integration | OpenAPI delta and permissions delta written first and tested against; tests written first and seen to fail; concurrency tests with real threads and separate connections for last-unit races, duplicate submissions and adjust/allocate races; integrity check after every scenario; no external platform touched | Pass |
| V. Small vertical slices | Only M1 scope: no orders, no allocation endpoint, no queue (synchronous import), no object storage, no multi-warehouse (CHECK forbids a second warehouse). The allocation service is the M1 exit gate, not speculation (R45). Five stories, each demonstrable | Pass |
| VI. Observability and recovery | History entries for every product, stock, allocation and import change in the same transaction; refusals recorded; import batches keep their errors durably; `flask bos stock-check` and the integrity report give a repair-finding path; maintenance records what it purged (R45, R50, R53, R54) | Pass |
| VII. No unauthorized automation | No third-party platform; images are never downloaded from links (FR-029); no AI | Pass |
| VIII. No destructive change without approval | Migration `0003` has a written downgrade and a documented loss list; rollback rehearsed on a throwaway database before the exit gate; no external writes; F-11 makes weak secrets and the development mail outbox refuse to start outside development; no secrets committed | Pass |

**Post-design re-check**: after writing research.md, data-model.md and the contracts, each
principle was checked again against the concrete design. No violation was found. Points that
needed a decision rather than a waiver, now recorded:

- Principle I and data-level store scope: a product belongs to several stores, so M0's
  per-path store check cannot express it. Resolved by the store-filtered declaration and a
  harness rule that still demands a cross-store test (R52), so the constitution's "tests that
  attempt cross-store access" holds for every catalog route.
- Principle II and lock contention: waiting forever is not failing closed. Resolved by the
  existing 10 s lock timeout mapped to a retryable 503 that applies nothing (R42).
- Principle III and the approved designs: three deliberate changes (low-stock row placement,
  Low stock list as its own screen, "Add variant" folded into options editing) are recorded
  in R55 and must be confirmed with the product owner with the new screen designs.
- Principle V and photos: staged uploads add one small lifecycle (24 h expiry) instead of a
  job queue; justified by the spec's photo edge cases (R50).

No entries are needed in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/002-native-catalog-inventory/
├── spec.md              # Approved specification
├── plan.md              # This file
├── research.md          # Phase 0: decisions R38–R58
├── data-model.md        # Phase 1: tables, rules, states, migration 0003
├── quickstart.md        # Phase 1: how to run and validate M1
├── contracts/
│   ├── openapi.yaml     # M1 endpoints + changes to /business and /audit
│   └── permissions.md   # M1 permission delta (catalog.view store-scoped)
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks; not created by /speckit-plan)
```

### Source Code (new and changed files only, in the existing tree)

```text
backend/
├── app/
│   ├── config.py                   # CHANGED: F-11 secret-key and outbox checks; BOS_ENVIRONMENT
│   ├── errors.py                   # CHANGED: lock timeout / deadlock → 503 try_again
│   ├── data/
│   │   └── common_passwords.txt    # NEW: F-15 list (source and licence in header)
│   ├── core/
│   │   ├── permissions.py          # CHANGED: catalog.view store-scoped; require(..., store_filtered=True)
│   │   ├── request_context.py      # CHANGED: not_found_in_scope() for out-of-store records
│   │   ├── security.py             # CHANGED: load the common-password file
│   │   ├── storage.py              # CHANGED: prepare_product_photo() (5 MB, 320/1080 WebP)
│   │   ├── audit.py                # CHANGED: M1 events
│   │   └── numbers.py              # NEW: Arabic-Indic digit and separator normalisation (CSV)
│   ├── api/
│   │   ├── __init__.py             # CHANGED: register new blueprints
│   │   ├── business.py             # CHANGED: low_stock_default
│   │   ├── catalog.py              # NEW: products, archive/restore/delete, search
│   │   ├── catalog_photos.py       # NEW: staged upload, authorised download
│   │   ├── stock.py                # NEW: adjustments, movements, low stock
│   │   └── catalog_import.py       # NEW: template, upload/preview, read, confirm
│   ├── services/
│   │   ├── catalog.py              # NEW: products, options, variants, scope predicate, version checks
│   │   ├── skus.py                 # NEW: SKU/code rules and suggestions
│   │   ├── catalog_search.py       # NEW: search, filters, keyset cursor, counts
│   │   ├── photos.py               # NEW: staging, attaching, removal, purge
│   │   ├── inventory.py            # NEW: default warehouse, balances, locking, adjustments, movements, low stock, integrity_report
│   │   ├── allocation.py           # NEW: allocate / release / consume (no HTTP in M1)
│   │   ├── catalog_import.py       # NEW: CSV parse, validate, batches, confirm
│   │   ├── onboarding.py           # CHANGED: default warehouse for a new business
│   │   ├── seed.py                 # CHANGED: warehouses + small demo catalog; seed-catalog load data
│   │   ├── settings.py             # CHANGED: low_stock_default setting
│   │   └── maintenance.py          # NEW: per-tenant purge of staged photos and expired batches
│   └── cli.py                      # CHANGED: stock-check, seed-catalog, maintenance step
├── migrations/
│   ├── versions/0003_catalog_inventory.py   # NEW (data-model.md "Migration 0003")
│   └── README.md                   # CHANGED: 0003, pg_trgm, rollback losses
├── scripts/
│   ├── local_api.py                # CHANGED: BOS_ENVIRONMENT=development; stock-check, purge-test-businesses
│   └── local_tests.py              # unchanged
└── tests/
    ├── paths.py                    # CHANGED: contracts of both features
    ├── conftest.py                 # CHANGED: tenant helpers create the default warehouse; integrity fixture
    ├── dbsupport.py                # CHANGED: catalog fixtures (products, variants, balances)
    ├── unit/                       # NEW: test_skus, test_numbers, test_photo_prepare, test_csv_rules, test_config_f11; CHANGED: test_permissions
    ├── integration/                # NEW: test_catalog_products, test_catalog_search, test_catalog_photos,
    │                               #      test_stock_adjustments, test_stock_movements, test_low_stock,
    │                               #      test_allocation, test_allocation_concurrency, test_stock_concurrency,
    │                               #      test_integrity, test_catalog_import, test_migration_0003, test_maintenance_catalog;
    │                               #      CHANGED: test_business_settings, test_audit_completeness, test_tenancy_and_audit
    ├── isolation/                  # NEW: test_m1_routes; CHANGED: coverage.py (store_filtered rule), test_rls (new tables)
    └── contract/                   # CHANGED: support.py validates each path against its feature's file

frontend/
├── messages/en.json, ar.json       # CHANGED: catalog, stock, import, low stock, new history events, error codes
├── src/
│   ├── app/[locale]/(shell)/
│   │   ├── sales/page.tsx          # CHANGED: low-stock row for owners/managers (screen 02 row)
│   │   └── more/
│   │       ├── MoreMenu.tsx        # CHANGED: Catalog entry (catalog.view)
│   │       ├── history/HistoryScreen.tsx   # CHANGED: catalog/stock events, F12 arrow keys in filter sheet
│   │       ├── settings/SettingsForm.tsx   # CHANGED: low-stock default
│   │       └── catalog/            # NEW
│   │           ├── page.tsx, CatalogList.tsx            # screen 12: search, pills, filter sheet
│   │           ├── new/page.tsx, ProductForm.tsx        # create (and edit) form, photos, options, variant grid
│   │           ├── [productId]/page.tsx, ProductDetail.tsx, AdjustStockSheet.tsx   # screens 13, 14
│   │           ├── [productId]/edit/page.tsx
│   │           ├── [productId]/variants/[variantId]/history/page.tsx, StockHistory.tsx
│   │           ├── low-stock/page.tsx, LowStockList.tsx
│   │           ├── import/page.tsx, ImportScreen.tsx
│   │           ├── catalog.module.css, parts.tsx, validation.ts
│   ├── components/
│   │   ├── PhotoPicker.tsx         # NEW: staged upload with per-photo retry
│   │   ├── Stepper.tsx             # NEW: quantity stepper (screen 14)
│   │   └── useRovingRadio.ts       # NEW: shared arrow-key radio group (F12, stock filter)
│   └── lib/
│       ├── catalog.ts, stock.ts, imports.ts   # NEW: API calls and types
│       ├── digits.ts               # NEW: Arabic-Indic → ASCII for catalog inputs
│       ├── money.ts                # CHANGED: approximate conversion helper
│       ├── session.ts              # CHANGED: re-read /me on screen change and on return to foreground
│       └── audit.ts                # CHANGED: event icons and "Catalog and stock" group
├── tests/catalog/                  # NEW: Vitest for form validation, digits, conversion, sheets
└── e2e/                            # NEW: m1-catalog.spec.ts, m1-stock.spec.ts, m1-import.spec.ts; CHANGED: a11y.spec.ts

.env.example, docker-compose.yml    # CHANGED: BOS_ENVIRONMENT
README.md                           # CHANGED: M1 commands, demo catalog, import template
specs/001-platform-foundation/
├── contracts/openapi.yaml          # CHANGED: /business low_stock_default, /audit target types (version note)
├── tasks.md                        # CHANGED: T021 closed as not built by design
└── plan.md                         # CHANGED: models/ line corrected
```

**Structure Decision**: The existing web application layout from M0. Backend code stays
`api` (HTTP, validation of request shapes) → `services` (rules, SQL) with cross-cutting code in
`core/`; there is no `models/` layer (plain SQL, as built in M0). The catalog frontend lives
under More, as the approved designs place it. Nothing here anticipates M2 internals beyond
the allocation service the spec requires.

## Design notes for implementation

- **Request lifecycle additions** (M0's lifecycle otherwise unchanged):
  - `require("catalog.view", store_filtered=True)` checks the permission in the decorator;
    the view then applies `services.catalog.visible_products(access)` to every query. A
    record that exists in the business but is outside the caller's stores is refused with
    `not_found_in_scope()` (404, `access.denied_store`, target the product); a record not in
    the business with M0's `not_found_in_tenant()`.
  - Stock change: `idempotent()` (M0) → resolve variant (scope) → lock balance rows `FOR
    UPDATE` in ascending `inventory_item_id` → check version and limits → insert movement →
    update balance (version + 1) → `audit.record` → commit. Allocation follows the same
    locking without HTTP.
  - Product save: lock the product row `FOR UPDATE` → compare `version` → (when variants are
    archived or deleted) lock their balances in ascending order → write → `product.updated`
    → commit. Unique-index violations on `sku_key` / `code_key` become 409 with field
    errors; `CHECK` violations on balances become `not_enough_stock`.
  - Photos: write both WebP files before the transaction references them, register
    `on_rollback` deletes; files of removed photos are deleted with `on_commit` (M0 R36).
  - Lock timeout (`55P03`) and deadlock (`40P01`) anywhere in a request → 503 `try_again`
    with `Retry-After: 1` (central handler in `errors.py`).
- **Tests that carry the exit gate**: an autouse fixture in the catalog, stock and import
  test modules runs the integrity report over every business after each test and fails on
  any difference (SC-003). Concurrency tests open one connection per thread from the
  application engine, align them with a `threading.Barrier`, and assert exact outcomes
  (one winner for the last unit; N winners for N units; no negative availability; one
  movement per Idempotency-Key). SKU tests cover case, spaces, archived, other businesses,
  CSV within file and against the catalog (SC-004).
- **Contract wiring** (R56): `tests/paths.py` lists both features; the permission test reads
  both `permissions.md` files; the events test reads each data model's events table (the
  "Events:" paragraph up to the next `##` heading); the contract test picks the OpenAPI file
  that defines the request's path.
- **Order of work** (for `/speckit-tasks`):
  1. Carried-forward small items (below), so M1 starts on a clean base.
  2. Foundation: migration `0003` with RLS, grants, warehouse backfill and its tests;
     default warehouse in onboarding, seed and test helpers; permissions and harness
     changes (`store_filtered`); contract wiring; integrity report and its fixture;
     error mapping for busy locks.
  3. US1 catalog: SKU rules → product create/read/update/archive/restore/delete →
     options and variants → photos → search and filters → screens 12, 13 and the product form.
  4. US2 ledger: adjustments (idempotent, versioned) → movements history → screen 14 and the
     stock history screen.
  5. US3 allocation: service → idempotency → concurrency tests → integrity CLI.
  6. US4 low stock: setting → computed states → Low stock list → low-stock row on the start
     tab.
  7. US5 import: parser and rules → preview batches → confirm → template → import screens.
  8. Polish: demo catalog and `seed-catalog`, performance measurement (SC-005, SC-006,
     SC-008), accessibility in both languages, README, migration rollback rehearsal,
     quickstart run.
- **Screens to design before they are built** (R55): product form (create and edit:
  options, variant grid, prices, opening quantities, photos, stores), variant stock history,
  Low stock list, CSV import (upload, preview with row errors, result), catalog filter sheet
  (archived, no photo), and the placement of the low-stock row on the start tab. Screens 12
  Catalog, 13 Product and variants and 14 Adjust stock already exist in
  `design/bos-screens.html`.

## Carried forward from M0

From M0's exit gate (`specs/001-platform-foundation/checklists/exit-gate.md`), each to become
an M1 task (details in research R57):

- **F-11**: refuse to start (outside testing) with a `BOS_SECRET_KEY` shorter than 32
  characters or starting with `CHANGE_ME`, and refuse `BOS_MAIL_OUTBOX_DIR` unless
  `BOS_ENVIRONMENT=development`.
- **F-15**: replace the 18-entry common-password list with a larger published list filtered to
  10+ characters, shipped as a data file.
- **`me.stores` going stale** after store access changes: the web app re-reads `/me` on each
  screen change and on returning to the foreground; catalog store pills use the fresh list.
- **Development database clean-up**: `local_api.py purge-test-businesses` removes
  end-to-end test businesses from the development database only.
- **History filter arrow keys (F12)**: roving focus in the filter sheet's radio groups, via a
  shared helper reused by the catalog filters.
- **Settings number fields**: the M0 Settings screen accepts Arabic-Indic digits like the
  new catalog fields (R48).
- **Close M0 task T021** (ORM models) in M0's tasks.md as "not built by design: plain SQL via
  SQLAlchemy `text()`", and **correct the M0 plan's `models/` line** in its Project Structure.

## Complexity Tracking

No constitution violations; nothing to justify.
