# M0 exit gate — Platform Foundation

**Commit under test**: `9386001` (branch `001-platform-foundation`), working tree clean at the start; the only
change made during this run is the wording of three lines in `quickstart.md` (see "Documentation fixes").
**Date**: 2026-11-13.

## T090 — quickstart run-through

**Machine**: Windows 10, slow disk, no Docker (see "Deviation from quickstart.md" below). PostgreSQL 17 on
127.0.0.1:55433 (`scripts/local_db.py`), Node 24.22.2 portable, Python 3.12 via uv, Edge 157 (installed, headless),
viewport 360 x 740, locales `en-US` and `ar`.

### Deviation from quickstart.md

`quickstart.md` describes the Docker Compose stack (`docker compose exec ...`, port 3000). This machine runs
without Docker, so the equivalent steps from the root `README.md` ("Run on the development PC without Docker")
were used: API `backend/scripts/local_api.py serve` on 5100 (activation links point at the web address used),
web app on 3400 (`next dev`) and, for a second pass, a production build on 3410 (`next build` + `next start`).
The Docker path itself (compose file, `docker compose exec` commands, Mailpit) was **not run**. Demo data
already existed in the development database (`BOS_ALLOW_DEMO_SEED` was not needed and not set by this run).

### 1. Automated suites (captured output)

| Suite | Command | Result |
|---|---|---|
| Backend tests (unit, contract, integration, isolation) | `uv run python scripts/local_tests.py` (from `backend/`) | `974 passed in 164.43s (0:02:44)`; the isolation route-coverage tests are inside this run |
| Backend lint | `uv run ruff check .` | `All checks passed!` |
| Backend format | `uv run ruff format --check .` | `86 files already formatted` |
| Backend types | `uv run mypy` | `Success: no issues found in 40 source files` |
| Frontend types | `npm run typecheck` | `tsc --noEmit`, no output (clean) |
| Frontend lint | `npm run lint` | `eslint .`, no output (clean) |
| Frontend unit | `npx vitest run` | `Test Files 52 passed (52)`, `Tests 636 passed (636)`, 62.55 s |
| End to end | `npx playwright test` (Edge, 360 px, en and ar, includes axe) | `10 passed (14.6m)`; both `a11y` runs report `0 axe violations; 0 focus problems; 0 targets under 44px`; no test failed, so no single-spec rerun was needed |

Logs: `<scratch>/pytest.log`, `lint.log`, `fe-static.log`, `vitest.log`, `playwright.log`, where `<scratch>` is
`C:\Users\Ghost\AppData\Local\Temp\claude\ac9b2cab3ed0f663\1545800f-3492-49d2-85a2-29d9b5462bcd\scratchpad\t090`.
The Playwright run leaves two `E2E Business ...` rows per language in the development database (known, `us1.md`).

### 2. Manual scenarios 1–5, English and Arabic

Driven by a throwaway Playwright script (not committed; kept in `<scratch>\manual.cjs`, with the follow-up
probes `follow.cjs`, `f3.cjs`, `f4.cjs`). It uses the real screens wherever the e2e suite does and the HTTP API
for "request it directly" steps. Each locale gets its own new business ("Test Merchant ...", store "Main").
The whole script ran **twice**: against `next dev` (3400) and against the production build (3410); results were
identical, so one table is given (**dev**, then **prod** in the next columns; en / ar each).
Quickstart order was changed slightly: scenario 4 steps 1–5 run before scenario 3 (so a second store exists for
"Store A" / "both stores"), and the six-wrong-passwords step (1.7) runs last because it blocks the owner's
sign-in for 15 minutes.

Differences from the literal quickstart (all by necessity): the demo business is used read-only (scenario 2);
scenarios 3–5 run in the new "Test Merchant" business, whose first store "Main" plays "Store A" and the store
added in scenario 4 plays "Store B"; scenario 3 step 9 uses the Demo Second Shop owner's number
(+96170000011) as "a user of the other business"; the manager in step 7/10 and the people in scenario 5 are
invited through the API (the screens for inviting are exercised in 3.1 and 3.8/3.9).

| Step | dev en | dev ar | prod en | prod ar | Observation |
|---|---|---|---|---|---|
| 1.1 operator signs in, sets up business (BOS Social, store "Main", owner phone) | pass | pass | pass | pass | link screen shown; timings below |
| 1.2 copy link; not shown again | pass | pass | pass | pass | clipboard equals the shown link; token absent from `/ops` after Done, after browser Back and after reload |
| 1.3–1.4 owner opens link in a fresh browser, chooses language, sets password | pass | pass | pass | pass | lands on Sales in the chosen language; `lang`/`dir` correct (`ar` is `rtl`); business name shown |
| 1.5 same link again | pass | pass | pass | pass | shows "This link was already used" (ar: "استُخدم هذا الرابط من قبل"), not the literal "no longer valid" of the quickstart; a revoked/expired link shows "This link is no longer valid" (3.8) |
| 1.6 sign in with the phone in other formats | pass | pass | pass | pass | national `071...`, `+961 71 xxx xxx`, `9617...` all sign in |
| 1.7 six wrong passwords, then the right one | pass | pass | pass | pass | six identical messages; the correct password during the block gets the same message; the page never says blocked/locked |
| 1.8 operator opens "Test Merchant" | pass | pass | pass | pass | there is no detail page; the list card shows name, edition, status, owner name and phone, store and user counts, and the Suspend / reset-link buttons; nothing from inside the business |
| 1.9 second business with the same owner phone | pass | pass | pass | pass | refused: "This phone number cannot be used. Enter a different phone number or an email." |
| 2.1–2.4 foreign store and staff ids from the other business | pass | pass | pass | pass | see finding P2: with the requests the app sends, every answer equals the made-up id's (404 `not_found`); two oracles remain with unusual requests |
| 2.4 histories | pass | pass | pass | pass | demo history contains nothing about Test Merchant; Test Merchant history has `access.denied_tenant` (store-logo requests and a made-up staff id; see P2 about foreign staff ids) |
| 2.5 History screen | pass | pass | pass | pass | "Refused: not in your business" entries visible, RTL layout correct |
| 4.1–4.2 add store, number typed `70 000 111` (ar: `70 000 112`), logo | pass | pass | pass | pass | shown as `+961 70 000 111`; the logo image loads |
| 4.3 same number again | pass | pass | pass | pass | "The store was not saved." plus "Another store in your business already uses this WhatsApp number." |
| 4.4 5 MB logo and a PDF as logo | pass | script error* | pass | script error* | both refused at selection with clear messages ("This image is larger than 2 MB. Choose a smaller one."; "This file is not a PNG, JPEG or WebP image. Choose another file."), also in Arabic (`follow.cjs`). See P5 |
| 4.5 exchange rate and delivery fee | pass | pass | pass | pass | saved; History shows who, and `89,500 -> 91,000` (fee `0.00 -> 2.50` in the entry) |
| 4.6 deactivate a store that has employees | pass | pass | pass | pass | sheet lists the employee and role before confirming; confirmed, then reactivated |
| 3.1 invite sales agent (Store A only), accept | pass | pass | pass | pass | timed, see below |
| 3.1 invite packing agent (both stores), accept | pass | pass | pass | pass | |
| 3.2 start tabs and stores | pass | pass | pass | pass | sales: starts on Sales, 1 store; packing: starts on Packing, every store; neither has Employees or Settings in More |
| 3.3 sales agent calls the staff list | pass | pass | pass | pass | 403 `forbidden`; `access.denied_permission` in the owner's history |
| 3.4 owner changes the sales agent's roles | pass | pass | pass | pass | removing the only role is refused ("1 thing to fix before saving"); swapping to Packing saves |
| 3.4b the agent's tabs change on the next tap, no refresh | **FAIL** | **FAIL** | **FAIL** | **FAIL** | see finding P1: the open app keeps the old tab bar until the page is loaded again (the server answers correctly) |
| 3.5 deactivate packing agent, next action goes to sign-in | **FAIL** | **FAIL** | **FAIL** | **FAIL** | see finding P1: tab taps stay on the page; a full page load goes to sign-in |
| 3.6 deactivate the only owner | pass | pass | pass | pass | screen explains ("You are the only owner..."), no button; API 403 `cannot_modify_self` |
| 3.7 manager changes the owner's roles | pass | pass | pass | pass | API 403 `forbidden`; screen shows "Only an owner can change an owner's access" |
| 3.8 invite, revoke, open link | pass | pass | pass | pass | "This link is no longer valid" |
| 3.9 invite a number used in another business | pass | pass | pass | pass | invitation created, no warning on the owner's screen; accepting shows "Use a different phone number or email" (ar: "استخدم رقم هاتف أو بريداً إلكترونياً آخر") |
| 3.10 manager changes own roles | pass | pass | pass | pass | API 403 `cannot_modify_self`; screen shows the "You can't change your own roles" note |
| 5.1 tabs and start tab per role | pass | pass | pass | pass | owner Sales/Packing/Delivery/Orders/More (start Sales); sales Sales/Orders/More; packing Packing/Orders/More (start Packing); matches `contracts/permissions.md`; labels in Arabic checked |
| 5.2 switch language | pass | pass | pass | pass | text and direction change at once; after sign-out, signing in on another browser (sign-in page opened in the old language) lands in the saved language |
| 5.3 "coming soon" tabs | pass | pass | pass | pass | Packing, Delivery, Orders show the chip and the "Nothing is wrong" note, no error or Try again button |
| 5.4 install | partial | partial | pass (script part) | pass (script part) | manifest (`display: standalone`), all three icons 200 on every run; service worker `none` on `next dev`, `active` on the production build (see P4). **The browser-menu install itself was not performed** |
| 5.5 offline save | pass | pass | pass | pass | settings: "Not saved. We couldn't reach the server ... What you typed is still here."; "Saved" not shown; the server value is unchanged |
| 5.x History event types seen | pass | pass | pass | pass | `access.denied_permission`, `access.denied_tenant`, `auth.sign_in`, `auth.sign_out`, `invitation.accepted/created/revoked`, `store.created/updated/deactivated/reactivated`, `tenant.created`, `tenant.settings_changed`, `user.deactivated`, `user.roles_changed` |

\* 4.4 in Arabic: the script saved the store after the first (refused) file, which created the store without a logo and left the
page, so its second file upload timed out. That is the script, not the app; the same two files were then checked
separately in Arabic with the correct messages (`follow.cjs`, notes in `follow-notes.json`).

Every run: **0 screens with horizontal scroll** at 360 px (checked on about 25 screens per run in both languages,
including the one-time link, activation, store form, settings, history, invite form, More, sign-in after block,
identifier-refused). **Console**: 30–32 `error` entries per run, all of them the browser's own "Failed to load
resource" lines for responses the scenarios provoke on purpose (401, 409, 410, 400) or for the offline step
(`ERR_INTERNET_DISCONNECTED`); no JavaScript exception, no hydration error, no page error in either language.

Screenshots (in `<scratch>`, named `shot-<en|ar>-<name>.png`; both language runs and the later runs reuse names, so the
files are from the last run that wrote them): `ops-list`, `ops-new-filled`, `ops-link`, `activate-filled`,
`home-owner`, `link-used`, `ops-card-active`, `ops-dup-phone`, `history`, `store-form`, `stores-list`,
`store-dup-number`, `settings-saved`, `history-settings`, `store-deactivate-warning` (caught mid-animation in `ar`),
`invite-form`, `invite-link`, `agent-activate`, `agent-home`, `more-sales`, `more-packing`, `owner-self-detail`,
`manager-views-owner`, `revoked-link`, `cross-business-identifier`, `tabs-owner`, `tabs-sales`, `tabs-pack`,
`language-switched`, `soon-packing`, `soon-delivery`, `soon-orders`, `offline-save`, `lockout-correct-password`;
for the findings `f-agent-after-reload`, `f-agent-after-deactivate-api`, `f3-profile-deactivated`.
The "Rendering..." pill and the round "N" button on some images are the Next.js development overlay (dev server only).

### 3. SC-001 and SC-002 timings

The script types nothing slowly: fields are filled in one step each. Wall clock, measured with a stopwatch in the script,
on warmed routes (every route was requested once before timing, as `e2e/global-setup.ts` does):

| Measure (spec wording) | From / to | `next dev` en | `next dev` ar | production build en | production build ar | Limit |
|---|---|---|---|---|---|---|
| SC-001 operator sets up a merchant | click "Set up a business" to the one-time link on screen | 1.1 s | 1.0 s | 0.5 s | 0.6 s | under 3 min |
| SC-001 owner, link to home screen | open the link to the Sales home with business name | 2.3 s | 2.7 s | 0.9 s | 1.2 s | under 2 min |
| SC-002 invite + employee in on starting tab | click Invite to the employee's starting tab, including copy and Done clicks | 4.0 s | 3.8 s | 1.9 s | 2.3 s | under 2 min |

**Estimate for a person (not measured)**: the operator form has 5 fields to type (about 70–90 s with a phone
keyboard) plus copying the link and handing it over; the owner reads the page, picks a language and types a 10+
character password twice (about 40–70 s on a phone); the invite form is about 4 fields (about 40–60 s) and the
employee does the same as the owner (about 40–70 s). That puts a first-time person at roughly 2 min for the operator,
about 1 min for the owner and about 2 min for the whole SC-002 chain. The SC-002 estimate is close to its limit, and it
**does not include sending the link to the employee** (WhatsApp, in person), which happens outside BOS. These are
estimates, not a measurement with people on a real phone.

### 4. Success criteria

| SC | How it is evidenced now | Status |
|---|---|---|
| SC-001 operator setup under 3 min, owner to home under 2 min on a phone | This run: scripted 1.1 s + 2.7 s worst case (dev), 0.6 s + 1.2 s (prod build); human time estimated above | **Met** for the app (machine time); human timing is an estimate, **needs a real device / real people** |
| SC-002 invite to employee on starting tab under 2 min | This run: 4.0 s worst case scripted; human estimate about 2 min, link hand-over excluded | **Met** for the app; borderline when a person types; **needs real device / real people** |
| SC-003 isolation, 100% refused | `backend/tests/isolation/` (RLS, route coverage, scoped functions, per-story route tests) inside the 974 passing tests; e2e `us1-activation` step 10; this run scenario 2 | **Met** (automated). Two small distinguishing signals for foreign staff ids with unusual requests (P2) |
| SC-004 permission refusals, 100% | `backend/tests/unit/test_permissions.py` and the permission cases of every isolation route test; this run 3.3, 3.7, 3.10 | **Met** (automated) |
| SC-005 access change effective on the next action | Backend `test_staff.py` (roles/stores/deactivation take effect on the next request, sessions ended), e2e `us2-staff` (`/me` and 401 after the change); this run: server side effective at once | **Met** after the P1 fix: server side at once; the open app follows on the next screen change or action, and goes to sign-in after deactivation (e2e `open-app-access`, en and ar, no reload) |
| SC-006 usable in en and ar at 360 px, no horizontal scroll | `e2e/a11y.spec.ts` (0 axe violations, no horizontal scroll, 44 px targets, both languages), e2e `us4-shell`; `checklists/ux-pass.md`; this run: 0 horizontal-scroll hits, RTL looked at by eye on three screenshots (owner home, History, store-deactivation sheet), the rest by the script and the a11y suite | **Met** on emulated Edge 360 px; **needs real device** for a phone's own browser |
| SC-007 double submit gives one business / account | Backend `test_idempotency.py` (same key returns the same resource, including `test_concurrent_duplicates_create_once_and_both_get_the_same_resource`, and the operator-setup case) and the acceptance cases in `test_auth.py`/`test_staff.py` | **Met** (automated); not exercised by hand in this run |
| SC-008 every FR-032 event in history with person and time | `backend/tests/integration/test_audit_completeness.py`, `test_audit_api.py`, e2e `us4-shell`; `checklists/us4.md`; this run: the History screen showed the event types listed above with the right actor and Beirut time | **Met** (automated and observed). Exception to look at: P2, cross-business staff ids leave no `access.denied_tenant` entry |
| SC-009 shell usable within 3 s on a mid-range Android on mobile data | `checklists/performance.md` third pass: simulated mid-range Android on slow 4G, LCP 0.9–1.2 s on all screens in both languages; this run only confirmed the screens work | **Met in simulation**; **needs real device** on real mobile data (the earlier decision on judging by the simulated profile is still the owner's, `performance.md` "Verdict") |

## Problems found

**P1 — A role change or deactivation does not show in the employee's open app until the page is loaded again
(quickstart 3.4 and 3.5, SC-005, FR-017).** Severity: medium (behaviour and UX; no data is exposed, because every API call
is refused or answered with the new access).
- Reproduction (`follow.cjs`, `f3.cjs`, and steps 3.4b/3.5 of the main run, identical in en and ar, dev and prod): sign
  in as an employee with Sales + Packing; the owner removes Sales (`PATCH /staff/{id}`, 200). The server answers
  `/me` with tabs `packing/orders/more` at once. In the employee's open page: tapping Orders, More, More > Devices (an
  API call) and More > Profile, then going back, all keep the tab bar `Sales/Packing/Orders/More`; a full page load of
  `/more` shows `Packing/Orders/More`.
- Deactivation (HTTP 200 from the owner): `GET /me/sessions` answers 401 `unauthenticated`. The open app does not
  go to sign-in: tab taps stay on the page; More > Devices shows "Couldn't load your devices - We couldn't reach BOS.
  Check your connection and try again." (a 401 is presented like a connection problem; screenshot
  `f-agent-after-deactivate-api`); More > Profile still renders from the page loaded earlier
  (`f3-profile-deactivated`). A full page load goes to `/en/sign-in`.
- Why the e2e suites pass: they call `/me` (401 or new tabs) and then reload; none taps through the open app.
- Not changed (verification task).
- **Fixed** (frontend): every 401/403 "session ended" answer from any screen goes to sign-in centrally (`lib/api.ts` `onApiRefusal`, `SessionGuard`), and `/me` is asked again on every screen change and after a 403 `forbidden` (one in flight, plus one follow-up when an action comes while it is on its way) and on window focus/visibility (at most once per 3 s); no timer; tests `tests/shell/open-app-access.test.tsx`, e2e `e2e/open-app-access.spec.ts` (no reload).

**P2 — Cross-business staff ids can be told apart from missing ids in two small ways (SC-003, FR-032).** Severity: low.
- With any request the screens send, a foreign staff id and a made-up id get identical answers (404 `not_found`):
  checked with `POST /staff/{id}/password-reset` (6 demo ids), `PATCH /staff/{id}` with `{"status":"active"}`,
  `PATCH /stores/{id}` and `DELETE /stores/{id}/logo`, and `GET /stores/{id}/logo`.
- (a) Invalid body: `PATCH /staff/{id}` with `{"roles":[]}` answers **400 `validation_failed` for a made-up id but
  404 `not_found` for a real staff id of another business** (`f3.cjs`; stores behave the same for both). An attacker
  would first need a real foreign UUID.
- (b) Audit: the 6 foreign staff ids requested through `POST /staff/{id}/password-reset` left **0**
  `access.denied_tenant` entries in the caller's history, while a made-up staff id and foreign store logos do
  (`f4.cjs`: 6 requests, 0 entries; 2 logo requests, 2 entries). `request_context.not_found_in_tenant` says both cases
  "must not be told apart" and are "recorded as `access.denied_tenant`".
- Not root-caused here; the 404 for foreign staff ids happens before the staff handler's validation and audit code.
- **Fixed** (security.md F-16): the two PATCH routes now find the record in the business before checking the body; tests `tests/isolation/test_uniform_answers.py` (58); the password-reset audit gap did not reproduce in code and is pinned by a test.

**P3 — Quickstart wording that does not match the app** (informational): step 1.5 expects "link no longer valid" but
a used link says "This link was already used" (a revoked/expired one says "no longer valid"); step 3.4 asked to "remove the sales role" but a person must keep one role.
Step 3.4 is corrected in `quickstart.md` (below); 1.5 was left alone because the spec text (`spec.md`) is the decider.

**P4 — The service worker only registers in production builds** (informational):
`frontend/src/components/ServiceWorkerRegistrar.tsx` skips registration when `NODE_ENV !== "production"`. The
Docker development stack and `next dev` therefore have a manifest but no service worker, so quickstart 5.4 on that stack
depends on the browser installing from the manifest alone. On the production build the worker was `active`. Not checked:
whether Edge/Chrome offers the install on `localhost` without a worker.

**P5 — A rejected logo does not stop the store from being saved** (informational, UX): the form shows the clear message
when the file is chosen, but "Save store" stays enabled and creates the store **without** a logo and without a second message
(`follow-notes.json`: stores 1 -> 2 -> 3). Matches "refused with clear messages"; noted because it leaves a store the
owner may think has a logo.
- **Fixed**: a refused logo now blocks "Save store" like any other field ("1 thing to fix", focus on Choose logo with the message), and Remove logo clears it to save without one; tests in `tests/stores/new.test.tsx`.

## Documentation fixes

In `specs/001-platform-foundation/quickstart.md` only:
1. Scenario 2: the note "Until the History screen exists in User Story 4, read history through `GET /api/v1/audit`" was
   out of date; it now says the History screen is under More (owners only) and the API returns the same entries.
2. Scenario 3 step 4: "remove the sales role ... tap anything" now reads "change the sales agent's role from Sales to
   Packing (a person always keeps at least one role) ... do something that asks the server (open Devices, save a
   setting)". The expectation ("tabs change on that next action") is unchanged and is what P1 reports against.
3. Prerequisites: added a pointer to the README's "Run on the development PC without Docker" for machines without Docker.

## Not checked

- Real phone: touch use, real mobile data timings, installing to the home screen (needs HTTPS on staging), Chrome.
- The Docker Compose path: image build, `docker compose exec` commands, Mailpit-captured email, the web port 3000.
- Installing from the browser menu (only manifest, icons and the worker were checked); `beforeinstallprompt`.
- A person timing SC-001 and SC-002; all human times above are estimates.
- Double submission by hand (SC-007) and the password-reset flows from the screens; operator suspend/reactivate by hand.
- Which statement in P2 explains the 404 for foreign staff ids (code path not traced).

## Left behind

The development database now holds the businesses this run created ("T090 Warm ...", "Test Merchant ...", "T090 Follow ...",
"T090 F3 ...", "T090 F4 ..." plus the Playwright `E2E Business ...` rows) and their users and invitations;
the two demo businesses were only read (plus the demo owner's own sign-in sessions and the sign-in history entries that come with them).
Everything started was stopped: API (5100), web (3400, 3410), PostgreSQL via `local_db.py stop`; no Edge process remains.
The user's dev server on 3100 was not touched. Nothing was committed.

## T091 — M0 against the Definition of Done

Reviewed 2026-11-14 on commit `0304d7f`, against the constitution ("Development Workflow & Quality Gates") and section 11 of
the product brief, plus the M0 exit gate in brief section 9.2 ("Multi-tenant isolation tests pass").

| Gate | Status | Evidence / gap |
|---|---|---|
| M0 exit gate: multi-tenant isolation tests pass | **Met** | Backend 1032 tests incl. `tests/isolation/` (RLS, scoped functions, route-coverage harness, uniform answers for foreign ids); security.md: no critical findings |
| Spec, plan, tasks: no unresolved critical contradictions | **Met, with two deviations to record** | `speckit-analyze` before implementation; deviations kept in tasks.md: T021 (ORM models) not built, plain SQL used throughout (plan still mentions models); T036's Playwright CI job not added |
| Migrations and rollback documented; tests executed | **Met** | `0001_platform_foundation.py` with `downgrade()`; README "Migrations" and `backend/migrations/README.md`; every test run upgrades then downgrades to base (`tests/conftest.py`) |
| Endpoints validated and permission-enforced; no cross-tenant leakage | **Met** | Contract tests validate every response against `openapi.yaml` and fail on unlisted routes; permission and store-scope tests; `access.denied_*` audit. Open security items below are not leaks of another business's data |
| Mobile flow demonstrated in Arabic and English | **Partly met** | Automated and scripted on a 360×740 phone viewport in both languages (Playwright 18/18, T090 scenarios 1–5). **Not yet shown on a real phone by a person**, and the Arabic wording has not been read by a native speaker |
| Error, loading, empty states and recoverability | **Met** | ux-pass.md; a11y e2e "errors and offline" (load error, offline notice, failed save, 0 axe violations); session-ended state (P1) |
| Audit events for stock, financial and permission changes | **Met for M0** | Role, store-access, deactivation, invitation, sign-in/session, store and settings changes (`user.roles_changed`, `user.deactivated`, `store.*`, `tenant.settings_changed` incl. the USD/LBP rate and delivery fee). No stock or money records exist yet (M1/M3) |
| Operational logs and failure/retry visible | **Met for M0** | Request log with request id (path only, no secrets), error log, mailer failures; failed saves and offline shown to the person. No monitoring yet (M7) |
| README: startup, env template, seed, demo sign-in, tests | **Met** | README sections Configuration, Run with Docker / without Docker, Migrations, Demo data and demo sign-ins, Operator account, Tests, Phone demo |
| No credentials or customer data committed | **Met** | Only `.env.example` tracked; history scan clean (security.md item 25) |
| Scope within the milestone | **Met** | No catalog, orders, WhatsApp, AI or WooCommerce code; additions beyond tasks were fixes found by reviews (security headers, server rendering for SC-009, open-app access) |
| CI (an M0 deliverable) | **Not met** | `.github/workflows/ci.yml` exists (backend lint, format, mypy, pytest; frontend lint, typecheck, unit tests) but has **never run**: there is no remote repository. No Playwright job |
| Docker Compose path | **Not checked since day 1** | Backend container verified 2026-11-10; the `web` image never built on this network (T001/T003/T006/T008 stay open for that reason). All later work ran on the no-Docker path |

### Open items for the product owner

Decisions:
1. **F-04** (Medium): **Fixed** 2026-11-14 (T092, `6af7b7c`): the same work happens before the answer for every address; lookup and email after it; 10 reset requests per client address per hour.
2. **F-09** (Low): **Fixed for email** 2026-11-14 (T093): an employee invitation by email needs a 6-digit code sent to that address before acceptance answers anything (research R37). Phone invitations and owner activations keep the residual until BOS can message phones.
3. **Real-phone check**: a person signs in on a real phone in both languages (SC-001/002 timed by hand, SC-006, SC-009 on real mobile data, install to home screen). SC-009 met only on the simulated mobile profile (0.92–1.2 s).
4. **CI**: create the GitHub remote so CI runs (and add the Playwright job), or accept local runs as the M0 evidence.

Carried forward (no decision needed now; target milestone in brackets):
- F-08 production serving (gunicorn behind TLS) and F-12 SMTP STARTTLS [M7, before any live use].
- F-11 refuse a weak or `CHANGE_ME` secret key at start-up, and refuse the development-only `BOS_MAIL_OUTBOX_DIR` (added with T093) outside development; F-15 larger common-password list [M1, small].
- F-10 dev-only npm advisories in the lint chain [routine update].
- F-06 follow-up: rotate the local secret key and database password used during development [before any shared deploy].
- `me.stores` can go stale in an open app until the next screen change [M1, with catalog store filters].
- Development database holds e2e and run-through test businesses [clean-up script, M1].
- History filter arrow keys (F12) [M1]; P3 wording "already used" vs "no longer valid"; P4 no service worker under `next dev` (by design).
- tasks.md housekeeping: close T021 as "not built by design" and update plan.md; T001/T003/T006/T008/T036 close when the Docker web image builds and CI runs.

**Recommendation:** approve the M0 exit gate with items 1–2 now fixed and items 3–4 scheduled; none blocks M1 work, which adds no
public sign-in surface. Exit-gate approval: _pending product owner_.
