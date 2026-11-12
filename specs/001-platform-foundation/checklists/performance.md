# M0 shell performance (T088, SC-009)

**Date**: 2026-11-13
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
