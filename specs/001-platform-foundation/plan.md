# Implementation Plan: Platform Foundation (M0)

**Branch**: `001-platform-foundation` | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-platform-foundation/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

M0 delivers the base every later milestone stands on: isolated business accounts set up by
Beta operators, sign-in by phone or email, employees (each belonging to exactly one
business) with roles limited to specific stores,
store and business settings, an unalterable history, and the bilingual mobile shell from the
approved designs.

Technical approach: a Flask REST API over PostgreSQL in which tenant isolation is enforced by
the database itself (Row-Level Security plus composite foreign keys) as well as by the
application; server-side sessions so access changes apply on the next request; a Next.js PWA
that renders the shell in Arabic and English from one codebase using CSS logical properties.
An isolation test suite enumerates every API route and fails if any route lacks a
cross-tenant, a missing-permission and (where store-scoped) a cross-store test. Decisions
and rejected alternatives are in [research.md](research.md).

**Revision 2 (2026-11-10)**: after an independent review found 30 issues, the product owner
decided each user belongs to one business. The data model, API contract, permissions and
tasks were revised; decisions R21–R32 in research.md record what changed and why.

## Technical Context

**Language/Version**: Python 3.12 (backend); TypeScript on Node 24 LTS (frontend)

**Primary Dependencies**: Flask, SQLAlchemy 2, Alembic, argon2-cffi, phonenumbers, Pillow
(backend); Next.js (App Router), React, next-intl (frontend). Versions pinned in lock files
at scaffold time.

**Storage**: PostgreSQL (single transactional source of truth, Row-Level Security enabled);
local Docker volume for store logos behind a storage interface

**Testing**: pytest against real PostgreSQL, including a route-enumerating isolation suite;
Vitest + Testing Library; Playwright end-to-end at 360×740 in `en` and `ar`

**Target Platform**: Linux containers (Docker Compose) for the server; mobile browsers on
low-cost Android phones first, desktop browsers second; installable as a PWA

**Project Type**: Web application (backend API + frontend PWA)

**Performance Goals**: Shell usable within 3 seconds on a mid-range Android phone over mobile
data (SC-009); API requests for M0 screens answered within 300 ms at the 95th percentile on
the pilot server

**Constraints**: No cross-tenant access under any request or job (Principle I); nothing shown
as saved before the server confirms (FR-031); no horizontal scroll at 360 px in either
language (SC-006); no offline writes; no Redis/Celery, no WhatsApp, no WooCommerce in M0

**Scale/Scope**: Pilot of about 5 businesses and under 100 users, designed to hold thousands
of tenants without structural change. About 12 screens, 36 API operations, 12 tables.

**Concrete values fixed here** (left open in the spec):

| Item | Value |
|---|---|
| Session inactivity limit, tenant users (FR-011) | 30 days, 90 days absolute |
| Session inactivity limit, operators | 12 hours, 7 days absolute |
| Minimum password length (FR-010) | 10 characters, common passwords rejected |
| Failed sign-in lock (FR-007) | 5 failures per identifier in 15 min → 15 min block |
| Logo upload limit (FR-025) | 2 MB; PNG, JPEG or WebP; re-encoded to WebP ≤ 512×512 |
| Activation and invitation link lifetime | 7 days |
| Password-reset link lifetime | 1 hour |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How this plan complies | Status |
|---|---|---|
| I. Tenant isolation and least privilege | RLS on every tenant table including `users`, composite FKs, tenant context for requests and jobs, only five narrowly scoped functions for pre-tenant access, 404 for foreign records, static role→permission map with store scope checked per request, route-enumerating isolation suite requiring cross-tenant, missing-permission and cross-store cases (R2, R3, R12, R18, R21–R24, R31) | Pass |
| II. Inventory and money integrity | No stock or orders in M0. Foundations laid: idempotency keys (R10), exact decimals with explicit currency for settings, append-only history (R11), settings never rewrite earlier records (FR-024) | Pass |
| III. Mobile-first, bilingual UX | Next.js PWA using the design tokens and logical properties; `en`/`ar` from the first screen, operator screens included; Playwright at 360 px in both languages; no optimistic success (R15, R16, R18, R28, R29) | Pass |
| IV. Contracts and tests before integration | OpenAPI contract and permissions matrix written before code; tests written first and seen to fail; real PostgreSQL in tests. No external platform is integrated in M0 | Pass |
| V. Small vertical slices | Only M0 scope. Celery/Redis and object storage deliberately deferred (R9, R14). Four user stories, each independently demonstrable | Pass |
| VI. Observability and recovery | Audit entries written in the same transaction as each change; refused access recorded; every email attempt and maintenance run recorded, failures visible in the business's history; structured request logs with request ID; health endpoint (R11, R27) | Pass |
| VII. No unauthorized automation | No third-party messaging or scraping. Links are shared by people; only password-reset email is sent, over SMTP | Pass |
| VIII. No destructive change without approval | Every migration has a documented downgrade; no external systems are written to; secrets only in `.env` (git-ignored); tokens stored hashed, never in URLs sent to the server, never in stored responses (R25, R26) | Pass |

**Post-design re-check (revision 2)**: the first version of this check was my own and
missed real problems; an independent review found four constitution conflicts (two isolation
flaws from multi-business users, English-only operator screens, unrecorded email sends). All
four are resolved in revision 2:

- `users` is now tenant-scoped and under RLS (R21, R22).
- Data needed before a tenant is known comes only from five narrowly scoped database
  functions, each tested from every context (R23).
- Operator screens are bilingual and phone-first (R28).
- Email attempts and maintenance runs are recorded (R27).

Three limitations are accepted and listed in data-model.md: identifiers are unverified, a
third party can trigger a sign-in lockout, and an operator-issued owner reset link could be
used by the operator (restricted, recorded and visible to the business).

No entries are needed in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-platform-foundation/
├── plan.md              # This file
├── research.md          # Phase 0: decisions and alternatives
├── data-model.md        # Phase 1: tables, rules, state transitions
├── quickstart.md        # Phase 1: how to run and validate M0
├── contracts/
│   ├── openapi.yaml     # API contract
│   └── permissions.md   # Roles → permissions → tabs
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks; not created by /speckit-plan)
```

### Source Code (repository root)

```text
backend/
├── pyproject.toml
├── Dockerfile
├── app/
│   ├── __init__.py            # app factory, request logging
│   ├── config.py              # environment configuration
│   ├── errors.py              # error envelope
│   ├── core/
│   │   ├── db.py              # engine, session, transaction helper
│   │   ├── tenancy.py         # tenant/operator context, SET LOCAL app.tenant_id
│   │   ├── request_context.py # session → user → tenant → permission lifecycle
│   │   ├── permissions.py     # role → permission map, require() with store scope
│   │   ├── security.py        # password hashing, tokens, CSRF header
│   │   ├── sessions.py        # server-side sessions and cookies
│   │   ├── rate_limit.py      # sign-in and reset-email limits
│   │   ├── mailer.py          # SMTP, records email.sent / email.failed
│   │   ├── idempotency.py
│   │   ├── audit.py           # append-only writer
│   │   ├── identifiers.py     # phone/email normalization
│   │   └── storage.py         # file storage interface + local-disk backend
│   ├── models/                # SQLAlchemy models (one module per aggregate)
│   ├── api/                   # blueprints: auth, me, business, stores, staff, audit, ops
│   ├── services/              # business rules: onboarding, invitations, staff, stores, settings, seed
│   └── cli.py                 # seed-demo, create-operator, maintenance
├── migrations/                # Alembic, incl. RLS policies and audit trigger
└── tests/
    ├── unit/
    ├── integration/           # per-endpoint behaviour against real PostgreSQL
    ├── isolation/             # route enumeration: cross-tenant + missing permission
    └── contract/              # responses validated against contracts/openapi.yaml

frontend/
├── package.json
├── Dockerfile
├── public/                    # manifest, icons, self-hosted fonts
├── messages/                  # en.json, ar.json
├── src/
│   ├── app/
│   │   ├── [locale]/
│   │   │   ├── (auth)/        # sign-in, activate, reset password
│   │   │   ├── (shell)/       # sales, packing, delivery, orders, more
│   │   │   │   └── more/      # employees, stores, settings, history, devices
│   │   │   ├── ops/           # operator sign-in, business list, setup form
│   │   │   └── layout.tsx     # dir/lang, fonts, tokens
│   │   └── sw.ts              # minimal service worker
│   ├── i18n/                  # next-intl routing and request config
│   ├── components/            # buttons, fields, chips, sheet, nav, states
│   ├── lib/                   # api client, error codes → messages, session
│   └── styles/                # tokens.css (from design/bos-screens.html)
├── tests/                     # Vitest + Testing Library
└── e2e/                       # Playwright, en + ar at 360×740

docker-compose.yml             # db, api, web, mail (db and api publish no host ports)
docker/db/init/                # creates the application role and test database
.env.example
.github/workflows/ci.yml
README.md
```

**Structure Decision**: Web application with `backend/` and `frontend/` at the repository
root, matching the brief's stack. Backend code is layered as `api` (HTTP) → `services`
(rules) → `models` (data), with cross-cutting concerns in `core/`. The frontend groups routes
by signed-out, shell and operator areas. Later milestones add modules inside these same
directories; nothing here anticipates their internals.

## Design notes for implementation

- **Request lifecycle**: resolve session by token hash (gives user id and tenant id) → open
  transaction → set `app.tenant_id` → load user and tenant → refuse if tenant is not active
  or user inactive → check permission and store scope → run handler → write audit entry →
  commit.
- **Order of work** (for `/speckit-tasks`): scaffold and CI → database, RLS and isolation test
  harness → auth and sessions → operator setup and owner activation (US1) → staff and
  permissions (US2) → stores and settings (US3) → shell, languages and PWA (US4) → seed data,
  README, quickstart run.
- **Screens to design before US2–US4 build**: account activation, employees and invitation
  sheet, stores list and edit, business settings, history, devices, and the operator's
  business list and setup form. Sign-in, home shell and More already exist in
  `design/bos-screens.html`.

## Complexity Tracking

No constitution violations; nothing to justify.
