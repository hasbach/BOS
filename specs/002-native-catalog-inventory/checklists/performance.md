# M1 performance evidence (T107)

**2026-11-21 — T107 remains open.** The backend bottleneck was fixed, but mobile screen readiness still misses the 3 s gate. See the browser timing breakdown below; search and screen readiness have separate budgets.

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
