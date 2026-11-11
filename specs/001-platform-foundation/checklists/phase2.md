# Phase 2 (Foundational) — exit evidence

**Date**: 2026-11-11
**Branch**: `001-platform-foundation`
**Run by**: orchestrating session (re-run independently of the agents that wrote the code)

## Environment

- Backend tests on the development PC against the private local PostgreSQL 17 cluster
  (`scripts/local_db.py`, 127.0.0.1:55433), as the restricted application role
  (`NOSUPERUSER`, `NOBYPASSRLS`, owns no tables). Migrations run as the owner role.
- Frontend checks with portable Node 24.22.2.
- Docker was not used: Docker Desktop on this PC failed repeatedly because of very slow
  disk flushes (see research.md R33). Container verification (T008) is deferred to staging.

## Automated results (final run)

| Check | Result |
|---|---|
| Backend full suite (`scripts/local_tests.py`) | `470 passed in 31.30s` |
| `ruff check .` | `All checks passed!` |
| `mypy` | `Success: no issues found in 20 source files` |
| Frontend `tsc --noEmit` | 0 errors |
| Frontend `eslint .` | 0 problems |
| Frontend `vitest run` | `Tests  107 passed (107)` |

## What the suites prove (Phase 2 checkpoint)

- **The database refuses cross-tenant access on its own** (`tests/isolation/test_rls.py`):
  for all nine RLS tables, tenant A cannot read, insert into, update, delete or move rows of
  tenant B; no tenant context sees nothing; RLS is enabled and forced; composite foreign
  keys stop cross-tenant references; history is append-only even for the owner role.
- **Pre-tenant access only through the five scoped functions**
  (`tests/isolation/test_scoped_functions.py`): each returns only its documented columns;
  the operator overview is refused outside operator context; operators cannot read inside
  any business.
- **Route-coverage harness** (`tests/isolation/test_route_coverage.py`): any `/api/v1` route
  without an access policy, or without its cross-tenant / missing-permission / cross-store /
  operator cases, fails the suite. Self-tested on a fake app.
- **Contract check** (`tests/contract/`): any route missing from `openapi.yaml` fails.
- **Sessions and request lifecycle**: 401/403/404 outcomes, CSRF, suspended/pending
  businesses, role changes effective on the next request, refusals recorded and surviving
  rollback, no tenant context leaking between pooled requests.
- **Idempotency** including two-thread races; **sign-in limits**; **mailer** never raising
  and recording every attempt; **CLI** commands including the demo-seed guard.
- **Frontend**: Arabic and English pages render server-side in the right language (checked
  by tests and by fetching the running server); components checked in a browser at 375 px in
  both languages, light and dark.

## Not done in this phase (moved or decided)

- **T036** (Playwright setup) moves to User Story 1: it needs the sign-in API built there.
- **T021** (ORM models): not built. Plain SQL through SQLAlchemy sessions is used throughout;
  models will be added only if a service clearly benefits. Recorded as a deliberate deviation.
- **T001, T003, T006, T008** remain open: container builds and CI have never run end to end
  (Docker unreliable here; no remote repository for CI).

## Approval

Phase 2 is a constitution approval point. Awaiting the product owner's go-ahead to start
User Story 1.
