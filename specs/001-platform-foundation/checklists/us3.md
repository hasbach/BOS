# User Story 3 — checkpoint evidence (T072)

**Date**: 2026-11-12
**Story**: Owner sets up stores and business settings (P3)
**Run by**: orchestrating session, independently of the agents that wrote the code

## Automated results (final run)

| Check | Result |
|---|---|
| Backend suite (`scripts/local_tests.py`), incl. route-coverage isolation and contract tests | `938 passed` |
| Frontend `tsc --noEmit` / `eslint .` | 0 errors / 0 problems |
| Frontend `vitest run` | `396 passed` (34 files) |
| Playwright, Microsoft Edge, 360×740, against the local API on 5100 | `6 passed (4.9m)` — US1, US2 and US3, `en` and `ar` |

The delegated agent also reported three consecutive full Playwright runs at `6 passed`
(5.1m, 4.1m, 4.3m) before the run above.

## What the suites prove

- **End to end, both languages**, on a fresh business each run: the owner adds a store with
  the number typed as `70 000 111` and sees `+961 70 000 111`; uploads a logo; changes the
  exchange rate; limits a sales agent to the first store; deactivates a store after the
  warning that lists who loses access; the sales agent is not offered Stores or Settings.
- **Backend**: E.164 normalisation from several formats; duplicate names (case-insensitive)
  and numbers among active stores refused; `confirmation_required` lists affected employees
  and pending invitations (names and roles only); last active store cannot be deactivated;
  logos decoded by content (PNG/JPEG/WebP only), 2 MB and 40 MP limits, re-encoded to WebP
  ≤ 512×512 with no metadata, under server-generated paths; settings stored as exact decimals
  with bounds, every change audited with before and after; other businesses' stores, logos and
  settings answered like unknown ones; a store-limited user gets 404 on another store's logo.
- **Session check never hangs**: `SessionGuard` and `OpsGuard` give up after 15 s, abort the
  request and show "Can't reach the server" with Try again; a late answer is ignored
  (`tests/auth/session-timeout.test.tsx`).

## End-to-end reliability on the development PC

- About one page load in a hundred, `next dev`'s `/api/v1` rewrite talking straight to the
  Werkzeug development server left `GET /me` unanswered (the API was idle). The exact fault
  was not pinned down. The e2e web server now reaches the API through a plain Node relay
  (`e2e/api-relay.mjs`, 127.0.0.1 only): 0 stalls in 500 stress loads. Production uses a
  reverse proxy, so the app is unchanged.
- `e2e/global-setup.ts` compiles every route the stories visit before they start; the test
  time limit is 240 s because first compiles on this disk are slow.

## Open items

- The development server on 3100 uses the direct rewrite and may still hit the rare stall;
  users there now see Try again after 15 s instead of an endless spinner.
- `me.stores` can be stale after store changes until the next `/me` load.
- "Last changed by" on settings is not in the `/business` contract.
- The "only owner — Deactivate disabled" state remains unreachable in the UI (unit tested).
- e2e test businesses accumulate in the development database.
