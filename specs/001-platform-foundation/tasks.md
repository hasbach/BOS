# Tasks: Platform Foundation (M0)

**Input**: Design documents from `/specs/001-platform-foundation/`

**Prerequisites**: plan.md, spec.md, research.md (incl. revision 2, R21–R32), data-model.md (revision 2), contracts/openapi.yaml (0.2.0), contracts/permissions.md, quickstart.md

**Revision 2 (2026-11-10)**: regenerated after the independent review and the decision that each user belongs to one business. Task numbers changed from revision 1.

**Tests**: Included. The constitution (Principle IV) requires tests to be written first and seen to fail, and Principle I requires automated cross-tenant and cross-store tests for every feature.

**Organization**: Tasks are grouped by user story so each story can be built, tested and demonstrated on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: Which user story the task belongs to (US1–US4)
- Every task names the file(s) it touches

## Path Conventions

Web application: `backend/` (Flask API) and `frontend/` (Next.js PWA) at the repository root, as defined in plan.md.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Empty but runnable project: containers start, tests run, CI is defined.

**Status note (2026-11-10, evening)**: backend side verified inside the `api` container: health check 200, migration applied, 334 tests pass, ruff and mypy clean. T001, T003, T005, T006 and T008 stay open because the `web` image has not built yet (npm downloads keep dropping on this network; the build retries with a package cache) and CI has never run (no remote repository).

- [ ] T001 Create root files: `.gitignore`, `.gitattributes` (LF for shell scripts), `.env.example` (database roles, secret key, public base URL, cookie flag, operator email allow-list, SMTP, demo and operator passwords, `BOS_WEB_PORT`, `BOS_WEB_BIND`, `BOS_MAIL_UI_PORT`), `docker-compose.yml` with services `db` (PostgreSQL 16, named volume, no host port), `api` (no host port), `web`, `mail` (Mailpit), and `docker/db/init/01-roles.sh` creating the application role (`NOSUPERUSER NOBYPASSRLS`) and the test database
- [x] T002 Scaffold backend in `backend/pyproject.toml` (Python 3.12, managed with `uv`, `uv.lock` committed; Flask, SQLAlchemy 2, Alembic, psycopg, argon2-cffi, phonenumbers, Pillow; dev: pytest, ruff, mypy, openapi-core, pyyaml) and `backend/Dockerfile`; create package folders `backend/app/{core,models,api,services}` and `backend/tests/{unit,integration,isolation,contract}`
- [ ] T003 [P] Scaffold frontend in `frontend/package.json` (Next.js App Router, React, TypeScript, next-intl; dev: Vitest, Testing Library, Playwright, ESLint; lock file generated under Node 24) and `frontend/Dockerfile` (Node 24); forward `/api/v1/*` to the `api` service in `frontend/next.config.ts`
- [x] T004 Create Flask app factory in `backend/app/__init__.py`, environment config in `backend/app/config.py`, error envelope `{ "error": { "code", "message", "fields" } }` for all 4xx/5xx in `backend/app/errors.py`, `GET /api/v1/health`, and request-ID logging that records the path only (never query strings or bodies); tests in `backend/tests/integration/test_health_and_errors.py`
- [x] T005 [P] Configure linting and type checks: `backend/ruff.toml`, mypy settings in `backend/pyproject.toml`, `frontend/eslint.config.mjs` (current supported ESLint), `frontend/tsconfig.json` (strict)
- [ ] T006 [P] Create CI workflow in `.github/workflows/ci.yml`: PostgreSQL 16 service with the application role created, backend lint + format check + mypy + pytest (all suites), frontend lint + typecheck + Vitest on every push; Playwright on pull requests (added with the first e2e test)
- [x] T007 Add Alembic in `backend/migrations/` (`env.py`, `script.py.mako`, hand-written migrations only) and `flask db upgrade|downgrade|current|history|revision` in `backend/app/cli.py`, always run as the owner role
- [ ] T008 Verify Phase 1 in containers: `docker compose up -d --build` (pull images one at a time on the development PC), `/api/v1/health` returns OK through the web proxy, backend and frontend test commands pass inside containers; record output in `specs/001-platform-foundation/checklists/phase1.md`

**Checkpoint**: Four services run; health check answers through port 3000; both test suites run in containers.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Tenant isolation, sessions, permissions with store scope, audit, seed data and the test harness that every story depends on.

**⚠️ CRITICAL**: No user story work starts until this phase is complete.

**Status note (2026-11-11, phase closed)**: Phase 2 complete except T021 (ORM models — deliberately not built; plain SQL throughout) and T036 (Playwright setup — moved to User Story 1, it needs the sign-in API). Evidence: `checklists/phase2.md` (470 backend tests, 107 frontend tests, all re-run by the orchestrating session). Development and tests run without Docker on the development PC (research R33).

### Tests first (write, run, confirm they fail)

- [x] T009 [P] Write database-level RLS tests in `backend/tests/isolation/test_rls.py`: for every RLS table in data-model.md (`tenants`, `stores`, `users`, `user_stores`, `invitations`, `password_resets`, `idempotency_keys`, `files`, `audit_entries`), with `app.tenant_id` = tenant A, selecting/inserting/updating/deleting rows of tenant B returns or affects zero rows or is rejected; with no tenant set, zero rows; the application role cannot `UPDATE`/`DELETE` `audit_entries`; a row cannot reference a parent in another tenant (composite FKs)
- [x] T010 [P] Write tests for the scoped database functions in `backend/tests/isolation/test_scoped_functions.py`: `auth_lookup_identifier` returns only id, tenant id, password hash, user status and tenant status for an exact normalized match and nothing for partial input; `auth_lookup_token` returns only tenant id and row id; `ops_business_overview()` raises in tenant context and with no context and returns only account-level columns in operator context; `audit_platform_event` can only insert null-tenant rows; `platform_maintenance()` touches only expired invitations, expired sessions, old login attempts and old idempotency keys
- [x] T011 [P] Write the route-enumeration harness in `backend/tests/isolation/conftest.py` and `backend/tests/isolation/test_route_coverage.py`: list every registered `/api/v1` route and fail if any route lacks a registered cross-tenant case and a missing-permission case, and a cross-store case when the route is declared store-scoped; public routes must be explicitly declared public
- [x] T012 [P] Write unit tests for identifier normalization in `backend/tests/unit/test_identifiers.py`: `70 000 111`, `070000111`, `+96170000111`, `0096170000111` normalise to one E.164 value with default region LB; invalid numbers rejected; emails lower-cased; input containing `@` treated as email
- [x] T013 [P] Write unit tests for the permission map in `backend/tests/unit/test_permissions.py` asserting every cell of the "M0 permissions" table in `contracts/permissions.md`, union of roles, store scope (a user with `all_stores` false and stores {A} is refused on store B; owners and managers always pass), and the tab/start-tab rules
- [x] T014 [P] Write unit tests for security helpers in `backend/tests/unit/test_security.py`: Argon2id hash/verify, password policy (minimum 10 characters, common passwords rejected), token generation (32 random bytes, only SHA-256 hash stored), CSRF header required on POST/PUT/PATCH/DELETE
- [x] T015 [P] Write integration tests for idempotency in `backend/tests/integration/test_idempotency.py`: same key + same body returns the same resource; same key + different body returns 409 `idempotency_conflict`; keys are scoped by endpoint and actor; no response body or link is ever stored in `idempotency_keys`
- [x] T016 [P] Write integration tests for sessions and the request lifecycle in `backend/tests/integration/test_request_context.py`: session resolved by token hash; idle expiry 30 days / absolute 90 days (operators 12 hours / 7 days); revoked session refused; suspended or pending tenant refused; inactive user refused; a role change is effective on the next request; request log lines contain the path only

### Implementation

- [x] T017 Implement database engine, session and transaction helper in `backend/app/core/db.py`; the application connects as the role that does not own tables and has no `BYPASSRLS`
- [x] T018 Implement tenant and operator context in `backend/app/core/tenancy.py`: `tenant_context(tenant_id)` runs `SET LOCAL app.tenant_id` inside the transaction; `operator_context()` sets `app.operator = on`; `enter_tenant_from_operator(tenant_id)` usable only by `services/onboarding.py`; all usable from requests and from CLI code (FR-004)
- [x] T019 [P] Implement identifier normalization in `backend/app/core/identifiers.py` (phonenumbers, default region `LB`, E.164 output; email lower-casing)
- [x] T020 [P] Implement security helpers in `backend/app/core/security.py`: Argon2id hashing, password policy, link/session token generation and hashing, CSRF header check
- [X] T021 **Not built by design** (closed in M1 T013): plain SQL through SQLAlchemy `text()` throughout; no ORM models, and the empty `backend/app/models/` package was removed. Original task: Create all models in `backend/app/models/` per data-model.md revision 2, one module per aggregate (`operator.py`, `tenant.py`, `store.py`, `user.py` incl. `user_stores`, `invitation.py`, `password_reset.py`, `session.py`, `login_attempt.py`, `idempotency_key.py`, `file.py`, `audit_entry.py`), quoting these constraints: names 1–120 chars (store name 1–80); `users.tenant_id` NOT NULL; `users` check `phone_e164 IS NOT NULL OR email IS NOT NULL`; `users.phone_e164` and `users.email` unique across all tenants (email case-insensitive); `users.roles` non-empty subset of `owner, manager, sales, packing, dispatch`; `all_stores` true when roles include `owner` or `manager`; `tenants.usd_lbp_rate` numeric(18,2) > 0, `default_delivery_fee` numeric(12,2) ≥ 0 default 0; `tenants.is_demo` default false; enums exactly as listed in data-model.md
- [x] T022 Write the initial Alembic migration in `backend/migrations/versions/0001_platform_foundation.py`: all 12 tables; composite unique `(tenant_id, id)` on `stores`, `users`, `files`; composite FKs from `user_stores`, `password_resets` and `stores.logo_file_id`; partial unique indexes on `stores (tenant_id, whatsapp_e164)` and `stores (tenant_id, name)` where status is active; at most one `pending` invitation per `(tenant_id, invitee_phone_e164)` and per `(tenant_id, invitee_email)`; at most one `pending` `owner_activation` per tenant; RLS enabled and forced on the nine RLS tables; operator-context policy on `tenants` (select, insert, update of status only); the five `SECURITY DEFINER` functions from data-model.md with a fixed `search_path`; trigger rejecting `UPDATE`/`DELETE` on `audit_entries`; grants for the application role; documented `downgrade()`
- [x] T023 Implement the append-only audit writer in `backend/app/core/audit.py`: `record(event, target, data)` in the current transaction; `record_denied(...)` in a separate transaction so it survives rollback; `record_platform(...)` via `audit_platform_event`; attribution exactly as in the data-model table; event names exactly as listed; never store passwords, tokens or links in `data`
- [x] T024 Implement the permission map and `require(permission, store_param=None)` decorator in `backend/app/core/permissions.py` from `contracts/permissions.md`, including store scope (404 + `access.denied_store`), the reserved later-milestone permissions, and tab/start-tab computation; missing permission → 403 `forbidden` + `access.denied_permission`
- [x] T025 Implement session handling in `backend/app/core/sessions.py`: create/lookup by token hash, cookies `bos_session` and `bos_ops_session` (HttpOnly, Secure per config, SameSite=Lax), sliding `idle_expires_at`, `absolute_expires_at`, revoke one, revoke all for a user, revoke all except current
- [x] T026 Implement the request lifecycle in `backend/app/core/request_context.py` and register it in `backend/app/__init__.py`: resolve session → open transaction → set tenant context → load user and tenant → refuse if tenant not `active` or user not `active` → handler → commit; foreign or unknown records → 404 `not_found` + `access.denied_tenant`; operator requests use operator context and are confined to `/ops/*`
- [x] T027 [P] Implement idempotency in `backend/app/core/idempotency.py` (decorator reading `Idempotency-Key`; stores resource reference only; 24-hour retention)
- [x] T028 [P] Implement rate limiting in `backend/app/core/rate_limit.py` using `login_attempts`: 5 failures per identifier in 15 minutes → 15-minute block; 30 failures per IP in 15 minutes; reset-email requests limited to 3 per address per hour
- [x] T029 [P] Implement the mailer in `backend/app/core/mailer.py` (SMTP from config) recording `email.sent` / `email.failed` in the recipient business's history; test in `backend/tests/integration/test_mailer.py` with a failing SMTP server
- [x] T030 Implement operations commands in `backend/app/cli.py` and `backend/app/services/seed.py`: `flask bos create-operator --email` (must be on the allow-list; password from `BOS_OPERATOR_PASSWORD`, never an argument), `flask bos maintenance` (calls `platform_maintenance()`, records `maintenance.run`), `flask bos seed-demo` (demo tenant "Demo Denim House Group", edition `commerce`, `is_demo` true, two stores, one user per role; a second small demo tenant; passwords from `BOS_DEMO_PASSWORD`; safe to run twice) (FR-035); tests in `backend/tests/integration/test_cli.py` incl. that maintenance changes nothing it should not
- [x] T031 [P] Create pytest fixtures in `backend/tests/conftest.py`: migrated test database, per-test isolation, factories for two tenants (A and B) each with two stores and one user per role plus one store-limited sales user, authenticated test clients per user and per operator
- [x] T032 [P] Create contract-test helper in `backend/tests/contract/conftest.py` that validates every test response against `specs/001-platform-foundation/contracts/openapi.yaml`, and fails for any registered route missing from the contract
- [x] T033 [P] Frontend foundation: copy design tokens (light and dark) from `design/bos-screens.html` into `frontend/src/styles/tokens.css`; self-host Inter and IBM Plex Sans Arabic in `frontend/public/fonts/`; configure next-intl in `frontend/src/i18n/` with `frontend/messages/en.json` and `frontend/messages/ar.json`; set `lang`/`dir` per locale in `frontend/src/app/[locale]/layout.tsx`; first visit without a locale redirects by device language (Arabic → `ar`, otherwise `en`) (FR-027a); CSS logical properties only
- [x] T034 [P] Frontend API client in `frontend/src/lib/api.ts` (same-origin fetch, `X-BOS-CSRF` header, `Idempotency-Key` support, typed error envelope) and error-code-to-message mapping in `frontend/src/lib/errors.ts` with entries for every code in openapi.yaml in both message files; a test fails if a code has no translation
- [x] T035 [P] Build shared UI components from the designs in `frontend/src/components/`: `Button`, `Field`, `Chip`, `Card`, `Sheet`, `SegmentedControl`, `ListRow`, and state components `Loading`, `Empty`, `ErrorState`, `OfflineNotice`; 48 px primary buttons, 44 px minimum touch targets; component tests in `frontend/tests/components/`
- [ ] T036 [P] Playwright setup in `frontend/playwright.config.ts` and `frontend/e2e/fixtures.ts`: 360×740 viewport, projects for `en` and `ar`, sign-in helpers for each seeded demo user and the operator; add the Playwright job to `.github/workflows/ci.yml`
- [x] T037 Run T009–T016 and all Phase 2 tests; confirm they pass; record output in `specs/001-platform-foundation/checklists/phase2.md`

**Checkpoint (approval point)**: The database refuses cross-tenant access on its own; pre-tenant access exists only through the five tested functions; sessions, permissions with store scope, audit and idempotency work; demo data can be seeded; the route harness will fail any future route lacking coverage.

---

## Phase 3: User Story 1 - A business is set up and its owner signs in (Priority: P1) 🎯 MVP

**Goal**: An operator sets up a merchant; the owner activates by link, signs in with phone or email, and reaches a home screen that belongs only to their business.

**Independent Test**: An operator sets up two businesses; each owner activates on their own phone and sees only their own business; neither can reach anything of the other's, including by editing identifiers (quickstart scenarios 1 and 2).

### Design (approval needed before T050–T052)

- [x] T038 [US1] Design the missing screens for US1 in `design/bos-screens.html` (new section "M0 additions"): account activation (set password + language), "link no longer valid", "already activated — sign in", "use a different phone number or email", forgot/reset password, operator sign-in, operator business list, operator setup form with one-time link display; all in English and Arabic at phone width; present to the product owner for approval

### Tests for User Story 1 (write first, confirm they fail)

- [x] T039 [P] [US1] Contract + integration tests for operator endpoints in `backend/tests/integration/test_ops.py`: sign-in (allow-listed email only; `operator.sign_in` recorded); `GET /ops/me`; create business (exactly one tenant `pending`, one store, one pending `owner_activation` invitation, no user row yet, `usd_lbp_rate` required, link returned once); owner identifier already used in BOS → 409 `identifier_unavailable`; repeat with the same `Idempotency-Key` → same business, fresh link, earlier link invalid; list shows account-level fields only; suspend blocks all the tenant's users, reactivate restores; pending business cannot be suspended or activated (409 `business_pending`); resend activation; owner password-reset only for an active owner without email (409 `owner_has_email`, 404 otherwise); every operator action appears in that tenant's history with actor type `operator`
- [x] T040 [P] [US1] Integration tests for activation and sign-in in `backend/tests/integration/test_auth.py`: preview by token in the body; accept creates the user with the invitation's roles and stores, sets password + locale, tenant becomes `active`, session cookie set; second submission → 410 `link_already_used` and still exactly one user (SC-007); expired/revoked/unknown → 410 `link_invalid`; sign-in by phone in several formats and by email; wrong password, unknown identifier, inactive user and locked identifier return the identical 401 body; lock after 5 failures also rejects the correct password; suspended business → 403 only after correct credentials; sign-out; audit attribution for each case per data-model.md
- [x] T041 [P] [US1] Integration tests for passwords, sessions and own identifiers in `backend/tests/integration/test_me.py`: email reset request always 204, limited to 3 per hour, `email.sent`/`email.failed` recorded; reset link valid 1 hour and single-use; completing a reset ends all sessions; changing password ends all other sessions; list own sessions, end one, end all others; `PATCH /me` name and locale; add or change phone/email requires current password, enforces platform-wide uniqueness (409 `identifier_unavailable`), cannot remove the last identifier, records `auth.identifier_changed`; `auth.password_changed`, `auth.sign_out`, `auth.session_revoked` recorded
- [x] T042 [P] [US1] Integration tests for history in `backend/tests/integration/test_audit_api.py`: `GET /audit` returns only the caller's tenant entries, newest first, paginated by cursor, filterable by event and actor; only `audit.view` (owner) may call it; null-tenant rows never appear
- [x] T043 [P] [US1] Isolation cases for all US1 routes in `backend/tests/isolation/test_us1_routes.py`: tenant B owner requesting tenant A identifiers gets 404 identical to a made-up ID; operator cannot reach any tenant route; tenant users cannot reach `/ops/*`; `access.denied_tenant` recorded
- [x] T044 [P] [US1] Playwright scenario in `frontend/e2e/us1-activation.spec.ts` (`en` and `ar`): operator creates business → owner opens link → sets password and language → lands on home in that language; second use of the link shows "already activated — sign in"; the token is never part of a request URL

### Implementation for User Story 1

- [x] T045 [US1] Implement onboarding service in `backend/app/services/onboarding.py`: `create_business(...)` (tenant in operator context, then the store and the owner-activation invitation in that tenant's context, one transaction; audit `tenant.created`, `invitation.created`), `resend_owner_activation`, `issue_owner_password_reset(owner_user_id)`, `set_business_status` (active ⇄ suspended only; audit `tenant.suspended` / `tenant.reactivated`)
- [x] T046 [US1] Implement invitations service in `backend/app/services/invitations.py`: create (validates roles/stores, same-tenant duplicate → `already_member`), preview, accept (lookup via `auth_lookup_token`, row lock, validate `pending` and not expired, re-validate stores, create the user, platform-wide identifier clash → `identifier_unavailable`, tenant `pending` → `active` for owner activation, audit `invitation.accepted`), resend (pending or expired), revoke; lazy expiry
- [x] T047 [US1] Implement operator API in `backend/app/api/ops.py` per openapi.yaml: `/ops/auth/sign-in`, `/ops/auth/sign-out`, `/ops/me`, `GET/POST /ops/businesses`, `PATCH /ops/businesses/{id}`, `/owner-activation`, `/owner-password-reset`
- [x] T048 [US1] Implement auth API in `backend/app/api/auth.py` per openapi.yaml: `/auth/sign-in` (via `auth_lookup_identifier`, rate limit, uniform 401), `/auth/sign-out`, `/auth/password-reset/request`, `/auth/password-reset/complete`, `/invitations/preview`, `/invitations/accept`; bilingual reset email templates in `backend/app/templates/email/`
- [x] T049 [US1] Implement "me" and history APIs in `backend/app/api/me.py` and `backend/app/api/audit.py`: `GET/PATCH /me`, `/me/password`, `GET/DELETE /me/sessions`, `DELETE /me/sessions/{id}`, `GET /audit`
- [x] T050 [US1] Build signed-out screens in `frontend/src/app/[locale]/(auth)/`: `sign-in/page.tsx` (design screen 01, single "Phone or email" field, language switch), `activate/page.tsx` (token read from the URL fragment), `reset/page.tsx` (request by email, and set new password from fragment token); all strings in both message files; errors shown next to fields
- [x] T051 [US1] Build session handling in `frontend/src/lib/session.ts` and a guard in `frontend/src/app/[locale]/(shell)/layout.tsx`: load `/me`, redirect to sign-in when unauthenticated, switch to the user's saved locale after sign-in (FR-027a), minimal home page at `frontend/src/app/[locale]/(shell)/page.tsx` showing business and user name
- [x] T052 [US1] Build operator area in `frontend/src/app/[locale]/ops/`: `sign-in/page.tsx`, `page.tsx` (business list with status, suspend/reactivate, resend activation, owner reset), `new/page.tsx` (setup form; shows the activation link once with copy and share buttons and a warning that it will not be shown again); bilingual, phone-first
- [x] T053 [US1] Run T039–T044 and the route-coverage and contract tests; confirm all pass; record output in `specs/001-platform-foundation/checklists/us1.md`

**Checkpoint (approval point)**: Two merchants can be set up and activated, each sees only their own business, and the isolation suite proves it. Demonstrate in both languages.

---

## Phase 4: User Story 2 - Owner invites employees with roles and store access (Priority: P2)

**Goal**: Owners and managers invite people, give them roles limited to chosen stores, change or remove access, and those limits are enforced by the server on every action.

**Independent Test**: Invite a sales agent limited to Store A and a packing agent for both stores; each sees only what is permitted; direct requests outside their permission are refused and recorded (quickstart scenario 3).

### Design (approval needed before T060)

- [x] T054 [US2] Design the missing screens for US2 in `design/bos-screens.html`: employees list (active, inactive, pending and expired invitations), invite sheet (name, phone or email, roles multi-select, stores multi-select or "all stores"), one-time invitation link with "share on WhatsApp" and copy, employee detail (change roles/stores, deactivate, reset link), confirmation dialogs; English and Arabic; present for approval

### Tests for User Story 2 (write first, confirm they fail)

- [x] T055 [P] [US2] Integration tests for staff endpoints in `backend/tests/integration/test_staff.py`: invite by phone or email with roles and stores (link returned once); non-owner/manager with zero stores and `all_stores` false → 400; owner/manager invitations always get all stores; identifier of a user or pending invitation in this business → 409 `already_member`; identifier used in another business → invitation created with no warning and acceptance → 409 `identifier_unavailable`; repeat with the same `Idempotency-Key` → same invitation, fresh link, earlier link invalid; resend for pending and for expired; resend/revoke after acceptance → 409 `invitation_closed`; simultaneous accept and revoke leaves exactly one outcome; `GET /staff` lists members and pending/expired invitations; change roles/stores applies on the employee's next request; deactivate ends all their sessions; reactivate; issue reset link
- [x] T056 [P] [US2] Integration tests for owner and self protection in `backend/tests/integration/test_owner_rules.py`: last active owner cannot be deactivated or demoted (409 `last_owner`); nobody can change their own roles, stores or status or reset themselves (403 `cannot_modify_self`); a manager cannot invite an owner, grant `owner`, change, deactivate or reset an owner (403)
- [x] T057 [P] [US2] Isolation and permission cases for staff routes in `backend/tests/isolation/test_us2_routes.py`: every role without `staff.view`/`staff.manage` is refused on each route; tenant B cannot see, change, resend or revoke tenant A users or invitations; a store-limited user's `/me` lists only their stores (US2 scenario 5; route-level cross-store cases arrive with the store routes in US3); refusals recorded
- [x] T058 [P] [US2] Playwright scenario in `frontend/e2e/us2-staff.spec.ts` (`en` and `ar`): owner invites a sales agent for Store A → agent accepts → sees Sales tab and only Store A → owner removes the sales role → agent's next tap reflects it → owner deactivates → agent is sent to sign-in

### Implementation for User Story 2

- [x] T059 [US2] Implement staff service and API in `backend/app/services/staff.py` and `backend/app/api/staff.py` per openapi.yaml: `GET /staff`, `POST /staff/invitations` (idempotent), `POST /staff/invitations/{id}/resend`, `DELETE /staff/invitations/{id}`, `PATCH /staff/{userId}` (last-owner check under a tenant row lock, owner-protection and self-modification rules, deactivate → revoke all sessions), `POST /staff/{userId}/password-reset`; audit `invitation.*`, `user.roles_changed`, `user.stores_changed`, `user.deactivated`, `user.reactivated`, `auth.password_reset_issued`
- [x] T060 [US2] Build employees screens in `frontend/src/app/[locale]/(shell)/more/employees/`: `page.tsx` (list), `invite/page.tsx`, `[userId]/page.tsx`; share link via the Web Share API with copy fallback; show the link once; hide controls the caller lacks permission for while relying on the server for enforcement
- [x] T061 [US2] Run T055–T058 and the route-coverage and contract tests; confirm all pass; record output in `specs/001-platform-foundation/checklists/us2.md`

**Checkpoint (approval point)**: Roles and store limits are real, server-enforced restrictions, effective on the next request.

---

## Phase 5: User Story 3 - Owner manages stores and business settings (Priority: P3)

**Goal**: Add and edit stores (name, WhatsApp number, logo) and set business defaults (currency, USD/LBP rate, delivery fee).

**Independent Test**: Add a second store with its own WhatsApp number and logo, change the exchange rate, confirm values persist and that a sales agent cannot change them (quickstart scenario 4).

### Design (approval needed before T070–T071)

- [x] T062 [US3] Design the missing screens for US3 in `design/bos-screens.html`: stores list, store edit (name, WhatsApp number, logo upload, deactivate with affected-employees warning), business settings (currency, exchange rate, default delivery fee); English and Arabic; present for approval

### Tests for User Story 3 (write first, confirm they fail)

- [x] T063 [P] [US3] Integration tests for stores in `backend/tests/integration/test_stores.py`: add store; WhatsApp number normalised to E.164 from several input formats; duplicate number or name among active stores → 409; deactivate with assigned employees → 409 `confirmation_required` listing them, succeeds with `confirm`; last active store cannot be deactivated; very long and mixed Arabic/Latin names accepted up to the limit and rejected beyond it
- [x] T064 [P] [US3] Integration tests for logos in `backend/tests/integration/test_store_logo.py`: PNG/JPEG/WebP accepted and re-encoded to WebP ≤ 512×512; file over 2 MB → `file_too_large`; non-image and disguised file → `file_not_image`; path cannot be influenced by the client
- [x] T065 [P] [US3] Integration tests for business settings in `backend/tests/integration/test_business_settings.py`: owner and manager can change name, default currency, `usd_lbp_rate` (> 0) and default delivery fee (≥ 0); invalid values rejected with field errors; `tenant.settings_changed` contains old and new values; values handled as decimals
- [x] T066 [P] [US3] Isolation, permission and cross-store cases in `backend/tests/isolation/test_us3_routes.py`: sales/packing/dispatch refused on all manage routes; tenant B cannot read or change tenant A stores, logos or settings; a store-limited user gets 404 on another store's logo and does not see it in `GET /stores` (`access.denied_store` recorded)
- [x] T067 [P] [US3] Playwright scenario in `frontend/e2e/us3-stores-settings.spec.ts` (`en` and `ar`): add store with number typed as `70 000 111` → shown as `+961 70 000 111`; upload logo; change exchange rate; sign in as sales agent and confirm settings are not offered

### Implementation for User Story 3

- [x] T068 [P] [US3] Implement the storage interface and local-disk backend in `backend/app/core/storage.py` (server-generated path `tenant/<tenant_id>/<random>.webp`; Pillow decode + re-encode; 2 MB limit)
- [x] T069 [US3] Implement stores and settings services and APIs in `backend/app/services/stores.py`, `backend/app/services/settings.py`, `backend/app/api/stores.py`, `backend/app/api/business.py` per openapi.yaml: `GET/POST /stores`, `PATCH /stores/{id}`, `PUT/GET/DELETE /stores/{id}/logo`, `GET/PATCH /business`; audit `store.*` and `tenant.settings_changed` with before/after
- [x] T070 [US3] Build stores screens in `frontend/src/app/[locale]/(shell)/more/stores/` (`page.tsx`, `new/page.tsx`, `[storeId]/page.tsx`) with logo upload, client-side size/type pre-check, and the deactivation warning sheet
- [x] T071 [US3] Build business settings screen in `frontend/src/app/[locale]/(shell)/more/settings/page.tsx`; money inputs as decimal strings; save shows success only after the server responds
- [x] T072 [US3] Run T063–T067 and the route-coverage and contract tests; confirm all pass; record output in `specs/001-platform-foundation/checklists/us3.md`

**Checkpoint (approval point)**: Two-store businesses with separate WhatsApp numbers can be configured; settings are audited.

---

## Phase 6: User Story 4 - Bilingual, role-aware app shell (Priority: P4)

**Goal**: The five-tab shell from the designs, tabs and start tab by role, full Arabic/English with remembered choice, installable, with clear placeholder and offline states.

**Independent Test**: Sign in as the seeded owner, sales agent and packing agent on a 360 px screen; each sees the correct tabs and start tab; language switch flips layout and persists; app installs on `localhost` (quickstart scenario 5).

### Design (approval needed before T078–T082)

- [x] T073 [US4] Design the missing screens for US4 in `design/bos-screens.html`: History, Devices, Language, Profile (name, phone, email), placeholder state, offline notice; English and Arabic; present for approval

### Tests for User Story 4 (write first, confirm they fail)

- [x] T074 [P] [US4] Component tests in `frontend/tests/shell/`: bottom navigation shows exactly the tabs from `contracts/permissions.md` for each role combination; `start_tab` order honoured; placeholder state rendered for later-milestone areas; `dir` is `rtl` for `ar` and `ltr` for `en`; times render in Asia/Beirut regardless of the device time zone (FR-030)
- [x] T075 [P] [US4] Playwright scenario in `frontend/e2e/us4-shell.spec.ts` using seeded users: for owner, sales and packing users in `en` and `ar` at 360×740 — correct tabs and start tab; no horizontal scroll on any M0 screen (assert `scrollWidth <= clientWidth`); language switch applies immediately and persists after sign-out and sign-in in a fresh browser context; saved language wins over the pre-sign-in choice; with the network offline, saving shows the failure message and the value is not shown as saved
- [x] T076 [P] [US4] Test in `frontend/tests/pwa/manifest.test.ts` that the manifest is valid (name "BOS", `display: standalone`, icons 192 and 512, `start_url`) and the service worker caches only static shell assets, never `/api/`
- [x] T077 [P] [US4] End-to-end history check in `backend/tests/integration/test_audit_completeness.py`: run one of every action from stories 1–3 and assert every event in data-model.md appears once with the correct actor and time (SC-008)

### Implementation for User Story 4

- [x] T078 [US4] Build the shell layout in `frontend/src/app/[locale]/(shell)/layout.tsx` and `frontend/src/components/BottomNav.tsx` per design screens 02 and 18: five tabs filtered by `me.tabs`, redirect to `me.start_tab` on entry, safe-area padding, active tab indicated by icon weight + label (not color alone)
- [x] T079 [P] [US4] Build tab pages with placeholder states in `frontend/src/app/[locale]/(shell)/{sales,packing,delivery,orders}/page.tsx` and the More menu in `frontend/src/app/[locale]/(shell)/more/page.tsx` showing only permitted items (Employees, Stores, Settings, History, Devices, Profile, Language, Sign out)
- [x] T080 [P] [US4] Build Language and Profile screens in `frontend/src/app/[locale]/(shell)/more/language/page.tsx` and `more/profile/page.tsx` (`PATCH /me`; changing phone or email asks for the current password)
- [x] T081 [P] [US4] Build History and Devices screens in `frontend/src/app/[locale]/(shell)/more/history/page.tsx` (translated event names, Beirut time, load more) and `more/devices/page.tsx` (list own sessions, end one, end all others)
- [x] T082 [P] [US4] Add PWA assets: `frontend/public/manifest.webmanifest`, icons in `frontend/public/icons/`, minimal service worker in `frontend/src/app/sw.ts` (static shell cache + offline notice only), registration in `frontend/src/app/[locale]/layout.tsx`
- [x] T083 [US4] Add global connection and error handling in `frontend/src/components/OfflineNotice.tsx` and `frontend/src/lib/api.ts`: no optimistic success anywhere; failed writes show a clear message and keep the user's input
- [x] T084 [US4] Run T074–T077 and the route-coverage and contract tests; confirm all pass; record output in `specs/001-platform-foundation/checklists/us4.md`

**Checkpoint (approval point)**: All four stories work together in both languages on a phone.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and the M0 exit gate.

- [x] T085 [P] Write `README.md`: what BOS is, local startup, `.env.example` explanation, ports, migrations, seed data, demo sign-ins, operator creation, all test commands, phone demo on the local network, project layout, link to the constitution and specs
- [x] T086 [P] Document migration rollback in `backend/migrations/README.md` and verify `flask db downgrade base` then `upgrade head` works on a seeded database
- [x] T087 [P] Accessibility and RTL pass over every M0 screen: visible focus states, labels on all fields and icon buttons, contrast ≥ 4.5:1 in light and dark, touch targets ≥ 44 px; record findings and fixes in `specs/001-platform-foundation/checklists/ux-pass.md`
- [x] T088 [P] Measure SC-009 with Lighthouse mobile throttling on sign-in, home, employees, stores and settings; record results in `specs/001-platform-foundation/checklists/performance.md`; fix anything over 3 seconds
- [x] T089 [P] Security review against the spec: no secret, token or link is logged, stored in plain text or returned after creation; cookies have the required flags; uniform sign-in errors; `.env` is git-ignored; scan the repository for committed secrets; record in `specs/001-platform-foundation/checklists/security.md`
- [x] T090 Run the full quickstart (`specs/001-platform-foundation/quickstart.md`): all automated suites with captured output, then manual scenarios 1–5 in English and Arabic, timing business setup, owner activation and employee invitation against SC-001 and SC-002; record each step in `specs/001-platform-foundation/checklists/exit-gate.md`
- [x] T091 Review M0 against the Definition of Done in the constitution and the product brief section 11; list any gaps in `specs/001-platform-foundation/checklists/exit-gate.md` and present to the product owner for exit-gate approval
- [x] T092 Close exit-gate finding F-04: password-reset requests answer after the same work whether or not the email is registered (lookup, link and email sent after the response) and are limited per IP address; tests in `backend/tests/`; update `checklists/security.md`
- [x] T093 Close exit-gate finding F-09 per FR-012a (revised 2026-11-14): accepting an employee invitation by email first asks for a single-use code emailed to that address; migration with rollback, contract, accept screen in English and Arabic, tests at every level; update `checklists/security.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: needs Phase 1; blocks every user story
- **US1 (Phase 3)**: needs Phase 2
- **US2 (Phase 4)**: needs US1 (invitations service, sign-in, `/me`)
- **US3 (Phase 5)**: needs US1; independent of US2 (tests use fixtures and seeded users)
- **US4 (Phase 6)**: needs US1; uses seeded users of every role from Phase 2, so it does not need US2. More-menu items for areas not yet built stay hidden until their story lands
- **Polish (Phase 7)**: needs all stories

### User Story Dependencies

```text
Setup → Foundational → US1 ─┬→ US2 ─┐
                            ├→ US3 ─┼→ Polish
                            └→ US4 ─┘
```

### Within Each User Story

1. Design task → shown to the product owner → approved (in parallel with tests and backend work; only frontend build tasks wait for it)
2. Tests written and seen to fail
3. Services → API → frontend screens
4. Run the story's tests plus route-coverage and contract tests; capture output

### Parallel Opportunities

- Phase 1: T003, T005, T006 alongside T002/T004
- Phase 2: test tasks T009–T016 together; then T019, T020, T027, T028, T029 together; frontend foundation T033–T036 in parallel with backend work
- Each story: all its test tasks together
- Design tasks T038, T054, T062, T073 all edit `design/bos-screens.html` and are therefore **not** parallel with each other
- After US1: US2, US3 and US4 can proceed in parallel if more than one person is working

---

## Parallel Example: User Story 1

```text
# Write all US1 tests together:
T039 backend/tests/integration/test_ops.py
T040 backend/tests/integration/test_auth.py
T041 backend/tests/integration/test_me.py
T042 backend/tests/integration/test_audit_api.py
T043 backend/tests/isolation/test_us1_routes.py
T044 frontend/e2e/us1-activation.spec.ts

# Meanwhile:
T038 design/bos-screens.html (M0 additions) → approval
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup, verified in containers (T008)
2. Phase 2 Foundational — do not skip; this is where isolation is built and proven
3. Phase 3 US1
4. **Stop and validate**: quickstart scenarios 1 and 2; isolation suite green
5. Demonstrate: two merchants, each closed to the other

### Incremental Delivery

1. Setup + Foundational → isolation proven at the database level
2. + US1 → merchants can be set up and sign in (demo)
3. + US2 → real roles and store limits (demo)
4. + US3 → two-store businesses configured (demo)
5. + US4 → full bilingual shell, installable (demo)
6. Polish → exit gate; M0 complete, M1 may start

### Approval points

- After Phase 2 (T037): show the RLS, scoped-function and route-coverage tests passing
- Each design task before its screens are built
- After each story: demonstrate in both languages before starting the next
- After T091: product owner approves the M0 exit gate (approved 2026-11-14)

---

## Notes

- [P] tasks touch different files and have no unfinished dependency
- New API routes must be registered with the isolation harness (T011) and exist in the contract (T032) in the same task that adds them, or the suites fail
- Never claim a test passed without running it and capturing the output (Principle IV)
- On the development PC, pull container images one at a time and check free memory first; other software shares this Docker engine
- Out of scope for every task here: catalog, stock, orders, packing, delivery, COD, WhatsApp, WooCommerce, job queue, object storage, identifier verification by SMS/email code
