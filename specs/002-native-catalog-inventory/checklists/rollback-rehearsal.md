# T111 — M1 rollback rehearsal

**Result:** Passed on 2026-11-20 (local time, UTC+02:00). `0003 → 0002 → 0003` removed M1 data and recreated the schema, not the data. Two uploaded WebP files remained on disk, and three retained `product.created` audit entries pointed to products that no longer existed.

## Isolation and setup

- Used the already-running private PostgreSQL from `scripts/local_db.py`. The harness checked the server-side address, port (`127.0.0.1:55433`), and data directory against that script before creating anything. It created `bos_t111_13256f6f091646e8a10167244664c537` from `template0`, checked `current_database()`, port, and role on both owner and app connections, and gave Flask explicit URLs for that database only. `postgres` was used only for administration of the throwaway database. No connections to `bos`, `bos_test`, or any live database; no changes to cluster settings.
- The upload root was a unique temporary `t111-7r761lu0/uploads` directory outside the repo. Both returned paths resolved inside that root. Credentials stayed in process configuration; the demo password was generated for the rehearsal. No live data was copied. HTTP requests ran through the Flask test client with no listening app server.
- Created the `0002` baseline using the M0 `seed-demo` implementation from `146b8b8:backend/app/services/seed.py`, loaded only for that CLI invocation. This matters: an initial isolated attempt to run **M1** `seed-demo` on `0002` exited `1` with `psycopg.errors.UndefinedTable: relation "warehouses" does not exist`. M1 `seed-demo` creates a default warehouse for each new tenant, so it is not the M0 seeder. After the baseline, the harness restored the M1 working-tree imports and seeded the existing demo business with `bos seed-catalog`. An intervening attempt using a separate archived M0 CLI process hit the harness timeout; that database and its temp directory were cleaned up before the successful run. The failed attempt's database and temp directory were also verified absent.

## Observed output

Selected lines from the successful run (routine logging and demo sign-in details omitted):

```text
2026-11-20T03:42:41+02:00 verified private cluster 127.0.0.1:55433
$ flask db upgrade 0002
exit=0
M0 seed implementation: 146b8b8:backend/app/services/seed.py
$ flask bos seed-demo
Created demo business 'Demo Denim House Group' (commerce, id 1800e141-3f31-5416-bc41-9394793a3777)
Created demo business 'Demo Second Shop' (social, id 20099d26-9d74-5fd1-b2e3-c9a846f4a731)
exit=0
M0 full-row baseline: {'tenants': 2, 'users': 7, 'stores': 3, 'operators': 1, 'invitations': 0, 'invitation_codes': 0, 'sessions': 0}; files=0 audit=5
seeded M0: revision=0002 M1_tables=0/13 low_stock_default=False pg_trgm=False
$ flask db upgrade head
2026-11-20 03:42:55,553 INFO alembic.runtime.migration Running upgrade 0002 -> 0003, Catalog and inventory: products, variants, inventory items, balances, the ledger, allocations.
exit=0
first head: revision=0003 M1_tables=13/13 low_stock_default=True pg_trgm=True
POST auth/sign-in -> 200
$ flask bos seed-catalog --tenant 1800e141-3f31-5416-bc41-9394793a3777 --variants 8
Added 8 variants across 2 products to demo business 1800e141-3f31-5416-bc41-9394793a3777.
exit=0
POST catalog/photos -> 201
POST catalog/products (attach photo, opening=4) -> 201
attached photo=0825ca88-60ef-4843-9c74-b86e09b408aa product=f9ac8ca7-f38a-4eba-9bdd-01f29405e4ad
GET /api/v1/catalog/photos/0825ca88-60ef-4843-9c74-b86e09b408aa/thumb -> 200 image/webp
GET /api/v1/catalog/photos/0825ca88-60ef-4843-9c74-b86e09b408aa/large -> 200 image/webp
photo path=tenant/1800e141-3f31-5416-bc41-9394793a3777/McQp59R7KgmB73gZoAN3PE0eFymxeBTu8-LKrakBfJ4.webp bytes=628 sha256=291917101e897ee80ba01552af917aeca064f2a86da706a2c793086ae6cd0650
photo path=tenant/1800e141-3f31-5416-bc41-9394793a3777/xrHLvdjgJ4X0cPaPk6CBc_FYTg2L-NtWTVFtAsgAJSs.webp bytes=218 sha256=53de97f2a6df1188f43170d875d1c7a2bfc51a288a4cb962bd5e8bccca5b4086
before rollback: {'warehouses': 2, 'import_batches': 0, 'products': 3, 'product_stores': 5, 'product_options': 2, 'option_values': 8, 'product_photos': 1, 'inventory_items': 9, 'variants': 9, 'stock_balances': 9, 'allocations': 0, 'allocation_lines': 0, 'stock_movements': 9}
audit id=f27babed-ae14-434d-aa04-7575b8545797 event=product.created target=227de13e-c6dc-4f7c-b967-2ff6b3683220 source=seed-catalog
audit id=d787c9cf-8ef3-4875-8817-04260e56514f event=product.created target=36e18313-5feb-4690-b07c-7366688add7c source=seed-catalog
audit id=812f4d31-eee9-488a-962f-200a3a775b59 event=product.created target=f9ac8ca7-f38a-4eba-9bdd-01f29405e4ad source=api
$ flask db downgrade 0002
2026-11-20 03:43:17,496 INFO alembic.runtime.migration Running downgrade 0003 -> 0002, Catalog and inventory: products, variants, inventory items, balances, the ledger, allocations.
exit=0
downgraded: revision=0002 M1_tables=0/13 low_stock_default=False pg_trgm=True
downgraded: M0 rows unchanged; all 9 audit rows unchanged; 3 product targets retained; 0 photo file rows; 2 orphan paths unchanged (size+SHA-256)
$ flask db upgrade head
2026-11-20 03:43:24,763 INFO alembic.runtime.migration Running upgrade 0002 -> 0003, Catalog and inventory: products, variants, inventory items, balances, the ledger, allocations.
exit=0
re-upgraded: revision=0003 M1_tables=13/13 low_stock_default=True pg_trgm=True
re-upgraded: {'warehouses': 2, 'import_batches': 0, 'products': 0, 'product_stores': 0, 'product_options': 0, 'option_values': 0, 'product_photos': 0, 'inventory_items': 0, 'variants': 0, 'stock_balances': 0, 'allocations': 0, 'allocation_lines': 0, 'stock_movements': 0}
re-upgraded: M0 rows unchanged; all 9 audit rows unchanged; 3 product targets retained; 0 photo file rows; 2 orphan paths unchanged (size+SHA-256)
re-upgraded: 2 default warehouses for the same tenants, with new IDs; dangling product audit rows=3
GET /api/v1/catalog/photos/0825ca88-60ef-4843-9c74-b86e09b408aa/thumb -> 404
GET /api/v1/catalog/photos/0825ca88-60ef-4843-9c74-b86e09b408aa/large -> 404
All rehearsal assertions passed.
cleanup: bos_t111_13256f6f091646e8a10167244664c537 absent from pg_database
cleanup: isolated temp upload directory absent
```

## What survived and what did not

- Full-row comparisons confirmed that the sampled M0 data (tenants excluding `low_stock_default`, users, stores, operators, invitations, invitation codes, and the pre-downgrade test session) survived both steps. The invitation tables and baseline `files` table were present but empty; existing invitation rows and store logos were not exercised. `pg_trgm` stayed installed.
- All 13 M1 tables and the low-stock column disappeared on downgrade. The re-upgrade restored them, including one new default warehouse per tenant, but restored none of the removed catalog, photo, or stock rows. Import and allocation tables were exercised for schema presence/absence only; they contained no fixture rows.
- All 9 pre-downgrade audit rows compared equal after each migration, including the 3 product entries. Before downgrade all 3 targets resolved; after re-upgrade a left join found all 3 dangling. This comparison ran before the final `404` probes. The photo's two `files` rows were gone by ID and path, but both WebPs remained byte-for-byte unchanged until temp cleanup.
- For a rollback on real data, take a coordinated backup of the database and upload storage first. Do not treat re-upgrade as recovery, delete orphan files before deciding whether to restore, or edit append-only audit history to hide dangling references. Backup/restore was not performed in this rehearsal.
