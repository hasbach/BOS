# Phase 2 checkpoint (T036)

**Run**: 2026-11-15, by the lead, on the development PC (private PostgreSQL 17.4 on 127.0.0.1:55433, Node 24).

- [x] Backend, from `backend/`: `uv run python scripts/local_tests.py -q -p no:cacheprovider` → `1408 passed in 100.35s`
- [x] Backend lint and types (by the implementing agent, same tree): `ruff check` clean, `ruff format --check` 94 files formatted, `mypy` no issues in 40 source files
- [x] Frontend, from `frontend/`: `npm test` → `Tests 700 passed (700)`; `npm run typecheck` clean; `npm run lint` clean
- [x] Migration 0003 upgrades from 0002 with M0 data (warehouse and low-stock backfill) and downgrades back to 0002, tested in `backend/tests/integration/test_migration_0003.py`
- [x] Contract, permission and events tests read both features (backend T027, frontend T028)
- [ ] T035 screen designs approved by the product owner (blocks every new screen task)

Notes:
- The development database still needs `uv run python scripts/local_api.py migrate` to reach 0003.
- `MAX_CONTENT_LENGTH` in `backend/app/__init__.py` is 3 MB; the photo upload route (T049) must raise it for 5 MB photos.
