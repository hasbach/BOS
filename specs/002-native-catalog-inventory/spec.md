# Feature Specification: Native Catalog and Inventory (M1)

**Feature Branch**: `002-native-catalog-inventory`

**Created**: 2026-11-14

**Status**: Draft

**Input**: User description: "M1 native-catalog-inventory (product brief social_commerce_saas_mvp_speckit.md: section 9.2 row M1, US-02, sections 4, 6, 6.1, 7, 10). Deliverable: native products and variants, CSV import, inventory ledger and adjustments, low stock. Exit gate: SKU and allocation integrity tests pass. Builds on M0 platform-foundation (tenants, stores, roles, permissions, audit, bilingual mobile PWA shell). A seller creates products with photos, code/SKU, size/colour variants, USD/LBP price, quantity and optional descriptions; each physically stocked variant has one stable canonical inventory item and a SKU unique within the business; one default warehouse; stock is a ledger of movements with one authoritative balance per item; available = sellable on hand minus active allocations, never negative; manual stock changes need permission, a reason, an audit record and protection against concurrent edits; allocations are transactional and idempotent (the path orders will use in M2); CSV import validates duplicates, variants and missing data with row-level errors before committing anything; low-stock warnings per item; products can be listed in one or more of the business's stores. Out of scope: orders, customers, WooCommerce, WhatsApp, AI, multi-warehouse."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Build the catalog on the phone (Priority: P1)

An owner or manager adds a product from their phone: name (Arabic and/or English), a product code, photos, an optional description, the sizes and colours it comes in, a price, and the stores it is sold in. Each size/colour combination becomes a variant with its own SKU and its own starting quantity. Sales, packing and dispatch staff can search and browse the catalog of the stores they are allowed to see, with photos, variants, prices and how many are available, but cannot change anything.

**Why this priority**: Nothing else in BOS works without products: orders (M2), packing (M3) and the website connection (M4+) all point at catalog items. It is also the first thing a merchant does after activation.

**Independent Test**: The owner of a fresh business creates a jeans product with sizes 30/32/34 and colours blue/black, two photos, a USD price and a starting quantity per variant, listed in Store A only. A sales agent limited to Store A finds it by typing part of the name or the code and sees the six variants with their available quantities; a sales agent limited to Store B does not see it; a packing agent cannot open any edit control, and editing requests sent directly are refused and recorded.

**Acceptance Scenarios**:

1. **Given** an owner on the Catalog screen, **When** they create a product with two option types (size, colour) and three and two values, **Then** six variants are created, each with a SKU that is unique in the business and a stable identity that never changes afterwards, even if its SKU, price or name is edited later.
2. **Given** a product form with a SKU already used by another variant in the same business (ignoring letter case and surrounding spaces), **When** the owner saves, **Then** saving is refused with a message on that field naming the conflict; the same SKU in a different business is allowed.
3. **Given** a product with stock history, **When** the owner tries to delete it or one of its variants, **Then** deletion is not offered; the owner can archive it instead, which hides it from sales search while keeping its history, stock and SKU reserved.
4. **Given** a sales agent limited to Store A, **When** they search the catalog, **Then** they only see active products listed in Store A, with photo, name, variant options, price and available quantity per variant.
5. **Given** any employee without catalog management permission, **When** they request a catalog change directly, bypassing the interface, **Then** it is refused and the refusal is recorded in the business's history.
6. **Given** two managers editing the same product at the same time, **When** the second one saves, **Then** they are told the product changed since they opened it and shown the current version; nothing is silently overwritten.

---

### User Story 2 - Trustworthy stock with a ledger and adjustments (Priority: P2)

Every change to a variant's physical stock is recorded as a movement with who, when, why and how much: the opening quantity, stock received, a count correction, damaged, lost or found goods. The quantity on hand is always exactly the sum of the variant's movements. An owner or manager can record a change from the phone by choosing a reason, the quantity and an optional note, and can read each variant's stock history.

**Why this priority**: The brief's first non-negotiable rule is inventory integrity. Without a ledger, orders in M2 would decrement numbers nobody can explain, and the M1 exit gate (SKU and allocation integrity) cannot be met.

**Independent Test**: Starting from a variant with opening quantity 10, a manager records "received +5", "damaged −1" and a count correction to 12. The variant shows 12 on hand, the history shows four movements that add up to 12 with reasons and names, and each change appears in the business's history. A packing agent's direct request to change stock is refused and recorded.

**Acceptance Scenarios**:

1. **Given** a variant with 10 on hand, **When** a manager records "received" with quantity 5, **Then** on hand becomes 15 and a movement with reason, quantity, person, time and note is added; nothing about earlier movements changes.
2. **Given** a manager who opened the adjustment form when on hand was 15, **When** someone else changes the stock before they save, **Then** their change is refused, they are shown the new numbers, and they can repeat it knowingly.
3. **Given** a variant with 3 available, **When** a manager records a decrease of 5, **Then** the change is refused because stock may not go below what is already allocated or below zero.
4. **Given** a count correction to an exact number, **When** it is saved, **Then** the system records the difference as the movement (for example −3) together with the counted number.
5. **Given** the same adjustment submitted twice (double tap or a retry after a lost connection), **When** both reach the server, **Then** only one movement is recorded.
6. **Given** any stock change, **When** it is saved, **Then** an entry appears in the business's history (the existing History screen), and the variant's own stock history lists it.

---

### User Story 3 - Availability that cannot oversell (Priority: P3)

BOS distinguishes what is physically on the shelf (on hand) from what is promised (allocated) and what can still be sold (available = on hand − allocated). Allocating stock to something — in M2, a confirmed order — is a single all-or-nothing step that either reserves every requested quantity or none, never lets available go below zero, and never counts the same request twice. Releasing an allocation returns the quantity; consuming it (when goods leave in M3) reduces on hand and the allocation together. In M1 there are no orders yet: this capability is delivered and proven by integrity tests, and catalog screens show allocated and available quantities.

**Why this priority**: It is the M1 exit gate and the foundation M2 builds on, but it has no screen of its own until orders exist.

**Independent Test**: Through the automated test harness, two allocation requests for the last unit of a variant arrive at the same moment: exactly one succeeds and available becomes 0. A request for several variants where one lacks stock reserves nothing. A request repeated with the same request key returns the first result without reserving again. Releasing restores availability; the ledger and balances always reconcile.

**Acceptance Scenarios**:

1. **Given** a variant with 1 available, **When** two allocations for 1 unit arrive simultaneously, **Then** exactly one succeeds and the other is refused as not enough stock.
2. **Given** an allocation request for variants A (enough stock) and B (not enough), **When** it is processed, **Then** nothing is allocated for A or B.
3. **Given** an allocation already made with a given request key, **When** the same request arrives again, **Then** the original result is returned and stock is not allocated twice; the same key with different contents is refused.
4. **Given** an active allocation, **When** it is released, **Then** available goes back up by that quantity; **When** it is consumed instead, **Then** on hand and allocated both go down by that quantity and a movement records it.
5. **Given** any sequence of movements and allocations, **When** the integrity check runs, **Then** for every variant on hand equals the sum of its movements, allocated equals the sum of its active allocations, and available is never negative.

---

### User Story 4 - Low-stock warnings (Priority: P4)

Each variant can have a low-stock level. When available stock falls to or below it, the variant is flagged on the catalog screens and appears in a "Low stock" list that owners and managers can open from the Catalog area, sorted with the most urgent first.

**Why this priority**: Valuable daily, but the catalog and the ledger must exist first.

**Independent Test**: Set a variant's low-stock level to 3 with 5 available; record "damaged −2". The variant now shows a low-stock flag and appears in the Low stock list; record "received +4" and it disappears from the list.

**Acceptance Scenarios**:

1. **Given** a business default low-stock level, **When** a variant has no level of its own, **Then** the default applies; a variant level of 0 means no warning.
2. **Given** a variant at its low-stock level, **When** an owner opens the Low stock list, **Then** it is listed with product, variant, available, on hand and level; out-of-stock variants are listed first.
3. **Given** a sales agent, **When** they browse the catalog, **Then** they see the low-stock flag and "out of stock" labels but not the Low stock list.

---

### User Story 5 - Import a catalog from a spreadsheet (Priority: P5)

An owner who already keeps products in a spreadsheet uploads a CSV file. BOS checks every row first — required fields, duplicate SKUs within the file and against the existing catalog, inconsistent rows of the same product, invalid prices or quantities — and shows a preview: how many products and variants would be created and every problem with its row number and column. Nothing is saved until the file has no errors and the owner confirms; then everything is saved at once, including opening quantities as ledger movements.

**Why this priority**: Saves hours for merchants with existing catalogs, but merchants can start by hand with User Story 1.

**Independent Test**: Upload a file with 40 valid rows and 3 faulty ones (a duplicate SKU, a missing price, a negative quantity). The preview lists exactly those three rows with clear reasons in the person's language and saves nothing. After fixing the file, the preview shows the counts, and confirming creates all products and variants with opening-stock movements; uploading the same file again is refused as duplicates rather than creating copies.

**Acceptance Scenarios**:

1. **Given** a CSV file in the documented template (one row per variant, rows of the same product sharing a product code), **When** it is uploaded, **Then** a preview shows the products, variants and opening stock to be created, and every row error with row number, column and reason.
2. **Given** a file with at least one error, **When** the owner views the preview, **Then** the confirm action is not available and nothing has been saved.
3. **Given** a valid file, **When** the owner confirms, **Then** all rows are saved in one step, or, if anything fails at that moment (for example someone created the same SKU meanwhile), none are, and the owner is told why.
4. **Given** the import template, **When** the owner downloads it, **Then** it has the column headers and one example product, and both Arabic and English text in cells are accepted (UTF-8, with or without a byte-order mark).

---

### Edge Cases

- A product with no options (one size, one colour): it has exactly one variant, created automatically, with its own SKU and stock.
- Adding a new size to a product that already has stock: new variants are created with zero stock; existing variants keep their identity and history.
- Removing an option value whose variants have stock or history: those variants are archived, not deleted.
- SKUs differing only in letter case or surrounding spaces count as the same SKU; an archived variant's SKU stays reserved.
- A product listed in no store is visible only to owners and managers; a deactivated store's products stay in the catalog but are hidden from that store's sales staff until the store is reactivated.
- An employee whose store access changes sees the new set of products on their next screen change (as for other screens in M0).
- Quantities and prices typed with Arabic-Indic digits are accepted; large LBP amounts (e.g., 89,500,000) display with thousands separators in both languages.
- Photo upload fails on a weak connection: the form keeps everything else and lets the person retry the photo; a refused photo (too large, wrong type) blocks saving like any other field error.
- A CSV file with a photo or image-link column is treated like any file with unknown columns.
- A CSV file that is too large, not CSV, or has unknown columns is refused before row checks with one clear message.
- Allocation requests for an archived variant are refused; archiving a variant with active allocations is refused until they are released.

## Requirements *(mandatory)*

### Functional Requirements

**Catalog**

- **FR-001**: Owners and managers (permission `catalog.manage`) MUST be able to create, edit and archive products; every employee MUST be able to view and search the catalog within their store access (`catalog.view`).
- **FR-002**: A product MUST have a name (Arabic, English or both), a product code unique in the business, an optional description per language, up to 8 photos, up to 2 option types (e.g., size, colour) with their values, and the stores it is listed in.
- **FR-003**: Each combination of option values MUST be a variant with its own SKU, price, low-stock level and optional photo chosen from the product's photos; a product without options MUST have exactly one variant.
- **FR-004**: Each variant MUST have one stable inventory identity, created with it and never reused or changed; SKU, price, names and options may be edited later without changing that identity.
- **FR-005**: SKUs MUST be unique within a business, compared without regard to letter case and surrounding spaces, including archived variants. The system MUST suggest a SKU built from the product code and option values when the person leaves it empty.
- **FR-006**: Prices MUST be stored as exact decimal amounts with an explicit currency, and MUST NOT be converted silently. Each variant MUST have one price in a currency the seller chooses, USD or LBP; the other currency MUST be shown as an approximate conversion at the business's current USD/LBP rate (from Settings) and labelled as approximate. Changing the rate MUST NOT change any stored price. A variant's price MUST be the same in every store the product is listed in; there are no per-store prices in M1.
- **FR-007**: Products and variants with stock history or allocations MUST NOT be deletable; they can be archived and restored. Archived items MUST be excluded from sales search and from new allocations.
- **FR-008**: Changes to a product MUST be refused when the product changed since the person opened it, showing the current version.
- **FR-009**: Catalog search MUST match product names in either language, product codes and SKUs, partially and ignoring letter case, and MUST filter by store and by in-stock / low / out-of-stock.
- **FR-010**: Product photos MUST accept PNG, JPEG or WebP up to 5 MB each and MUST be shown in sizes suited to phone screens.

**Stock ledger and adjustments**

- **FR-011**: The business MUST have exactly one default warehouse; each variant MUST have exactly one stock balance in it.
- **FR-012**: Every change to on-hand stock MUST be recorded as an immutable movement with variant, signed quantity, reason, person (or system process), time, optional note and, for count corrections, the counted number. Movements MUST never be edited or deleted; mistakes are corrected with a new movement.
- **FR-013**: On hand MUST always equal the sum of the variant's movements.
- **FR-014**: Owners and managers (permission `stock.adjust`) MUST be able to record these reasons: opening stock, received, count correction, damaged, lost, found, other (note required). Sales, packing and dispatch agents MUST NOT be able to change stock.
- **FR-015**: A stock change MUST be refused if the balance changed since the person loaded it, or if it would make on hand lower than zero or lower than the quantity allocated.
- **FR-016**: Repeated submission of the same stock change (same request key) MUST be recorded once.
- **FR-017**: Every stock change MUST appear in the business's history (audit, readable by owners, as in M0) and in the variant's stock history (readable by owners and managers).

**Allocation**

- **FR-018**: Available MUST equal on hand minus active allocations and MUST never be negative; there is no backorder in M1.
- **FR-019**: The system MUST offer one allocation capability that reserves quantities for several variants all-or-nothing, identified by a request key that makes repeats return the first result; the same key with different contents MUST be refused.
- **FR-020**: Allocations MUST be releasable (quantity returns to available) and consumable (on hand and allocated both decrease, with a movement recorded); each of these changes MUST be recorded in the business's history.
- **FR-021**: Concurrent allocation and adjustment requests for the same variant MUST never produce negative availability or lost updates.
- **FR-022**: The system MUST provide an integrity check that verifies FR-013 and FR-018 for every variant of a business and reports any difference.

**Low stock**

- **FR-023**: The business MUST have a default low-stock level (settable by owners and managers, initially 2); each variant MAY override it; 0 disables the warning.
- **FR-024**: A variant whose available is at or below its level MUST be flagged in catalog screens, and listed in a Low stock list for owners and managers, out-of-stock first.

**CSV import**

- **FR-025**: Owners and managers MUST be able to download an import template and upload a CSV file (UTF-8, up to 2,000 rows and 2 MB) with one row per variant.
- **FR-026**: The system MUST validate the whole file before saving anything: required columns and fields, product code consistency across rows of the same product, duplicate SKUs within the file and against the catalog, number formats, non-negative opening quantities, known store names, option combinations not repeated within a product.
- **FR-027**: The preview MUST list every error with row number, column and a reason in the person's language, and the counts of products, variants and opening stock that would be created.
- **FR-028**: Confirming a valid preview MUST save all rows in one step or none, recording opening quantities as ledger movements and the import as one entry in the business's history.
- **FR-029**: Import in M1 MUST only create new products and variants; rows whose SKU or product code already exists MUST be reported as errors. The import file MUST NOT carry photos or photo links; imported products start without photos, and catalog search MUST offer a "no photo" filter for owners and managers so they can add them on the phone.

**Cross-cutting**

- **FR-030**: All catalog, stock and allocation data MUST be isolated per business and checked against the person's store access, as in M0; refused attempts MUST be recorded.
- **FR-031**: All new screens MUST work at 360 px wide in Arabic (right-to-left) and English, with the loading, empty, error and offline states used in M0.

### Key Entities *(include if feature involves data)*

- **Product**: What the merchant sells, in one or both languages: code, names, descriptions, photos, option types, store listings, status (active/archived).
- **Variant**: One sellable combination of option values (e.g., size 32, blue) with SKU, price, low-stock level and photo; carries the stable inventory identity.
- **Inventory item**: The stable, never-reused identity of a physically stocked variant, used by orders and, later, by website mappings.
- **Warehouse**: The business's one physical stock location in M1.
- **Stock balance**: Per variant and warehouse: on hand and allocated; available is derived.
- **Stock movement**: An immutable ledger entry changing on hand, with reason, quantity, person, time and note.
- **Allocation**: Quantity of a variant reserved for a request (an order from M2), with request key and state (active, released, consumed).
- **Store listing**: Which of the business's stores sell a product.
- **Import batch**: An uploaded file, its validation result and, if confirmed, what it created.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner creates a product with 3 sizes, 2 colours, a photo, a price and opening stock on a phone in under 3 minutes.
- **SC-002**: In automated concurrency tests, 100% of races for the last unit allocate it exactly once, and 100% of repeated requests (allocations and stock changes) are applied once.
- **SC-003**: After every automated test scenario, the integrity check reports zero differences between on hand and movements, allocated and active allocations, and no negative availability.
- **SC-004**: 100% of SKU uniqueness tests (case, spaces, archived variants, other businesses, CSV within file and against catalog) behave as specified.
- **SC-005**: A 500-row CSV file is validated and its preview shown in under 30 seconds, and no import test ever leaves a partial import.
- **SC-006**: Catalog search shows results in under 1 second for a business with 5,000 variants on the simulated mobile profile used in M0.
- **SC-007**: 100% of catalog and stock changes attempted without the required permission or store access are refused, including direct requests, and recorded.
- **SC-008**: Every new screen loads in under 3 seconds on the simulated mobile profile and passes the M0 accessibility checks in both languages.

## Clarifications

### Session 2026-11-14

- Q: How do prices work with USD and LBP? → A: One price per variant in a currency the seller chooses (USD or LBP); the other currency is shown as an approximate conversion at the business rate (FR-006).

### Session 2026-11-15

- Q: When a product is listed in several stores, is its price the same in all of them? → A: Yes, one price per variant for the whole business; no per-store prices in M1 (FR-006).
- Q: Does the CSV import bring in photos? → A: No; imported products start without photos, which are added on the phone, helped by a "no photo" filter (FR-029). BOS does not download images from web links.

## Assumptions

- Builds on M0: businesses, stores, employees, roles and permissions (`catalog.view`, `catalog.manage`, `stock.adjust` already defined), history/audit, the bilingual mobile shell and its states.
- One physical warehouse per business; stock is shared by all of the business's stores. Multi-warehouse is out of scope.
- No orders, customers, packing or courier work in M1; allocations are exercised through the integrity tests and become user-visible with orders in M2. Custom non-catalog order items belong to M2.
- No WooCommerce mapping, website sync, WhatsApp or AI features in M1; the stable inventory identity is what M4 will map to.
- Up to 2 option types per product covers the pilot merchants (size and colour); more can be added later.
- Photos use the same storage approach as store logos in M0, with a larger size limit for product photos.
- Stock history is kept indefinitely.
- CSV import creates only; updating existing products by spreadsheet is a later enhancement.
- Times are stored in UTC and shown in Asia/Beirut time, as in M0.
