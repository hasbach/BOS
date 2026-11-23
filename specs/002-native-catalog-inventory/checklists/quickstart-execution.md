# T112 — M1 bilingual quickstart execution (2026-11-23)

**Result:** Both six-variant products were created and timed through the real UI: **EN 3.827 s** and **AR 3.738 s** (one completed sample per locale; both below 180 s). These are scripted operator-style browser measurements, **not** human first-use timings, screen-reader evidence, or product-owner approval. This is a scoped execution record, not the full [exit gate](exit-gate.md).

## Scope and setup

- Candidate: `bd3d91a575c96fc73f68b9ef8534b511390786c8`, with pre-existing frontend changes in `m1-import.spec.ts`, `ImportScreen.tsx`, and `tsconfig.json`. The isolated production frontend was built from 285 tracked frontend files copied from the working tree; pre-build source-set SHA-256 `6f084bb209779cfe1efc939a95ee356dce0d95c950348b135901a77e3475bce8`. The untracked `frontend/performance/` was not in the copy. `next build --webpack` and TypeScript finished, then `next start` listened on `127.0.0.1:3227` (Next.js 16.4.6, Node 24.22.3). Flask demo API on `127.0.0.1:5207` answered health HTTP 200; Flask's local server is not a deployment configuration.
- Isolated demo DB `bos_m1_quickstart_3227` on the private loopback PostgreSQL cluster at `55433`; verified `current_database()` as both `bos_owner` and `bos_app` before applying migrations through `0003` and seeding the two demo businesses. Separate upload and outbox paths and generated demo credentials; did not use shared development or `bos_test` databases.
- Tester: Hermes Agent using Playwright touch/keyboard control of **headed Microsoft Edge** (`Edg/158.0.0.0` UA), real fixed **360 × 740 CSS px** contexts with separate browser sessions per role. Accounts signed in via the form, checked localized routes and `html lang/dir`, and used More → Language to change the stored locale when needed. Store B sales was invited and activated through the UI in each locale. Uploads selected files through chooser events from the actual buttons. All workflow writes used the UI except runbook-specified direct demo permission checks. No cookies, passwords or invitation tokens are recorded here.
- References: [quickstart](../quickstart.md#manual-validation-scenarios) and [runbook](quickstart-runbook.md). Local raw evidence (not committed) is under `%LOCALAPPDATA%/hermes/cache/scratch/m1-quickstart-3227/`: `observations.jsonl` (step names used below), build/API logs, screenshots and selected UI-originated response bodies. UTC timestamps are from the actual run; local Beirut time was UTC+02:00.

## 1 — Catalog (SC-001, SC-004, SC-007)

| Step | Locale / role | Result / observation | Local evidence |
| --- | --- | --- | --- |
| 1.1 | EN owner | Started `17:52:52.515Z`; **3.827 s**, POST 201. Saved `JN-TEST`, **Test jeans**, product `4674a4cf-2580-4c15-8d38-f1997c2ca7b7`. Price `$45.00`; `≈ LBP 4,027,500 · approximate, at 89,500 LBP per USD`. | `en-created.png`, `en-created.json`, `1.1 timing/detail` |
| 1.1 | AR owner | Started `17:55:56.499Z`; **3.738 s**, POST 201. Saved `JN-TEST-AR`, **جينز تجريبي**, product `42e7e700-b939-43e3-bcf8-96fcc83b8fad`. Price `$45.00`; `≈ 4,027,500 ل.ل. · تقريبي، على سعر 89,500 ل.ل. للدولار`. | `ar-created.png`, `ar-created.json`, `1.1 timing/detail` |
| 1.2 | EN owner / Second Shop owner | Space-padded ` jn-test-32-blue ` on `JN-TEST2` → 409 `sku_in_use`; field named **Test jeans**. Second Shop accepted the same SKU via its form (201; product `220e1f22-557e-43b9-9b56-b1e59f9b348d`). 6 MiB PNG and PDF bytes named `renamed.jpg` were refused; Save was focusable, but each tap produced a local error with **0** product POSTs. The named draft survived both refusals and saved (201) after both removals. | `1.2 duplicate/second shop/photos verification`; `en-refused-*.png` |
| 1.2 | AR owner / Second Shop owner | ` jn-test-ar-32-blue ` on `JN-TEST2-AR` showed localized duplicate summary and field `مستخدم في Test jeans...` (uses English product name). The initial assertion incorrectly expected the Arabic name; the archived repeat captured 409 `sku_in_use`. Second Shop accepted its form (201; `1c75b9b3-d8d2-4614-984d-78e7fb96bb69`). Both bad files showed localized errors; 0 product POSTs while refused, draft saved after removal (201). | `ar-1.2 duplicate-failure.png` (selector expectation, not absence of field error), `ar-refused-*.png`, `1.2 photos verification` |
| 1.3 | EN sales A/B, owner | Store A's exact UI searches `test`, `jn-te`, `32-BLU` returned the saved product ($45.00, six variants, 30 available, photo visible on detail). Separate Store B-only sales invite/activation; no search match, copied URL returned localized Not found; Denim House History showed store denial (`access.denied_store`). | `1.3 Store A`, `1.3 invite`, `1.3 Store B` |
| 1.3 | AR sales A/B, owner | Same three search strings returned the Arabic product ($45.00, six variants, 30 available, photo). Store B-only invite/activation in RTL, no match, copied URL `غير موجود`; owner saw `وصول مرفوض: متجر غير مسموح` (`access.denied_store`). | `1.3 Store A`, `1.3 invite`, `1.3 Store B` |
| 1.4 | EN packing, owner | No Edit/Adjust on detail. Signed-in PUT with CSRF and UI-derived body → 403 `forbidden`; owner History showed no-permission denial (`access.denied_permission`); original heading remained. | `1.4` |
| 1.4 | AR packing, owner | No Edit/Adjust; same authorized 403 `forbidden`, localized owner History permission refusal and unchanged Arabic heading. | `1.4` |
| 1.5 | EN owner/manager/sales A | Two edit sessions; owner saved first, manager got 409 `product_changed` and saw `Owner checked en` instead of their stale draft. No Delete with stock; Archive hid product from staff search/direct URL, owner Archived filter showed it, same padded SKU still 409 `sku_in_use`. | `1.5 stale edit/archive`, `en-archived.png` |
| 1.5 | AR owner/manager/sales A | Same clash, localized message, owner description `Owner checked ar` restored. No Delete; Archived filter retained product, staff search/direct URL hid it, SKU still held (409). | `1.5 stale edit/archive`, `ar-archived.png` |

Timer: started when the Add product form's first field was visible after More → Catalog → Add product. Entered code, both names, selected two distinct PNGs, unticked Store B, entered Size `30/32/34` × Colour `Blue/Black`, shared `45` USD, and filled each opening field with `٥`. Waited for both upload tiles; tapped Save. Stopped after the new product heading/table were visible on `?saved=created` and two rendering frames elapsed. Excludes fixture preparation, login and navigation to opening the form; includes file selection/upload and save. The first EN attempt stopped before saving because the chooser and its visually hidden input shared an accessible name; selector was corrected. The first AR attempt stopped before the form because the account's stored locale was EN; switched through the app's language control before timing.

Both details displayed the saved six variants and 30 opening units, Store A only, the 1-of-2 photo gallery and no root horizontal overflow (`360/360`). Every saved variant was `45.00 USD`, **5 on hand / 0 reserved / 5 available**. IDs from the browser's actual create response:

| Options | EN SKU → variant ID | AR SKU → variant ID |
| --- | --- | --- |
| 30 / Blue | `JN-TEST-30-BLUE` → `eaf1a81c-3781-4575-94ca-e0f1dd83bb17` | `JN-TEST-AR-30-BLUE` → `41e11c47-d900-4a4a-a3d2-a0ed59604817` |
| 30 / Black | `JN-TEST-30-BLACK` → `6f71776c-516f-4afe-be28-5901385838d0` | `JN-TEST-AR-30-BLACK` → `7c10baf7-b31f-4105-b058-33c8f57452b4` |
| 32 / Blue | `JN-TEST-32-BLUE` → `53cc34c7-3dd2-49d8-bbff-269f281b8f6c` | `JN-TEST-AR-32-BLUE` → `b35069d4-561b-45b3-b9d4-9336a63ba693` |
| 32 / Black | `JN-TEST-32-BLACK` → `d1e64b88-3c4a-4c8a-88b2-756ef9da4989` | `JN-TEST-AR-32-BLACK` → `c4290751-767b-4a44-8059-e99a133c393d` |
| 34 / Blue | `JN-TEST-34-BLUE` → `c6cee8e1-f77a-4528-abd4-d48635ee5e36` | `JN-TEST-AR-34-BLUE` → `23a78c2c-6314-4ef4-a023-566e248d884b` |
| 34 / Black | `JN-TEST-34-BLACK` → `a28d98ed-6914-47f1-bdb9-4f1b6c7084f1` | `JN-TEST-AR-34-BLACK` → `1d8af992-d052-48fc-9d0f-e6604aee03c2` |

Photo IDs: EN `2131b475-e6bc-4b0e-81a3-183d0acb2b4c`, `cb67711e-f044-4fe1-8699-2483f7f74828`; AR `4ee279aa-4db8-4d3d-9919-0bb309c9459d`, `000f0df5-5c17-434a-98f6-5e31202db250`.

## 2 — Stock adjustments (SC-002, SC-007)

| Step | Locale / role | Result / observation | Local evidence |
| --- | --- | --- | --- |
| 2.1 | EN manager | On `QUICK-STOCK-EN`, opening 10, Add/Received +5 previewed 15/15 and saved; Damaged −1 → 14; counted 12 → movement −2. Four rows with actor/reason/time/balance; signed total 12, reserved 0. | `en-ledger.png`, `2.1 ledger/adjustments` |
| 2.1 | AR manager | On `QUICK-STOCK-AR`, same localized previews and running balances; four history rows including `العدد المحسوب 12` with −2, Demo Owner/Manager and Beirut time. | `ar-ledger.png`, `2.1 ledger/adjustments` |
| 2.2 | EN manager | Double tap sent one POST/one movement (12→13). First two-tab attempt timed out targeting a reason; keyboard retry first save 201, second 409 `stock_changed` showing 14, deliberate retry 201 → 15. Remove 20 displayed max 15; no POST. | `2.2 stale retry EN/bounds verification`, `en-remove-20.png` |
| 2.2 | AR manager | First save 201, second 409 `stock_changed` showing 13/0/13, retry 201 → 14. Double tap sent one POST/one movement (14→15). Remove 20 displayed localized maximum 15; no POST. | `2.2 stale/bounds verification`, `ar-remove-20.png` |
| 2.3 | EN owner / packing | Packing POST with CSRF and fresh idempotency key → 403 `forbidden`. Owner History showed Demo Packing permission refusal; ledger still 13 after refusal. Owner History network readback included `stock.adjusted` deltas (including 15→14 and 14→12). | `2.3 direct/history/final ledger/audit values` |
| 2.3 | AR owner / packing | Packing POST → 403 `forbidden`; localized owner History refusal, ledger remained 15. Readback included prior 10→15 and counted 14→12 with `counted_quantity: 12`. | `2.3 direct/history/final ledger/audit values` |

## 3 — Allocation integrity (SC-002, SC-003)

| Step | Locale / role | Result / observation | Local evidence |
| --- | --- | --- | --- |
| 3 / Reserved | EN owner | `Reserved` displayed all six zero values on the newly saved product (also in stock detail/history). | `en-created.png`, `1.1 detail` |
| 3 / Reserved | AR owner | `محجوز` displayed all six zero values on the newly saved product (also in stock detail/history). | `ar-created.png`, `1.1 detail` |
| 3 / backend | No UI | Fresh isolated `pytest -v -p no:cacheprovider tests/integration/test_allocation.py tests/integration/test_allocation_concurrency.py`: **38 passed in 13.77 s** (29 allocation, 9 concurrency), with the `integrity_check` fixture active and no failed integrity check. Verified both DB roles pointed at `bos_m1_qs_allocation_3227`; verified its teardown (`None`). | `allocation.log`; [prior checkpoint](us2.md#t112-scenario-3-backend-evidence-no-allocation-ui) |

Named passes: `test_two_allocations_for_the_last_unit_exactly_one_wins`, `test_twenty_threads_racing_for_five_units_exactly_five_win`, `test_one_short_line_reserves_nothing_and_every_short_line_is_listed`, `test_the_same_key_and_contents_return_the_original_whatever_its_state`, `test_the_same_key_with_other_contents_is_refused`, `test_release_returns_the_quantity_and_can_be_repeated`, `test_consume_lowers_on_hand_and_allocated_with_one_movement_per_line`, `test_an_archived_variant_or_product_is_refused[variant]` / `[product]`, and `test_allocations_racing_adjustments_never_oversell_and_lose_no_update`. No allocation UI exists in M1; lost-response behavior was not a browser exercise here.

## 4 — Low stock

| Step | Locale / role | Result / observation | Local evidence |
| --- | --- | --- | --- |
| 4.1 | EN owner | Settings default 2. Set `Q-LOW-EN` threshold 3 and damaged −2 from 5; detail showed Low, 3/0/3. Opened Low stock list from Catalog and Sales; Store A list confirmed product, variant SKU, available/on hand/threshold all 3, and Out above Low. | `4.1 list verified`, `en-low-store-a.png` |
| 4.1 | AR owner | Same for `Q-LOW-AR`: localized Low, 3/0/3, default 2, both list entry points, and matching Store A list figures with Out-first ordering. | `4.1 list verified`, `ar-low-store-a.png` |
| 4.2 | EN owner | Received +4 → 7; target absent on initial Low stock results (not an exhaustive paginated absence check). On a fresh `Q-ZERO-EN` with threshold disabled, damaged −1 from 1, previewed 0/0, saw Out on the product, and found no row in the complete filtered Store A list. Adjustment HTTP 201; response body not retained because the browser had already navigated. | `4.2`, `4.2 zero transition`, `api.log` at 20:06:24 local |
| 4.2 | AR owner | Same on separate AR fixtures. `Q-ZERO-AR` previewed 0/0 after damaged −1, showed Out and was excluded from the complete Store A list. API logged 201; response body not retained after navigation. | `4.2`, `4.2 zero transition`, `api.log` at 20:06:31 local |
| 4.3 | EN Store A sales, owner | Low/Out chips and working Low filter; no privileged list link. Signed-in GET → 403 `forbidden`, owner History event `access.denied_permission` recorded the exact path and `stock.adjust` permission. | `4.3 verification` |
| 4.3 | AR Store A sales, owner | Localized Low/Out chips and Low filter; no privileged list link. Signed-in GET → 403 `forbidden`, owner History recorded `access.denied_permission` with the exact path and `stock.adjust`. | `4.3 verification` |

## 5 — CSV import (SC-005)

| Step | Locale / role | Result / observation | Local evidence |
| --- | --- | --- | --- |
| 5.1 | EN owner | Browser downloaded `catalog-template.csv`; parsed UTF-8 BOM, Arabic `قميص` intact, two variant rows for `SHIRT`. Generated separate UTF-8 fixture (not opened in a desktop spreadsheet). Catalog prefix `M1CSV-EN-` returned zero items before import. | `en-template.csv`, `5.1 template/baseline` |
| 5.1 | AR owner | Same template encoding/content, independent fixtures and pre-import `M1CSV-AR-` zero results. No native spreadsheet check. | `ar-template.csv`, `5.1 template/baseline` |
| 5.2 | EN owner | Invalid 40+3 file: localized errors at row 42 `sku` duplicate, 43 `price` required, 44 `opening_quantity` negative; Confirm disabled; zero matching catalog rows. Corrected: preview 43 products / 43 variants / 86 units; confirm 200; all 43 unique catalog products read back, one `catalog.imported` for batch `dd0fa84d-7826-4f3d-9ad3-019231f62e1d`; sampled imported variant movement `Opening stock +2 — From a CSV import`. | `en-csv-*.png`, `en-batch.json`, `5.2` |
| 5.2 | AR owner | Same three row/column errors rendered in Arabic; no catalog change. Corrected: 43/43/86; confirm 200, all 43 catalog products, one `catalog.imported` for batch `e981b6e8-e305-4930-96ab-0f6db2117881`. Sampled `M1CSV-AR-10-SKU`: localized opening movement +2, CSV source; not an exhaustive ledger review. | `ar-csv-*.png`, `ar-batch.json`, `5.2` |
| 5.3 | EN owner | Re-upload: 86 errors (code and SKU on the 43 data rows), Confirm disabled. No photo filter showed imported product. `image_url` → 400 `unknown_columns`; 3 MiB file → local “The file is too large”, not checked, no preview response; binary `.xlsx` → 400 `file_not_csv`. | `5.3`, `en-5.3 3 MB-failure.png` (response wait timed out because browser refused locally) |
| 5.3 | AR owner | Same repeat refusals and No photo result. Arabic file-level messages for all three, same status/code behavior as EN. | `5.3`, `ar-5.3 3 MB-failure.png` |

## 6 — Business isolation (FR-030, SC-007)

| Step | Locale / role | Result / observation | Local evidence |
| --- | --- | --- | --- |
| 6.1 | EN Second Shop owner | Four genuine Denim House IDs (product, first variant's movements, first photo thumb, committed import batch) vs four well-formed random UUIDs: **4/4 equal pairs**, each 404 with `{"error":{"code":"not_found","fields":{},"message":"Not Found"}}`. Copied product address showed Not found. | `6.1 API/UI`, `en-second-not-found.png` |
| 6.1 | AR Second Shop owner | Independent valid Arabic fixture IDs vs fresh random UUIDs: **4/4 equal pairs**, same 404 body. Copied product address showed `غير موجود`. | `6.1 API/UI`, `ar-second-not-found.png` |
| 6.2 | EN both owners | Comparing owner History before/after, eight new `access.denied_tenant` entries in Second Shop (four genuine and four nonexistent request targets); none new in Denim House. | `6.2 History`, `en-second-history.png` |
| 6.2 | AR both owners | Eight new entries for the eight Arabic-run requests in Second Shop, none in Denim House; refusal shown in Arabic. | `6.2 History`, `ar-second-history.png` |

**Not covered here:** native spreadsheet opening, exhaustive per-variant CSV movement review, the full quickstart's automated suites/performance/accessibility gates or human screen-reader testing, and owner approval. Did not rerun the development `stock-check` (the [exit gate](exit-gate.md) carries that separate 2026-11-22 record). No application source edits, staging, commits, or pushes in this task.

**Teardown:** Stopped both runner-owned servers. The combined cleanup command for `bos_m1_quickstart_3227` and its scratch credential was blocked by the terminal approval channel and did not run; do not treat the demo DB or credential as removed. The separate allocation DB teardown was verified above. Cleanup of the demo DB and generated scratch credential needs an interactive approval channel.
