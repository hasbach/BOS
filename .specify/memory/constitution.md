# BOS (Beta Orders Solutions) Constitution

## Core Principles

### I. Tenant Isolation and Least Privilege (NON-NEGOTIABLE)

- Every request and every background job MUST be scoped to exactly one tenant, and to the
  stores the acting user is allowed to access.
- Permissions MUST be enforced on the server. Hiding a control in the interface is never a
  permission check.
- No tenant may read, list, guess or infer another tenant's customers, orders, products,
  stock, media or staff.
- Each role gets only the abilities it needs. A packing agent MUST NOT change prices or stock;
  a sales agent MUST NOT overwrite stock or alter settlements.
- Every feature MUST ship with automated tests that attempt cross-tenant and cross-store
  access and prove it is refused.

Rationale: BOS holds several competing merchants' customer lists and money records in one
system. One leak ends the product.

### II. Inventory and Money Integrity First (NON-NEGOTIABLE)

- There MUST be exactly one authoritative stock balance per sellable item per physical
  warehouse. `available = sellable on hand − active reservations`.
- Reservations MUST be all-or-nothing within one transaction. Negative availability is
  forbidden.
- Every operation that changes stock, orders or money MUST be idempotent: double taps,
  retries, replays and duplicate events never apply twice.
- Stock and money changes MUST be recorded as immutable, attributed, timestamped entries.
  Corrections are new entries; existing entries are never edited or deleted.
- Money MUST be stored as exact decimals with an explicit currency. Historical orders are
  never silently recalculated when exchange rates change.
- When the outcome of an operation is uncertain, the system MUST fail closed (refuse and say
  so) rather than risk an oversell or a double charge.

Rationale: the product exists to remove stock mistakes and COD confusion. Getting these wrong
is worse than not having the feature.

### III. Mobile-First, Bilingual, Role-Focused UX

- Every screen MUST be designed first for a narrow, low-cost Android phone, and MUST remain
  usable on desktop.
- Arabic (right-to-left) and English (left-to-right) MUST both be supported from the first
  feature onward. No screen ships in one language only.
- Sales and packing workflows MUST be completable one-handed with large touch targets and
  without horizontal scrolling.
- The interface MUST NOT show success before the server has durably confirmed it. Loading,
  empty, error and offline states MUST be designed, not left to defaults.
- Status MUST never be conveyed by color alone.
- Screens follow the approved designs in `design/bos-screens.html` unless a spec records a
  deliberate change.

Rationale: the users are sales and packing staff working on phones, often in Arabic, often
on weak connections.

### IV. Contracts and Tests Before Integration

- Interfaces between parts of the system and with external systems MUST be written down and
  tested before code depends on them.
- No behavior of an external platform (WooCommerce checkout events, WhatsApp availability,
  courier systems) may be assumed. It MUST be verified against a real staging instance first.
- Tests are written before or alongside the code they cover, and MUST be seen to fail before
  they are made to pass.
- Concurrency-sensitive behavior (last-unit contention, duplicate submissions) MUST have
  automated concurrent tests, not only sequential ones.
- Nobody may claim a test passed unless it was executed and its output captured.

Rationale: the hardest failures in this product are at boundaries and under concurrency, where
assumptions are cheapest to make and most expensive to get wrong.

### V. Small Vertical Slices

- Work proceeds one milestone at a time in the order defined in the product brief (M0, M1,
  M2, M3, M3.5, M4, M5, M6, M7).
- Each slice MUST be independently testable and demonstrable end to end before the next one
  starts.
- Implementation MUST stay inside the currently approved feature. Scope from later
  milestones is not started early, however convenient.
- The simplest design that satisfies the current slice is preferred. Speculative
  abstractions for future milestones require written justification in the plan.

Rationale: a usable BOS Social release comes first. Building everything at once delays it and
hides defects.

### VI. Operational Observability and Recovery

- Every background job and every call to an external system MUST leave a durable record of
  what was attempted, the outcome and any retry.
- Failures MUST be visible to staff in the product, not only in server logs.
- Any state that can be left uncertain by an external failure MUST have a reconciliation or
  repair path, and MUST block downstream steps (for example shipment release) until resolved.
- An audit history MUST exist for stock changes, financial changes, permission changes and
  sign-in security events.

Rationale: merchants will run their business on this. When something goes wrong they need to
see it and fix it without a developer.

### VII. No Unauthorized Automation

- BOS MUST connect to third-party platforms only through their official, authorized
  interfaces.
- Scraping WhatsApp Web, automating a personal WhatsApp session, or otherwise bypassing
  platform authorization is forbidden under all circumstances.
- BOS MUST NOT claim to read or send messages it has no authorized access to. Without an
  approved connection, messages are only copied or opened for the user to send.
- AI features (image recognition, transcription, automatic order creation) MUST NOT be added
  to the MVP silently. They require an amendment to the product brief.

Rationale: an unofficial integration risks the merchant's WhatsApp number being banned, which
would cost them their sales channel.

### VIII. No Destructive Change Without Backup, Staging and Approval

- No destructive data migration and no write to a merchant's live external system (for
  example WooCommerce stock or orders) may happen without a verified backup, a successful
  rehearsal on staging, and explicit release approval from the product owner.
- Every database migration MUST have a documented rollback.
- Approval for one release or one environment does not carry over to the next.
- Credentials, API tokens and real customer data MUST NOT be committed to version control.
  Secrets are encrypted at rest and never returned to the client after creation.

Rationale: the pilot merchant's two live stores and shared stock are real money. Mistakes
there are not reversible by a redeploy.

## Product & Technical Constraints

- **Product**: BOS — Beta Orders Solutions, a product by Beta Marketing Solutions. One
  platform, two editions: BOS Social (sellers without websites) and BOS Commerce (WooCommerce
  and multiple stores). Both editions share one tenant, store, order and inventory model.
- **Source of truth for scope**: `social_commerce_saas_mvp_speckit.md`. Where a spec and the
  brief disagree, the brief wins until it is amended.
- **Out of scope for the MVP**: public marketplace, full ERP/POS, online storefront, native
  mobile apps, payment gateway, AI features, Instagram/Facebook messaging.
- **Locale**: timestamps stored in UTC and shown in Asia/Beirut time. USD and LBP are both
  first-class currencies.
- **Technology guidance** (decided per feature in its plan, not in specs): mobile-first PWA
  frontend, a single backend framework (not mixed), one transactional relational database as
  the source of truth, a durable job queue with retries, containerized deployment.
- **One order, several statuses**: sale, fulfillment, delivery, payment and integration sync
  are separate dimensions and MUST NOT be collapsed into a single status.

## Development Workflow & Quality Gates

- Each feature follows the Spec Kit sequence: specify → clarify → plan → checklist → tasks →
  analyze → implement → converge. Artifacts are presented for approval before implementation
  begins.
- Specifications describe what and why. Technology choices belong in the plan.
- A milestone is done only when all of the following hold:
  - spec, plan and tasks have no unresolved critical contradictions;
  - migrations and their rollback are documented, and relevant tests were executed;
  - endpoints are validated and permission-enforced, with no cross-tenant leakage;
  - the mobile flow was demonstrated in both Arabic and English;
  - error, loading and empty states are handled;
  - audit events exist for stock, financial and permission changes;
  - the README covers local startup, environment template, seed data, demo sign-in and test
    commands;
  - scope stayed within the milestone.
- Review checklists MUST NOT be marked complete unless actually reviewed.

## Governance

- This constitution supersedes other practices and conventions in this repository. Plans and
  task lists MUST include a check against it, and any deviation MUST be justified in writing
  in the plan.
- Amendments are made by editing this file, with a version bump and an updated amendment
  date, and require approval from the product owner (Beta Marketing Solutions).
- Versioning follows semantic versioning: MAJOR for removing or redefining a principle, MINOR
  for adding a principle or materially expanding guidance, PATCH for clarifications.
- Compliance is reviewed at every milestone exit gate. Principles I, II, VII and VIII cannot
  be waived for schedule reasons.

**Version**: 1.0.0 | **Ratified**: 2026-11-10 | **Last Amended**: 2026-11-10
