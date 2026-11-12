# User Story 4 — checkpoint evidence (T084)

**Date**: 2026-11-12
**Story**: Everyone lands in a bilingual, role-aware app shell (P4)
**Run by**: orchestrating session, independently of the agents that wrote the code

## Automated results (final run)

| Check | Result |
|---|---|
| Backend suite (`scripts/local_tests.py`), incl. route-coverage isolation, contract tests and T077 audit completeness | `967 passed` |
| `ruff check` / `ruff format --check` / `mypy` | clean / clean / `no issues found in 40 source files` |
| Frontend `tsc --noEmit` / `eslint .` | 0 errors / 0 problems |
| Frontend `vitest run` | `546 passed` (45 files) |
| Playwright, Microsoft Edge, 360×740, against the local API on 5100 (restarted on the new backend) | 8 passed — US1–US4, `en` and `ar` (9.4m incl. a throwaway screenshot spec, since deleted) |
| Production build (`next build`, separate dist dir) + `next start` on 127.0.0.1 | builds; `/manifest.webmanifest` 200, `/sw.js` 200, icons 200, HTML links the manifest (agent run) |

The frontend agent also reported two consecutive full Playwright runs at 8 passed.

## What the suites prove

- **Shell, both languages**: owner, sales agent and packing agent each get exactly their tabs
  (from `/me`) and open on their start tab; a tab that is not theirs redirects to their start
  tab; later-milestone tabs show the coming-soon state, not an error; `dir` is `rtl`/`ltr`;
  no horizontal scroll on any M0 screen at 360 px.
- **Language**: switching flips the layout at once, is saved to the account, survives sign-out
  and wins over the sign-in page's language in a fresh browser.
- **No optimistic success**: with the network off the offline notice shows, a profile save
  says it did not go through, keeps the input, and nothing is saved; Try again saves once back
  online.
- **History** (owners only): every action from stories 1–3 leaves exactly the documented
  entries with the right actor, target and time (SC-008); names are current and never resolve
  across businesses; operators are shown as the Beta team; no passwords, links, full phone
  numbers or email addresses in any entry (identifier changes are masked: "••56", "••@domain").
- **Devices**: browser and system are parsed on the server; the raw user agent is never
  returned; end one, end all others.
- **PWA**: manifest (BOS, standalone, 192/512 icons); the service worker caches only
  `/_next/static/` and `/icons/`, never `/api/` or page navigations, and is registered only in
  production builds.
- Times render in Asia/Beirut regardless of the device time zone (FR-030).

## Looked at by hand

Screenshots with real data, `en` and `ar`: coming-soon tab, More, History (e.g. "Exchange
rate: 89,500 → 90,000 LBP", "By the Beta team"), Devices ("Edge on Windows · This device"),
Language, Profile, Change password, offline banner. Found and fixed: phone numbers shown
unformatted on More and Profile (now `+961 71 612 815`).

## Deviations from tasks.md

- Service worker is `frontend/public/sw.js` (static file at a fixed URL), not `src/app/sw.ts`.
- Language save failure: the layout returns to the previous language with a Try again banner
  (design 119 kept the new language on the phone); avoids navigating to a dead page offline.
- More menu sub-lines that need extra requests (employee count, settings summary, device count)
  are omitted.

## Open items

- Service worker registration and caching not checked in a real browser on a phone; install
  to home screen not tried on a device.
- Arabic copy not taken from the design was translated by an agent — worth a native check.
- Failed sign-ins cannot be filtered by person (the account is the target, not the actor).
- `me.stores` can be stale after store changes; e2e test businesses accumulate in the dev
  database; the dev server on 3100 may rarely stall on `/me` (now ends in Try again).
