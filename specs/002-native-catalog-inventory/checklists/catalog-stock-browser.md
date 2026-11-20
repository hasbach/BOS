# M1 catalog and stock browser verification

- Command (from `frontend/`, Node 24): `BOS_E2E_PRODUCTION=1 npm run e2e -- e2e/m1-catalog.spec.ts e2e/m1-stock.spec.ts` (Git Bash).
- Result: **4 passed** in 5.0 minutes, one catalog and one stock scenario per language at 360 × 740.
- The initial development-server attempt timed out before tests started while compiling sign-in on demand. The production-build option passed using the same API, relay, fixtures and scenarios.
- T044 and T063 are verified. This run does not close T057 or T070: those checkpoints also require their backend and frontend suite results.
