# BOS — Beta Orders Solutions: MVP Product Brief & Spec Kit Build Guide

**Document version:** 1.2  
**Date:** 2026-11-10  
**Status:** Product requirements baseline for Claude / GitHub Spec Kit; not an implemented system  
**Product name:** BOS (full name: Beta Orders Solutions)  
**Positioning:** Social Commerce & Order Management Platform  
**Tagline:** From Conversation to Delivery.  
**Arabic tagline:** من أول رسالة لآخر طلبية  
**Brand relationship:** A product by Beta Marketing Solutions  
**Editions (one platform):** **BOS Social** for sellers without websites (segment 1 below); **BOS Commerce** for businesses connecting WooCommerce and multiple stores (segment 2 below). Domain availability is not assumed.

> **Instructions for Claude:** Treat this document as the product brief and acceptance baseline. Use GitHub Spec Kit's official workflow to create the constitution, individual feature specifications, technical plans, and tasks. Do not interpret the implementation milestones below as permission to build everything at once. Implement one independently testable vertical slice at a time. Ask targeted clarification questions only for unresolved decisions that block a safe implementation; otherwise use the defaults explicitly marked in this document. Do not silently expand the MVP with AI or unauthorized WhatsApp message access.

---

## 1. Vision & commercial objective

Build a **mobile-first, multi-tenant social commerce operations SaaS** for Lebanese sellers whose customers mainly come through Facebook, Instagram, and WhatsApp. The application converts conversations into structured customer orders, manages inventory, routes tasks to packing employees, records external courier delivery statuses, and reconciles cash on delivery (COD).

There are two user segments using the **same core system**:

1. **Social-only sellers — BOS Social (initial general-market MVP):** No website or reliable catalog. They create products, variations, stock, and orders directly in the SaaS. Catalog-free custom items are permitted without fake stock movements.
2. **Connected-commerce sellers — BOS Commerce (pilot integration milestone):** Existing WooCommerce websites. Products are imported/mapped into the SaaS. A known pilot has **two WooCommerce stores, one shared physical stock pool, separate WhatsApp Business numbers, an external courier, and distinct sales and packing employees**. Customers may message Store A but buy items belonging to both Store A and Store B in one combined order.

**Outcome:** Reduce retyping orders, inventory mistakes, packing errors, and COD reconciliation confusion. Never replace functioning WhatsApp sales with a brittle integration.

**Non-goal:** Building a new public marketplace, full ERP/POS, shipping company, social network, full web store, or autonomous AI sales bot in the MVP.

### 1.1 Product success metrics (pilot targets; not market guarantees)

- At least 5 actively testing merchant accounts, including 1 two-store WooCommerce pilot.
- At least 3/5 pilot merchants express willingness to renew at the tested subscription price.
- At least 80% of pilot WhatsApp-originated orders entered through the SaaS after adoption.
- Routine packing performed from the SaaS mobile UI without using WooCommerce mobile app.
- 0 confirmed duplicate orders from retry/double click during pilot tests.
- 0 oversells in controlled concurrent checkout/order tests for shared stock.
- A merchant can trace order → delivery → courier cash settlement, including refunds/returns.

---

## 2. Confirmed pilot facts and assumptions

| Detail | Status |
|---|---|
| Two independent WooCommerce websites | Confirmed |
| Shared physical inventory | Confirmed |
| Separate WhatsApp phone number per store | Confirmed |
| External delivery company | Confirmed |
| Sales and packing handled by different employees | Confirmed |
| WooCommerce mobile app currently used for packing | Confirmed |
| WhatsApp conversation on Store A can contain products sold by A and B | Confirmed |
| Whether catalogs completely/partially overlap | **Unknown; mapping must support both** |
| Whether website checkout is active on both sites | **Unknown; assume yes for safety until verified** |
| Where current authoritative stock count resides | **Unknown; reconciliation required before sync activation** |
| Courier API availability | Unknown; default manual/CSV |
| WhatsApp Cloud API/coexistence eligibility | Unknown; no API requirement in MVP |

### 2.1 Clarifications required before activating live WooCommerce stock sync

- Confirm if storefront checkout accepts orders and which payment methods are active.
- Audit WooCommerce versions, inventory settings, stock reductions on statuses, third-party plugins, and custom checkout hooks.
- Confirm whether SKUs exist and are unique at the physically stocked **variation** level.
- Perform a physical stock count / signed opening-balance reconciliation; never sum Store A and Store B stock as if they were independent stock pools.
- Identify who may edit stock and how returned goods are inspected.
- Determine how child WooCommerce order payment/tax/shipping records should be represented for combined cross-store orders, and whether any invoicing/tax obligations apply.

### 2.2 WhatsApp Cloud API eligibility check (starts now, in parallel with M0–M3)

This is a business/paperwork task with Meta, not development work. Its result decides whether M3.5 can be built.

- Confirm each pilot store's WhatsApp Business number can be onboarded to the Cloud API **with coexistence** in Lebanon (existing app keeps working on the same number).
- Complete Meta business verification for the merchant (and for Beta Marketing Solutions if BOS acts as the tech provider).
- Confirm the current per-message pricing for Lebanon and which message types are free inside the 24-hour customer service window.
- Record the outcome per number: eligible / not eligible / pending, with date.

---

## 3. Personas and permissions

| Persona | Must be able to | Must not be able to by default |
|---|---|---|
| Owner / manager | Configure business and stores, invite staff, manage catalogs, stock corrections, orders, reports, couriers, settlements, integrations | Access another tenant's data |
| Sales agent | Search catalog, enter customer, create/edit draft baskets, confirm orders, send/copy message templates, view assigned store chats context | Arbitrarily overwrite stock, alter settlements, access unauthorized stores |
| Packing agent | View confirmed picking queue for assigned stores, check item photos/size/color, verify quantities, mark packed/ready for courier | Change product prices or perform financial adjustments |
| Dispatch / collections agent (can be owner in MVP) | Assign courier, export manifests, record delivery outcomes, reconcile settlements | Edit system inventory without adjustment workflow |

One employee may hold multiple roles. Store-level permissions are scoped by `tenant_id` and allowed `store_id`s. A cross-store order must be visible to authorized fulfillment staff without exposing unrelated tenant data.

---

## 4. Product boundaries by release

**Core MVP (ship first, no external messaging dependency):**

- Tenant onboarding and basic settings; secure authentication and roles.
- Native product catalog with images, SKU, descriptions, variants (size/color), pricing, stock, and CSV import.
- Stock ledger, adjustment reasons, active allocations, low-stock warnings; custom untracked order items.
- Mobile sales UI with customer lookup and draft baskets; explicit shop/source and flexible cross-store items.
- Order confirmation, cancellation, picking/packing, shipment creation.
- External courier directory, printable/CSV manifests, manual tracking status, COD settlements.
- Basic dashboard/reports and audit history.
- Click-to-chat and copyable WhatsApp confirmation text; no chat-reading claims.

**Connected-Commerce MVP extension (pilot, conditional on integration audit):**

- Connect 2 WooCommerce stores; import/map product/variation identities.
- Shared authoritative stock ledger and live checkout stock allocation through verified WordPress connector plugin on both stores.
- SaaS order → correct WooCommerce child order(s), including one master order spanning two stores.
- Import website orders into the same fulfillment queue; idempotent sync and reconciliation.
- Rollout gated by concurrency tests, physical stock reconciliation, backups, and rollback.

**WhatsApp inbox extension (M3.5 — after the BOS Social beta, conditional on Meta eligibility):**

- Official WhatsApp Cloud API connection per store number, using coexistence so the existing WhatsApp Business app keeps working on the same number.
- In-app conversation list and two-way chat for assigned stores, so sales staff do not switch apps to take an order.
- "Create order from this chat": customer phone and source store prefilled into the existing draft-basket flow (US-03/US-04 unchanged underneath).
- Order confirmation sent from BOS inside the 24-hour customer service window; approved templates for anything outside it.
- Official API only. If a number is not eligible, that store keeps the MVP copy/open-in-WhatsApp workflow; no WhatsApp Web scraping or unofficial access under any circumstances.
- Meta per-message charges must be measured during the pilot and reflected in edition pricing before general release.

**After MVP — explicitly excluded:**

- Instagram/Facebook direct messages and ads integrations.
- AI image recognition, transcription, automated recommendations, auto-order generation.
- Full online storefront, native Android/iOS application, integrated payment gateway.
- Real-time courier integrations unless the pilot courier has documented, proven APIs.
- Complex accounting/GL, advanced purchasing, loyalty, supplier management, multi-warehouse optimization.

---

## 5. Primary user journeys and acceptance criteria

### US-01 — Merchant onboarding and employees (P0)

**As an owner**, I can create my business, add one or more shops, set default currency and delivery settings, invite employees, and grant roles.

**Acceptance:**
- New business has isolated tenant data, one owner, one store, and a usable initial dashboard.
- Employee permissions enforced in API, not only hidden in UI.
- Stores can have distinct WhatsApp phone numbers and branding.
- No tenant can enumerate another tenant's customers, orders, products, or media.

### US-02 — Create catalog and inventory (P0)

**As a social seller**, I can create a product with photo, code/SKU, size/color variants, price, available quantity, and optional descriptions.

**Acceptance:**
- Each physically stocked variant receives one stable canonical inventory item ID and unique SKU within its tenant (or a clearly governed alternate mapping).
- Price supports USD/LBP and preserves transaction-time currency; exchange rate policy is configurable, never silently recalculated for historical orders.
- CSV import validates duplicates, variants, missing data, and gives row-level errors before committing.
- Product availability is calculated from physical sellable stock minus outstanding allocations; negative availability forbidden unless an explicitly authorized backorder policy is later introduced.
- Manual stock changes require permission, a reason, an audit record, and concurrency protection.

### US-03 — Chat-originated draft basket (P0)

**As a sales employee**, I can chat in the existing WhatsApp Business app and use the mobile PWA to build a saved draft order without retyping an inventory catalog for every sale.

**Acceptance:**
- Create/select customer by phone; store shipping address, area, landmark, and notes.
- Source channel/store recorded (e.g., `whatsapp`, Store A) separately from each line item's owning store.
- Search and add native/imported products by name, SKU, image, variant; change quantity.
- Add a custom item with description, amount, and untracked inventory flag (no stock deduction).
- Draft persists when switching mobile apps; resume without losing line items.
- Show subtotal, one configurable delivery fee, total COD, and warnings for unavailable items.
- Copy or open a prefilled confirmation message. Messages are **not automatically sent** without official authorized integration.

### US-04 — Confirm order and reserve inventory (P0)

**As a sales employee**, I can confirm a draft exactly once, reserving all tracked items.

**Acceptance:**
- For multiple items, inventory availability and allocations are validated **atomically** in one central database transaction.
- Double-taps, retries, and duplicate webhooks/events do not create duplicate orders/reservations.
- If one line has insufficient stock, the whole confirmation fails cleanly without partial allocation.
- Draft is editable before confirmation. Post-confirmation edits are controlled order amendments with adjustment history and safe reallocation.
- Reserve once; do not decrement twice when WooCommerce also updates its local stock record.
- Cancellation releases allocations only when legally/operationally appropriate and not already released; dispatched goods are not magically restocked.

### US-05 — Packing employee workflow (P0)

**As a packing agent**, I can process orders from either store on my own mobile device.

**Acceptance:**
- Dedicated mobile packing mode displays combined picklist with product photo, SKU, size, color, quantity, and source store.
- Packing employee checks off each line/quantity; can flag missing/wrong stock and route exception to manager.
- No transition to `packed` before all required quantities verified or explicit documented override.
- One combined master order produces one consolidated shipment by default, even when it has child orders on both WooCommerce sites.
- Confirmation changes visible immediately to authorized staff; audit who picked and when.

### US-06 — Courier dispatch, COD and returns (P0)

**As an operations employee**, I can assign external courier, export handoff manifest, record delivery results, and settle collected cash.

**Acceptance:**
- Dispatch includes customer address/phone, **one master shipment**, one total COD, and optional child-store breakdown for internal use.
- Delivery outcomes include delivered, failed, rescheduled, returning, returned, lost.
- `delivered` does **not** imply money has been remitted to merchant.
- Ledger distinguishes total COD collected by courier, allowed courier fees, amounts remitted, and outstanding merchant receivable.
- Partial remittances and corrections are supported with audit history; no silent balance editing.
- Returned items enter `quarantine/inspection`; they only become sellable after explicit checked restock action.
- Exchanges create traceable linked return/replacement records; where full automation is deferred, support a controlled manual replacement order referencing original.

### US-07 — Multi-store master order (P0 for connected-commerce pilot; supported structurally in core)

**As a sales employee**, I can accept one WhatsApp conversation originating at Store A containing merchandise belonging to both Store A and Store B.

**Acceptance:**
- Master order has customer identity, origin channel/store, all lines, one delivery charge, one COD amount.
- Each line references its owning store and canonical inventory item; no restriction that all lines belong to origin store.
- One picklist, one tracking reference/parcel by default; future split shipments possible but not MVP.
- For WooCommerce integration, create a child order in **each applicable site** using that site's own Woo product/variation IDs.
- Child orders link to master by stable external reference; suppress duplicate customer messages and double courier COD collection.
- If one child creation fails, keep master in explicit `sync_pending/recovery_required` state; retry idempotently and block shipment release until complete.
- Financial attribution per store must sum consistently to master order totals; shipping allocation policy documented.

### US-08 — WooCommerce connection and shared physical inventory (P0 for connected-commerce extension)

**As the owner**, I can connect two WooCommerce stores without replacing their public storefronts.

**Acceptance:**
- Import products, variations, storefront IDs, SKUs, stock configuration, prices and active orders; support partial catalog overlap.
- Maintain mapping `(store_id, woo_product_id, woo_variation_id) → canonical inventory_item_id`; names alone are never used as product identity.
- Stock quantity belongs to one physical warehouse ledger for shared items; **never add duplicate WooCommerce site quantities together**.
- Checkout for shared-stock items on **both** websites must request a centrally serialized allocation **before** accepting a stock commitment. Webhooks alone are insufficient.
- Connector uses appropriate WooCommerce/WordPress checkout and order lifecycle hooks; compatibility with actual WooCommerce configuration must be verified, including variations, stock-reduction statuses, payment methods and high-performance order storage (HPOS) where enabled.
- Central inventory outage: fail closed for shared-stock checkout/commit, with a clear user-facing explanation; no silent oversell.
- WooCommerce's local stock is a projected storefront representation; central ledger is authoritative for shared inventory; duplicate stock reductions avoided.
- Protect against Woo REST timeouts, retries, late/repeated/out-of-order webhooks with idempotency keys, persisted event IDs, reconciliation, and a repair queue.
- Audit and restrict manual Woo stock changes for shared SKUs; alert on divergence.
- Successful concurrent last-unit test: when only 1 item remains, 2 simultaneous checkouts across A and B lead to at most 1 accepted allocation/order commitment.

### US-09 — Reports (P1)

**As an owner**, I can filter by store, date, sales employee, order source, fulfillment status, delivery company and payment settlement.

**Acceptance:**
- KPIs distinguish `ordered`, `dispatched`, `delivered`, `courier collected`, and `merchant remitted` amounts.
- Cross-store master is counted **once** in overall orders/sales metrics; child orders only used for per-store attribution.
- Returns, fees and discounts are transparently represented; downloadable CSV basics.

---

## 6. Core domain model (logical, not final migration)

Required objects:

- `Tenant`, `User`, `Membership`, `Role`, `Store`, `Channel` (store's WhatsApp phone as metadata initially).
- `Product`, `ProductVariant`, `InventoryItem` (canonical sellable unit), `ProductMedia`, `StoreListing`, `StoreVariantMapping`.
- `Warehouse` (one default physical warehouse for MVP), `InventoryBalance`, `InventoryMovement`, `InventoryReservation`, `StockAdjustment`.
- `Customer`, `CustomerAddress`, `OrderDraft`, `MasterOrder`, `OrderLine`, `ChildStoreOrder`, `OrderAmendment`.
- `PickTask`, `PickTaskLine`, `Shipment`, `Courier`, `TrackingEvent`, `Return`, `Exchange`.
- `CourierCollection`, `CourierRemittance`, `SettlementEntry` (immutable financial audit events).
- `IntegrationConnection`, `IntegrationEvent`, `OutboxJob`, `SyncIncident`, `AuditLog`.

**Required constraints:**

- Tenant-scoped foreign keys / access checks throughout.
- Database constraints on unique store+external Woo order identity, unique integration event identity, unique reservation source/idempotency key, and unique variant mappings.
- Decimal money with explicit currency (never binary floating point for money).
- UTC timestamps in storage; show Asia/Beirut times in merchant UI.
- Sensitive API tokens encrypted at rest, never returned to frontend after creation.
- Master/child order model must avoid double-counting revenue and duplicate COD.

### 6.1 Inventory invariants

1. Exactly one authoritative physical stock balance per canonical SKU per physical warehouse.
2. `available = sellable_on_hand - active_reservations`; allocations are transactional.
3. No allocation for a SKU without verified canonical mapping where Woo is involved.
4. A dispatched order consumes physical stock; shipment does not release quantity for resale.
5. Returned goods only restocked after receipt and inspection.
6. Any inbound website sale or outbound SaaS order must pass the same allocation path for shared SKUs.
7. Event replay and retries never change stock twice.
8. During migration, no live writes until physical opening balances, Woo statuses, and checkout hooks are verified.

### 6.2 Order states (separate dimensions)

- `sales`: draft → confirmed → cancelled (with guarded transitions).
- `fulfillment`: pending_pick → picking → packed → dispatched; exception path.
- `delivery`: not_assigned → with_courier → delivered / failed / returning / returned / lost.
- `payment`: not_collected → collected_by_courier → partially_remitted → settled; adjustments/disputes supported.
- `integration_sync`: not_required / pending / synced / retrying / recovery_required.

**Never collapse all these into a single WooCommerce status.** Maintain explicit mapping rules for Woo statuses and avoid using Woo `completed` as proof of courier cash remittance.

---

## 7. User interface / UX requirements

**Mobile-first PWA** designed for lower-cost Android handsets; usable on desktop. Arabic RTL and English LTR supported from initial scaffolding. Use Lebanese-relevant delivery address input and clear USD/LBP display.

Main navigation:

1. **Sales:** customers, product search, draft cart, confirm order, switch to WhatsApp, resume draft.
2. **Packing:** assigned to-pick list, combined-store picklist, verify size/color, mark packed, exception.
3. **Delivery:** assign courier, create manifest, update shipment, reconcile COD.
4. **Catalog:** products, variants, photo, prices, stock, import, mapping.
5. **Orders:** searchable master orders, filters by store/source/status, activity history.
6. **Reports:** basic order/sales/collection counts.
7. **Settings:** businesses, stores, employees, couriers, Woo integration (if available).

**Critical interaction:** Sales employee can create a customer basket sourced from Store A WhatsApp while adding an item listed by Store B, without starting a second customer order. A separate packing employee immediately sees one consolidated pick task.

**MVP messaging workflow:** Existing WhatsApp Business app stays operational. PWA does not claim to read chats. Provide copy/open-prefilled-message controls and persistent drafts across app switches. The integrated inbox arrives in M3.5, only for numbers with approved official WhatsApp Cloud API setup.

---

## 8. Proposed technical stack (planning guidance, not a specification prerequisite)

Favor developer-familiar and low-cost technologies:

- **Frontend:** Next.js + React + TypeScript, mobile-first PWA, accessible UI and RTL support.
- **Backend:** Python Flask + SQLAlchemy + Alembic + REST API. FastAPI is an acceptable alternative if Claude documents a reason, but don't mix backend frameworks.
- **Database:** PostgreSQL as single transactional source of truth.
- **Jobs:** Celery + Redis or equivalent durable worker/outbox with retries and dead-letter/recovery tracking.
- **Images:** Object storage; private/signed URLs as applicable; validate type/size.
- **Auth:** Server-verified sessions or JWT with refresh rotation, rate limits, tenant/store RBAC.
- **Woo connector:** Small custom WordPress/PHP plugin per connected store with signed server-to-server communications, stock reservation enforcement, and order lifecycle hooks; use WC REST API for supported product/order operations.
- **Deployment:** Docker Compose for development and initial VPS, production TLS, migrations, monitored backups, log rotation, health checks.
- **Testing:** Unit + integration + E2E for user workflows; transactional concurrency tests and Woo staging checkout tests mandatory.

Do not assume that **REST/webhook-based eventual synchronization alone** guarantees no overselling. The connected-commerce extension requires a checkout-time central allocation path on all selling surfaces.

---

## 9. Spec Kit delivery strategy

**Do not run `/speckit.specify` just once for the entire platform and immediately implement all tasks.** Organize features into independent, end-to-end slices. Every slice follows the Spec Kit quality loop and is validated before the next slice starts.

### 9.1 One-time project constitution

Use `/speckit.constitution` to establish these non-negotiable principles:

1. **Tenant isolation and least privilege** in every request and background job.
2. **Inventory integrity first:** transactional allocations, idempotency, audited movements, safe failure.
3. **Mobile-first practical UX:** support sales/packing roles and Arabic RTL.
4. **API contracts and tests before integration:** no assumptions about Woo checkout events or WhatsApp availability.
5. **Small vertical slices:** implement only current phase; validate acceptance criteria before advancing.
6. **Operational observability:** durable logs, retries, reconciliation, recovery for uncertain external states.
7. **No unauthorized automation:** don't scrape WhatsApp Web or bypass platform authorization.
8. **No destructive migration or stock writes without backup, staging verification, and explicit release approval.**

### 9.2 Implementation milestones (features, not Spec Kit command phases)

**Status (2026-11-24):** M0 and M1 are complete and merged into `main`. M2 (`sales-orders`) is next and on hold until the product owner starts it. Open M1 follow-ups: the human first-use timing and screen-reader checks ([manual acceptance](specs/002-native-catalog-inventory/checklists/manual-acceptance.md)), and the deployment security checks deferred to the first deployment ([security review](specs/002-native-catalog-inventory/checklists/security.md#sign-off-decision-2026-11-23)).

| Milestone | Spec Kit feature | Deliverable | Exit gate | Status |
|---|---|---|---|---|
| M0 | `platform-foundation` | Repo, auth, tenant/store model, RBAC, PWA shell, migrations, CI, seed data | Multi-tenant isolation tests pass | **Done**: exit gate approved 2026-11-14 ([evidence](specs/001-platform-foundation/checklists/exit-gate.md)) |
| M1 | `native-catalog-inventory` | Native products/variants, CSV import, inventory ledger/adjustment, low stock | SKU and allocation integrity tests pass | **Done**: exit gate approved 2026-11-24; human timing and screen-reader checks still open ([evidence](specs/002-native-catalog-inventory/checklists/exit-gate.md)) |
| M2 | `sales-orders` | Customers, draft cart, custom items, store attribution, confirmation, cancellation, order idempotency | Mobile sales journey E2E passes | Next; on hold until the product owner starts it |
| M3 | `packing-delivery-cod` | Packing queue, mixed-store picklist, courier manifests, statuses, COD ledger, returns inspection | One order to final cash remittance E2E passes | Not started |
| M3.5 | `whatsapp-inbox` | Cloud API connection per store number (coexistence), in-app chat, create order from chat, confirmation sent from BOS | Meta eligibility confirmed for the pilot numbers; send/receive, webhook replay and 24-hour-window tests pass on a test number; fallback to copy/open workflow verified | Not started |
| M4 | `woocommerce-readonly-connector` | Both Woo API connections, read-only product/order import, variation matching, divergence reports | No live inventory writes; mappings verified | Not started |
| M5 | `woocommerce-shared-stock-sync` | WP connector, checkout-time central allocations, projected Woo stock, outbox/retry/reconciliation | Concurrent last-unit, timeout, webhook replay tests pass on staging | Not started |
| M6 | `cross-store-woo-orders` | Master order to both Woo child orders, partial-sync recovery, one shipment/COD | Full two-store mixed basket E2E passes | Not started |
| M7 | `pilot-hardening` | Backups, monitoring, release rollback, performance checks, merchant onboarding, metrics | Safe controlled live pilot approved | Not started |

**Suggested release points:** native social-seller beta after M3; WhatsApp inbox after M3.5; connected-commerce pilot only after M7. Do not expose shared inventory sync before M5 gates pass.

**M3.5 dependency:** M3.5 starts only if the eligibility check in section 2.2 succeeds. If it is still pending or fails when M3 completes, proceed to M4 and revisit M3.5 later; it must not block the WooCommerce milestones.

### 9.3 Exact Spec Kit workflow per feature

Run the available command form for the installed integration (some installations use `/speckit.specify`, others `/speckit-specify`):

1. `/speckit.constitution` — once before feature work.
2. `/speckit.specify` — one feature/story scope, focusing on **what/why**, not framework choices.
3. `/speckit.clarify` — resolve business ambiguities that affect correctness.
4. `/speckit.plan` — decide architecture, contracts, migrations, and validation approach.
5. `/speckit.checklist` — requirements-quality checklist; have reviewer evaluate it honestly.
6. `/speckit.tasks` — dependency-ordered, small implementation tasks.
7. `/speckit.analyze` — check spec/plan/tasks consistency; fix contradictions.
8. `/speckit.implement` — **implement only the approved feature/tasks**, then run tests and show working UI.
9. `/speckit.converge` — identify gaps, add missing tasks, implement/verify until converged.

Do not mark review checklists as complete unless actually reviewed. Do not claim tests passed unless executed and captured.

Official workflow reference: https://github.github.com/spec-kit/quickstart and https://github.github.com/spec-kit/reference/agentic-sdd.html

### 9.4 Initial prompt for Claude after attaching this file

```text
Read the attached social_commerce_saas_mvp_speckit.md in full and treat it as the source product brief.

We are using GitHub Spec Kit for specification-driven development. Start by reviewing assumptions and producing the project constitution using the Spec Kit constitution command available in this environment. Do not generate implementation code yet.

Next, propose the M0 feature specification (platform-foundation) only, using speckit.specify. Run clarify/plan/checklist/tasks/analyze for that feature, one step at a time, with acceptance criteria and test strategy. Present the generated artifacts for approval before implementing.

Follow the milestone ordering in the brief. Keep native catalog sellers and two-store WooCommerce pilot in one extensible tenant/store/order/inventory domain model. Preserve the ability for one WhatsApp-originated order to contain items from both stores with one shipment and one COD amount. Do not integrate the WhatsApp inbox before M3.5 or AI in the MVP. Do not write to production WooCommerce until later staging tests and explicit authorization.
```

### 9.5 Example feature specification prompt for M2

```text
/speckit.specify Build mobile-first customer and draft-order workflow for sales employees. Sellers can select a customer, add product variations from any permitted store, include untracked custom items, choose COD and one delivery fee, resume drafts after switching to WhatsApp Business, and confirm an order with an atomic all-or-nothing stock reservation and idempotency key. Keep sales source store separate from each line item's owning store. Packing employees receive one combined pick task. Focus on requirements and acceptance criteria, not technical implementation.
```

### 9.6 Example implementation boundary

```text
/speckit.implement Implement only the currently approved M2 Sales Orders feature tasks. Do not start WooCommerce integration, WhatsApp API, or AI. Run relevant automated tests, report results and failures, and provide demo steps for mobile sales → confirmed order → packing queue.
```

---

## 10. Mandatory test matrix

### Functional

- Native social seller creates product with 3 sizes, adjusts stock, takes WhatsApp-originated draft order, confirms, and packs on another user's phone.
- Store A salesperson creates one basket containing a Store A size-32 jeans and Store B size-L shirt; one master order, one shipment, one COD total.
- Customer name/address reused on repeat order without mixing tenants.
- Custom non-catalog item can be sold but has **no** automatic stock reduction.
- Staff without pricing permission cannot edit amounts; packer cannot modify stock.
- Partial courier remittance leaves accurate outstanding balance.
- Return does not restock until inspected; exchange is linked and traceable.

### Concurrency, failures, security

- Last unit contested by two simultaneous sales agents; only one reservation succeeds.
- Two simultaneous checkouts on Woo Store A and Woo Store B for same last SKU; only one accepted.
- Duplicate confirm POST, double button click, duplicate Woo webhook, and job retry do not duplicate stock movements or orders.
- External Woo API timeout followed by retry finds existing child order or safely reconciles uncertain outcome.
- Connector unavailable: shared-stock checkout fails safely; failure visible to staff.
- Malicious tenant IDs, store IDs, and file paths cannot escape access scope.
- API keys are protected; webhook signatures checked; audit trail exists for stock and COD.
- Stale webhook cannot revert newer order state without explicit reconciliation policy.
- Restore-from-backup and Woo rollback are rehearsed on staging prior to live migration.

### Usability

- Sales workflow on narrow mobile screen; keyboard focus and selection usable in Arabic RTL.
- Sales agent switches between WhatsApp app and PWA; draft remains intact.
- Packing mode shows product image, correct size, color, quantity, originating store; supports exception reporting.
- Clear connectivity/error state; no optimistic “order confirmed” UI before durable server confirmation.

---

## 11. Definition of Done for every milestone

- Feature spec, plan, and tasks have no unresolved critical contradictions.
- Database migration and rollback documented; relevant tests included and executed.
- API endpoints validated and permission-enforced; no cross-tenant leakage.
- Responsive mobile flow manually demonstrated; both Arabic and English tested.
- Error states, loading, empty-state UX and recoverability addressed.
- Audit events exist for stock/financial state changes.
- Operational logs and failure/retry behaviors are visible.
- README updated with local startup, env template, seed data, demo login setup, and test commands.
- No credentials or personal customer data committed to version control.
- Scope remains within the milestone; no hidden WhatsApp/AI or unreviewed Woo live writes.

---

## 12. Decisions deferred intentionally

- Domain and visual identity (logo, colors). The product name is decided: BOS — Beta Orders Solutions.
- Subscription/payment collection mechanism for the SaaS itself (manual invoicing can serve pilot).
- Exact packaging and monthly price ($15–25 BOS Social / $39–79 BOS Commerce are hypotheses).
- Which courier is used and whether it provides CSV/API formats.
- Whether the Woo stores overlap fully/partially and which entity has accurate opening stock.
- Whether website checkout is enabled and the exact plugin ecosystem.
- Formal invoicing/tax configuration for combined-store orders; cannot be guessed from UI requirements.
- Outcome of the WhatsApp Cloud API eligibility check (section 2.2); M3.5 is planned but conditional on it.

**Build principle:** Deliver a usable native social-seller SaaS first, and extend it to the demanding WooCommerce two-store pilot without compromising inventory integrity or the simple mobile workflow.
