# M1 performance evidence (T107)

**2026-11-24 — T107 remains open.** The [latest full sweep](#full-sweep-with-the-native-csv-chooser-2026-11-24-latest) measured all 72 attempts: **69 passes, 3 measured misses, 0 unmeasured**. Every screen and interaction check passed 6/6, including cold CSV Upload; English search passed 3/3, Arabic search missed 3/3 against <1,000 ms. Search and screen readiness have separate budgets.

## Optimized catalog search, Low Stock list and Sales shortcut (2026-11-23)

All three checks passed **3/3 in each locale**. The unchanged Playwright assertions produced 18 timings and 18 profiles, with no budget misses or unmeasured attempts. Samples are in repeat order.

| Check | Locale | Strict budget (ms) | Individual samples (ms) | Passes |
|---|---|---:|---:|---:|
| Catalog search: input → matching row | en | <1,000 | 948.1 / 819.5 / 825.0 | 3/3 |
| Catalog search: input → matching row | ar | <1,000 | 762.2 / 772.8 / 720.0 | 3/3 |
| Low Stock list: navigation → visible Low and Out rows | en | <3,000 | 1,045.6 / 1,102.3 / 1,052.8 | 3/3 |
| Low Stock list: navigation → visible Low and Out rows | ar | <3,000 | 1,110.3 / 1,073.7 / 1,100.9 | 3/3 |
| Sales start tab: navigation → visible Low Stock link with correct destination | en | <3,000 | 1,078.0 / 1,218.5 / 1,123.6 | 3/3 |
| Sales start tab: navigation → visible Low Stock link with correct destination | ar | <3,000 | 1,207.0 / 1,260.9 / 1,214.0 | 3/3 |

- **Snapshot and profile:** `8ce90ca05fa24d2e44912895a4f8ead23e71df3d` includes backend shared aggregation `5d7871f`; the frozen working tree also includes the uncommitted server-first Low Stock/Sales changes, refresh fix, and offline live region. The isolated Next.js 16.4.6 webpack production build passed TypeScript on Node 24.22.3 before testing. Playwright 1.65.0 with headless Edge 158.0.4370.33, 360 × 740 mobile, live CDP at 150 ms RTT, 1.6 Mbps down / 0.75 Mbps up, 4× CPU, browser HTTP cache disabled and service workers blocked. One worker, no retries, `BOS_T107_PROFILE=1`; no concurrent build or suite. This is browser readiness, not Lighthouse Lantern LCP or real-device performance.
- **Fixtures and isolation:** Fresh `bos_t107_181d20fb8241` on loopback PostgreSQL 17.4 (`55433`), verified as both `bos_owner` and `bos_app` before migration `0003`; the app role was neither superuser nor `BYPASSRLS`. Seeded the demo fixtures and verified 1,000 products, 5,000 variants and 1,000 translated names for the second tenant, then ran `ANALYZE`. Search used that tenant (`Performance Denim` / `جينز الأداء`); Low Stock and Sales used the first tenant's unchanged fixtures. Flask `5197`, relay `5187` and Next `3217` were verified before the run. Stopped the three isolated servers, confirmed their ports closed, and verified the disposable database was gone. Dev and `bos_test` were not used.
- **Request evidence:** All six timed search GETs matched Flask `200` responses by request ID (70.2–93.9 ms in Flask). Search timings include the debounce and a rendering opportunity after the matching row appears; the slowest sample was 948.1 ms. No initial browser Low Stock API fetch appeared in any of the 12 navigation profiles; Flask logged 12 successful backing reads in the timing batch.
- **Separate smoke (12/12):** Both locales displayed the Low Stock rows and Sales shortcut with JavaScript disabled in private/no-store documents; anonymous navigation redirected to localized sign-in. The second tenant's list omitted the first tenant's fixture SKUs, and its API request for the first tenant's store returned 404. With JavaScript enabled, the Sales shortcut navigated to Low Stock and the store dialog opened, with no duplicate browser Low Stock GETs or console/page errors observed. Neither the refresh flow nor offline announcements were rechecked in this smoke.

Reproduction: [`frontend/performance/README.md`](../../../frontend/performance/README.md), `--grep '(catalog search|low stock list|start-tab low stock row)$' --repeat-each=3`. Raw timing/profile, smoke, build and Flask logs, DB verification and source manifest are in local scratch `bos-t107-low-search-c8k5gkpd/` (`snapshot.json` SHA-256 `fcb78de1708cf36911f131545048c2667dc78558271a2856e034a2f31a24125e`). This run meets the measured SC-006 search budget and the SC-008 timing budget for these two screens only; it does not close T107, T106 or the M1 exit gate. Other screens and the 500-row import case were not rerun here.

## Controlled backend follow-up (SC-006)

- Windows, PostgreSQL 17.4 at `127.0.0.1:55433`, fresh `bos_t107_*` database at migration `0003`. Ran `bos seed-demo`, `bos seed-catalog --variants 5000 --tenant <second-demo-tenant-id>` and `ANALYZE` after seeding. Confirmed 1,000 products and 5,000 variants as `bos_app` (neither superuser nor `BYPASSRLS`). No competing builds or test suites during the measured runs.
- Signed in through the normal Flask API as the second demo shop owner and sent sequential first-page requests to `GET /api/v1/catalog/products` through the Flask test client. These are `bos.request` server durations, excluding HTTP transport and browser work. For each case, captured the actual page and counts SQL with bound parameters and ran `EXPLAIN (ANALYZE, BUFFERS)` using `bos_app` in that tenant's transaction. Used the same seeded database before and after.

| First-page search | Before: one profiled API request | After: API median | After: API p95 |
|---|---:|---:|---:|
| Broad name (`Performance Denim`) | 29,685.6 ms | 195.4 ms | 299.7 ms |
| Full seeded SKU | 125.6 ms | 212.4 ms | 229.6 ms |
| No match | 72.1 ms | 74.9 ms | 88.0 ms |

After: 10 measured requests per case after one discarded warm-up; nearest-rank p95 is the maximum at this sample size. All returned HTTP 200 with expected first-page results, counts and cursor presence (20 of 1,000 with cursor; 1 of 1 without; 0 of 0 without). There is no before p95 for this controlled run. Full-SKU search costs more on this dataset after the change, but stayed under 230 ms in the measured series.

| Broad-search SQL | Before | After |
|---|---:|---:|
| First-page counts | 27,041.281 ms; 69,024 shared hits; `stock_balances` sequential scan ran 1,000 times (5,000 visible rows per loop) | 105.669 ms; 1,179 shared hits; `stock_balances` scanned once |
| Page | 536.243 ms; 1,556 shared hits; `stock_balances` scanned 21 times | 94.188 ms; 1,263 shared hits; `stock_balances` scanned once |

The correlated lateral stock aggregate caused the repeated scans; the plans showed zero shared blocks read from disk. The fix groups stock by matching product in both queries, keeping products with no qualifying active stock rows as out, not low. The stock filter still affects items but not first-page counts. Spot checks for broad `stock=in_stock` and `stock=out` returned 20 and 0 items respectively with the same unfiltered counts, at 192.4 and 193.9 ms after the fix. No schema change. The profiling database was dropped and its absence verified.

**Backend verification:** Full `pytest -q -p no:cacheprovider` suite: **1,911 passed** in 282.63 s. The new catalog search regression covers query and store filtering, allocated stock, archived variants, a disabled low-stock threshold, and counts that do not change with the selected stock filter. It also passed before the rewrite, confirming the expected behavior on the original query. Ruff lint, Ruff format check and mypy passed. Tests used separate throwaway databases with both connection targets verified before pytest and each database's absence verified after cleanup. The development database and `bos_test` were not used.

## Initial investigation (2026-11-20; competing build)

- On the Windows development host, applied migrations through `0003` and ran `bos seed-demo` and `bos seed-catalog --variants 5000 --tenant <id>` against a new `bos_t107_*` database on PostgreSQL 17 at `127.0.0.1:55433`. Used the second demo business (one active store, no preexisting catalog). Verified **1,000 products and exactly 5,000 variants** in that tenant. The app used its normal application DB role; the owner signed in through the real API. The disposable database was dropped and its absence verified. Neither live/dev nor `bos_test` was modified.
- Sent sequential authenticated HTTP requests to Werkzeug/Flask on `127.0.0.1:5197`: `GET /api/v1/catalog/products?q=Performance%20Denim` (first page, default stock/status and no store filter). All 1,000 seeded product names match. Each successful response was checked for HTTP 200, 20 items and a next cursor. The times below are Flask's `bos.request` durations, **not browser timings**. Other work, including a frontend build on the same host, was in progress; these are not controlled steady-state or production measurements.

| Attempt | Flask request time | Result |
|---|---:|---|
| 1 | 1,578.2 ms | 200 |
| 2 | 24,985.2 ms | 200 |
| 3 | 26,298.7 ms | 200 |
| 4 | 27,376.1 ms | 200 |
| 5 | — | Client timed out at 30 s; the request was still in `catalog_search._counts` when throwaway-DB cleanup interrupted it. The teardown 500 is not counted as an ordinary completed sample. |

This initial run identified the first-page stock-count SQL as a candidate bottleneck; the controlled follow-up above confirmed it. Exact-SKU and no-match samples were not reached on this initial run, and no p95 was calculated from it.

## Simulated mobile screens (SC-006, SC-008)

**2026-11-21 browser follow-up:** one completed sample per check and locale, 24 independent checks, one worker and no retries. **6 passed, 18 missed their strict budget**; every check reached its expected content. These are individual observations, not medians or production/real-device timings.

- Windows, Playwright 1.65.0 / headless Edge, 360 × 740 mobile emulation. Applied M0's nominal targets via live Chrome DevTools throttling: 150 ms latency, 1.6 Mbps down / 0.75 Mbps up, 4× CPU; browser HTTP cache disabled and service workers blocked. This measures live screen readiness, **not** Lighthouse's simulated Lantern LCP. No Lighthouse LCP was collected in this follow-up.
- Served a type-checked production Next.js 16.4.6 webpack build on Node 24.22.3 from a temporary frontend copy (`.next-t107`, loopback port `3217`). The API was Werkzeug/Flask on `5197`, via the local Node relay on `5187`. Build and seed completed before the benchmark; no other suite was run alongside it.
- PostgreSQL 17 on loopback `55433`, migration `0003`, fresh `bos_t107_30d17bf26d56`; verified the migration and app connection targets (`bos_owner`, `bos_app`) before migrating. Ran `seed-demo`, then `seed-catalog --variants 5000` on the second demo tenant; confirmed exactly 1,000 products and 5,000 variants, assigned 1,000 Arabic names to those same products, then ran `ANALYZE`. Other screens used the first demo tenant. Stopped the isolated servers and verified the disposable DB was dropped; dev and `bos_test` were not used.
- Search starts from an asserted no-match state and times the actual input event through the first matching row's rendering opportunity, including debounce. Both broad queries (`Performance Denim` and `جينز الأداء`) target the same 1,000 products. Screen navigation starts at navigation start and ends after Playwright observes real content and the browser has an opportunity to paint it (includes locator observation delay). The adjustment, preview and result clocks start at their respective click, file input and confirm events on an already-open parent screen. CSV preview/result use one valid row and do not replace SC-005.

| Check | Strict budget (ms) | English (ms) | Arabic (ms) |
|---|---:|---:|---:|
| Catalog search, input → matching row | <1,000 | 1,044.7 **FAIL** | 1,265.2 **FAIL** |
| Catalog list → product row and search control | <3,000 | 6,840.0 **FAIL** | 6,499.2 **FAIL** |
| Product detail → variant SKU | <3,000 | 5,012.0 **FAIL** | 5,406.0 **FAIL** |
| Create product → editable name and store option | <3,000 | 7,536.2 **FAIL** | 4,436.8 **FAIL** |
| Edit product → populated code and editable name | <3,000 | 4,581.2 **FAIL** | 5,745.8 **FAIL** |
| Adjustment sheet → editable quantity | <3,000 | 673.8 pass | 519.6 pass |
| Stock history → opening movement | <3,000 | 4,833.6 **FAIL** | 5,036.1 **FAIL** |
| Low stock list → low and out rows | <3,000 | 4,541.9 **FAIL** | 5,256.8 **FAIL** |
| Start tab → Needs attention link | <3,000 | 5,170.5 **FAIL** | 5,508.0 **FAIL** |
| CSV upload screen → template and file chooser | <3,000 | 3,650.8 **FAIL** | 4,207.3 **FAIL** |
| CSV file selected → valid preview and enabled confirm | <3,000 | 1,107.0 pass | 1,261.4 pass |
| CSV confirm → result and catalog link | <3,000 | 503.1 pass | 587.7 pass |

Rerun setup and per-check commands: [`frontend/performance/README.md`](../../../frontend/performance/README.md). The earlier compile/API timeout and the follow-up harness sign-in failure (missing CSRF header) produced no browser timing samples and are excluded from the table. Accessibility remains separate (T106).

## 500-row CSV preview (SC-005)

Previously reported T102 integration timing: **0.454 s** for the 500-row preview (vs. a 30 s budget). This is the prior agent's API/integration measurement, not a fresh browser preview timing or a re-verification of the full import atomicity criterion. See `backend/tests/integration/test_catalog_import.py` for the timed preview check.

## Playwright timing breakdown (2026-11-21)

Same live mobile profile and readiness assertions as above, using `BOS_T107_PROFILE=1`, one worker and no retries. Fresh, type-checked Next.js 16.4.6 webpack build in a source copy, Node 24.22.3, no concurrent builds or suites. The before run used `bos_t107_1d70a4ba9ebf` on loopback PostgreSQL at migration `0003`, with the verified owner/app targets and 1,000 products/5,000 variants including the Arabic name fixture; the database's absence was verified after teardown. Browser timings are not API or Lighthouse timings.

| Before (300 ms search debounce) | English (ms) | Arabic (ms) |
|---|---:|---:|
| Catalog search | 1,114.5 **miss** | 1,085.3 **miss** |
| Catalog list | 4,628.3 **miss** | 4,966.6 **miss** |
| Product detail | 4,574.7 **miss** | 4,700.5 **miss** |
| Create product | 3,415.8 **miss** | 2,285.1 pass |
| Edit product | 4,287.4 **miss** | 4,693.0 **miss** |
| Adjustment sheet | 727.1 pass | 574.1 pass |
| Stock history | 4,334.7 **miss** | 5,079.2 **miss** |
| Low stock list | 4,318.0 **miss** | 4,974.3 **miss** |
| Start-tab low-stock row | 4,298.6 **miss** | 4,821.9 **miss** |
| CSV upload | 1,492.3 pass | 1,784.5 pass |
| CSV preview | 1,240.6 pass | 1,131.7 pass |
| CSV result | No sample | No sample |

**22 completed samples: 7 passes, 15 strict budget misses.** Both additional CSV-result attempts timed out in the prerequisite preview assertion before reaching confirm; Flask recorded preview POSTs for the standalone preview cases, not for these result attempts. An upload before hydration is plausible, but this run did not prove it. These are assertion failures, not timed misses. The earlier passing CSV result samples above are historical, not a pass in this run. Single samples do not establish repeatability for the create screen or CSV upload, whose outcomes varied across runs.

| Cold catalog-list milestones (navigation-relative ms) | English | Arabic |
|---|---:|---:|
| Document first byte / complete | 160.9 / 288.0 | 163.2 / 329.9 |
| First contentful paint (not readiness) | 1,148.0 | 1,084.0 |
| Last observed JS response complete (13 chunks; 176,063 encoded bytes per locale) | 2,716.3 | 3,119.2 |
| Initial catalog API fetch start / response complete | 3,498.0 / 3,686.7 | 3,914.5 / 4,076.7 |
| Flask duration for that same request | 24.7 | 27.7 |
| Verified readiness | 4,628.3 | 4,966.6 |

The list, detail, edit, history, low-stock and start-tab routes wait for client startup before issuing their data requests (first screen API starts around 3.03–4.06 s in these samples). The cold catalog list already crosses its budget *before* the browser requests the data. Script transfers, font transfers, parsing/evaluation, hydration and other main-thread work overlap; first fetch is a client-effect milestone, not a direct measure of React hydration. The catalog list observed 1,428/1,446 ms of long-task time and 48,256/192,568 encoded font bytes (en/ar). Its browser request took 188.7/162.2 ms versus Flask's 24.7/27.7 ms, leaving a real transport cost but not the dominant delay. Create and CSV upload do not wait on a screen data API for the asserted controls; the English create miss had a 1,775.7 ms document TTFB outlier. The post-response tail includes rendering and test observation; it is not all React CPU. Prioritize removing the bundle/hydration → initial data-fetch waterfall on a scoped screen, then remeasure, rather than tuning SQL to close SC-008.

### Search experiment: shorten the debounce from 300 ms to 150 ms (reverted)

| Before: search phase (ms) | English | Arabic |
|---|---:|---:|
| Input → request start (debounce plus scheduling) | 349.5 | 379.6 |
| Browser request start → first byte | 397.8 | 315.8 |
| Flask processing, matched by request ID (part of preceding row) | 359.8 | 256.9 |
| First byte → response complete | 4.7 | 11.8 |
| Response complete → matching row's rendering opportunity | 362.5 | 378.1 |

Changed only the search pause for the experiment. A fake-timer test simulated a second edit 100 ms after the first, verified no request at 149 ms after that edit, then required exactly one request for the settled value at 150 ms. It failed on the 300 ms version (no search at 150 ms) and passed on the variant (19/19 catalog-list tests). Fresh production build and isolated seed as above. The first filtered invocation discovered no tests; excluded, and its DB was verified dropped. The corrected selection (`-g 'catalog search$' --repeat-each=3`) ran all six measurements against `bos_t107_e4d318eda1d8`; its absence was verified after stopping the servers.

| Locale | Before: input → ready (ms, one sample) | Variant: input → ready (ms, three samples in order) | Variant: input → request start (ms, same order) |
|---|---:|---|---|
| English | 1,114.5 | 1,184.8 / 1,175.4 / 1,573.5 | 287.2 / 243.0 / 219.5 |
| Arabic | 1,085.3 | 1,563.3 / 1,247.5 / 1,084.8 | 281.6 / 262.4 / 296.2 |

All six reached the expected row and **all six missed <1,000 ms**. The fetch started earlier in every variant sample, but matched Flask durations varied from 234.0 to 651.9 ms, and the browser still needed time to render the row after the response. RSC requests were observed during catalog activity; their causal impact was not isolated. With one before sample per locale, the comparison does not establish a statistically reliable end-to-end regression or improvement. The variant did not demonstrate enough benefit to justify more frequent requests during typing, so both the debounce change and its experimental unit test were reverted. Only the optional timing diagnostics and this evidence remain; no budgets or readiness assertions changed.

**Verification:** TypeScript and scoped ESLint passed. The full Vitest run with the variant had 847 passes and one operator sign-in redirect assertion failure; the rerun after restoring the original search code passed all 847 tests across 64 files. Cause of the earlier redirect failure was not isolated. SC-006 and SC-008 remain open; SC-005 above is historical evidence, and T106 accessibility/visual review and the M1 exit gate are separate.

## Catalog list: server-first initial render (2026-11-21)

The catalog page shares the shell's request-scoped `/me` and loads the same first page on the server once the session, locale and `catalog.view` are known. The existing API still enforces tenant and store scope; the fetch is `no-store`. `?no_photo=1` is forwarded only for `catalog.manage`. A usable response seeds the first render, counts and cursor; failure falls back to the existing browser load and error/retry path. Debounce, filters and pagination remain client-side.

Cold Edge tests used the same live throttle, catalog-list assertions and type-checked production build procedure as above, with three samples per locale on `bos_t107_818fca5bb01f`. Both DB connection identities and seeded counts were verified; the database was dropped and its absence verified. This is a comparison against the earlier single baseline sample per locale, not a controlled estimate of the size of the improvement.

| Locale | Before (ms, one sample) | Server-first (ms, three samples in order) | Median (ms) | Strict <3 s |
|---|---:|---|---:|---|
| English | 4,628.3 | 3,717.6 / 4,361.0 / 1,761.1 | 3,717.6 | 1 pass, 2 misses |
| Arabic | 4,966.6 | 1,764.3 / 1,773.1 / 1,671.9 | 1,764.3 | 3 passes |

No initial browser catalog GET appeared in any of the six list profiles (previously started at 3,498.0 ms English and 3,914.5 ms Arabic). Document first byte was 166.3–221.6 ms and document completion was 321.7–360.7 ms. In a separate Edge probe, each of the two demo owners saw only their own fixture rows with JavaScript disabled; the document was `private, no-cache, no-store, max-age=0, must-revalidate`. Anonymous navigation went to sign-in. With JavaScript enabled the filters dialog opened without a browser list GET or page error. The list metric measures the visible row and enabled search control, not the time at which React actually handles input.

The first six search attempts timed out in the **untimed** no-match setup: the seeded list was visible, but the early input did not issue a search. They produced no search measurement. The harness now retries only the untimed setup until the existing no-match assertion succeeds; the measured input, result assertion and budget are unchanged.

The search rerun used the same build on a fresh verified `bos_t107_5442f79525b6` database, also dropped and verified absent. All six reached the expected matching row and **all six missed <1,000 ms**: English 1,134.6 / 1,097.2 / 1,069.9 ms; Arabic 1,100.3 / 1,094.4 / 1,491.5 ms. The earlier profiled baseline was 1,114.5 / 1,085.3 ms (one sample per locale); the server-first render is not a fix for post-hydration search latency.

Verification: the new initial-render and route tests failed on the old code. Full Vitest on Node 24 passed (856 tests, 65 files), as did TypeScript, scoped ESLint and the isolated production build.

The change removes the initial fetch waterfall, but SC-006, SC-008, T107 and the M1 gate remain open. The English list still misses intermittently; product detail, edit, stock history, low stock and the start-tab row had budget misses in both languages in the prior profile and were not rerun here. Create and CSV timings remain as documented above, not newly certified.

## Product detail and stock history: matched server-first comparison (2026-11-23)

The server-first candidate met the strict 3 s budget in **11 of 12** completed samples. The baseline met it in **0 of 10** completed samples; two other baseline attempts did not reach the readiness assertion and produced no timing. The candidate still missed once on English product detail, so this does not clear SC-008 or T107.

- Frozen candidate: shared checkout at `9c67379ec529ac7f81a52526c90ce3f2bd104572`, including the local working-tree changes. The baseline restored only `ProductDetail.tsx`, `StockHistory.tsx`, and their two `page.tsx` files from `f774d588215f73decaa09959982809adcc9d05a6` and omitted `serverCatalogScreens.ts`, `catalogScreenSeed.ts`, `product-page.test.tsx`, and `stock-history-page.test.tsx`. A file-by-file SHA-256 comparison verified that those eight paths were the only source-copy differences. Both webpack production builds completed with TypeScript checks before sampling (Node 24.22.3, Next.js 16.4.6, `.next-t107` in each copy).
- Same Playwright 1.65.0 harness, headless Edge, 360 × 740, live CDP throttling at 150 ms RTT, 1.6 Mbps down / 0.75 Mbps up and 4× CPU; cold browser HTTP cache, service workers blocked. Baseline first, then candidate, one worker, three attempts per locale/screen/build, no retries, `BOS_T107_PROFILE=1`. Readiness is the visible variant SKU or opening movement plus a rendering opportunity, timed from navigation start; it is not Lighthouse LCP, measured hydration time, or real-device performance.
- Same loopback web origin `3217`, Flask API `5197` and relay `5187`; verified all hops before each batch. Same fresh PostgreSQL 17.4 DB `bos_t107_f1bd96fc3a58` on `55433`, with `bos_owner` and non-superuser/non-`BYPASSRLS` `bos_app` targets verified, migrated to `0003`. Demo Second Shop had exactly 1,000 products, 5,000 variants and 1,000 translated names; ran `ANALYZE`. Both timing batches used the first demo tenant's unchanged `DEMO-SLIM` stock fixtures. Stopped the isolated servers, verified all three ports stopped accepting connections, and verified the disposable DB was absent. Neither `bos` nor `bos_test` was used.

| Locale | Screen | Baseline samples (ms) | Baseline median | Baseline <3 s | Candidate samples (ms) | Candidate median | Candidate <3 s |
|---|---|---:|---:|---:|---:|---:|---:|
| en | Product detail | 3,825.9 / 3,643.8 / — | 3,734.9 | 0/2 | 3,259.3 / 1,363.9 / 1,108.1 | 1,363.9 | 2/3 |
| en | Stock history | — / 4,084.9 / 3,209.2 | 3,647.1 | 0/2 | 1,653.7 / 1,111.9 / 1,110.2 | 1,111.9 | 3/3 |
| ar | Product detail | 4,018.3 / 3,747.9 / 3,746.6 | 3,747.9 | 0/3 | 1,314.2 / 1,627.1 / 2,595.2 | 1,627.1 | 3/3 |
| ar | Stock history | 3,584.1 / 3,763.5 / 3,536.8 | 3,584.1 | 0/3 | 1,391.4 / 1,249.5 / 1,100.2 | 1,249.5 | 3/3 |

`—` means the 15 s visibility assertion timed out while the screen still showed loading. Flask logged the harness's untimed product lookup but no subsequent screen GETs for those two attempts. The cause of the stalls was not established. Medians and fractions use completed samples only; the English medians compare two baseline samples to three candidate samples.

**Request profiles.** The ten completed baseline cases initiated their first screen data GET at 2,473.0–3,121.7 ms. All 15 baseline browser product/movements responses matched a Flask `200` by request ID (five detail GETs and five product/movements pairs for history). None of the 12 candidate profiles had an initial page-initiated product or movements GET. After separating the harness's untimed product lookup, Flask logged one product read for each candidate detail navigation and one product plus one movements read for each candidate history navigation. The candidate English detail miss had document first byte/end at 2,219.8/2,355.0 ms, versus 158.1/291.7 and 243.6/380.8 ms on its two passing repeats. The source of the first-byte outlier was not isolated.

**Candidate smoke, outside timing (28 checks passed).** In both locales, separate owner contexts with JavaScript disabled rendered their own distinct product SKU and, on history, the opening movement (eight owner checks). Owner documents returned `200` and `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`. After visiting each URL as its owner, eight cross-tenant checks returned a private/no-store document shell (`200`) with neither the foreign SKU nor product code in the raw HTML; the corresponding product/movements API returned `404 not_found`. Eight anonymous checks returned `307` to the locale's sign-in page without the SKU. With JavaScript enabled, the adjustment sheet opened and its quantity field was editable on both routes in both locales; through these four interactions, no duplicate browser product/movements GETs, console errors or uncaught page errors were observed. These were read/open checks, not stock mutations or a comprehensive permission audit.

Raw profiles, timing logs, assertion contexts, smoke log, Flask log, DB verification and source manifest are in local scratch `bos-t107-detail-4vvjoc1a/` (`snapshot.json` SHA-256 `274fb7fd35d68aa89369b838707ec00a7f253e9ce52dd0f0ac47ba198cf1ba49`). No other screen or search case was remeasured; SC-006, SC-008 and the M1 exit gate remain open.

## Full integrated candidate sweep (2026-11-23)

**T107 remains open.** The unchanged harness ran all 12 checks in English and Arabic, three times each: **52 passes, 1 measured budget miss, 19 unmeasured failures** across 72 attempts (53 timings and 53 profiles; no skips or retries). Edit, Create, Product Detail, CSV Upload, Low Stock, and the Sales shortcut passed all six attempts each. CSV Upload measures readiness of the template link and file chooser; it does not establish that file selection or confirm works at that point.

| Check | Strict budget (ms) | English samples (ms) | English passes | Arabic samples (ms) | Arabic passes |
|---|---:|---|---:|---|---:|
| Catalog search | <1,000 | 723.6 / 769.9 / 846.3 | 3/3 | 779.7 / 2,964.4 **miss** / 848.4 | 2/3 |
| Catalog list | <3,000 | 1,248.6 / 1,235.3 / 1,171.1 | 3/3 | 1,226.5 / 1,318.0 / 1,317.0 | 3/3 |
| Product detail | <3,000 | 1,189.4 / 1,139.4 / 1,193.6 | 3/3 | 1,219.9 / 1,268.1 / 1,230.3 | 3/3 |
| Create product | <3,000 | 1,517.5 / 1,277.6 / 1,219.3 | 3/3 | 1,349.2 / 1,389.0 / 1,364.8 | 3/3 |
| Edit product | <3,000 | 1,238.4 / 1,102.1 / 1,191.3 | 3/3 | 1,225.6 / 1,268.3 / 1,226.7 | 3/3 |
| Adjustment sheet | <3,000 | — / — / — | 0/3 | — / — / — | 0/3 |
| Stock history | <3,000 | 1,566.2 / 1,481.1 / — | 2/3 | 1,257.4 / 2,265.1 / 1,385.4 | 3/3 |
| Low Stock list | <3,000 | 1,131.9 / 1,155.9 / 1,292.7 | 3/3 | 1,219.4 / 1,219.7 / 1,273.5 | 3/3 |
| Sales start-tab Low Stock shortcut | <3,000 | 1,169.1 / 1,177.8 / 1,212.6 | 3/3 | 1,325.5 / 1,345.4 / 1,337.4 | 3/3 |
| CSV upload | <3,000 | 1,130.2 / 1,125.7 / 1,059.2 | 3/3 | 1,300.5 / 1,226.2 / 1,244.9 | 3/3 |
| CSV preview | <3,000 | — / — / — | 0/3 | — / — / — | 0/3 |
| CSV result | <3,000 | — / — / — | 0/3 | — / — / — | 0/3 |

Samples are in repeat order; `—` means no timing, not a measured miss. All 20 failed attempts have individual Playwright error contexts.

| Check | Locale / repeats | What happened |
|---|---|---|
| Catalog search | ar / 2 | Matching row appeared at 2,964.4 ms. The timed GET returned 200; Flask logged 2,367.5 ms for that request (`5abcc082ed424f75bfb6275012917972`), compared with 67.7–87.5 ms for the other five timed search GETs. The cause of the server-time outlier was not isolated. |
| Adjustment sheet | en and ar / 1, 2, 3 each | Each click was followed by a 15 s dialog-heading visibility timeout. Product detail remained visible; none reached the editable-quantity readiness check. |
| CSV preview | en and ar / 1, 2, 3 each | The harness selected a file, but the preview summary never appeared within 15 s. |
| CSV result | en and ar / 1, 2, 3 each | The **untimed preview prerequisite** timed out in 15 s. Confirm was never clicked, so result readiness was not measured. |
| Stock history | en / 3 | Opening stock was visible in the error snapshot; `page.evaluate` in the readiness timing helper hit the 90 s test timeout before emitting a sample. |

Flask logged no catalog-import POST during the sweep. The sheet and CSV failures are consistent with controls being used before their handlers were ready, but this run did not prove the cause. None of the six Edit or six Product Detail profiles showed an initial browser catalog API request. The separate Arabic stock-history preflight authenticated and reached the opening movement, but took **4,313.7 ms** and missed its budget; this sample is outside the 72-attempt sweep.

- **Snapshot and profile:** `028f2e8b78c0c2d5de4de8dd48320593416d5022` plus the frozen local frontend changes (including server-first Edit and Low Stock refresh) and the existing T107 harness. The isolated Node 24.22.3 / Next.js 16.4.6 webpack production build passed TypeScript before sampling. Playwright 1.65.0, headless Edge 158.0.4370.33, 360 × 740 mobile, live CDP at 150 ms RTT, 1.6 Mbps down / 0.75 Mbps up, 4× CPU, browser HTTP cache disabled and service workers blocked. One worker, no retries; process checks found no other build or suite before build and sampling. This is browser readiness, not Lighthouse LCP or real-device performance.
- **Fixture and isolation:** Fresh `bos_t107_14ec273504ea` on the private loopback PostgreSQL 17.4 cluster (`55433`); verified `bos_owner` and non-superuser/non-`BYPASSRLS` `bos_app` connections before migration `0003`. Verified 1,000 products, 5,000 variants and 1,000 translated names in Demo Second Shop, then ran `ANALYZE`. Search used that tenant; other cases used the first tenant's demo stock fixtures. Verified Flask `5197`, relay `5187` and Next `3217`, then verified all three ports closed and the disposable DB was absent after teardown. No dev or `bos_test` database was used.
- **Evidence:** [`frontend/performance/README.md`](../../../frontend/performance/README.md), `--repeat-each=3 --workers=1 --retries=0`, `BOS_T107_PROFILE=1`. Local scratch `bos-t107-full-3q26gso9/` contains discovery, build, smoke, browser and Flask logs, `results.json`, `results/*/error-context.md`, `run.json`, and `snapshot.json` (SHA-256 `4bae48e8f6ff53b53143814383921f26e0cfe4c3f2c16d08122f335b2774475a`). Cross-checked all 72 locale/check/repeat outcomes against the timing/profile logs.
## Cold CSV Upload: shell-script preload experiment

A streaming-proxy A/B kept the build, fixture, throttle and first-click readiness assertion unchanged. Each arm had three samples per language. All 12 first clicks opened the native chooser, but none met the strict 3-second budget. The preload advanced median shell-script discovery from 2.40–2.76 s to 0.26–0.33 s with no duplicate transfers. It did not reliably improve readiness: English median 3,390.4 → 3,373.3 ms; Arabic 3,860.7 → 3,993.7 ms. The preload was not adopted. Raw measurements and cleanup verification are in local scratch `bos-t107-csv-preload-ab/run-u3ke5c_w/evidence.md`.

## Follow-up: adjustment and CSV interaction measurements

The [repaired browser measurement harness](../../../docs/performance.md#focused-verification) retained the mobile profile and budgets and retried only untimed setup. Adjustment Sheet passed 6/6, CSV Result 6/6, and CSV Preview 5/6 (one chooser setup failure before timing). Cold CSV Upload passed 0/6: two opens exceeded three seconds and four first clicks did not open the chooser. These are scoped retests on the frozen sweep build, not a passing rerun of the entire gate.

- **SC-005, separate:** The captured [T102 checkpoint](us5.md#captured-timing-and-atomicity-sc-005) reports **0.172 s** for the 500-row Flask test-client preview against <30 s. It was not rerun here and cannot substitute for the unmeasured one-row browser preview/result. SC-006 and SC-008 timing remain open; no T107 or M1 gate sign-off.

## Full sweep with the native CSV chooser (2026-11-24; latest)

**T107 remains open.** The unchanged harness ran all 12 checks in English and Arabic, three times each: **69 passes, 3 measured budget misses, 0 unmeasured failures** across 72 attempts (72 timings and 72 profiles; no skips or retries). All three misses are Arabic catalog search. Every screen and interaction check passed 6/6, including cold CSV Upload (first enabled click opens the native chooser), CSV Preview, CSV Result and the Adjustment Sheet, which had no timings in the 2026-11-23 sweep.

| Check | Strict budget (ms) | English samples (ms) | English passes | Arabic samples (ms) | Arabic passes |
|---|---:|---|---:|---|---:|
| Catalog search | <1,000 | 910.6 / 850.6 / 780.9 | 3/3 | 1,031.9 **miss** / 3,331.8 **miss** / 3,314.5 **miss** | 0/3 |
| Catalog list | <3,000 | 1,396.5 / 1,332.8 / 1,416.1 | 3/3 | 1,567.0 / 1,874.0 / 2,409.8 | 3/3 |
| Product detail | <3,000 | 1,249.2 / 1,178.0 / 1,206.7 | 3/3 | 1,193.5 / 1,313.5 / 1,174.6 | 3/3 |
| Create product | <3,000 | 1,422.1 / 1,371.3 / 1,503.7 | 3/3 | 1,902.1 / 1,839.7 / 1,788.5 | 3/3 |
| Edit product | <3,000 | 1,279.9 / 1,243.3 / 1,378.8 | 3/3 | 1,481.5 / 1,545.0 / 1,586.2 | 3/3 |
| Adjustment sheet | <3,000 | 296.6 / 272.3 / 288.3 | 3/3 | 281.3 / 293.0 / 307.7 | 3/3 |
| Stock history | <3,000 | 1,106.8 / 1,207.0 / 1,166.0 | 3/3 | 1,249.1 / 1,304.2 / 1,246.2 | 3/3 |
| Low Stock list | <3,000 | 1,143.9 / 1,233.7 / 1,235.2 | 3/3 | 1,330.2 / 1,417.2 / 1,345.2 | 3/3 |
| Sales start-tab Low Stock shortcut | <3,000 | 1,317.6 / 1,272.2 / 1,318.2 | 3/3 | 1,312.6 / 1,348.0 / 1,291.8 | 3/3 |
| CSV upload (cold, first click) | <3,000 | 1,601.5 / 1,390.2 / 1,481.5 | 3/3 | 1,623.4 / 1,575.4 / 1,720.8 | 3/3 |
| CSV preview | <3,000 | 2,168.2 / 2,741.2 / 2,423.2 | 3/3 | 2,228.3 / 2,710.7 / 2,802.8 | 3/3 |
| CSV result | <3,000 | 406.7 / 420.0 / 427.7 | 3/3 | 471.7 / 415.0 / 418.7 | 3/3 |

Samples are in repeat order. Pass totals: English 36/36, Arabic 33/36. Interaction checks (Adjustment, CSV Preview, CSV Result) are timed from the captured browser event; navigation checks from navigation start.

- **Arabic search misses:** All three reached the matching row; each failed only the `<1,000 ms` assertion. The timed search GETs matched Flask `200` responses by request ID: Arabic 188.9 / 2,587.5 / 2,657.7 ms in Flask (`e32eb7fd6aaa488380f159dd8b199ae9`, `3d5351bbd9ec4e71b6011852c6816f33` for the two slow ones), English 91.3 / 108.0 / 84.0 ms. Repeats 2 and 3 are dominated by server time; repeat 1 (1,031.9 ms) missed by 31.9 ms with a fast server response. The cause of the ~2.6 s server times was not isolated; the 2026-11-23 sweep had one similar Arabic outlier (2,367.5 ms in Flask).
- **CSV checks:** Flask logged 12 preview POSTs (`201`) and 6 confirm POSTs (`200`), one confirm per CSV Result attempt. No document request in the 24 detail/create/edit/upload navigation profiles had first byte above 158.5 ms.
- **Smoke (outside the 72):** the authenticated Arabic stock-history preflight passed at 1,740.1 ms.
- **Snapshot and profile:** `92028d828897e6f315a5f9b311905fd28b516754` plus the uncommitted working tree: the CSV chooser as a native `<input type="file">` over a label (`ImportScreen.tsx`, `import.module.css`), the related e2e/Vitest test changes, the two new T106 browser cases, and the untracked `frontend/performance/` harness. 351 files from `frontend/`, `backend/app` and `backend/migrations` were copied and hash-verified against the working tree (`snapshot.json` SHA-256 `ae2db29dcadfdd8c7171cd603a3c54843e8cd9fb3158821d8f9de35850260225`). Isolated Next.js 16.4.6 webpack production build with TypeScript check on Node 24.22.2 (portable `bos-dev` Node). Playwright 1.65.0, headless Edge 158.0.4370.33, 360 × 740 mobile, live CDP at 150 ms RTT, 1.6 Mbps down / 0.75 Mbps up, 4× CPU, browser HTTP cache disabled and service workers blocked. `--repeat-each=3 --workers=1 --retries=0`, `BOS_T107_PROFILE=1`. Process audits before the build and before sampling found no other build or test process. Budgets, throttling and readiness assertions in `frontend/performance/*` were not changed. This is browser readiness, not Lighthouse LCP or real-device performance.
- **Fixture and isolation:** Fresh `bos_t107_76b5f1e3aa40` on the private loopback PostgreSQL 17.4 cluster (`55433`); verified `bos_owner` and non-superuser/non-`BYPASSRLS` `bos_app` connections to it, migrated to `0003`, seeded demo data, and verified 1,000 products, 5,000 variants and 1,000 translated names in Demo Second Shop before `ANALYZE`. Search used that tenant; other checks used the first tenant's demo fixtures. Uploads and mail outbox were temporary run directories. Flask `5197`, relay `5187` and Next `3217`, all bound to `127.0.0.1`, were verified before sampling. Dev and `bos_test` databases were not used.
- **Teardown:** Stopped the three isolated servers, verified ports 3217, 5187 and 5197 no longer accept connections, dropped the disposable database and verified it is absent.
- **Run note:** The first driver attempt stopped after the build, before any database or server was created, when the host's default code page could not decode the build log; the stack step was rerun on the same frozen build with Python UTF-8 mode. No sample was taken in the aborted attempt.
- **Evidence:** local scratch `bos-t107-full-ibx_cvq7/` (session scratchpad): build, list, smoke, timing, Flask and relay logs, `results.json`, per-failure `error-context.md`, `run.json`, `snapshot.json`. Cross-checked all 72 locale/check/repeat outcomes against the timing and profile lines.
