# M1 exit gate — Native Catalog and Inventory

**Status: open.** This is a record of verified evidence, not release approval.

| Gate | Evidence | State |
| --- | --- | --- |
| English/Arabic catalog, stock, low-stock, and CSV journeys at 360 px | [Combined browser run](m1-browser.md): 8 passed | Passed |
| Full frontend suite, typecheck, lint, and production build | 834 Vitest tests passed; TypeScript and ESLint passed; Next.js production build exercised by Playwright | Passed for that run |
| Full backend suite, lint, formatting and types | 1,910 pytest tests passed in 419.89 s; Ruff lint and formatting passed; mypy passed in 53 source files | Passed |
| Reservation concurrency and inventory integrity | [US3 checkpoint](us3.md) and full backend suite with the inventory integrity fixture | Passed |
| Audit event completeness | `test_audit_completeness.py`; 269 related integration tests passed in an isolated database | Passed |
| Rollback and data-loss rehearsal | [Disposable database rehearsal](rollback-rehearsal.md) and [migration guidance](../../../backend/migrations/README.md) | Passed |
| Automated accessibility and RTL at 360 px | [T106 browser retest](ux-pass.md): 4 passed after repairs | Automated pass; visual review open |
| Performance, security, full quickstart and evidence mapping | Pending completion and review | Open |

Rollback caveat: re-upgrade recreates the schema, not the catalog. Photo files can be orphaned and retained audit rows can refer to deleted records.
