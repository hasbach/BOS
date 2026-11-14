# Data Model: Platform Foundation (M0)

Logical model for M0, revision 2 (after the independent review of 2026-11-10 and the product
owner's decision that **each user belongs to exactly one business**). Column types are
indicative; the migration is written during implementation. All timestamps are stored in UTC
(`timestamptz`). All primary keys are random UUIDs. "RLS" means the table has a Row-Level
Security policy on `tenant_id` (research R2).

## Overview

```text
Operator ──creates──> Tenant ──has──> Store
                        │               ▲
                        │               │ user_stores
                        ├──< User >─────┘      (a user belongs to exactly one tenant)
                        ├──< Invitation        (holds invitee details until accepted)
                        ├──< File (logos)
                        └──< AuditEntry        (platform-level entries have no tenant)
User / Operator ──< Session
User ──< PasswordReset
```

There is no membership table. Roles, store access and status live on the user.

## Access before a tenant is known

Three situations need data before `app.tenant_id` can be set. Each uses one narrowly scoped
`SECURITY DEFINER` database function owned by the owner role; there is no general bypass of
RLS (review findings H1, H3, M14).

| Function | Used by | Returns / does |
|---|---|---|
| `auth_lookup_identifier(kind, value)` | sign-in, email reset request | For one normalized phone or email: user id, tenant id, password hash, user status, tenant status. Nothing else. |
| `auth_lookup_token(kind, token_hash)` | invitation preview/accept, reset completion | The tenant id and row id for one invitation or password-reset token hash. |
| `ops_business_overview()` | operator business list | Account-level rows only; raises unless `app.operator = on`. |
| `platform_maintenance()` | `flask bos maintenance` | Marks expired invitations, deletes expired sessions, old login attempts and idempotency keys. Reads no merchant business data. |
| `audit_platform_event(...)` | sign-in failure for an unknown identifier, operator sign-in, maintenance | Inserts an audit row with `tenant_id` null. |

Session lookup needs no function: `sessions` is not under RLS, is only ever queried by token
hash, and carries `tenant_id`, which is then used to set the tenant context.

## Tables

### operators (not tenant data)

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| email | text | unique, lower-cased, must be on the configured allow-list |
| name | text | 1–120 chars |
| password_hash | text | Argon2id |
| is_active | bool | default true |
| created_at | timestamptz | |

### tenants (RLS: `id = app.tenant_id`; operator context may read and insert)

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| name | text | 1–120 chars |
| edition | enum `social` / `commerce` | recorded only; gates nothing in M0 |
| status | enum `pending` / `active` / `suspended` | see state transitions |
| is_demo | bool | default false; true only for seeded demonstration businesses (FR-035) |
| default_currency | enum `USD` / `LBP` | default `USD` |
| usd_lbp_rate | numeric(18,2) | > 0; LBP per 1 USD; entered by the operator at setup, no built-in default |
| default_delivery_fee | numeric(12,2) | ≥ 0; default 0 |
| default_delivery_fee_currency | enum `USD` / `LBP` | default `USD` |
| created_by_operator_id | uuid | FK operators |
| created_at, updated_at | timestamptz | |

### stores (RLS)

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | FK tenants; unique `(tenant_id, id)` for composite references |
| name | text | 1–80 chars; unique per tenant among active stores |
| whatsapp_e164 | text, nullable | E.164; unique per tenant among active stores (FR-022) |
| logo_file_id | uuid, nullable | FK `(tenant_id, id)` → files |
| status | enum `active` / `inactive` | a tenant must keep at least one active store |
| created_at, updated_at | timestamptz | |

### users (RLS)

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | FK tenants, NOT NULL; unique `(tenant_id, id)` |
| name | text | 1–120 chars |
| phone_e164 | text, nullable | E.164; **unique across all tenants** |
| email | text, nullable | lower-cased; **unique across all tenants**, case-insensitive |
| password_hash | text | Argon2id; set when the invitation is accepted |
| locale | enum `en` / `ar` | chosen at activation |
| roles | enum[] | non-empty subset of `owner`, `manager`, `sales`, `packing`, `dispatch` |
| all_stores | bool | always true when `roles` contains `owner` or `manager` |
| status | enum `active` / `inactive` | a user row exists only after acceptance |
| created_at, updated_at | timestamptz | |

Checks: `phone_e164 IS NOT NULL OR email IS NOT NULL`; `all_stores` is true when roles include
`owner` or `manager`.

Identifiers are unique platform-wide because sign-in takes only an identifier and a
password. A person who works for two merchants needs a different identifier for each. The
user row is created at acceptance, not at invitation, so an unaccepted invitation never
reserves an identifier (review finding C2).

Rule: a tenant must always have at least one `active` user with `owner` in `roles`, once it
has left `pending` (FR-018). Enforced in the service layer under a row lock on the tenant.

### user_stores (RLS)

| Field | Type | Rules |
|---|---|---|
| tenant_id | uuid | part of both composite FKs |
| user_id | uuid | FK `(tenant_id, id)` → users |
| store_id | uuid | FK `(tenant_id, id)` → stores |

PK `(user_id, store_id)`. A user with `all_stores = false` must have at least one row.

### invitations (RLS)

Holds everything about the invitee until acceptance; it does not reference a user row.

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | FK tenants |
| kind | enum `owner_activation` / `employee` | |
| invitee_name | text | 1–120 chars |
| invitee_phone_e164 | text, nullable | at least one of phone/email |
| invitee_email | text, nullable | |
| roles | enum[] | non-empty |
| all_stores | bool | |
| store_ids | uuid[] | validated against the tenant's stores at creation and again at acceptance |
| token_hash | bytea | unique; SHA-256 of the link token |
| status | enum `pending` / `accepted` / `revoked` / `expired` | |
| expires_at | timestamptz | created + 7 days |
| created_by_user_id / created_by_operator_id | uuid, nullable | exactly one set |
| accepted_user_id | uuid, nullable | the user created at acceptance |
| accepted_at | timestamptz, nullable | |
| created_at | timestamptz | |

Constraints: at most one `pending` invitation per `(tenant_id, invitee_phone_e164)` and per
`(tenant_id, invitee_email)`; at most one `pending` `owner_activation` per tenant.

### invitation_codes (RLS)

Codes for accepting an employee invitation by email (FR-012a, research R37; migration
`0002`). One row per code sent.

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | FK `(tenant_id, invitation_id)` → invitations |
| invitation_id | uuid | indexed with created_at; 5 rows per invitation per hour at most |
| code_hash | bytea | HMAC-SHA-256 (keyed with the server secret) of the invitation id and the 6-digit code; the code itself is never stored |
| expires_at | timestamptz | created + 15 minutes |
| failed_attempts | int | 0–5; the fifth wrong entry voids the code |
| voided_at | timestamptz, nullable | set when a newer code is sent or after 5 wrong entries |
| created_at | timestamptz | |

A code is open while `voided_at` is null and `expires_at` is in the future; at most one is
open per invitation. The application role may select, insert and update, not delete.

### password_resets (RLS)

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | FK tenants |
| user_id | uuid | FK `(tenant_id, id)` → users |
| token_hash | bytea | unique |
| expires_at | timestamptz | created + 1 hour |
| used_at | timestamptz, nullable | |
| issued_by_user_id / issued_by_operator_id | uuid, nullable | both null when self-requested by email |
| created_at | timestamptz | |

### sessions (not under RLS; queried only by token hash)

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| user_id | uuid, nullable | FK users |
| tenant_id | uuid, nullable | set with `user_id`; used to set the tenant context |
| operator_id | uuid, nullable | FK operators; exactly one of user/operator set |
| token_hash | bytea | unique |
| created_at, last_seen_at | timestamptz | |
| idle_expires_at | timestamptz | last_seen + 30 days (users) / 12 hours (operators) |
| absolute_expires_at | timestamptz | created + 90 days (users) / 7 days (operators) |
| revoked_at | timestamptz, nullable | |
| user_agent | text | truncated to 255; shown in "your devices" |
| ip | inet | |

### login_attempts (not tenant data)

| Field | Type | Rules |
|---|---|---|
| id | bigserial | PK |
| identifier_hash | bytea | HMAC-SHA-256 (keyed with the server secret) of the normalized identifier typed; separate namespaces hold password-reset email requests and invitation-code emails (recorded with `success = true`, so they never count towards a sign-in block) |
| ip | inet | |
| success | bool | |
| at | timestamptz | indexed with identifier_hash and with ip |

Rows older than 30 days are deleted by `platform_maintenance()`.

### idempotency_keys (RLS; operator-context rows have null tenant)

Stores a reference to what the first request created, never a response body, so no one-time
link is ever stored (review finding H4).

| Field | Type | Rules |
|---|---|---|
| key | text | PK part |
| scope | text | PK part; endpoint name |
| actor_id | uuid | PK part; operator or user id |
| tenant_id | uuid, nullable | null for operator requests |
| request_hash | bytea | same key with a different body → 409 `idempotency_conflict` |
| resource_type, resource_id | text, uuid | what the first request created |
| created_at | timestamptz | deleted after 24 hours |

On a repeat, the endpoint returns the same resource and, where the first response contained
a one-time link, issues a **fresh** link and revokes the previous one (the retrying client
never received the first).

### files (RLS)

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | FK tenants; unique `(tenant_id, id)` |
| kind | enum `store_logo` | more kinds in M1 |
| storage_path | text | server-generated, never from user input |
| mime | text | `image/webp` after re-encoding |
| size_bytes | int | ≤ 2 MB on upload |
| created_by_user_id | uuid | |
| created_at | timestamptz | |

### audit_entries (RLS; append-only)

| Field | Type | Rules |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid, nullable | null only for platform-level events |
| actor_type | enum `user` / `operator` / `system` / `anonymous` | |
| actor_id | uuid, nullable | |
| event | text | from the fixed list below |
| target_type, target_id | text, uuid, nullable | |
| data | jsonb | the event's fields, listed per event below; change events use `{before, after}` with same-shaped sides; never passwords, hashes, tokens or links, and never a person's full phone number or email address |
| ip | inet, nullable | |
| at | timestamptz | indexed `(tenant_id, at desc)` |

`UPDATE` and `DELETE` are rejected by trigger and not granted to the application role.
Tenant rows are inserted in tenant context. Null-tenant rows can only be inserted through
`audit_platform_event(...)` and are not readable through the product.

**Attribution rules** (review finding H7):

| Situation | tenant_id | actor |
|---|---|---|
| Successful sign-in, sign-out, password change, session ended | the user's tenant | user |
| Failed sign-in for an identifier that belongs to a user | that user's tenant | anonymous; target = the user |
| Failed sign-in for an unknown identifier | null (platform) | anonymous |
| Operator sets up, suspends or reactivates a business, resends activation, issues an owner reset link | that tenant, so its owners see it | operator |
| Operator sign-in, maintenance run | null (platform) | operator / system |
| Refused cross-tenant or missing-permission request | the caller's tenant | user |
| Email sent or failed | the recipient's tenant | system |

Events: the fixed list, with each event's target and `data` fields. "Change" means
`{"before": …, "after": …}` where both sides have the same shape. Contact details never
appear in full: a person's phone number is reduced to its last two digits (`••56`) and an
email address to its domain (`••@example.com`, or the bare domain for email events). A
store's WhatsApp number is the business's own public number and is kept as entered.

| Event | Target | `data` |
|---|---|---|
| `auth.sign_in` | user | `session_id`; `via: "invitation"` when signed in by accepting an invitation |
| `auth.sign_in_failed` | user (known identifier) / none (platform) | `reason`: `wrong_password`, `inactive_user`, `business_suspended`, `business_pending`; platform rows: empty, or `area: "ops"` for the operator sign-in |
| `auth.sign_out` | session | empty |
| `auth.session_revoked` | session (one) / user (all others) | one: `scope: "one"`, `current` (bool); all others: `scope: "others"`, `ended` (count) |
| `auth.password_changed` | user | `via`: `self` or `reset_link`; `sessions_ended` (count) |
| `auth.password_reset_issued` | user | `channel`: `email`, `staff` or `operator` |
| `auth.identifier_changed` | user | change; each side `{phone?, email?}` holding only the identifiers that changed, reduced as above (`null` when absent) |
| `tenant.created` | tenant | `name`, `edition`, `default_currency`, `usd_lbp_rate` (operator); `name`, `edition`, `is_demo`, `source` (demo seed) |
| `tenant.suspended` | tenant | change; sides are status strings |
| `tenant.reactivated` | tenant | change; sides are status strings |
| `tenant.settings_changed` | tenant | change; sides are objects of the changed settings (money as decimal strings) |
| `invitation.created` | invitation | `kind`; for employees also `name` (invitee's name) and `roles` |
| `invitation.accepted` | invitation | `kind`, `roles` |
| `invitation.revoked` | invitation | `kind` |
| `invitation.resent` | invitation (the new one) | `kind`, `previous_invitation_id`; `repeat: true` when an idempotent repeat refreshed the same invitation's link |
| `invitation.code_sent` | invitation | `kind` (actor `anonymous`: the link holder); never the code or the address. The email itself is `email.sent` / `email.failed` with purpose `invitation_code` |
| `invitation.code_failed` | invitation | `kind`, `attempts` (5): the code was voided after 5 wrong entries (actor `anonymous`) |
| `user.roles_changed` | user | change; sides are lists of role codes |
| `user.stores_changed` | user | change; sides are `{all_stores, store_ids}` |
| `user.deactivated` | user | change; sides are status strings; plus `sessions_ended` (count) |
| `user.reactivated` | user | change; sides are status strings |
| `store.created` | store | `name`, `whatsapp_number` (demo seed adds `source`) |
| `store.updated` | store | change; sides are objects of the changed fields among `name`, `whatsapp_number`, `logo_file_id` |
| `store.deactivated` | store | change; sides are status strings; plus `affected`: list of `{kind, id}` left without an active store |
| `store.reactivated` | store | change; sides are status strings |
| `access.denied_permission` | the refused record, if any | `path`, `method`; `permission` when a permission was missing (absent for "cannot change yourself") |
| `access.denied_tenant` | the record looked for, if known | `path`, `method` |
| `access.denied_store` | none | `path`, `method`, `permission`, `store_id` |
| `email.sent` | none | `purpose`, `domain` |
| `email.failed` | none | `purpose`, `domain`, `error` (exception class name) |
| `operator.sign_in` | none (platform) | empty |
| `maintenance.run` | none (platform) | counts of what was expired or deleted |

## State transitions

**Tenant**: `pending` → `active` (only by owner activation) → `suspended` ⇄ `active`
(operator). A `pending` tenant cannot be suspended or set active by an operator. Suspension
blocks sign-in and every request for the tenant's users; no data is removed.

**User**: created `active` at invitation acceptance → `inactive` ⇄ `active` (owner/manager).
Deactivation revokes all of the user's sessions.

**Invitation**: `pending` → `accepted` | `revoked` | `expired`. Terminal states never change.
Resend is allowed while `pending` or `expired`: it creates a new `pending` invitation with
the same details and marks the old one `revoked` (if it was pending). A revoked invitation is
re-invited as a fresh invitation.

**Store**: `active` ⇄ `inactive`. The last active store cannot be deactivated.

## Known, accepted limitations

- **Phone numbers are not verified.** An employee invited by email proves control of the
  address with an emailed code before acceptance (FR-012a). Links by phone number and owner
  activations are shared by the inviter, so BOS does not prove the invitee controls the
  phone number. Because users belong to one business, the effect is limited to that
  business, plus the possibility of claiming a phone number someone else would want to use.
  An operator can release a wrongly claimed identifier. SMS codes wait for an SMS channel.
- **Sign-in lockout can be triggered by a third party** who knows a user's phone number
  (5 wrong passwords block that identifier for 15 minutes). Accepted for the pilot.
- **An operator who issues an owner reset link could use it.** This is restricted to owners
  without an email, always recorded in the business's own history, and ends all the owner's
  sessions, so it cannot be done unnoticed.

## Requirement coverage

| Requirement | Where enforced |
|---|---|
| FR-002 one owner, one store, no duplicates | setup transaction + idempotency key |
| FR-003 / FR-004 isolation | RLS on every tenant table incl. `users`, composite FKs, scoped functions only |
| FR-005c operator cannot see inside | operator context reads `tenants` and `ops_business_overview()` only |
| FR-006 / FR-006a identifiers | platform-wide unique indexes on normalized `phone_e164`, `email` |
| FR-018 last owner | service-layer check under tenant row lock |
| FR-020 one business per user | `users.tenant_id` NOT NULL |
| FR-022 WhatsApp number | E.164 + partial unique index |
| FR-024 settings do not rewrite history | settings live on `tenants`; later records copy values at creation |
| FR-032–034 history | `audit_entries` append-only, same-transaction writes, attribution rules above |
