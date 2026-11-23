# T057 / US1 — Catalog checkpoint evidence

**Automated evidence captured.** Quickstart scenario 1 demonstration and checkpoint approval are not recorded; see the [manual runbook](quickstart-runbook.md#1--catalog-t057-sc-001-sc-004-sc-007).

| Task | Automated evidence |
| --- | --- |
| T037 | [SKU unit cases](../../../backend/tests/unit/test_skus.py): **31 passed**. Boundaries, allowed characters, trim/case keys, suggestion rules, Arabic positions, truncation and collision suffixes. |
| T038 | [Product API](../../../backend/tests/integration/test_catalog_products.py): **83 passed**, integrity active. Six variants/items/balances and opening movements; field errors, stored currency/rate independence, store lifecycle, idempotent and simultaneous create, stale version, identity-preserving edits, archive/restore/delete and audit. Named SKU results below. |
| T039 | [Photo API](../../../backend/tests/integration/test_catalog_photos.py): **21 passed**, integrity active. Content and size limits (including an accepted near-5-MB upload), staging, ordered attachment, private cache/ETag/304, file path control and transaction-based file cleanup. |
| T040 | [Catalog search](../../../backend/tests/integration/test_catalog_search.py): **43 passed**, integrity active. Partial bilingual name/code/SKU search, literal wildcards, stock and admin-only filters, stable paging/counts, price ranges and active-store scope. |
| T041 | [Catalog maintenance](../../../backend/tests/integration/test_maintenance_catalog.py): **4 passed** across photo and import maintenance, integrity active. Includes expired staged photos per business and deletion only after tenant commit. |
| T042 | [M1 route isolation](../../../backend/tests/isolation/test_m1_routes.py): **49 catalog product/photo cases passed** (within the shared **67 M1 cases**, integrity active). Cases check missing `catalog.view`, staff manage denial, foreign vs invented IDs, Store B list/detail/photo exclusion and `access.denied_store`, and tenant-bound upload/list behavior. |
| T043 | [Catalog list](../../../frontend/tests/catalog/catalog-list.test.tsx), [detail](../../../frontend/tests/catalog/product-detail.test.tsx), [form](../../../frontend/tests/catalog/product-form.test.tsx), [money](../../../frontend/tests/lib/money.test.ts) and [More menu](../../../frontend/tests/shell/more-menu.test.tsx): source/assertions matched to the full Vitest suite below. Includes filters, permissions, stock numbers, both-currency display, Arabic-Indic input, dotted errors, photo retry/block and stale-version recovery. |
| T044 | [Bilingual catalog journey](../../../frontend/e2e/m1-catalog.spec.ts) in the full Playwright run: six-variant creation with photos, Store A searches, Store B absent/not found, packing refusal, variant restore, archive visibility and overflow assertions at covered screens. |

### Captured SC-004 and race results

```text
 test_a_sku_used_by_another_product_is_refused_ignoring_case_and_spaces[TEE-1] PASSED
 test_a_sku_used_by_another_product_is_refused_ignoring_case_and_spaces[tee-1] PASSED
 test_a_sku_used_by_another_product_is_refused_ignoring_case_and_spaces[  Tee-1  ] PASSED
 test_archived_variants_and_products_keep_their_sku_reserved PASSED
 test_the_same_sku_and_code_in_another_business_are_allowed PASSED
 test_two_identical_creates_at_the_same_moment_create_one_product PASSED
```

### Shared automated run records (T057, T070, T088, T102)

- **Fresh backend scope, 2026-11-23:** `880 passed in 151.26s (0:02:31)` at `f774d58` (no backend changes). From `backend/`, `uv run --no-sync python <scratch>/bos_m1_story_verify.py` ran pytest `-vv -s --color=no -p no:cacheprovider` for `tests/contract`, `tests/isolation`, SKU/numbers/CSV units and the catalog, maintenance, stock, settings, low-stock, import, allocation and integrity integration modules named in these checkpoints. Both roles verified `current_database()` on disposable `bos_story_79c3b3c694f94ca9` at port 55433 before pytest; the wrapper dropped it and confirmed absence. Full case-level log and wrapper are retained locally as `bos_m1_story_verify.log` and `bos_m1_story_verify.py` under `%LOCALAPPDATA%/hermes/cache/scratch/` (not repo artifacts).
- **Contract and registered route coverage:** [contract suite](../../../backend/tests/contract/test_contract.py) **9 passed**, including `test_every_registered_api_route_is_in_the_contract`, `test_each_path_is_checked_against_the_feature_that_defines_it` and `test_operations_of_every_feature_count_as_documented`. [Route coverage](../../../backend/tests/isolation/test_route_coverage.py) **7 passed**, including `test_every_api_route_has_a_policy_and_its_isolation_cases`. Those registration checks complement the executed endpoint tests; they are not proof that every possible response was exercised. Catalog and stock JSON cases through [`ok`/`refused`](../../../backend/tests/integration/us1_support.py) also validate the response against OpenAPI; other story-specific captures are noted in their records.
- **Integrity:** **369 passing calls** had `integrity_check` in their runtime fixtures, including one self-test that deliberately verifies the checker detects corruption. The [fixture](../../../backend/tests/conftest.py) asserts no discrepancies per World/business as the app role before teardown for opted-in ordinary tests; it does not print a separate zero-difference line for every test and is not global. [Checker detection tests](../../../backend/tests/integration/test_integrity.py) are not all clean-data scenarios. This was not a development `stock-check` run.
- **Previously executed full suites:** [exit-gate record](exit-gate.md) gives backend **1,912 passed in 271.08s**, frontend **872 Vitest tests passed**, and production Playwright **32 passed in 13.6 min** at 360 × 740 (`en` and `ar`) with catalog fixes `bdc2a6a`, Windows upload fix `df72d33`, and the local accessibility changes in the tested candidate. The shared totals are prior-run evidence, not reruns in this pass; frontend case mappings use the referenced source. They do not validate later working-tree changes to product detail and stock-history routing/seeding. The older [8-test run](m1-browser.md) and [4-test run](catalog-stock-browser.md) are historical scoped runs. See [T106](ux-pass.md) for separate accessibility evidence and remaining visual checks.

**Still manual:** The six-variant timer (SC-001), sample file/photo refusals, role/History walkthrough, stale two-session edit and the rest of scenario 1 need a recorded operator demonstration in both locales. Passing Playwright is not elapsed-time or owner approval evidence.
