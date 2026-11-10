# Contract: Roles and Permissions

The single source of truth for what each role may do. The backend permission map and the
frontend's tab visibility are both generated from, and tested against, this table.

A user's effective permissions are the union of their roles' permissions. Every permission
marked **store-scoped** additionally requires that the action concerns a store in the user's
store list (or `all_stores`). Owners and managers always have `all_stores`; this is why
`store.manage` and `staff.manage` need no store scope.

## M0 permissions (enforced now)

| Permission | Owner | Manager | Sales | Packing | Dispatch | Store-scoped |
|---|---|---|---|---|---|---|
| `business.view` (name, own profile, own stores) | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `settings.manage` (currency, rate, delivery fee) | ✓ | ✓ | – | – | – | – |
| `store.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `store.manage` (add, edit, logo, deactivate) | ✓ | ✓ | – | – | – | – |
| `staff.view` | ✓ | ✓ | – | – | – | – |
| `staff.manage` (invite, change roles/stores, deactivate, issue reset link) | ✓ | ✓ | – | – | – | – |
| `staff.manage_owners` (grant/remove Owner, change an owner's access) | ✓ | – | – | – | – | – |
| `audit.view` | ✓ | – | – | – | – | – |

Additional rules:

- A manager cannot change, deactivate or issue a reset link for an owner (FR-019).
- Nobody can remove or deactivate the last active owner, including that owner (FR-018).
- Nobody can change their own roles, store access or active status, or issue a reset link
  for themselves (`cannot_modify_self`) (FR-019a).
- A user can always: view and edit their own name and language, change their own phone
  number or email (with their current password), change their own password, list and end
  their own sessions.
- A store-scoped action on a store outside the user's list returns 404 and is recorded as
  `access.denied_store`.

## Shell tabs (M0)

| Tab | Visible to | Opens first for |
|---|---|---|
| Sales | Owner, Manager, Sales | Owner, Manager, Sales |
| Packing | Owner, Manager, Packing | Packing |
| Delivery | Owner, Manager, Dispatch | Dispatch |
| Orders | Owner, Manager, Sales, Packing, Dispatch | – |
| More | everyone | – |

When a user holds several roles, the first tab is chosen in this order: Owner/Manager →
Sales tab; otherwise Sales, then Packing, then Dispatch.

## Reserved for later milestones (defined now, not exercised in M0)

| Permission | Owner | Manager | Sales | Packing | Dispatch | Milestone |
|---|---|---|---|---|---|---|
| `catalog.view` | ✓ | ✓ | ✓ | ✓ | ✓ | M1 |
| `catalog.manage` (products, prices) | ✓ | ✓ | – | – | – | M1 |
| `stock.adjust` | ✓ | ✓ | – | – | – | M1 |
| `order.create` / `order.confirm` | ✓ | ✓ | ✓ | – | – | M2 |
| `order.cancel` / `order.amend` | ✓ | ✓ | ✓ | – | – | M2 |
| `packing.work` | ✓ | ✓ | – | ✓ | – | M3 |
| `dispatch.work` (courier, delivery results) | ✓ | ✓ | – | – | ✓ | M3 |
| `settlement.manage` (COD remittances) | ✓ | ✓ | – | – | ✓ | M3 |
| `reports.view` | ✓ | ✓ | – | – | – | M3 |
| `chat.view` / `chat.send` | ✓ | ✓ | ✓ | – | – | M3.5 |
| `integration.manage` | ✓ | – | – | – | – | M4 |

## Operator (not a tenant role)

| Ability | Operator |
|---|---|
| Create a business and its first store and owner | ✓ |
| List businesses with account-level info only | ✓ |
| Resend an owner activation link | ✓ |
| Issue a password-reset link for an owner who has no email (recorded in that business's history) | ✓ |
| Suspend / reactivate a business | ✓ |
| View or change anything inside a business (staff, stores' details, settings, history) | ✗ |
