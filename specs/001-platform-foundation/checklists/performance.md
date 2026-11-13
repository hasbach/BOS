# M0 shell performance (T088, SC-009)

**Date**: 2026-11-13 (two measurements the same day: the first with a `/me` preload, the second after the
signed-in shell was rendered on the server; the second is the current state and comes first below)

## Current results: server-rendered shell (second pass)

### Change made

- `frontend/src/app/[locale]/(shell)/layout.tsx` (server component) now asks the API for `GET /api/v1/me` while it
  renders (`lib/serverMe.ts`, `lib/serverSession.ts`): it forwards only the `bos_session` cookie to
  `BOS_API_INTERNAL_URL`, `cache: "no-store"`, 2 s timeout, one call per request (React `cache()`).
  - Person found: the guard (`SessionGuard`, new `initialMe` prop) starts with it and does not ask again, so the
    frame, the screen title and the tab bar (with the person's tabs) are in the HTML.
  - No session cookie, or the API answers `unauthenticated` / `business_suspended` / `business_pending`: a
    server redirect to `/{locale}/sign-in`, exactly where the client guard sends people.
  - Anything else (API down, slow, 5xx, 404 for an operator session, an odd body, a business cookie together with
    an operator cookie on a 401): the page renders as before and the client guard loads `/me` itself (loading,
    silent retry, error with Try again). Only in this fallback is the earlier `preload("/api/v1/me")` still sent.
- Home (`/{locale}`) redirects on the server to the person's start tab, in their saved language, so the
  placeholder -> `/me` -> client redirect step is gone (the client `StartRedirect` stays as the fallback).
- Signed-in pages are now dynamic (`ƒ` in the build) and answered with
  `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`; the service worker still caches only
  `/_next/static` and `/icons`.
- Fonts were checked and left alone: the four Plex Arabic weights loaded (400, 500, 600, 700) are all used by the
  styles; dropping subsets would change how Latin text looks in Arabic.

Tried and reverted (no change beyond noise): preloading each screen's first data request (`/staff`, `/stores`,
`/business`) from the page head when the server knows the person (employees en 3.18 s, ar 4.34 s on one run each).

### Harness change

Lighthouse is now given the session cookie in the browser's own cookie jar (puppeteer-core `Network.setCookies`
on the launched Edge, then the Lighthouse node API on the same browser) instead of an `--extra-headers` Cookie.
With server redirects the header method no longer works: Chrome sends its own jar on the redirected request
(the first run of home landed on sign-in for that reason, and was discarded). Same Lighthouse 13.6.0, Edge 157,
mobile form factor, simulated throttling, categories, 3 runs, medians, fresh business per language. CPU benchmark
index 667 to 979 across runs.

### Results (medians of 3, ms)

| Page | Lang | FCP | LCP | TBT | CLS | Speed Index | TTI | Perf | LCP <= 3.0 s |
|---|---|---|---|---|---|---|---|---|---|
| Sign-in | en | 992 | **992** | 394 | 0 | 1204 | 3205 | 90 | pass |
| Sign-in | ar | 1436 | **1436** | 326 | 0 | 1473 | 3789 | 93 | pass |
| Home (server redirect to /sales) | en | 1158 | **1158** | 468 | 0 | 1528 | 3268 | 88 | pass |
| Home (server redirect to /sales) | ar | 1240 | **1240** | 711 | 0 | 1446 | 4153 | 83 | pass |
| Employees | en | 763 | **3219** | 758 | 0 | 1322 | 3349 | 75 | fail by 0.2 s |
| Employees | ar | 902 | **4377** | 409 | 0 | 1483 | 4540 | 75 | fail by 1.4 s |
| Stores | en | 768 | **3190** | 440 | 0 | 1157 | 3236 | 82 | fail by 0.2 s |
| Stores | ar | 919 | **4338** | 284 | 0 | 1205 | 4567 | 79 | fail by 1.3 s |
| Settings | en | 756 | **3248** | 442 | 0 | 1450 | 3248 | 82 | fail by 0.25 s |
| Settings | ar | 912 | **4139** | 707 | 0 | 1627 | 4435 | 69 | fail by 1.1 s |

LCP of each run: sign-in en 992/933/1183, sign-in ar 3484/1077/1436 (first run cold), home en 1158/1202/966,
home ar 1310/1240/1193, employees en 3341/3189/3219, employees ar 4377/4363/4378, stores en 3240/3190/3030,
stores ar 4338/4125/4380, settings en 3294/3200/3248, settings ar 4105/4139/4277. Accessibility and
best-practices 100 on every run. No client `GET /api/v1/me` on any signed-in run (the network log shows only the
screen's own data requests).

### Before and after (LCP medians, ms)

| Page | en first pass (preload) | en now | ar first pass (preload) | ar now |
|---|---|---|---|---|
| Sign-in | 943 | 992 | 1107 | 1436 (noise; run 2 was 1077) |
| Home | 3863 | **1158** | 4393 | **1240** |
| Employees | 3004 | 3219 | 4082 | 4377 |
| Stores | 3260 | 3190 | 3656 | 4338 |
| Settings | 3156 | 3248 | 3648 | 4139 |

The home row ends on `/sales`, so it also measures a tab screen. The other tab screens (`/packing`, `/delivery`,
`/orders`) and the More menu are drawn from `/me` alone in the same way; they were not measured separately.

### Why the three data screens still miss

1. **Their largest paint is the loaded data, not the frame.** The frame and title now paint at FCP 0.76 to
   0.92 s (was 0.97 to 1.15 s, and it was only the "Checking your session" placeholder then). The LCP element is
   the first row of the people list (`span.name`, "LH Owner ... You"), the first store row, and on settings the
   information banner under the form. Those need all scripts (about 165 KB gzip), hydration, then the screen's
   own API call. `/me` no longer sits on that path, but it already ran in parallel after the first pass's
   preload, so removing it saves almost nothing on these screens. Preloading the data request as well did not
   move LCP either: the path is scripts + hydration, not the API (it answers in 20 to 60 ms).
2. **Arabic got slower on these screens (+0.3 to +0.7 s), English stayed within noise.** The server HTML now
   contains real text, so the browser starts downloading the fonts at once (observed at about 0.4 to 0.7 s, five
   or six IBM Plex Sans Arabic files, 190 to 230 KB) in parallel with the scripts, on the simulated 1.6 Mbps link.
   Before, the page had no Arabic text until the scripts had run, so the fonts came after them. The Arabic pages
   move 420 to 440 KB against 250 to 260 KB in English; the extra 170 KB is about 0.85 s at 1.6 Mbps, matching
   the en/ar LCP gap (about 1.0 to 1.2 s). In English the 48 KB Inter file costs less.
3. Run-to-run noise on this machine remains about +-0.3 s.

### What would close the remaining gap (not done here)

- Render the first page of the data on the server too (lists and the settings values), so the largest paint is in
  the HTML. That changes how these screens load data (the brief excluded it).
- Arabic fonts: fewer bytes before the first paint, for example a single variable Plex Arabic file, or letting
  Inter draw the Latin letters on Arabic pages. Both change the look and need a design decision.
- Production: HTTP/2 or HTTP/3 with brotli behind the real reverse proxy, then re-measure there.

### Verdict (current)

- **Pass**: sign-in en/ar (1.0 / 1.4 s), home en/ar including the start tab `/sales` (1.2 / 1.2 s; was 3.9 /
  4.4 s). The other screens drawn from `/me` alone should behave like `/sales` (not measured).
- **Fail on this harsh profile**: employees, stores, settings: English by 0.2 to 0.25 s (inside or just outside
  the +-0.3 s noise), Arabic by 1.1 to 1.4 s. Their frame and title are visible at under 1 s; the miss is the
  data rows (all three languages) plus Arabic font bytes (Arabic).
- T088 stays open for the data screens; the owner still needs to decide whether SC-009 is judged on this
  simulated profile or on a real device.

### Reproduce (second pass)

`next build` with `BOS_NEXT_DIST_DIR=.next-build`, `next start -H 127.0.0.1 -p 3300` with
`BOS_API_INTERNAL_URL=http://127.0.0.1:5100`; a fresh business per language through the API (owner, second store,
pending invitation); for each run launch Edge headless with chrome-launcher, put the owner's `bos_session` and
`NEXT_LOCALE` cookies into its jar through CDP, then run Lighthouse (node API, `formFactor: "mobile"`, default
simulated throttling) on the same browser. Scripts are not committed.

### Checks after the second change

- `npm run typecheck`, `npm run lint` clean; `npx vitest run` 585 passed (558 before, plus 27: the server-side
  `/me` outcomes and cookie forwarding in `tests/auth/server-me.test.ts`, the layout and home redirects in
  `tests/shell/server-shell.test.tsx`, the guard started from `initialMe` in `tests/auth/session.test.tsx`).
- Full `npx playwright test`: 10/10 passed (23.7 min) after one test-harness fix. The first two full runs had
  3 to 5 failures (us1 and us2 after activation, a11y on time): shell pages are now rendered on the server with
  the person, but `e2e/global-setup.ts` warmed them without a session, so the server redirected to sign-in and
  the pages' own server-side code was first compiled during the stories (single page loads of 11 to 42 s on
  `next dev` with the slow disk, against a 15 s expectation). The failing stories passed when run alone. The
  warm-up now signs in as a throwaway owner and visits each language's pages with that language saved; after
  that, the full run passed with no failures.

---

## History: first pass (preload of `/me`)

The rest of this file is the first measurement of the day and its analysis, kept as it was.
**Requirement**: SC-009: "Pages of the shell become usable within 3 seconds on a typical mid-range Android
phone on a mobile data connection." (plan.md, Performance Goals: "Shell usable within 3 seconds on a mid-range
Android phone over mobile data".)

## What "loaded" means here

Neither text names a metric, so this record fixes one:

- **Usable = Largest Contentful Paint (LCP) at or under 3.0 s.** LCP is the moment the main content of the screen
  is painted. On the signed-in screens that is the real content (the people list, the store list, the settings
  form), not the "Checking your session" placeholder, because the screen is not usable until the session check
  (`GET /me`) and the screen's own data have answered. FCP is reported too but is not the gate: on the signed-in
  screens it is only the placeholder.
- **Interactivity check**: Total Blocking Time (TBT) and Lighthouse's "interactive" time (TTI) are listed as
  information. Lighthouse 13 no longer scores TTI, so it is not used as the gate.
- "Phone on mobile data" = Lighthouse's own mobile profile with **simulated** (Lantern) throttling: Moto-class
  viewport and user agent, 150 ms RTT, 1.6 Mbps down / 0.75 Mbps up ("Slow 4G"), CPU slowdown 4x. This is a
  deliberately harsh profile.

## Environment

| Item | Value |
|---|---|
| Machine | Windows 10 dev laptop, Intel Core i7-2760QM (2011, 4 cores), 12 GB RAM, slow disk |
| Lighthouse CPU benchmark index | 630 to 870 across runs (a recent desktop scores well above 1000) |
| Browser | Microsoft Edge 157.0.4341.46, headless (`--headless=new`), run through the Lighthouse CLI |
| Lighthouse | 13.6.0 (npm, pinned), `--form-factor=mobile`, default simulated throttling, categories performance + accessibility + best-practices |
| Web server | production build: `next build` then `next start -H 127.0.0.1 -p 3300` (Next.js 16.4.6, Turbopack), HTTP/1.1, gzip, no reverse proxy |
| API | the Flask API on 127.0.0.1:5100 behind the web server's `/api/v1` proxy. **It is Werkzeug's development server**, not a production server (gunicorn) |
| Data | a fresh business per locale (created through the operator API as `e2e/fixtures.ts` does), owner activated with a throwaway password generated in-process, plus 1 extra store and 1 pending employee invitation (2 stores, 2 people in the lists) |
| Auth for Lighthouse | the owner's session cookie passed as an extra request header (never printed or stored here) |
| Runs | 3 per page and language, **median** reported; sign-in is measured signed out, the rest signed in |

Harness notes (not product bugs):

- Home is `/{locale}` and redirects client-side to the person's start tab; for the owner that is `/{locale}/sales`.
  The result below is the whole journey (entry to the start tab painted).
- Lighthouse's extra `Cookie` header is overridden by the browser's own cookie once the page has set
  `NEXT_LOCALE` (Arabic pages do). Signing in as an Arabic-language owner and adding `NEXT_LOCALE=ar` to the
  header keeps the session on every request. A first Arabic pass without it landed on sign-in and is discarded.
- The simulation is network-bound (see "Why"): lowering the CPU slowdown from 4x to 2x moved the employees
  LCP only from 3.1 s to 2.9 s, so the slow host CPU is not the main cause.

## Results (medians of 3, after the fix described below)

Times in milliseconds. "Final URL" shows where the page ended up. Accessibility 100 and best-practices 100 on
every row.

| Page | Lang | FCP | LCP | TBT | CLS | Speed Index | TTI | Perf score | LCP <= 3.0 s |
|---|---|---|---|---|---|---|---|---|---|
| Sign-in | en | 943 | **943** | 548 | 0 | 1334 | 3385 | 86 | pass |
| Sign-in | ar | 1107 | **1107** | 466 | 0 | 1133 | 3875 | 88 | pass |
| Home (to start tab /sales) | en | 1005 | **3863** | 669 | 0.049 | 2216 | 3894 | 71 | fail |
| Home (to start tab /sales) | ar | 1149 | **4393** | 764 | 0.045 | 2188 | 4585 | 64 | fail |
| Employees | en | 967 | **3004** | 331 | 0 | 1059 | 3423 | 87 | fail (by 4 ms; within noise of 3.0 s) |
| Employees | ar | 1131 | **4082** | 651 | 0 | 1753 | 4897 | 74 | fail |
| Stores | en | 971 | **3260** | 508 | 0 | 1419 | 3656 | 81 | fail |
| Stores | ar | 1146 | **3656** | 337 | 0 | 1281 | 4779 | 82 | fail |
| Settings | en | 1012 | **3156** | 314 | 0 | 1680 | 3296 | 86 | fail |
| Settings | ar | 1117 | **3648** | 647 | 0 | 1586 | 4638 | 74 | fail |

Spread of the three LCP runs per row (ms): sign-in en 2296/943/935 (first run cold), sign-in ar 1107/1106/1133,
home en 4083/3588/3863, home ar 4786/4393/4337, employees en 3004/3040/3000, employees ar 4082/4551/3596,
stores en 3084/3309/3260, stores ar 3661/3553/3656, settings en 3173/3109/3156, settings ar 3648/3535/3691.
Run-to-run noise on this machine is about +-0.3 s.

### Before the fix (same method, medians of 3, LCP in ms)

| Page | en | ar |
|---|---|---|
| Sign-in | 979 | 1095 |
| Home | 3999 | 4458 |
| Employees | 3251 | 3957 |
| Stores | 3319 | 4156 |
| Settings | 3335 | 3955 |

### Bytes and JavaScript per route (Lighthouse transfer, gzip, first visit)

Next.js 16 does not print per-route sizes in the build output, so these come from the network log of a run.
Scripts are the framework (about 135 KB: React DOM 71 KB, Next client 48 KB, runtime/router) plus about 30 KB of
application code including next-intl; the same chunks serve every route.

| Route | Scripts | Fonts en / ar | Document en / ar | Total en / ar |
|---|---|---|---|---|
| Sign-in | 178 KB | 93 / 147 KB | 13 / 15 KB | 312 / 371 KB |
| Home (then /sales) | 165 KB | 48 / 191 KB | 13 / 15 KB | 292 / 441 KB |
| Employees | 170 to 177 KB | 48 / 211 KB | 13 / 15 KB | 280 / 440 KB |
| Stores | 169 to 180 KB | 48 / 211 KB | 13 / 15 KB | 272 / 450 KB |
| Settings | 170 KB | 48 / 236 KB | 13 / 15 KB | 262 / 455 KB |

(The built HTML also lists a 110 KB nomodule polyfill chunk; modern browsers, Edge included, do not fetch it.)

## Fix made

`frontend/src/app/[locale]/(shell)/layout.tsx`: the shell layout now calls `preload("/api/v1/me", { as: "fetch",
crossOrigin: "anonymous" })` (react-dom). The browser starts the session request from the page head, in parallel
with the scripts, instead of after the scripts have downloaded and run. Verified in the network log: exactly one
`/api/v1/me` request (the guard's own `fetch` picks the preloaded answer up), and it starts at about 90 to
220 ms instead of about 810 ms. It removes one round trip from the path to every signed-in screen. It is the
only code change.

| Page (en) | LCP before | LCP after |
|---|---|---|
| Employees | 3251 | 3004 |
| Stores | 3319 | 3260 |
| Settings | 3335 | 3156 |
| Home | 3999 | 3863 |

(Arabic moved by -0.1 to -0.3 s on the same pages: employees 3957 to 4082 is inside the noise, stores 4156 to
3656, settings 3955 to 3648, home 4458 to 4393.)

Tried and reverted (no change beyond noise, so not kept): warming all five tab pages with `router.prefetch` while
`/me` loads (home en 3.8 s vs 3.9 s) and `prefetch={false}` on the list-row links (employees en 3.3 s vs 3.0 s,
ar 4.2 s vs 4.1 s).

## Why the signed-in screens are still over 3 s here

1. **Content appears only after the whole JavaScript bundle has arrived and the session check has answered.**
   The sign-in screen paints server-rendered text at FCP (0.9 to 1.1 s, passes). A signed-in screen shows only
   the "Checking your session" placeholder until the client has hydrated and `/me` has answered, then paints the
   real content, so LCP = (all scripts downloaded + hydration + data). Even `/more/language`, which needs no data
   beyond `/me`, measured 3.4 s, and `/more` 3.1 s, with `/me` already started at 90 ms. The floor of the current
   architecture on this profile is therefore about 3.0 to 3.1 s in English.
2. **It is bytes and round trips, not CPU.** About 165 to 180 KB of gzip JavaScript plus 48 KB of font, a 13 KB
   document and CSS is roughly 280 KB over a simulated 1.6 Mbps link, on HTTP/1.1 with six connections that each
   start in TCP slow start. CPU slowdown 2x instead of 4x gave only -0.2 s.
3. **Arabic costs about +0.6 to +1.0 s** because the Arabic pages download 150 to 235 KB of IBM Plex Sans Arabic
   font files (Latin and Arabic subsets of up to four weights) against 48 KB of Inter for English. That is the
   whole difference in bytes (440 KB vs 280 KB) and it matches the difference in LCP.
4. **Home adds about +0.8 s** over opening `/sales` directly (3.1 s) because it first renders the placeholder,
   waits for `/me`, then navigates to the start tab.

## What would bring them under 3 s (not done: larger than a small, design-preserving change)

- Render the shell frame and page title on the server so that the largest paint no longer waits for hydration
  and `/me` (the guard would still gate the data). This is the change that moves LCP toward the sign-in numbers.
- Serve over HTTP/2 or HTTP/3 with brotli, as the production reverse proxy will. Lighthouse here measured a bare
  Next.js server over HTTP/1.1; the production figures should be re-measured behind the real proxy.
- Arabic fonts: load fewer weights/subsets on the first screen (for example one variable font, or drop the
  Latin subset of Plex Arabic by letting Inter draw Latin letters). This changes the visual design, so it needs a
  design decision and was not done.
- Home: send people to their start tab without the placeholder step (for example a server redirect using a
  remembered start tab).

## Verdict

- **Pass**: sign-in en and ar (0.9 s and 1.1 s).
- **Fail on the harsh Lighthouse profile, not fixable here without architecture or design changes**: home,
  employees, stores, settings, in both languages. English signed-in screens are at 3.0 to 3.3 s (employees
  borderline); Arabic signed-in screens at 3.6 to 4.4 s.
- Evidence the host is not the cause: CPU slowdown 2x gives 2.9 s (employees en) against 3.1 s at 4x; the dev API
  answers in tens of milliseconds (`/me` and the list calls complete in under 100 ms in the unthrottled trace),
  and the slow disk does not enter into a measurement served from memory. What the host does inflate is run-to-run
  noise (+-0.3 s) and TBT (benchmark index 630 to 870).
- Follow-up: T088 should stay open for the server-rendered shell frame and the production-proxy re-measurement;
  the owner needs to decide whether SC-009 is judged with this simulated profile or with real-device testing.

## Reproduce

Production build with `BOS_NEXT_DIST_DIR=.next-build`, `next start -H 127.0.0.1 -p 3300` with
`BOS_API_INTERNAL_URL=http://127.0.0.1:5100`, then
`lighthouse http://127.0.0.1:3300/{en|ar}/<path> --form-factor=mobile --only-categories=performance,accessibility,best-practices
--chrome-path=<msedge.exe> --chrome-flags="--headless=new --no-sandbox" --extra-headers=<json with the Cookie header>`
three times per page. The scripts used (setup of a business, owner, store and invitation through the API; the
runner and median summary) are not committed.

## Checks after the code change

`npm run typecheck`, `npm run lint` clean; `npx vitest run` 558 passed; full `npx playwright test` 10/10 passed
(23.8 min). A first full run had one timeout (en us2-staff after a slow 5.4 min a11y run on this PC); that
scenario passed alone in 34 s and the whole suite passed on the rerun.
