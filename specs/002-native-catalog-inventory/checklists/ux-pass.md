# M1 accessibility and RTL pass (T106)

**Status:** All four revised Playwright scenarios passed after the placeholder contrast fix. T106 remains open for full visual, assistive-technology and state-matrix review.

## Coverage and method

`frontend/e2e/a11y.spec.ts` adds two T106 scenarios in each of the existing `en` and `ar` projects, with an explicit 360 × 740 CSS-pixel viewport. The tests use fresh businesses and the actual UI/API.

| Screen or state | Specific checks alongside the common audit |
| --- | --- |
| Catalog | Empty and populated search; waits for the actual debounced GET and its rendered result (an explicit no-match state first rules out the server-seeded row); named clear button, text stock chip, stock radio positions and arrow navigation in both directions, Store and More filters sheets |
| Product | Text Low/Out chips in the variant table and left-to-right SKU isolation |
| Product form | Create, validation with the invalid field linked to its message, and populated edit; English/Arabic input direction and named variant controls |
| Adjust stock | Named modal, initial focus, forward/reverse Tab containment, Escape and return to opener |
| Stock history | Populated history with an opening-stock movement |
| Low stock | Populated list with text Low/Out chips |
| Sales start tab | Named Needs attention region and link with a localized count |
| CSV import | Upload controls, preview with named row errors and a disabled import button, valid preview, and successful result |

The common audit checks the document language and direction, heading/landmark/title, horizontal document and dialog overflow, actual Tab order, and rendered enabled targets against 44 × 44 CSS pixels in both themes (excluding inline links in prose and hidden file-input proxies; wrapping checkbox/radio labels count as the target). Each keyboard stop must match `:focus-visible` and gain or change a computed outline or box shadow compared with its unfocused baseline; a permanent decorative shadow does not qualify. The audit applies the M0 axe rule set in light mode and repeats text contrast in dark mode. The per-run axe check override raises only the large-text ratio to 4.5:1; the normal-text ratio and all other built-in contrast options are preserved. Each scan attaches axe violations and incomplete results as JSON. Serious/critical axe results, definite contrast failures, size failures, and keyboard failures fail the test.

`frontend/tests/a11y/a11y-pass.test.tsx` exercises localized names, roving stock radio semantics, textual chips, dialog focus/return, field error associations, direction and SKU isolation, the start shortcut, and named CSV progress and announced row errors in both languages. These jsdom tests do not measure layout, focus visibility, targets, or contrast.

## Evidence and open findings

- **Component tests:** Node 24.22.3, `vitest run tests/a11y tests/catalog tests/components --configLoader runner --maxWorkers=2`: **188 passed in 16 files**, including 18 in the a11y file (12 new M1 cases). Vitest exited 0 but logged a Vite shutdown warning. The default config loader did not complete on this machine.
- **Browser evidence:** `BOS_E2E_API_PORT=5101 BOS_E2E_PRODUCTION=1 npm run e2e -- e2e/a11y.spec.ts --grep T106` completed in 9.5 minutes: both CSV scenarios passed; both catalog/stock scenarios failed. The run reported no visible keyboard focus indicator on catalog search in either theme, a Tab wrap failure in the Store sheet in both languages and themes, and a 20.56 × 44 px Arabic Change button on the product form. It did not report the option-pill size after the CSS target was enlarged.
- **Verified browser retest:** After adding a keyboard focus outline to search, excluding non-tabbable controls from dialog wrapping, and widening the Change button, all four scenarios passed in 4.6 minutes at 360 × 740. The dialog regression failed before the fix; the Sheet and accessibility component suites passed afterward (27 tests). The option-value remove/keep button target is now styled at 44 × 44 CSS px.
- **Assertion-review retest (2026-11-23):** Node 24.22.3, Edge, production Playwright run on web/API ports 3200/5101 (`BOS_E2E_API_PORT=5101 BOS_E2E_PRODUCTION=1 node node_modules/@playwright/test/cli.js test e2e/a11y.spec.ts --grep T106 --reporter=list,json`). All four cases passed in 8.5 minutes; the 64 axe reports (16 states × two locales × two themes) contained no violation or incomplete nodes. The two catalog runs each observed the actual no-match response and matching SKU response and verified their rendered states. No additional product changes were needed for this automated retest. The build used the shared working tree at `f774d58` with the existing a11y product repairs and concurrent product detail/stock-history work, not a clean checkout or a claim about a later merge. Focused Sheet/accessibility component retest: 27 passed; spec ESLint passed.
- **Visual spot check:** Inspected eight Edge screenshots at 360 × 740: focused Catalog search and the focused Store sheet Close control in both locales and both themes. The focus outlines were visible without clipping in the sample and the sheet/header placement mirrored in Arabic. The dark search placeholder looked dim despite the clean axe reports. A separate browser control fixture confirmed that the stricter axe run reports large text below 4.5:1 while still reporting low-contrast normal text and retaining the default emoji exemption.
- **Search placeholder regression (red):** With the actual old CSS, the English catalog scenario failed the new direct `::placeholder` contrast assertion in dark mode: the browser default `rgb(117, 117, 117)` on `rgb(19, 28, 46)` measured **3.70:1**. The assertion reads the rendered foreground, opacity and field background separately from axe. The fix uses the existing muted foreground token and full opacity.
- **Final browser retest (green):** Rebuilt and reran the same four T106 cases on ports 3200/5101: **4 passed in 5.7 minutes**, with **64 axe reports, zero violation or incomplete nodes**. Both locales measured **7.58:1 light / 7.76:1 dark** for the placeholder. The local JSON reports (`t106-review-browser.json`, `t106-placeholder-red.json`, `t106-placeholder-green.json`) and screenshots (`t106-search-*`, `t106-store-*`) are in the verification scratch directory.
- **Additional frontend check:** Latest spec ESLint passed. Vitest across the shared tree reported 889 passed and one timeout in `tests/request-locale.test.tsx` while the browser retest ran; that whole file passed (5 tests) on a focused one-worker retry. This is not a clean full-suite result.
- **Not yet verified:** Full visual/assistive-technology review, including focus-ring clipping beyond the sampled states, and the full loading/offline/error matrix. CSV progress naming is covered in jsdom; upload transients, file refusals and expired/replayed preview states are not part of the T106 browser audit. This also does not certify photo interaction, every secondary sheet, or full visual mirroring of every screen. SC-008 timing belongs to T107.

After the primary run is done, from `frontend` with Node 24:

```sh
npm run e2e -- e2e/a11y.spec.ts --grep T106
```
