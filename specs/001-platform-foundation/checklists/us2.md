# User Story 2 — checkpoint evidence (T061)

**Date**: 2026-11-12
**Story**: Owner invites employees with roles and store access (P2)
**Run by**: orchestrating session, independently of the agents that wrote the code

## Automated results (final run)

| Check | Result |
|---|---|
| Backend suite (`scripts/local_tests.py`) | `772 passed` |
| `ruff check .` / `mypy` (project settings) | clean / `no issues found in 34 source files` |
| Frontend `tsc --noEmit` / `eslint .` | 0 errors / 0 problems |
| Frontend `vitest run` | `301 passed` (twice) |
| Playwright, Microsoft Edge, 360×740, against the local API on 5100 | `4 passed (3.3m)` — US1 and US2, `en` and `ar` |

## What the suites prove

- **End to end, both languages**, on a fresh business each run: the owner invites a Sales
  agent limited to a store and copies the one-time link; the agent accepts and lands in the
  app; the agent has no Employees entry and is refused on the Employees page; `/me` lists only
  the permitted store; the owner swaps Sales for Packing and the agent's next request reflects
  it without signing in again; the owner deactivates the agent, whose next request is refused
  and whose sign-in fails; the owner's own record is read-only; no token ever appears in a
  request URL.
- **Backend**: last-owner rule under concurrent mutual demotion (two threads; exactly one
  active owner remains); accept and revoke racing on one invitation end in one outcome;
  managers cannot touch owners or owner invitations; nobody modifies themselves; every role
  without staff permission is refused on all six staff routes and the refusal is recorded;
  other businesses' users, invitations and store ids are answered exactly like unknown ones;
  an identifier used in another business is never revealed to the inviter.
- Tenant-row locks are uniformly `FOR NO KEY UPDATE` (accept, operator status change, owner
  activation reissue, staff changes).

## Open items

- Cross-store visibility in the UI is only checked with one store: there is no store API yet.
  Completed with User Story 3.
- The "only owner — Deactivate disabled" state cannot be reached in the UI today (the only
  owner can only see themselves, read-only; managers see owners read-only). Logic is unit
  tested.
- Home has no link to More until the bottom navigation arrives in User Story 4.
- The flaky frontend unit test from User Story 1 did not recur (Testing Library wait limit
  raised from 1 s to 5 s); keep watching.
