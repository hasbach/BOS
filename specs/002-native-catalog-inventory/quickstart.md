# Quickstart: Validating Native Catalog and Inventory (M1)

How to run M1 locally and prove it works end to end. Commands marked *(new in M1)* become
real when the tasks are implemented; the others exist since M0. Details are in
[contracts/openapi.yaml](contracts/openapi.yaml), [contracts/permissions.md](contracts/permissions.md)
and [data-model.md](data-model.md).

This guide uses the development PC without Docker (research R33). The Docker Compose path
from M0's quickstart works the same way (`docker compose exec api flask db upgrade`, and so
on).

## Start

From the repository root, the private PostgreSQL (port 55433):

```powershell
python scripts/local_db.py start
```

From `backend/`:

```powershell
uv sync
uv run python scripts/local_api.py migrate      # applies 0003_catalog_inventory
uv run python scripts/local_api.py bootstrap    # operator + demo data, now with a small demo catalog
uv run python scripts/local_api.py serve        # http://127.0.0.1:5100
```

From `frontend/`, in a second terminal:

```powershell
npm ci
$env:BOS_API_INTERNAL_URL = "http://127.0.0.1:5100"
& "$env:LOCALAPPDATA\bos-dev\node24\node.exe" node_modules\next\dist\bin\next dev -H 127.0.0.1 -p 3100
```

Open http://127.0.0.1:3100. Demo sign-ins are in the root `README.md` (password
`BOS_DEMO_PASSWORD` from `.env`). Stop the database at the end with
`python scripts/local_db.py stop`.

Optional clean-up of test businesses left by earlier end-to-end runs *(new in M1)*:

```powershell
uv run python scripts/local_api.py purge-test-businesses --yes
```

**Expect**: it lists and removes only non-demo `E2E Business …` businesses from the
development database, and refuses the test database.

## Automated checks

From `backend/`:

```powershell
uv run python scripts/local_tests.py                          # everything
uv run python scripts/local_tests.py tests/isolation -q       # isolation suite incl. M1 routes
uv run python scripts/local_tests.py -k "allocation or concurrency" -q   # exit-gate tests
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

From `frontend/`:

```powershell
npm test
npm run lint
npm run typecheck
npm run e2e       # Playwright, en + ar at 360 px; uses the API on 5100 and the dev database
```

Integrity of the development database *(new in M1)*, from `backend/`:

```powershell
uv run python scripts/local_api.py stock-check
```

**Expect**: all pass. The isolation suite reports cross-tenant, missing-permission and (for
every `catalog.view` route) cross-store cases for every M1 route. Every catalog and stock
test ends with the integrity check reporting zero differences (SC-003). `stock-check`
prints "0 differences" for every business and exits 0.

## Manual validation scenarios

Run each at 360 px wide, once in English and once in Arabic. "Store A agent" is the demo
user `sales-store-a@demo.bos.test`.

### 1. Build the catalog on the phone (User Story 1; SC-001, SC-004, SC-007)

1. Sign in as the demo owner. More → Catalog → Add product. Start a timer.
2. Code `JN-TEST`, English name "Test jeans", Arabic name "جينز تجريبي", options Size
   `30, 32, 34` and Colour `Blue, Black`, one price `45` USD for all, opening quantity 5
   for each variant typed with Arabic-Indic digits (`٥`), two photos, listed in Store A only.
   Save. **Expect**: under 3 minutes (SC-001); six variants with SKUs like
   `JN-TEST-30-BLUE`; the price shows "≈ LBP …" labelled approximate; each variant shows on
   hand 5, reserved 0, available 5.
3. Edit the product, type the SKU of the first variant as ` jn-test-32-blue ` (lower case,
   spaces) on another variant. **Expect**: refused on that field, naming the product that has
   it. Create the same SKU in "Demo Second Shop". **Expect**: allowed.
4. Upload a 6 MB photo and a PDF renamed `.jpg`. **Expect**: both refused as field errors;
   the rest of the form is kept; saving is blocked until they are removed.
5. Sign in as the Store A agent; search `test`, then `jn-te`, then `32-BLU`. **Expect**: the
   product found each time, with photo, variants, price and available. As the owner, invite
   a sales agent limited to Store B (More → Employees) and sign in as them. **Expect**: the
   product is not found; opening its address directly shows "not found", and the owner's
   History shows `access.denied_store`.
6. As the packing agent, open the product. **Expect**: no edit or adjust controls. Send
   `PUT /api/v1/catalog/products/<id>` from the browser console with the CSRF header.
   **Expect**: 403, and the owner's History shows `access.denied_permission`.
7. Open the product's edit form in two browsers as owner and manager; save in one, then the
   other. **Expect**: the second is told the product changed and shown the current version.
8. Try to delete the product. **Expect**: not offered (it has opening stock); archive it.
   **Expect**: gone from the Store A agent's search, still in the owner's archived filter,
   its SKUs still refused for new variants.

### 2. Stock ledger and adjustments (User Story 2; SC-002, SC-007)

1. As the manager, open a variant with on hand 10 (or set it with a count correction).
   Adjust: Add, received, 5. **Expect**: preview "on hand 15, available 15" before saving;
   after saving on hand 15.
2. Remove, damaged, 1; then Set count 12. **Expect**: the count is recorded as a movement of
   −2 with counted 12. The variant's stock history lists every movement with reason,
   quantity, person, time and the running on-hand number; the movements sum to 12.
3. Open the adjust sheet in two windows; save in one, then the other. **Expect**: the second
   is refused, shows the new numbers, and can repeat knowingly.
4. Try Remove 20. **Expect**: refused, stock may not go below zero or below reserved.
5. Double-tap Save. **Expect**: one movement only. (A retry after a lost answer, which
   reuses the same Idempotency-Key, is proven by the integration tests, since it cannot be
   timed by hand.)
6. As the owner, open History. **Expect**: `stock.adjusted` entries with old and new
   numbers. As the packing agent, post an adjustment directly. **Expect**: 403, recorded.

### 3. Availability that cannot oversell (User Story 3; exit gate, SC-002, SC-003)

No screen exists in M1; run the tests and read their captured output:

```powershell
uv run python scripts/local_tests.py tests/integration/test_allocation.py tests/integration/test_allocation_concurrency.py -v
```

**Expect** (each a named test): two simultaneous allocations for the last unit — exactly
one succeeds, available 0; a two-variant request with one short — nothing reserved; the same
request key repeated — first result returned, reserved once; the same key with other
contents — refused; release restores available; consume lowers on hand and reserved with an
`allocation_consumed` movement; archived variants refused; 20 threads racing for 5 units —
exactly 5 succeed; adjustments racing allocations — never negative, no lost update; the
integrity check after each scenario reports zero differences.

In the development database "Reserved" is 0 everywhere until M2 creates orders; the product
screen still shows the column, as designed.

### 4. Low-stock warnings (User Story 4)

1. As the owner, Settings → low-stock level default: confirm it shows 2 (FR-023).
2. Set one variant's level to 3 with 5 available; record damaged −2. **Expect**: "Low" chip
   on the variant and product; the variant appears in the Low stock list (from the start
   tab's low-stock row or the Catalog app bar) with product, variant, available, on hand and
   level. Out-of-stock variants are listed above it.
3. Record received +4. **Expect**: it leaves the list.
4. Set another variant's level to 0 and take it to 0 available. **Expect**: "Out" label, not
   in the Low stock list.
5. As the Store A agent: **Expect** "Low"/"Out" chips and the Low stock filter pill in the
   catalog, but no Low stock list; `GET /api/v1/catalog/low-stock` answers 403 and is
   recorded.

### 5. Import from a spreadsheet (User Story 5; SC-005)

1. As the owner, Catalog → Import CSV → download the template. **Expect**: opens in a
   spreadsheet with Arabic intact; one example product.
2. Fill 40 valid rows, plus one duplicate SKU, one missing price and one negative quantity.
   Upload. **Expect**: the preview lists exactly those three rows with row number, column and
   a reason in the current language; Confirm is not offered; the catalog is unchanged.
3. Fix the rows and upload again. **Expect**: counts of products, variants and opening units;
   Confirm. **Expect**: everything created; each variant's history shows an opening movement;
   History shows one `catalog.imported`.
4. Upload the same file again. **Expect**: every row reported as SKU or code already in use;
   nothing created.
5. Upload a file with an `image_url` column, a 3 MB file and a `.xlsx`. **Expect**: each
   refused with one clear message before row checks.
6. Products imported have no photos: the owner's "No photo" filter lists them.

### 6. Isolation between businesses (FR-030, SC-007)

1. As the "Demo Second Shop" owner, request a demo product id, a variant's movements, a
   photo and an import batch id of "Demo Denim House Group".
2. **Expect**: "not found" for each, identical to a made-up id; the Second Shop's History
   shows `access.denied_tenant`; the demo business's history shows nothing.

## Performance (SC-005, SC-006, SC-008)

```powershell
uv run flask --app app:create_app bos seed-catalog --variants 5000 --tenant <demo business id>   # new in M1, dev only
```

(run with the environment `local_api.py` builds, and `BOS_ALLOW_DEMO_SEED=true`). Then
measure catalog search and the new screens on the simulated mobile profile used for M0
(`specs/001-platform-foundation/checklists/performance.md`). **Expect**: search results in
under 1 second; every new screen usable in under 3 seconds and passing the M0 accessibility
checks in both languages. The 500-row import timing is an integration test
(`test_catalog_import.py::test_500_rows_preview_within_budget`).

## Exit gate for M1

- SKU integrity tests (SC-004) and allocation integrity and concurrency tests (SC-002,
  SC-003) pass, with output captured.
- All automated checks above pass; scenarios 1–6 demonstrated in both languages.
- Migration `0003` applied and rolled back (`downgrade 0002`, `upgrade head`) on a
  throwaway database as in `backend/migrations/README.md`, with what the rollback leaves
  behind written down.
- README updated: new commands, `BOS_ENVIRONMENT`, demo catalog, import template.
