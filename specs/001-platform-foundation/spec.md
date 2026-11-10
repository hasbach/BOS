# Feature Specification: Platform Foundation (M0)

**Feature Branch**: `001-platform-foundation`

**Created**: 2026-11-10

**Status**: Draft

**Input**: User description: "M0 platform-foundation from the BOS product brief: a merchant can create an isolated business account with a first store, sign in securely, invite employees and give them roles limited to specific stores, and everyone lands in a bilingual (Arabic/English) mobile-first app shell. Exit gate: multi-tenant isolation tests pass. No catalog, orders, WhatsApp or WooCommerce in this feature."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A business is set up and its owner signs in (Priority: P1)

A Beta Marketing Solutions operator sets up a new merchant: business name, first store, edition, default currency and the owner's name and contact. The operator sends the owner an activation link. The owner opens it, sets their own password and language, and arrives on a home screen that belongs only to their business. They can sign out and sign back in later on the same or another phone.

**Why this priority**: Nothing else in BOS can exist without an isolated business account and a signed-in owner. On its own it already proves the most important promise of the platform: one merchant's space is closed to every other merchant.

**Independent Test**: An operator sets up two separate businesses and each owner activates their account on their own phone. Each owner signs in and sees only their own business name, store and home screen. Neither can reach anything of the other's, including by altering addresses or identifiers by hand.

**Acceptance Scenarios**:

1. **Given** a Beta operator, **When** they set up a merchant with a business name, first store name, edition, default currency and the owner's name and phone or email, **Then** a new business exists with exactly one pending owner and one store, and an activation link is available to send to the owner.
2. **Given** an owner with a valid activation link, **When** they open it and set a password and language, **Then** their account becomes active and they land on their business's home screen.
3. **Given** a member of the public with no activation link, **When** they look for a way to create a business, **Then** none exists; BOS offers sign-in only.
4. **Given** an owner who has signed out, **When** they sign in with their phone number or email and correct password, **Then** they land on their business's home screen in the language they last chose.
5. **Given** a sign-in attempt with wrong details, **When** it is submitted, **Then** access is refused with a message that does not reveal whether the account exists, and repeated failures are slowed down.
6. **Given** two businesses A and B, **When** the owner of A tries to open any record of B by guessing or editing an identifier, **Then** the request is refused and nothing about B is revealed, including whether the record exists.
7. **Given** an owner who forgot their password, **When** they complete the recovery process, **Then** they can set a new password and all their other signed-in sessions are ended.
8. **Given** a Beta operator, **When** they look at a merchant they set up, **Then** they see account-level information only (business name, edition, status, owner contact, store count), never that merchant's staff activity, customers or later business data.

---

### User Story 2 - Owner invites employees with roles and store access (Priority: P2)

The owner adds the people who work for them: a sales agent, a packing agent, someone handling dispatch and collections, or another manager. Each person gets one or more roles and is limited to the stores the owner chooses. An employee accepts the invitation, sets their own password, and from then on sees only what their roles and stores allow.

**Why this priority**: The brief's core workflow depends on different people doing sales and packing on their own phones. Roles must be real restrictions enforced by the system before any stock, order or money features are built on top of them.

**Independent Test**: The owner invites one sales agent limited to Store A and one packing agent for both stores. Each accepts and signs in. Check that each sees only their permitted areas and stores, and that directly requesting something outside their permission is refused even though the interface never offered it.

**Acceptance Scenarios**:

1. **Given** an owner, **When** they invite a person with a name, contact detail, one or more roles and one or more stores, **Then** a pending invitation exists and the owner can share it with that person.
2. **Given** a valid, unexpired invitation, **When** the invited person accepts it and sets a password, **Then** they become an active employee of that business only, with exactly the roles and stores chosen.
3. **Given** an expired, revoked or already used invitation, **When** someone tries to use it, **Then** it is refused and no account is created.
4. **Given** an employee without a given permission, **When** they request that action directly, bypassing the interface, **Then** the system refuses it and records the refusal.
5. **Given** an employee limited to Store A, **When** they try to view or act on anything belonging only to Store B, **Then** it is refused.
6. **Given** an active employee, **When** the owner changes their roles or stores, or deactivates them, **Then** the change takes effect on that employee's very next action, and a deactivated employee is signed out everywhere.
7. **Given** a business with one owner, **When** anyone tries to remove or deactivate that last owner, **Then** it is refused.

---

### User Story 3 - Owner manages stores and business settings (Priority: P3)

The owner can add a second store, give each store its own name, WhatsApp phone number and logo, and set business-wide defaults: default currency, the USD/LBP exchange rate, and a default delivery fee.

**Why this priority**: The pilot merchant has two stores with separate WhatsApp numbers, and every later milestone attributes products, orders and staff to a store. The settings are simple, but they must exist and be correctly isolated before M1.

**Independent Test**: An owner adds a second store with its own WhatsApp number and logo, changes the exchange rate, and confirms the values persist and appear to employees with access, while a sales agent cannot change them.

**Acceptance Scenarios**:

1. **Given** an owner, **When** they add a store with a name and optional WhatsApp number and logo, **Then** the store exists in their business and can be assigned to employees.
2. **Given** two stores in one business, **When** the owner views store settings, **Then** each store shows its own name, WhatsApp number and logo independently.
3. **Given** an owner, **When** they change the default currency, exchange rate or default delivery fee, **Then** the new value is saved with who changed it and when, and applies from then on without altering anything recorded earlier.
4. **Given** an employee who is not an owner or manager, **When** they try to change store or business settings, **Then** it is refused.
5. **Given** a store that still has employees assigned, **When** the owner deactivates it, **Then** they are warned which employees are affected before confirming.

---

### User Story 4 - Everyone lands in a bilingual, role-aware app shell (Priority: P4)

After signing in on a phone, each person sees the BOS shell from the approved designs: the five bottom tabs (Sales, Packing, Delivery, Orders, More), shown or hidden according to their roles, opening on the tab that matches their main role. They can switch between Arabic and English at any time, and can add BOS to their phone's home screen. Areas that later milestones will fill show a clear "coming soon" state rather than an error.

**Why this priority**: The shell is the frame every later milestone plugs into, and Arabic right-to-left support is far cheaper to build in at the start than to retrofit. It delivers less on its own than the first three stories, which is why it ranks last.

**Independent Test**: Sign in as an owner, a sales agent and a packing agent on a narrow phone screen. Confirm each sees the correct tabs and starting tab, that switching language flips the whole layout and persists across sign-ins, and that BOS can be installed to the home screen and reopened.

**Acceptance Scenarios**:

1. **Given** a signed-in packing agent, **When** the app opens, **Then** it opens on the Packing tab and does not show areas their roles do not permit.
2. **Given** any signed-in user, **When** they switch language between Arabic and English, **Then** all shell text and layout direction change immediately and the choice is remembered for that user on every device.
3. **Given** a phone-sized screen, **When** any M0 screen is displayed in either language, **Then** nothing requires horizontal scrolling and every control can be tapped comfortably.
4. **Given** a supported phone browser, **When** the user chooses to install BOS, **Then** it appears on their home screen and opens full-screen to their starting tab.
5. **Given** a lost connection, **When** the user attempts an action, **Then** they see a clear message that it did not go through, and nothing is shown as saved unless it was.

---

### Edge Cases

- A person who already has a BOS account in another business is invited using the same phone number or email: acceptance must be refused with a neutral message that reveals nothing about the other business, and they must be invited with a different identifier.
- The same sign-in identifier is used to try to create a second business or accept a second invitation in the same business.
- An invitation is accepted at the same moment the owner revokes it.
- An operator submits business setup twice (double tap or retry on a slow connection): only one business may be created.
- An activation link is opened after it expired, or a second time after the owner already activated.
- A user registered with a phone number later wants to add an email, or the reverse.
- An employee's roles are reduced while they are in the middle of using the app.
- The only owner tries to leave, demote or deactivate themselves.
- A user is assigned a role but zero stores.
- A store's WhatsApp number is entered in different formats (with or without country code, spaces, leading zero), or is already used by another store in the same business.
- A logo upload that is too large, not an image, or attempts to reference another business's file.
- Session left open on a shared or lost phone: the user or the owner must be able to end it remotely.
- Very long business, store or person names, and names mixing Arabic and Latin script.

## Requirements *(mandatory)*

### Functional Requirements

**Business accounts and isolation**

- **FR-001**: System MUST let a Beta Marketing Solutions operator set up a business account with a business name, a first store, an edition, a default currency (USD or LBP) and the owner's name and phone number or email.
- **FR-002**: System MUST ensure a newly set up business has exactly one owner and one store, and that submitting the setup more than once creates only one business.
- **FR-003**: System MUST keep every business's data fully separate, so that no user of one business can read, list, change or detect the existence of any record, file or staff member belonging to another business.
- **FR-004**: System MUST apply the same separation to work it performs on its own in the background, not only to user requests.
- **FR-005**: New business accounts MUST be created only by Beta Marketing Solutions operators. There MUST be no public self-service sign-up in this feature.
- **FR-005a**: The owner of a new business MUST activate their account through a single-use, expiring activation link and set their own password; the operator never knows it.
- **FR-005b**: Operators MUST be able to list businesses, see account-level information (name, edition, status, owner contact, number of stores and users), resend an activation link, and suspend or reactivate a business. Suspending a business MUST block sign-in for all its users without deleting anything.
- **FR-005c**: Operators MUST NOT be able to view or change a merchant's internal data (staff activity, and from later milestones customers, catalog, orders, stock and money). Every operator action MUST be recorded with who and when.

**Sign-in and sessions**

- **FR-006**: Users MUST sign in with either their phone number or their email, whichever they registered, plus their password. Each phone number and each email MUST identify at most one user.
- **FR-006a**: Phone numbers used for sign-in MUST be accepted in common local and international formats and treated as the same number.
- **FR-007**: System MUST refuse incorrect sign-ins without revealing whether the account exists, and MUST slow down or temporarily block repeated failed attempts. Requests for a password-reset email MUST also be limited per address.
- **FR-008**: Users MUST be able to sign out, and MUST be able to end their sessions on other devices.
- **FR-009**: Users MUST be able to recover access when they forget their password: users with an email receive a reset link by email; users with only a phone number are sent a single-use reset link by an owner or manager of their own business. An owner who has no email and no other owner to help may be sent one by a Beta operator; this MUST be recorded in that business's history where its owners can see it. A password change MUST end all of that user's other sessions.
- **FR-010**: System MUST enforce a minimum password strength and MUST never display or send back a stored password.
- **FR-011**: Sessions MUST expire after a period of inactivity that keeps daily phone use convenient while limiting exposure on lost devices.

**Employees, roles and store access**

- **FR-012**: Owners and managers MUST be able to invite a person to their business, identified by phone number or email, with one or more roles and one or more stores.
- **FR-013**: System MUST provide these roles: Owner, Manager, Sales agent, Packing agent, Dispatch/collections agent. One person MUST be able to hold several roles at once.
- **FR-012a**: If the phone number or email already belongs to someone in the same business, or to a pending invitation there, the invitation MUST be refused immediately. If it belongs to a BOS user in another business, the system MUST NOT reveal that: the invitation is created normally and acceptance is refused with a neutral message asking for a different phone number or email.
- **FR-014**: Invitations MUST be single-use, MUST expire, and MUST be revocable by an owner or manager before they are accepted. A pending or expired invitation MUST be resendable, which issues a new link and invalidates the old one.
- **FR-015**: An invited person MUST set their own password when accepting; the inviter never knows it.
- **FR-016**: System MUST check every action against the acting user's roles and permitted stores at the moment of the action, regardless of what the interface displayed.
- **FR-017**: Owners and managers MUST be able to change an employee's roles and stores, deactivate them and reactivate them. Changes MUST take effect on the employee's next action, and deactivation MUST end all their sessions.
- **FR-018**: System MUST prevent a business from being left with no active owner.
- **FR-019**: Managers MUST NOT be able to grant the Owner role or change an owner's access; only an owner can.
- **FR-019a**: Nobody MUST be able to change their own roles, store access or active status. Owners and managers always have access to all stores of their business.
- **FR-020**: Each user MUST belong to exactly one business. A phone number or email MUST identify at most one user across the whole platform, so a person who works for two merchants uses a different phone number or email for each.
- **FR-020a**: Users MUST be able to add or change their own phone number or email after confirming their current password, subject to the same uniqueness rule.

**Stores and settings**

- **FR-021**: Owners and managers MUST be able to add stores, edit each store's name, WhatsApp phone number and logo, and deactivate a store.
- **FR-022**: System MUST store WhatsApp phone numbers in one consistent international format and MUST reject a number already used by another active store in the same business.
- **FR-023**: Owners MUST be able to set business-wide defaults: default currency, USD/LBP exchange rate and default delivery fee.
- **FR-024**: Changing a setting MUST NOT alter anything recorded before the change.
- **FR-025**: Uploaded logos MUST be limited to images of a reasonable size and MUST be viewable only by users of that business.

**App shell and language**

- **FR-026**: System MUST present a mobile-first shell with the Sales, Packing, Delivery, Orders and More areas, showing each user only the areas their roles permit and opening on the area matching their main role.
- **FR-027**: System MUST fully support Arabic (right-to-left) and English (left-to-right) for every M0 screen and message, including the operator's screens, let the user switch at any time, and remember the choice per user.
- **FR-027a**: Before sign-in, the language MUST follow the device's language (Arabic if the device is set to Arabic, otherwise English) and be switchable on the spot. After sign-in, the user's saved language MUST always win. The language chosen during activation becomes the user's saved language.
- **FR-028**: System MUST be installable to a phone's home screen and open full-screen.
- **FR-029**: Areas that belong to later milestones MUST show a clear placeholder state, not an error.
- **FR-030**: System MUST show times in Beirut local time.
- **FR-031**: System MUST never show an action as completed before it is durably saved, and MUST show clear loading, empty, error and no-connection states.

**Audit and operations**

- **FR-032**: System MUST keep a permanent, unalterable history of: sign-ins and failed sign-ins, sign-outs and ended sessions, password changes and reset links issued, changes to a user's phone number or email, invitations sent/accepted/revoked/resent, role and store-access changes, employee activation changes, store changes, settings changes, emails sent or failed, and every action a Beta operator takes on the business, each with who, what and when.
- **FR-033**: Owners MUST be able to view the history for their own business only.
- **FR-034**: System MUST record every refused attempt to access another business's data or to act without permission.
- **FR-035**: A demonstration business with sample stores and one user per role MUST be available for testing and demos, clearly separate from real merchants.

**Explicitly out of scope for this feature**

- Products, stock, customers, orders, packing, delivery, COD and reports (M1–M3).
- Any WhatsApp connection (M3.5) or WooCommerce connection (M4–M6).
- Subscription billing for BOS itself.
- Edition switching between BOS Social and BOS Commerce as a paid feature; the edition is recorded on the business but gates nothing yet.

### Key Entities

- **Operator**: A Beta Marketing Solutions staff member who sets up and suspends businesses. Not a member of any business and has no access to merchants' internal data.
- **Business (tenant)**: A merchant's isolated space. Has a name, edition (BOS Social or BOS Commerce), default currency, exchange rate, default delivery fee and status. Owns everything else.
- **Store**: A selling identity inside a business. Has a name, optional WhatsApp phone number, optional logo and status. A business has one or more.
- **User**: A person who can sign in. Belongs to exactly one business. Has a name, a phone number and/or an email, a password, a preferred language, one or more roles, the stores they may access, and whether they are active. Exists independently of any one business.
- **Role**: A named set of permissions (Owner, Manager, Sales agent, Packing agent, Dispatch/collections agent).
- **Invitation**: A pending offer for a person to join a business with given roles and stores; the owner's activation link is the same thing with the Owner role. Has an expiry and a status (pending, accepted, revoked, expired).
- **Session**: One signed-in device for a user, which can be listed and ended.
- **Audit entry**: An unalterable record of a security- or settings-relevant event within one business.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can set up a new merchant in under 3 minutes, and the owner can go from opening the activation link to their own home screen in under 2 minutes on a phone.
- **SC-002**: An owner can invite an employee, and that employee can be signed in and on their starting tab, in under 2 minutes in total.
- **SC-003**: In the full automated isolation test suite, 100% of attempts by one business to read, list, change or detect another business's data are refused, across every action M0 offers.
- **SC-004**: In automated permission tests, 100% of actions attempted without the required role or store access are refused, including when requested directly rather than through the interface.
- **SC-005**: A change to an employee's access or a deactivation is effective on that employee's next action in 100% of test cases.
- **SC-006**: Every M0 screen is fully usable in both Arabic and English on a 360-pixel-wide phone screen with no horizontal scrolling.
- **SC-007**: Submitting business setup, owner activation or invitation acceptance twice results in exactly one business or one user account in 100% of test cases.
- **SC-008**: Every event listed in FR-032 that occurs during the acceptance test run appears in the business's history with the correct person and time.
- **SC-009**: Pages of the shell become usable within 3 seconds on a typical mid-range Android phone on a mobile data connection.

## Assumptions

- "Owner / manager" in the brief is treated as two roles: Owner (full control, including other owners) and Manager (same day-to-day abilities, but cannot grant or change the Owner role).
- Each user belongs to exactly one business (decided by the product owner on 2026-11-10 after the independent review). A person working for two merchants uses a different phone number or email for each.
- Phone numbers and emails are not verified in M0, because BOS has no SMS sending and links are shared by the inviter. The effect of a wrongly claimed identifier is limited to the inviter's own business; an operator can release it. Verification is deferred until BOS has a sending channel.
- Demonstrations on a real phone during development run over the local network without HTTPS; installing BOS to a phone's home screen needs HTTPS and is validated on a staging address.
- Invitations are delivered by the owner sharing a link (for example over WhatsApp), because BOS has no message-sending integration in the MVP. Invitations expire after 7 days.
- BOS sends email (for password reset) but has no SMS or WhatsApp sending in the MVP, which is why phone-only users get their reset link from a person rather than automatically.
- Activation and reset links are shared by the operator, owner or manager over whatever channel they already use (for example WhatsApp). Activation links expire after 7 days, reset links after 1 hour.
- Public self-service sign-up is deferred; it will need contact verification and abuse protection when added.
- Default currency is USD with LBP as the secondary display currency, matching the designs. The exchange rate is entered manually by the owner.
- The demonstration business is used for tests and demos only and never contains real customer data.
- Role permissions for areas that do not exist yet (stock, orders, settlements) are defined now as a permission list but are only exercised from M1 onward.
- Screens follow `design/bos-screens.html` (01 Sign in, 02 Home shell, 18 More). New screens are needed and not yet designed: account activation, employees and invitations, stores, business settings, and the operator's business list and setup form. The operator screens follow the same bilingual, phone-first rules as the rest.
- Subscription status and billing for merchants are handled manually outside the product during the pilot.
