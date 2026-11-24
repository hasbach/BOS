# BOS — Beta Orders Solutions

**From Conversation to Delivery.** (Arabic: من أول رسالة لآخر طلبية)

BOS is a mobile-first, multi-tenant social commerce and order management platform, a product
by Beta Marketing Solutions. Sellers who take orders through chat apps and social media run
their orders, stores and staff from one place. It ships as one platform in two editions:

- **BOS Social** for sellers without a website.
- **BOS Commerce** for businesses that connect WooCommerce and run several stores.

The product brief is [social_commerce_saas_mvp_speckit.md](social_commerce_saas_mvp_speckit.md).
This repository currently contains two completed milestones:

- **M0, the platform foundation**: businesses (tenants) with row-level isolation, stores,
  staff, roles and store access, sign-in, the operator area for Beta staff, the history
  (audit) trail, and the English/Arabic mobile app shell.
- **M1, native catalog and inventory**: products with variants and photos, bilingual
  search, CSV import, stock adjustments and history, low stock, and stock reservations.

Orders (M2, next), delivery, WhatsApp and WooCommerce come in later milestones; see the
[roadmap](social_commerce_saas_mvp_speckit.md#92-implementation-milestones-features-not-spec-kit-command-phases).

- Constitution: [.specify/memory/constitution.md](.specify/memory/constitution.md)
- M0 specification, plan, tasks, contracts: [specs/001-platform-foundation/](specs/001-platform-foundation/)
  (start with [spec.md](specs/001-platform-foundation/spec.md),
  [plan.md](specs/001-platform-foundation/plan.md) and
  [quickstart.md](specs/001-platform-foundation/quickstart.md))
- M1 specification, plan, tasks, contracts: [specs/002-native-catalog-inventory/](specs/002-native-catalog-inventory/)
  (start with [spec.md](specs/002-native-catalog-inventory/spec.md) and
  [quickstart.md](specs/002-native-catalog-inventory/quickstart.md))

## Stack

- **Backend**: Python 3.12, Flask, SQLAlchemy, Alembic (hand-written migrations), PostgreSQL 16
  with row-level security. Dependencies are managed with [uv](https://docs.astral.sh/uv/).
- **Frontend**: Next.js (React, TypeScript) on Node 24, `next-intl` for English and Arabic
  (right-to-left), installable PWA. The browser only talks to the web app; the web app
  forwards `/api/v1/*` to the API.
- **Tests**: pytest (backend), Vitest (frontend), Playwright (end to end).

## Project layout

```
backend/            Flask API (package app/), tests/, migrations/, scripts/
  app/api/            HTTP routes        app/services/   business logic (incl. seed.py)
  app/core/           db, tenancy, security, audit       app/cli.py   flask db / flask bos commands
  migrations/         Alembic (see migrations/README.md)
  scripts/            local_api.py, local_tests.py (run without Docker)
frontend/           Next.js app (src/), messages/ (en, ar), tests/ (Vitest), e2e/ (Playwright)
docker/db/init/     creates the application database role and the test database
docker-compose.yml  development stack: db, api, web, mail
scripts/local_db.py a private PostgreSQL for development without Docker
specs/              specifications, plans, tasks and API contracts (source of truth for tests)
design/             design assets
.env.example        environment template
.github/workflows/  CI (ruff, mypy, pytest; eslint, tsc, Vitest)
```

## Configuration: `.env`

```bash
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

Change every value marked `CHANGE_ME`. `.env` is ignored by git; never commit it and never
put real secrets in `.env.example`. Docker Compose, `scripts/local_db.py`,
`backend/scripts/local_api.py`, `backend/scripts/local_tests.py` and the end-to-end tests all
read this one file.

| Variable | Meaning |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Database **owner** role and the development database. The owner creates tables and runs migrations; the running app does not use it. |
| `BOS_APP_DB_USER`, `BOS_APP_DB_PASSWORD` | **Application** role the API connects as. It owns nothing and cannot bypass row-level security. |
| `BOS_TEST_DB` | Separate database used only by automated tests. The tests drop and recreate its tables. |
| `BOS_WEB_PORT` | Host port of the web app in Docker Compose (default 3000). |
| `BOS_WEB_BIND` | Address Compose publishes the web port on. `127.0.0.1` = this computer only; `0.0.0.0` = also phones on the network (development only, see [Phone demo](#demo-on-a-phone-on-the-local-network)). |
| `BOS_MAIL_UI_PORT` | Host port of Mailpit, which captures outgoing email in Compose (default 8025). |
| `BOS_DB_PORT` | Host port of the Compose database, for tools and tests outside the containers (default 55432). |
| `BOS_LOCAL_DB_PORT` | Port of the private PostgreSQL from `scripts/local_db.py` (default 55433). When set, host-side scripts and tests use it instead of `BOS_DB_PORT`. |
| `BOS_SECRET_KEY` | Long random string required by Flask, at least 32 characters. The API refuses to start without it, or (outside the tests) with a shorter or `CHANGE_ME...` value. |
| `BOS_PUBLIC_BASE_URL` | Public address of the web app. The API puts it in activation and password-reset links, so it must be the address users actually open. |
| `BOS_COOKIE_SECURE` | `true` by default in code; set `false` only for local `http` development, otherwise sign-in cookies are not sent over plain http. |
| `BOS_OPERATOR_EMAILS` | Comma-separated allow-list of Beta staff emails that may be operators. |
| `BOS_SMTP_HOST`, `BOS_SMTP_PORT`, `BOS_SMTP_USER`, `BOS_SMTP_PASSWORD`, `BOS_SMTP_FROM` | Outgoing mail for password-reset links and invitation codes. Compose points at the Mailpit container (`mail:1025`). |
| `BOS_ENVIRONMENT` | `development`, `staging` or `production`; unset means `production`, so forgetting it keeps the strict start-up checks on. `scripts/local_api.py` and the Compose `api` service set `development`. Outside the test suite the API refuses to start with a `BOS_SECRET_KEY` shorter than 32 characters or still starting with `CHANGE_ME`, and with `BOS_MAIL_OUTBOX_DIR` set anywhere but `development`. |
| `BOS_MAIL_OUTBOX_DIR` | Development only (`BOS_ENVIRONMENT=development`, otherwise the API refuses to start): write email as JSON files to this folder instead of SMTP. `scripts/local_api.py` sets it (default `%LOCALAPPDATA%\bos-dev\outbox`). **Never set in production.** |
| `BOS_DEMO_PASSWORD` | Password given to every demo user by `seed-demo`. |
| `BOS_OPERATOR_PASSWORD` | Password set by `create-operator`. |
| `BOS_ALLOW_DEMO_SEED` | Must be `true` for `seed-demo` to run. **Never set in production.** |
| `NEXT_PUBLIC_BOS_SUPPORT_WHATSAPP` | Beta support WhatsApp number in E.164 form (for example `+9617xxxxxxx`). Empty hides the WhatsApp button. |

Compose also sets, inside the containers, variables that are not in `.env`:
`BOS_DATABASE_URL` and `BOS_MIGRATION_DATABASE_URL` (application and owner connections),
`BOS_TEST_DATABASE_URL` and `BOS_TEST_MIGRATION_DATABASE_URL`, `BOS_UPLOAD_DIR`,
`BOS_SPECS_DIR` and, for the web container, `BOS_API_INTERNAL_URL` (where `/api/v1` is
forwarded). The local scripts build the same variables from `.env`.

Passwords are always read from environment variables, never from command-line arguments, so
they stay out of shell history.

## Ports

| Port | What | Used by |
|---|---|---|
| 3000 | Web app | Docker Compose (`BOS_WEB_PORT`) |
| 8025 | Mailpit web UI | Docker Compose (`BOS_MAIL_UI_PORT`) |
| 55432 | Compose PostgreSQL, published on 127.0.0.1 | Docker Compose (`BOS_DB_PORT`) |
| 55433 | Private PostgreSQL, 127.0.0.1 only | `scripts/local_db.py` |
| 5100 | API run directly on the host | `backend/scripts/local_api.py serve` |
| 3100 | Web app dev server on the host | `next dev` (development PC) |
| 3200 | Web app for end-to-end tests | Playwright |
| 5180 | Relay between the e2e web server and the API | Playwright |

In Compose the API listens on port 8000 **inside the Compose network only**; it publishes no
host port. BOS never uses port 8000 on the host, and `local_api.py` refuses it, because other
software may already use it. Nothing in BOS should ever forward to it.

## Run with Docker Compose

Prerequisites: Docker Desktop (Compose v2). This is the stack described in
[quickstart.md](specs/001-platform-foundation/quickstart.md). It is a **development**
stack: the web service runs `npm run dev`, the API runs `flask run --debug`, and the source
folders are mounted into the containers. It is not a production deployment.

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec api flask db upgrade
docker compose exec -e BOS_ALLOW_DEMO_SEED=true api flask bos seed-demo
docker compose exec -e BOS_OPERATOR_PASSWORD api flask bos create-operator --email ops@example.test
```

Services: `db` (PostgreSQL 16; first start runs `docker/db/init` to create the application
role and the test database), `api` (built from `backend/Dockerfile`, Python 3.12 + uv), `web`
(built from `frontend/Dockerfile`, Node 24) and `mail` (Mailpit).

| Service | Address |
|---|---|
| Web app | http://localhost:3000 |
| Operator area | http://localhost:3000/ops |
| API | http://localhost:3000/api/v1 (proxied; the API publishes no port) |
| Captured email | http://localhost:8025 |

## Run on the development PC without Docker

The development PC runs without Docker: a private PostgreSQL cluster, the API as a plain
Python process, and the web app with `next dev`. Everything binds to `127.0.0.1`.

Prerequisites: PostgreSQL 16 or 17 binaries installed on Windows (used only as programs;
its Windows services are never touched), [uv](https://docs.astral.sh/uv/), and a Node 24
install. Here Node is the portable copy in `%LOCALAPPDATA%\bos-dev\node24\node.exe`, and
the examples below use it; any Node 24 works the same way.

**1. Database.** `scripts/local_db.py` creates its own data folder
(`%LOCALAPPDATA%\bos-dev\pgdata`) and its own port (55433), as an ordinary process of your
user, not a Windows service, so start it again after each reboot. Optional `.env` settings
`BOS_LOCAL_PG_BIN` and `BOS_LOCAL_PG_DATA` override the PostgreSQL binary folder and data
folder.

```powershell
python scripts/local_db.py init      # once: data folder, roles, databases bos and bos_test
python scripts/local_db.py start
python scripts/local_db.py status
python scripts/local_db.py stop
```

`init` turns off `fsync` and related settings because this machine's disk is very slow. Those
settings can lose data in a crash, which is acceptable only because this cluster holds
development and test data. Never reuse them for real data.

**2. API.** From `backend/`:

```powershell
cd backend
uv sync
uv run python scripts/local_api.py migrate      # apply migrations as the owner role
uv run python scripts/local_api.py bootstrap    # create the operator; seed demo data if allowed
uv run python scripts/local_api.py serve        # http://127.0.0.1:5100
```

`local_api.py` reads `../.env`, passes the secrets through the environment, and refuses the
test database and port 8000. `--public-base-url URL` sets the web address put in activation
and reset links (default `http://127.0.0.1:3100`). `--port N` changes the API port. There is
no mail server here, so the API writes every email (reset links, and the codes that people
invited by email enter on the invitation page) as a JSON file to `BOS_MAIL_OUTBOX_DIR`
(default `%LOCALAPPDATA%\bos-dev\outbox`); open the newest file to read a code. The end-to-end
tests read codes from the same folder. Activation links are copied from the screen.

**3. Web app.** From `frontend/`, pointing the proxy at the API:

```powershell
cd frontend
npm ci
$env:BOS_API_INTERNAL_URL = "http://127.0.0.1:5100"
& "$env:LOCALAPPDATA\bos-dev\node24\node.exe" node_modules\next\dist\bin\next dev -H 127.0.0.1 -p 3100
```

Open http://127.0.0.1:3100. `.claude/launch.json` holds the same two commands (API and web)
for the Claude Code preview. If `BOS_API_INTERNAL_URL` is unset the web app forwards to
`http://127.0.0.1:5100`.

## Migrations

Migrations are hand-written Alembic revisions (plain SQL, including row-level security
policies) in `backend/migrations/`. They run as the owner role. Full guide, including
rollback and what it leaves behind: [backend/migrations/README.md](backend/migrations/README.md).

| Task | Docker | Development PC (from `backend/`) |
|---|---|---|
| Apply | `docker compose exec api flask db upgrade` | `uv run python scripts/local_api.py migrate` |
| Roll back everything | `docker compose exec api flask db downgrade base` | `uv run flask --app app:create_app db downgrade base` (with the `BOS_*` URLs set) |
| Current revision | `docker compose exec api flask db current` | same as above with `db current` |

`downgrade base` deletes all BOS data. Never run it on a database that holds real data
without a backup.

## Demo data and demo sign-ins

> **Warning: demo data is for development only.** `seed-demo` creates **active users with
> known sign-in details**. It refuses to run unless `BOS_ALLOW_DEMO_SEED=true`. Never set that
> variable in production or on any server reachable from the internet, and never use a real
> password as `BOS_DEMO_PASSWORD`.

```bash
# Docker
docker compose exec -e BOS_ALLOW_DEMO_SEED=true api flask bos seed-demo
```

```powershell
# Development PC: bootstrap seeds the demo data when BOS_ALLOW_DEMO_SEED=true in .env
uv run python scripts/local_api.py bootstrap
```

The command is safe to run twice: a business that already exists is left unchanged. Every
demo user's password is the value of `BOS_DEMO_PASSWORD` in your `.env`; it is not written
anywhere in the repository. All identifiers are fake (reserved test domain, `+961 70 000 xxx`
numbers). You can sign in with either the email or the phone number.

**Demo Denim House Group** (BOS Commerce, stores "Store A" and "Store B")

| Role | Email | Phone | Language | Stores |
|---|---|---|---|---|
| Owner | owner@demo.bos.test | +96170000001 | English | both |
| Manager | manager@demo.bos.test | +96170000002 | Arabic | both |
| Sales | sales@demo.bos.test | +96170000003 | English | both |
| Packing | packing@demo.bos.test | +96170000004 | Arabic | both |
| Dispatch | dispatch@demo.bos.test | +96170000005 | English | both |
| Sales (Store A only) | sales-store-a@demo.bos.test | +96170000006 | Arabic | Store A |

**Demo Second Shop** (BOS Social, store "Main Store")

| Role | Email | Phone | Language |
|---|---|---|---|
| Owner | owner@second.demo.bos.test | +96170000011 | English |

A system-only seed operator `demo-seed@bos.invalid` is recorded as the creator of both
businesses. It is inactive and can never sign in.

## Operator (Beta staff) account

Operators manage businesses at `/ops` (for example http://127.0.0.1:3100/ops). An email must
be on `BOS_OPERATOR_EMAILS` before it can become an operator. The password comes from
`BOS_OPERATOR_PASSWORD` (at least 10 characters, not a common password), never from an
argument. Running the command again for the same email sets a new password.

```bash
# Docker
docker compose exec -e BOS_OPERATOR_PASSWORD api flask bos create-operator --email ops@example.test
```

On the development PC, `local_api.py bootstrap` does this for the first address in
`BOS_OPERATOR_EMAILS`, using `BOS_OPERATOR_PASSWORD` from `.env`.

`flask bos maintenance` expires old invitations and removes ended sessions, old sign-in
attempts, old idempotency keys and password resets. It also clears expired staged product
photos and uncommitted CSV batches per business. Committed import batches are retained.

## Catalog and inventory (M1)

- The demo catalog has eight sample products across the two Denim House stores, including
  low-stock and out-of-stock examples. Opening stock is recorded in the stock ledger.
- `flask bos stock-check [--tenant ID]` is read-only and exits nonzero on a discrepancy.
  On the local development PC, run `uv run python scripts/local_api.py stock-check` from
  `backend/`, optionally with `--tenant ID`.
- `flask bos seed-catalog --variants 5000 --tenant ID` appends synthetic data to a demo
  business only. It requires `BOS_ENVIRONMENT=development` and `BOS_ALLOW_DEMO_SEED=true`.
  Run it against a disposable demo dataset; rerunning it adds another dataset.
- `uv run python scripts/local_api.py purge-test-businesses` previews which temporary E2E
  businesses would be removed. `--yes` performs the removal; the command is restricted to
  the loopback development database. Do not use it as a backup or restore tool.
- Product photo files live under `BOS_UPLOAD_DIR/tenant/<id>/`. They are served through
  the authorized API rather than public links.

### CSV import

In Catalog → Import CSV, download the template, fill it in, review the preview, then confirm.
Files must be UTF-8 (a BOM is accepted), at most 2 MB and at most 2,000 data rows. Required
columns are `product_code`, at least one of `name_en` and `name_ar`, `price`, and `currency`.
Optional columns are `description_en`, `description_ar`, `stores` (store names separated by
`|`), `option1_name`, `option1_value`, `option2_name`, `option2_value`, `sku`,
`opening_quantity`, and `low_stock_level`. A preview does not write products; confirmation
imports the batch in one transaction. Add photos afterward in the catalog.

## Tests

Backend (pytest; unit, contract, integration, isolation). The tests need the test database
(`BOS_TEST_DB`) on a running PostgreSQL. They drop and recreate its tables, so they never
use the development database.

```bash
# Docker
docker compose exec api pytest
docker compose exec api pytest tests/isolation -q
```

```powershell
# Development PC: private PostgreSQL running; from backend/
uv run python scripts/local_tests.py                     # everything
uv run python scripts/local_tests.py tests/isolation -q  # any pytest arguments work
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

The isolation suite must have at least one case for every registered route; a route without
one fails the suite by design.

Frontend (from `frontend/`):

```powershell
npm test            # Vitest
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
```

On Docker: `docker compose exec web npm test`.

End to end (Playwright, from `frontend/`): drives an **installed** Edge (set
`BOS_E2E_BROWSER=chrome` for Chrome); nothing is downloaded. It starts its own web server on
3200 with its own build folder (`BOS_NEXT_DIST_DIR=.next-e2e`) and a relay on 5180, so the
dev server on 3100 is untouched. It uses the API on 5100 (override with `BOS_E2E_API_PORT`;
it starts one if none is running) and therefore the **development database**, with the demo
data seeded and the passwords from `.env`. The tests run in English and Arabic at a 360 px
phone width.

```powershell
cd frontend
npm run e2e
```

CI (`.github/workflows/ci.yml`) runs ruff, mypy and pytest for the backend and eslint, tsc
and Vitest for the frontend.

## Demo on a phone on the local network

Development only. The development setup uses plain `http`, so a phone gets no install
prompt or HTTPS-only features; real phone installs are checked on a staging server with HTTPS.

Rules that keep this safe:

- Only on a network you trust (your own home or office Wi-Fi). Never on public Wi-Fi.
- Only with demo data. Anyone on the same network who opens the address can reach the sign-in
  page, and `BOS_COOKIE_SECURE=false` means cookies travel unencrypted.
- Bind only the web app, never the database or the API. The API and PostgreSQL stay on
  `127.0.0.1`; the web app forwards `/api/v1` to the API on the same computer.
- Stop the server when finished, and revert to `127.0.0.1`.

The three things that must match are the address the phone opens, the web bind address, and
`BOS_PUBLIC_BASE_URL` (the address placed in activation and reset links). Use the computer's
LAN address, shown by `ipconfig` (for example `192.168.1.50`; used below only as an example).

**Docker:** in `.env` set `BOS_WEB_BIND=0.0.0.0`, keep `BOS_COOKIE_SECURE=false`, and set
`BOS_PUBLIC_BASE_URL=http://192.168.1.50:3000`; then `docker compose up -d` and open
`http://192.168.1.50:3000` on the phone.

**Development PC:** start the API with the LAN web address in its links, and the web app on
the LAN address (the API itself stays on 127.0.0.1):

```powershell
uv run python scripts/local_api.py serve --public-base-url http://192.168.1.50:3100
& "$env:LOCALAPPDATA\bos-dev\node24\node.exe" node_modules\next\dist\bin\next dev -H 192.168.1.50 -p 3100
```

Binding to the single LAN address (instead of `0.0.0.0`) keeps the server off other
interfaces. You may need to allow the port through Windows Firewall for the private network
profile only, and to remove that rule afterwards. Note that `next.config.ts` does not set
`allowedDevOrigins`; if the phone page loads but does not become interactive, the Next.js
development server is blocking the other origin and that setting would have to be added.
Open `http://192.168.1.50:3100` on the phone.

## Security notes

- Tenant isolation is enforced by PostgreSQL row-level security, not only by application
  filters; the application role cannot bypass it.
- No secrets or real customer data belong in the repository. `.env` is not committed.
- `BOS_ALLOW_DEMO_SEED` and `BOS_COOKIE_SECURE=false` are development-only settings.
