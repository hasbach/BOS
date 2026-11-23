# M1 exit gate — Native Catalog and Inventory

**Status: open.** This is a record of verified evidence, not release approval.

| Gate | Evidence | State |
| --- | --- | --- |
| English/Arabic browser journeys at 360 px | Latest full Playwright run: 32 passed in 15.8 min (2026-11-23), with the shared first-page search aggregate, server-rendered Low Stock and Sales shortcut, focus-ring repair, and offline-notice deduplication. This run was launched before the follow-up Low Stock refresh and offline live-region fixes; it does not verify those fixes. | Passed for that build |
| Frontend component suite, typecheck, lint, and production build | Latest component suite: 872 Vitest tests passed; TypeScript and scoped ESLint passed. The full Playwright suite exercised the production build. | Passed for those runs |
| Full backend suite, lint, formatting and types | Latest full run, including the Windows photo-storage regression: 1,912 pytest tests passed in 271.08 s; Ruff lint and formatting passed (125 files); mypy passed in 53 source files. | Passed |
| Reservation concurrency and inventory integrity | [US3 checkpoint](us3.md) and full backend suite with the inventory integrity fixture | Passed |
| Audit event completeness | `test_audit_completeness.py`; 269 related integration tests passed in an isolated database | Passed |
| Rollback and data-loss rehearsal | [Disposable database rehearsal](rollback-rehearsal.md) and [migration guidance](../../../backend/migrations/README.md) | Passed |
| Automated accessibility and RTL at 360 px | [T106 browser retest](ux-pass.md): 4 passed after repairs | Automated pass; visual review open |
| Development stock ledger check (T112) | `uv run --no-sync python scripts/local_api.py stock-check` from `backend/` on 2026-11-22: exit 0, zero differences for every business reported. | Passed; other T112 steps open |
| Mobile performance (T107) | [Performance measurements](performance.md): after server-first detail and history rendering (`adddd49`), 11 of 12 samples met 3 seconds on those two screens. One English product-detail sample took 3.259 seconds; search and other screen budgets are still open. | Open |
| Defensive security review (T108) | [Security checklist](security.md): forward-only audit data minimization verified; historical audit data and retained business identifiers still need a sign-off decision. | Open |
| Full quickstart and sign-off (T112–T113) | [Requirements evidence matrix](requirements-evidence.md) maps all 31 functional requirements and eight success criteria. Manual scenarios 1–6 in both languages, the timed product-creation exercise, and product-owner approval are not recorded. | Open |

Rollback caveat: re-upgrade recreates the schema, not the catalog. Photo files can be orphaned and retained audit rows can refer to deleted records.
