# Research: Platform Foundation (M0)

Decisions that resolve every open point in the plan's Technical Context. Each lists what was
chosen, why, and what was rejected. Library versions are "current stable at implementation
time" and are pinned in lock files when the project is scaffolded; they are not asserted here.

## R1. Backend framework

- **Decision**: Python 3.12 with Flask, SQLAlchemy 2 (typed ORM) and Alembic. One backend
  framework only.
- **Rationale**: Named as the default in the product brief (section 8); familiar and low-cost.
  Nothing in M0 needs async I/O.
- **Alternatives considered**: FastAPI (allowed by the brief only with a documented reason;
  none exists for M0). Django (bundled auth/admin, but its tenant and RBAC model would have to
  be bent to fit, and the brief names Flask).

## R2. Tenant isolation mechanism

- **Decision**: Shared database, shared schema. Every tenant-owned table carries `tenant_id`.
  Isolation is enforced twice:
  1. **In the database** with PostgreSQL Row-Level Security. The application connects as a
     role that does not own the tables and cannot bypass RLS. Each request and each job runs
     in a transaction that first sets `app.tenant_id` (transaction-local); policies compare
     `tenant_id` to it. With no tenant set, policies match nothing.
  2. **In the application**: a request-scoped tenant context; all repository queries go
     through helpers that add the tenant filter; cross-tenant foreign keys are impossible
     because child tables use composite foreign keys `(tenant_id, parent_id)`.
- **Rationale**: Constitution Principle I is non-negotiable. A forgotten `WHERE` clause must
  not be enough to leak data; RLS makes the database refuse. Composite keys stop a row in
  tenant A from pointing at a row in tenant B.
- **Alternatives considered**: Application-level filtering only (one missed filter leaks).
  Schema-per-tenant or database-per-tenant (strong, but migrations and connection handling
  become heavy for no pilot benefit, and cross-store shared stock in later milestones stays
  inside one tenant anyway).

## R3. Record identifiers and "not found" behavior

- **Decision**: Random UUID primary keys exposed in the API. Any record outside the caller's
  tenant or permitted stores returns `404 Not Found`, identical to a record that does not
  exist. Lacking a permission on a record the caller can see returns `403`.
- **Rationale**: FR-003 forbids revealing whether another tenant's record exists. Sequential
  integers invite guessing.
- **Alternatives considered**: Sequential IDs with access checks (leak volume and existence
  through timing and error differences).

## R4. Authentication and sessions

- **Decision**: Server-side sessions stored in PostgreSQL. The browser holds only an opaque
  random token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; the database stores its
  SHA-256 hash. Passwords are hashed with Argon2id. State-changing requests additionally
  require a custom header (`X-BOS-CSRF`) that a cross-site form cannot set.
- **Concrete values** (fixing FR-011):
  - Tenant users: session ends after **30 days without activity**, and at most **90 days**
    after sign-in regardless of activity.
  - Operators: **12 hours** without activity, **7 days** maximum.
  - Minimum password length **10** characters, checked against a list of common passwords.
- **Rationale**: FR-017 requires role changes and deactivation to apply on the very next
  action and to sign the user out everywhere. With server-side sessions that is one database
  update; permissions are re-read on every request. Staff use phones all day, so a short
  timeout would be hostile; 30 days sliding is the practical minimum for adoption.
- **Alternatives considered**: JWT with refresh rotation (allowed by the brief, but immediate
  revocation needs a server-side denylist anyway, which removes the benefit). Third-party
  identity provider (extra cost and a dependency; phone-number sign-in without SMS is awkward
  with most providers).

## R5. Sign-in identifiers

- **Decision**: A user has an optional `phone_e164` and an optional `email`, at least one
  required, each unique across all users. Phone input is parsed with the `phonenumbers`
  library using Lebanon as the default region and stored in E.164. Email is stored
  lower-cased and compared case-insensitively. The sign-in form accepts one field and decides
  by the presence of `@`.
- **Rationale**: FR-006/FR-006a. Normalizing once at the edge prevents two accounts for the
  same number typed in different formats.
- **Alternatives considered**: Storing raw input and normalizing at comparison time (error
  prone, cannot be enforced by a unique index).

## R6. Brute-force protection

- **Decision**: Failed sign-ins are recorded in PostgreSQL. After **5 failures for one
  identifier within 15 minutes**, further attempts for that identifier are refused for 15
  minutes. A looser per-IP limit (**30 failures per 15 minutes**) applies as well. The
  response for a wrong password, an unknown identifier and a locked identifier is the same
  message.
- **Rationale**: FR-007. Counting in PostgreSQL avoids adding Redis to M0 (Principle V).
- **Alternatives considered**: Flask-Limiter backed by Redis (introduces a service nothing
  else in M0 needs). CAPTCHA (hostile on low-end phones; revisit if abuse appears).

## R7. Invitations, owner activation and password reset links

- **Decision**: One mechanism for all three: a random 32-byte token shown once as a link;
  only its hash is stored. Tokens are single-use and expire: **7 days** for owner activation
  and employee invitations, **1 hour** for password resets. Accepting is done in one
  transaction that locks the token row, so a simultaneous revoke and accept cannot both
  succeed.
- **Rationale**: FR-005a, FR-014, FR-015, and the edge case "accepted at the same moment it
  is revoked".
- **Alternatives considered**: Operator or owner sets an initial password (violates FR-015;
  the inviter would know it).

## R8. Email delivery

- **Decision**: Plain SMTP configured by environment variables. Local development uses a
  Mailpit container that captures all mail. Email is used only for password-reset links to
  users who have an email. Sending is done inline within the request in M0.
- **Rationale**: The only M0 email is low volume and user-initiated. No SMS or WhatsApp
  sending exists in the MVP (spec Assumptions), so phone-only users receive links from a
  person.
- **Alternatives considered**: Transactional email API (fine later; SMTP keeps the provider
  swappable). Background queue for sending (deferred, see R9).

## R9. Background jobs

- **Decision**: No job queue in M0. FR-004 (isolation in background work) is satisfied by
  building and testing the tenant-context helper that jobs will use, exercised through a
  command-line maintenance task (expiring stale invitations and sessions). Celery + Redis is
  introduced in the first milestone that needs asynchronous work.
- **Rationale**: Principle V: no speculative infrastructure. The isolation primitive is what
  matters now, and it is tested.
- **Alternatives considered**: Adding Celery + Redis now (two more services to run and
  monitor with nothing for them to do).

## R10. Idempotency

- **Decision**: Business setup, owner activation, invitation acceptance and employee
  invitation accept an `Idempotency-Key` header. The key, actor and a hash of the request are
  stored with the response; a repeat returns the stored response, and the same key with a
  different body is rejected. Database unique constraints back this up (one membership per
  user per tenant; one active owner-activation per tenant).
- **Rationale**: FR-002, SC-007, Principle II. The same mechanism is reused for order
  confirmation in M2.
- **Alternatives considered**: Relying on unique constraints alone (prevents duplicates but
  returns an error on the retry instead of the original success).

## R11. Audit history

- **Decision**: One append-only `audit_entries` table. The application role is granted
  `INSERT` and `SELECT` only; a database trigger rejects `UPDATE` and `DELETE` for everyone.
  Entries are written in the same transaction as the change they describe. Refused access
  attempts are written in a separate transaction so they survive the rollback of the refused
  request.
- **Rationale**: FR-032 to FR-034, Principle VI. Writing in the same transaction means there
  is never a change without its history.
- **Alternatives considered**: Log files only (not queryable by owners, not tamper-evident).
  Generic ORM change-capture (records too much noise and misses refused attempts).

## R12. Roles and permissions

- **Decision**: Roles are a fixed set stored as an array on the membership. A static map in
  code translates each role to a set of permission strings (for example `staff.manage`,
  `store.manage`, `settings.manage`, `audit.view`). Endpoints declare the permission they
  need and, where relevant, which store the action concerns; a decorator checks both against
  the membership on every request. The full map, including permissions for areas that arrive
  in later milestones, is in `contracts/permissions.md`.
- **Rationale**: FR-013, FR-016. A static map is reviewable in one file and trivially
  testable. Custom per-tenant roles are not required by the brief.
- **Alternatives considered**: Database-driven custom roles (flexibility nobody asked for).

## R13. Operator access

- **Decision**: Operators are a separate table with their own sign-in endpoint, session
  cookie and URL space (`/ops`). Operator requests never set `app.tenant_id`; instead they run
  with `app.operator = on`, and RLS policies grant that context access only to the `tenants`
  table and to account-level aggregates exposed through a database view. Operator sign-in
  requires an email on an allow-list set in configuration. The first operator is created by a
  command-line command.
- **Rationale**: FR-005b/c: operators manage accounts but must not see inside a merchant.
  Enforcing this with RLS means an operator endpoint bug cannot expose merchant rows.
- **Alternatives considered**: A "super admin" membership inside every tenant (gives exactly
  the access FR-005c forbids).

## R14. Logo storage

- **Decision**: A small storage interface with a local-disk implementation on a Docker
  volume. Uploads are limited to **2 MB**, PNG/JPEG/WebP only, verified by decoding the image
  and re-encoding it to WebP at a maximum of 512×512. Files are stored under a path derived
  from the tenant and a random name, and are served only through an authenticated endpoint
  that checks the tenant (fixing FR-025).
- **Rationale**: Re-encoding strips anything that is not image data. Serving through the API
  keeps files private per tenant. The interface lets M1 move product photos to object storage
  without touching callers.
- **Alternatives considered**: S3-compatible object storage now (needed for product photos in
  M1, premature for one logo per store). Public static URLs (violates FR-025).

## R15. Frontend framework, languages and layout direction

- **Decision**: Next.js (App Router) with React and TypeScript. Translations with
  `next-intl`, locale in the URL (`/en/...`, `/ar/...`), `dir` and `lang` set on the document.
  Styling uses the CSS custom-property tokens from `design/bos-screens.html` and CSS logical
  properties throughout, so right-to-left needs no separate stylesheet. Fonts (Inter, IBM
  Plex Sans Arabic) are self-hosted. The user's language is stored on the user record and
  applied after sign-in.
- **Rationale**: Named in the brief. Logical properties are what made the Arabic design
  screens work without hand-flipping. Self-hosted fonts avoid a third-party request on slow
  connections.
- **Alternatives considered**: A component library with its own theming (would fight the
  approved designs and RTL). Locale in a cookie only (harder to test and to share links).

## R16. Installable app (PWA)

- **Decision**: A web app manifest plus a minimal service worker that caches only the static
  shell and shows an offline notice. No offline data, no queued writes.
- **Rationale**: FR-028 needs installability; FR-031 forbids showing success before the
  server confirms, which rules out queued offline writes.
- **Alternatives considered**: Full offline-first with background sync (conflicts with
  Principle II and FR-031 for stock and money).

## R17. Frontend-to-backend communication

- **Decision**: The browser calls the Flask API at `/api/v1` on the same origin, through a
  reverse proxy in production and a Next.js rewrite in development. JSON over REST; errors
  use one envelope `{ "error": { "code", "message", "fields" } }` with stable codes that the
  frontend translates. The contract is `contracts/openapi.yaml`.
- **Rationale**: Same origin keeps cookies first-party and avoids CORS. Stable error codes
  keep Arabic and English messages in the frontend.
- **Alternatives considered**: GraphQL (no need). Next.js server actions calling the database
  (would create a second backend, forbidden by the brief).

## R18. Testing approach

- **Decision**:
  - **Backend**: pytest against a real PostgreSQL (the Compose database), each test in a
    rolled-back transaction or a fresh schema. No SQLite.
  - **Isolation suite**: a dedicated suite that enumerates every registered route and, for
    each, calls it as tenant B against tenant A's records and as each role lacking the needed
    permission. The suite fails if a route exists without an isolation case, so new endpoints
    cannot ship untested. RLS is additionally tested directly at the database level.
  - **Frontend**: Vitest and Testing Library for components.
  - **End to end**: Playwright at a 360×740 viewport in both `en` and `ar`, covering the four
    user stories.
  - **Order**: tests are written first and seen to fail (Principle IV).
- **Rationale**: RLS and composite keys only exist in PostgreSQL, so tests must run on it.
  Route enumeration turns SC-003 and SC-004 from a promise into a mechanism.
- **Alternatives considered**: SQLite for speed (cannot test RLS). Hand-maintained isolation
  tests (silently incomplete as endpoints are added).

## R19. Local development and CI

- **Decision**: Docker Compose runs `db` (PostgreSQL), `api` (Flask), `web` (Next.js) and
  `mail` (Mailpit). Python dependencies are managed with `uv`, Node with `npm`. A GitHub
  Actions workflow runs lint, type checks, backend tests (including the isolation suite) and
  frontend tests on every push; Playwright runs on pull requests.
- **Rationale**: Named in the brief. One command to start everything is part of the
  Definition of Done.
- **Alternatives considered**: Running services directly on the developer's Windows machine
  (PostgreSQL and Python version drift; the machine has Python 3.8).

## R20. Seed and demonstration data

- **Decision**: A command creates a demonstration tenant ("Demo Denim House Group", edition
  BOS Commerce) with two stores and one user per role, plus a second small tenant used only by
  the isolation tests and demos of separation. Demo passwords come from the environment
  template, never from committed code.
- **Rationale**: FR-035 and the Definition of Done.
- **Alternatives considered**: Fixture SQL dumps (drift from migrations).

---

# Revision 2 (2026-11-10): decisions after the independent review

An independent review of the spec, plan and tasks found 30 issues. The product owner decided
that **each user belongs to exactly one business**. The decisions below resolve the review's
findings and **override** any earlier text in this file that conflicts with them (notably
parts of R2, R5, R7, R10 and R13).

## R21. One business per user

- **Decision**: `users` carries `tenant_id` and is under RLS. There is no membership table;
  roles, store access and status are columns on the user. Phone and email remain unique
  across the whole platform because sign-in takes only an identifier.
- **Rationale**: Removes cross-business account takeover through owner-issued reset links
  (review C1), shared identity data between businesses (C2), and the undefined behaviour of
  multi-business sign-in and suspension (H5).
- **Alternatives considered**: Keeping multi-business users with verified identifiers (needs
  SMS or email codes that BOS cannot send in the MVP).

## R22. User rows are created at acceptance

- **Decision**: An invitation stores the invitee's name, identifier, roles and stores. The
  user row is created only when the link is accepted. An identifier already used elsewhere in
  BOS is not reported to the inviter; acceptance fails with a neutral `identifier_unavailable`.
- **Rationale**: Unaccepted invitations never reserve an identifier, and inviters cannot
  probe whether a phone number is registered with another merchant (C2).

## R23. Data needed before a tenant is known

- **Decision**: Five narrowly scoped `SECURITY DEFINER` functions (listed in data-model.md):
  identifier lookup for sign-in, token lookup for links, the operator overview, platform
  maintenance, and platform-level audit insert. `sessions` carries `tenant_id` and is queried
  only by token hash. No general RLS bypass exists for the application role.
- **Rationale**: Review H1, H3, M14. Each function returns the minimum needed and is tested
  from tenant context, operator context and no context.

## R24. Operator writes

- **Decision**: Business setup runs in one transaction: insert the tenant in operator
  context, then enter that tenant's context for the store and the owner invitation.
  Resending activation and issuing an owner reset link enter the target tenant's context the
  same way. Only functions in `services/onboarding.py` may do this, and each writes an audit
  entry in the tenant's own history.
- **Rationale**: Review H2, M12. Operators still cannot read inside a business through any
  endpoint; the overview function is the only read path.

## R25. Idempotency without stored responses

- **Decision**: `idempotency_keys` stores a reference to the created resource, not the
  response. A repeat returns the same resource and, if the first response carried a one-time
  link, issues a fresh link and revokes the earlier one. The table has `tenant_id` and RLS.
  Invitation acceptance uses no idempotency key: the link is single-use and a second
  submission returns 410 `link_already_used`.
- **Rationale**: Review H4, M11. No plaintext link is ever stored.

## R26. Tokens never in URLs sent to the server

- **Decision**: Link tokens are sent to the API in request bodies. Web pages carry them in
  the URL fragment (`/activate#<token>`, `/reset#<token>`), which browsers do not transmit.
- **Rationale**: Review M9. Request logs record paths.

## R27. Email and maintenance are recorded

- **Decision**: Each email attempt writes `email.sent` or `email.failed` to the recipient
  business's history; each maintenance run writes `maintenance.run` at platform level.
  Failed reset emails are therefore visible to the business's owners.
- **Rationale**: Review C4; constitution Principle VI.

## R28. Operator screens are bilingual and phone-first

- **Decision**: The operator area lives under the localized routes (`/[locale]/ops`) and
  follows the same rules as every other screen.
- **Rationale**: Review C3; constitution Principle III has no exemption for internal tools,
  and there are only three operator screens.

## R29. Language rule

- **Decision**: Signed-out pages use the locale in the URL; a first visit without one is
  redirected by the device language (Arabic → `ar`, otherwise `en`). The language chosen at
  activation is saved to the user. After sign-in the saved language always wins.
- **Rationale**: Review M7.

## R30. Test data, operator creation and phone demos

- **Decision**: The demo seed and a non-interactive `create-operator` (password from an
  environment variable) move to the foundation phase so end-to-end tests have users of every
  role from the start. For phone demos during development the web port can be bound to the
  local network with secure cookies switched off (development only); installing to a phone's
  home screen needs HTTPS and is validated on staging.
- **Rationale**: Review M5, M10.

## R31. Store scope is enforced from the foundation

- **Decision**: Store-scope checks are part of the permission decorator built in the
  foundation phase, and the route-coverage harness requires a cross-store test for every
  store-scoped route, in addition to cross-tenant and missing-permission tests.
- **Rationale**: Review H6, M13; constitution Principle I requires cross-store tests.

## R32. Container images and ports on the development PC

- **Decision**: PostgreSQL 16 (already present on the development machine), Node 24 and
  Python 3.12 images. The database and API publish no host ports; only the web app (3000)
  and the mail viewer (8025) do, both configurable.
- **Rationale**: Ports 5432 and 8000 are used by other software on the development PC.

## R33. Decisions after the foundation phase (2026-11-11)

- **Identifier hashing**: `login_attempts.identifier_hash` is HMAC-SHA-256 keyed with
  `BOS_SECRET_KEY`, not plain SHA-256: a plain hash of a Lebanese phone number can be
  reversed by trying every number. Rotating the secret resets the counters, which is
  acceptable. Password-reset email requests use the same table in a separate namespace.
- **Idempotency key format**: 1–200 characters; otherwise 400 `invalid_idempotency_key`.
  The request fingerprint covers method, path and canonical JSON body.
- **Demo seed guard**: `flask bos seed-demo` creates active users with known identifiers,
  so it refuses to run unless `BOS_ALLOW_DEMO_SEED=true` is set. Development and staging
  set it; production never does.
- **Operators**: `create-operator` sets a password but never reactivates a deactivated
  operator; reactivation is a deliberate separate act (not needed in M0).
- **Development without Docker**: on the development PC, PostgreSQL runs as a private local
  cluster (`scripts/local_db.py`, port 55433, disk flushing off) and the frontend uses a
  portable Node 24, because Docker Desktop there failed repeatedly on very slow disk
  flushes. The Compose files remain the reference for staging and production.

## R34. Contacting Beta, and the US1 screen designs (2026-11-11)

- **Approved designs**: screens 29–48 in `design/bos-screens.html` (section "M0 — Sign-in
  and setup"), approved by the product owner on 2026-11-11. Link lifetimes shown to users:
  activation and invitation links "work once, within 7 days"; reset links "work once,
  within 1 hour".
- **Contacting Beta**: where a merchant needs Beta (bad or expired link, suspended business),
  the screen offers a "Message Beta on WhatsApp" button that opens a chat with Beta's support
  number. The number is configuration (`NEXT_PUBLIC_BOS_SUPPORT_WHATSAPP`, E.164); when it
  is not set the button is hidden and the plain text "Contact Beta Marketing Solutions" is
  shown, so no placeholder number ever reaches a real merchant.
- **Names as typed**: business, store and person names are shown exactly as entered, in any
  script, in both languages; they are never translated.
- **Sharing one-time links**: the button opens the phone's share sheet (Web Share API) with
  copy as the fallback; WhatsApp is the expected choice but not forced.

## R35. Employee screens (2026-11-12)

- **Approved designs**: screens 49–74 in `design/bos-screens.html` (section "M0 — Employees"),
  approved by the product owner on 2026-11-12, with these decisions:
  - Share buttons for one-time links read "Share link" (they open the phone's share sheet).
  - Expired invitations can be resent but not revoked; pending ones can be both.
  - "Issue password-reset link" is offered for every employee, without a confirmation step
    (single use, one hour, recorded in history).
  - Deactivate (and removing the Owner role) is disabled up front for the only active owner;
    the server still refuses with `last_owner` if two changes race.
  - Resend lives in the invitation detail only, not on list rows.
- **Arabic role names** (confirmed by the product owner): مالك (Owner), مدير (Manager),
  موظف مبيعات (Sales agent), موظف تجهيز (Packing agent), موظف توصيل وتحصيل
  (Dispatch/collections); Deactivate = إلغاء التفعيل.

## R36. Stores and settings (2026-11-12)

- **Approved designs**: screens 75–102 in `design/bos-screens.html` (section "M0 — Stores and
  settings"), approved by the product owner on 2026-11-12.
- **More menu**: "Currency and rate" becomes **Settings** (business name, currency, rate,
  default delivery fee).
- **Money input**: people may type thousands separators (`89,500`); the app strips them and
  sends a plain decimal string. The API accepts ASCII decimal strings only, at most 2 decimals;
  JSON numbers, commas, exponents and non-Latin digits are refused (`invalid`). Rate > 0 and at
  most 10,000,000; delivery fee ≥ 0 and at most 100,000,000.
- **Deactivating a store**: the warning lists everyone who would lose their only access —
  active store-limited employees and pending store-limited invitations — by name and roles
  only. Their store assignments are kept, so reactivating restores access. A store-limited
  user whose only store is inactive sees no stores.
- **Store visibility**: owners and managers see every store, inactive included; other users
  see only their active permitted stores.
- **Logos**: new files are written before the database change and removed if the request rolls
  back; replaced files are removed only after commit. Images over 40 megapixels count as
  `file_too_large`.
