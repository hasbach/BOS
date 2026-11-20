# M1 browser journeys

Node 24, Edge, 360 × 740, local PostgreSQL and Flask API, production Next.js build.

```bash
BOS_E2E_PRODUCTION=1 npm run e2e -- e2e/m1-catalog.spec.ts e2e/m1-stock.spec.ts e2e/m1-low-stock.spec.ts e2e/m1-import.spec.ts
```

**Result: 8 passed in 9.4 minutes.** Catalog creation and store scope, manager stock adjustments and history, low-stock list behavior, and CSV import ran once each in English and Arabic. The low-stock stale-pagination and repeated-selection cases also passed in the component suite. The earlier combined run did not execute any tests because automatic API startup timed out; the passing run started the local API separately and confirmed health returned HTTP 200.

This is browser journey evidence, not accessibility, performance, or full milestone approval.
