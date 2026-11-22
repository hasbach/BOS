# M1 exit gate — Native Catalog and Inventory

**Status: open.** This is a record of verified evidence, not release approval.

| Gate | Evidence | State |
| --- | --- | --- |
| English/Arabic browser journeys at 360 px | [Earlier scoped M1 run](m1-browser.md): 8 passed. Latest full Playwright run: 31 passed, 1 failed (Arabic catalog photo flow did not render the first uploaded photo tile). | Open |
| Frontend component suite, typecheck, lint, and production build | Latest component suite: 864 Vitest tests passed; TypeScript and ESLint passed. Playwright reached the app on the production build. | Passed for those runs |
| Full backend suite, lint, formatting and types | Latest full run: 1,911 pytest tests passed in 414.93 s; Ruff lint and formatting passed; mypy passed in 53 source files. | Passed |
| Reservation concurrency and inventory integrity | [US3 checkpoint](us3.md) and full backend suite with the inventory integrity fixture | Passed |
| Audit event completeness | `test_audit_completeness.py`; 269 related integration tests passed in an isolated database | Passed |
| Rollback and data-loss rehearsal | [Disposable database rehearsal](rollback-rehearsal.md) and [migration guidance](../../../backend/migrations/README.md) | Passed |
| Automated accessibility and RTL at 360 px | [T106 browser retest](ux-pass.md): 4 passed after repairs | Automated pass; visual review open |
| Development stock ledger check (T112) | `uv run --no-sync python scripts/local_api.py stock-check` from `backend/` on 2026-11-22: exit 0, zero differences for every business reported. | Passed; other T112 steps open |
| Performance, security, full quickstart and evidence mapping | Pending completion and review | Open |

Rollback caveat: re-upgrade recreates the schema, not the catalog. Photo files can be orphaned and retained audit rows can refer to deleted records.
