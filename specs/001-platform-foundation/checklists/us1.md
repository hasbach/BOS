# User Story 1 — checkpoint evidence (T053)

**Date**: 2026-11-11
**Story**: A business is set up and its owner signs in (P1, MVP)
**Run by**: orchestrating session, independently of the agents that wrote the code

## Automated results (final run)

| Check | Result |
|---|---|
| Backend suite (`scripts/local_tests.py`) | `649 passed` |
| `ruff check .` / `mypy` (project settings) | clean / `no issues found in 32 source files` |
| Frontend `tsc --noEmit` / `eslint .` | 0 errors / 0 problems |
| Frontend `vitest run` | `226 passed` (6 of 7 runs; one run had 1 failure — see open items) |
| Playwright `us1-activation.spec.ts`, Microsoft Edge, 360×740 | `2 passed (1.5m)` — `en` and `ar` |

## What the end-to-end run proves (both languages)

Against the real API (`scripts/local_api.py`, port 5100) and the real development database:

1. A Beta operator signs in and sets up a business in the console; the business appears as
   Pending.
2. The one-time activation link is copied; a fresh browser opens it; the token disappears from
   the address bar and never appears in any request URL.
3. The owner sees the business, their name and the Owner role, chooses a language, sets a
   password, and lands on their home screen in that language (`lang`/`dir` correct).
4. Opening the link again shows "already activated — sign in".
5. Signing in with the phone number typed in a different format works; a wrong password shows
   only the generic message.
6. The operator list shows the business as Active.
7. Isolation: the new owner cannot end another business's sessions (404 identical to an
   unknown id) and their history shows nothing of another business.

## Bug found by this checkpoint

The language-redirect matcher in `frontend/src/proxy.ts` lost a backslash, so every path
except `/` skipped the redirect and every activation link opened a 404. Unit tests did not
catch it; the end-to-end run did. Fixed, with a matcher test.

## Open items

- One frontend unit test failed once in seven runs (right after the backend suite, machine
  busy) and could not be reproduced. To be identified and made deterministic.
- T036: the Playwright CI job is not added (no remote repository yet).
- Password-reset request timing reveals whether an email exists (email sent inline). Needs a
  background job queue; scheduled for the milestone that introduces one.
- Each end-to-end run leaves two `E2E Business …` rows in the development database.
- Store-level isolation check waits for the store routes (User Story 3).

## Demo

Start the API (`bos-api` in `.claude/launch.json`, or `cd backend && uv run python
scripts/local_api.py serve`) and the web app (`bos-web`), then open
`http://127.0.0.1:3100/en/ops/sign-in` and sign in with the operator email and password from
`.env`.
