# T107 browser measurement harness

The [M1 performance checklist](../specs/002-native-catalog-inventory/checklists/performance.md) is the acceptance record. See the [isolated runner instructions](../frontend/performance/README.md) for provisioning. The budgets remain strictly under 1,000 ms for search and under 3,000 ms per screen, with the same mobile CDP profile, one worker, and no retries.

## Timing boundaries

| Check | Before the timer | Measured readiness |
|---|---|---|
| Adjustment Sheet | On the product detail page, open and cancel Archive without changing data. This proves the client handles clicks without opening or warming the Adjustment Sheet itself. | One Adjust click → visible dialog heading and editable quantity, then a rendering opportunity. |
| CSV Upload | Sign-in and locale only. | Cold navigation → visible template link and chooser button, then the **first** click on the enabled button must open the native file chooser. No warm-up or second click. |
| CSV Preview | Open the native chooser; retry only this setup if necessary. | Select one fresh CSV file once → visible preview summary and enabled, visible one-product Confirm button, then a rendering opportunity. The exact upload POST must return a valid one-row preview. |
| CSV Result | Open the chooser and create one successful preview; do not retry the file submission or pre-confirm. | One Confirm click → localized success with one product, one variant and one opening unit, plus the catalog link, then a rendering opportunity. The exact preview batch's Confirm POST must return that batch as committed. |

CSV API checks run alongside UI polling; the response body check does not delay the browser readiness timestamp. The one-row browser measurements do not replace the 500-row backend budget.

## Interpreting failures

- The old `bos-t107-full-3q26gso9` sweep had six missing timings each for Adjustment Sheet, CSV Preview, and CSV Result. The result cases did not reach Confirm. Flask logged no import POSTs; that alone does not identify why the browser failed to send them. The old CSV Upload readiness check proved only rendered controls, not a working chooser.
- The new `action-evidence` attachment separates fixture setup attempts, a captured browser trigger, a sent POST, its response or network failure, and uncaught page errors. A missing trigger means dispatch or harness instrumentation must be investigated. A trigger without the required product effect after proven setup is a functional failure, not a measured budget miss. A successful POST without the expected UI also fails; the API response alone is not readiness.
- A lost cold chooser click remains a failure even if Preview and Result pass after their independent setup. Do not substitute those interaction timings for cold Upload readiness or use any of these checks to infer when React hydrated.

## Focused verification

Same frozen application build as `bos-t107-full-3q26gso9`, with the repaired harness and a fresh database. Node 24.22.3 / Next.js 16.4.6 / Playwright 1.65.0, headless Edge, 360 × 740 mobile, live CDP at 150 ms RTT, 1.6 Mbps down / 0.75 Mbps up, 4× CPU, browser cache disabled and service workers blocked. No competing build or test process was detected before launch or sampling. Three attempts per locale and check, one worker, no retries; the focused run does not replace the full T107 sweep.

| Check | English (ms, repeat order) | Arabic (ms, repeat order) | Passes |
|---|---|---|---:|
| Adjustment Sheet | 446.0 / 318.1 / 286.0 | 311.2 / 275.5 / 378.8 | 6/6 |
| CSV Upload, cold | 3,302.6 miss / 4,232.1 miss / — | — / — / — | 0/6 |
| CSV Preview | 568.0 / 664.6 / — | 506.6 / 610.2 / 666.5 | 5/6 |
| CSV Result | 639.8 / 368.9 / 357.6 | 395.0 / 442.1 / 380.0 | 6/6 |

**24 attempts: 17 passes, 2 measured misses, 5 unmeasured failures.** In four cold Upload attempts, the enabled-button click was captured, but no native chooser event followed within the existing 15 s assertion window. The remaining two opened past the 3 s budget. One English Preview failed its **untimed** chooser check; no file was selected and no timed action was retried. Most successful interaction setups needed a second click on the chooser or Archive. This is consistent with early controls not being ready, but does not establish hydration as the cause. All 11 preview (201) and 6 confirm (200) POSTs matched Flask request IDs. **T107 remains open.**

Run filter: `--grep '(adjustment sheet|CSV (upload|preview|result))$' --repeat-each=3 --workers=1 --retries=0`, with `BOS_T107_PROFILE=1`. Local scratch `bos-t107-harness-xu4hg5vo/` contains timing logs, structured results and per-attempt attachments, Flask logs, harness hashes, and database/port teardown verification. The disposable DB was removed and all three isolated ports closed.
