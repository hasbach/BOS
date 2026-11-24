# Contract: Roles and Permissions — M1 delta

M0's [permissions.md](../../001-platform-foundation/contracts/permissions.md) remains the
source for every M0 permission, the shell tabs and the operator. This file records what M1
changes. The backend map (`app/core/permissions.py`) is tested against both files: the rows
of the table below **override** the same permissions' rows in M0's "Reserved for later
milestones" table, and the code's `STORE_SCOPED` must equal the union of the store-scoped
rows of M0's enforced table and this table (`store.view`, `catalog.view`).

## What changes

1. `catalog.view`, `catalog.manage` and `stock.adjust` move from "reserved" to **enforced**.
   **No role gains or loses a permission**: the code map already grants them exactly as
   below (`_GRANTS` in `app/core/permissions.py`: `catalog.view` → everyone,
   `catalog.manage` and `stock.adjust` → owner and manager), matching M0's reserved table.
2. `catalog.view` becomes **store-scoped**. Its store scope is applied to the data (a product
   belongs to several stores), declared as `require("catalog.view", store_filtered=True)`;
   the route-coverage harness requires a cross-store isolation case for every such route
   (research R52). `catalog.manage` and `stock.adjust` are held only by roles that always
   have all stores, so, like `store.manage`, they need no store scope.
3. The More menu shows **Catalog** to everyone with `catalog.view` (screens 18, 74, 107).
   No bottom tab changes.

## M1 permissions (enforced now)

| Permission | Owner | Manager | Sales | Packing | Dispatch | Store-scoped |
|---|---|---|---|---|---|---|
| `catalog.view` (search and read products, variants, prices, on hand / reserved / available, photos) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `catalog.manage` (create, edit, archive, restore, delete products and variants; photos; prices; CSV import; archived and no-photo filters) | ✓ | ✓ | – | – | – | – |
| `stock.adjust` (record stock changes; read a variant's stock history; Low stock list) | ✓ | ✓ | – | – | – | – |

The business low-stock default is a business setting: M0's `settings.manage` (owner,
manager).

## What each role sees in the catalog

| Role | Products visible |
|---|---|
| Owner, Manager | Every product of the business: active, archived (when asked), listed in no store, listed only in inactive stores |
| Sales, Packing, Dispatch | Only **active** products listed in at least one **active** store they may work in (all active stores with `all_stores`, else their assigned active stores) |

A product, variant or photo outside this set answers 404 `not_found`, exactly like one that
does not exist; when it exists in the business it is recorded as `access.denied_store`
(`permission: catalog.view`), otherwise `access.denied_tenant`.

## Additional rules

- Sales, packing and dispatch agents never see edit, adjust, import, archived or no-photo
  controls, and every such request sent directly is refused (403 `forbidden`) and recorded
  as `access.denied_permission` with the missing permission (FR-001, FR-014, SC-007).
- The allocation service (research R45) has no endpoint in M1; nobody can call it over HTTP.
- History (`audit.view`) stays owner-only. Managers read stock changes in each variant's stock
  history (`stock.adjust`).
