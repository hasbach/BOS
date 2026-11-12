# Database migrations

BOS uses [Alembic](https://alembic.sqlalchemy.org/) for PostgreSQL schema changes. Migrations
are **written by hand**: there is no autogenerate. Row-level security policies, triggers,
`SECURITY DEFINER` functions and grants are part of the schema, and autogenerate does not see
them.

```
backend/migrations/
  env.py             Alembic environment (online/offline runner)
  script.py.mako     template for new revisions
  versions/          one file per revision, e.g. 0001_platform_foundation.py
```

There is no `alembic.ini`. The settings are built in code (`alembic_config()` in
`backend/app/cli.py`), so there is no second config file to keep in sync. Run migrations
through the Flask commands below, never with the bare `alembic` command.

## Which database role runs migrations

Migrations run as the **owner role** (`POSTGRES_USER`, for example `bos_owner`), using
`BOS_MIGRATION_DATABASE_URL`. The owner must be able to bypass row-level security: a superuser
in development and CI, a role with `BYPASSRLS` in production. The running API connects as the
**application role** (`BOS_APP_DB_USER`, `BOS_DATABASE_URL`), which owns nothing and cannot
bypass row-level security. If `BOS_MIGRATION_DATABASE_URL` is unset, the app URL is used,
which only works if that role can create tables, so set it.

The migration grants privileges to the application role. It reads the role name from the
environment variable `BOS_APP_DB_USER` (default `bos_app`) at migration time.

## Commands

Run from `backend/`, with `BOS_SECRET_KEY`, `BOS_DATABASE_URL` and
`BOS_MIGRATION_DATABASE_URL` set. On the Docker setup:

```bash
docker compose exec api flask db upgrade            # apply everything (head)
docker compose exec api flask db current            # which revision is applied
docker compose exec api flask db history            # list revisions
docker compose exec api flask db downgrade -1       # roll back one revision
docker compose exec api flask db downgrade base     # roll back everything
docker compose exec api flask db revision -m "add orders"   # new empty revision
```

On the development PC without Docker, `backend/scripts/local_api.py migrate` reads `../.env`
and runs `flask db upgrade` against the development database (`POSTGRES_DB`) on the private
PostgreSQL at 127.0.0.1:55433. For any other command, run Flask the same way with the
environment that script builds, or export `BOS_*` variables yourself:

```powershell
cd backend
uv run flask --app app:create_app db current
```

## Writing a migration

1. `flask db revision -m "short description"` creates `versions/<id>_<slug>.py` with empty
   `upgrade()` and `downgrade()`. Number revisions in order (`0002`, `0003`, ...) and keep
   `down_revision` pointing at the previous one: the history must stay a single line.
2. Write plain SQL through `op.get_bind().exec_driver_sql(...)` (see
   `0001_platform_foundation.py`). Keep the SQL in module-level strings so `upgrade` and
   `downgrade` stay short and readable.
3. For every new tenant-owned table:
   - include `tenant_id` and enable **and force** row-level security;
   - add the `tenant_isolation` policy comparing `tenant_id` to `app_tenant_id()`;
   - add the table to the grants for the application role, with only the privileges it needs
     (append-only tables get `SELECT, INSERT` only).
4. Write `downgrade()` so it undoes everything `upgrade()` created, in reverse dependency
   order (functions that reference tables first, then tables, then helper functions). This
   is required by the constitution (Principle VIII): every migration has a working rollback.
5. Do not edit a revision that has been applied anywhere beyond your own machine. Add a new
   one instead.
6. Update `specs/.../data-model.md` when the schema changes, and make sure the isolation
   suite (`backend/tests/isolation`) still covers every route.

## Rolling back

```bash
flask db downgrade base      # or -1 for only the latest revision
flask db upgrade             # reapply
```

`downgrade base` drops **every BOS object** the migrations created, including all data in
those tables. Take a backup first on any database that holds real data (for example
`pg_dump` as the owner role). It is a development and recovery tool, not something to run
casually on a live system.

The automated tests rely on this: the `owner_engine` fixture in `backend/tests/conftest.py`
runs `downgrade base` then `upgrade head` on the **test** database at the start of every test
session, so a broken downgrade fails the whole suite.

### What a rollback leaves behind

Verified on 2026-11-12 on a throwaway database seeded with the demo data
(`downgrade base` then `upgrade head`, then seed again; both seeds produced 2 businesses, 7
users and 5 history entries):

- Removed: all 12 BOS tables, all 8 functions, all 14 row-level-security policies, the
  append-only trigger and the sequence. Nothing was left in the `public` schema except the
  empty `alembic_version` table that Alembic itself keeps.
- Left, by design: the `alembic_version` table (now with zero rows), the database itself, the
  roles (`bos_owner`, `bos_app`; they are created outside migrations by
  `docker/db/init` or `scripts/local_db.py`), and the application role's `USAGE` on the
  `public` schema and `CONNECT` on the database. These grants are harmless without tables.
- Not undone: files uploaded to `BOS_UPLOAD_DIR` (logos). The `files` table rows are gone, so
  the files on disk are orphaned; delete the folder if you are discarding the data.

## Verifying a rollback yourself

Never run this against the development database `bos` or the test database. Create a
throwaway database on the same server, point the migration and application URLs at it, and
drop it at the end:

```sql
CREATE DATABASE bos_rollback_check OWNER bos_owner;
GRANT CONNECT ON DATABASE bos_rollback_check TO bos_app;
```

Then, with `BOS_MIGRATION_DATABASE_URL` and `BOS_DATABASE_URL` pointing at
`bos_rollback_check`, `BOS_ALLOW_DEMO_SEED=true` and a throwaway `BOS_DEMO_PASSWORD` set in
that shell only:

```bash
flask db upgrade
flask bos seed-demo
flask db downgrade base
flask db upgrade
flask bos seed-demo
```

Finally `DROP DATABASE bos_rollback_check WITH (FORCE);`.
