# Quickstart: Validating Platform Foundation (M0)

How to run M0 locally and prove it works end to end. Commands are the intended ones; they
become real when the tasks are implemented. Details of endpoints and tables are in
[contracts/openapi.yaml](contracts/openapi.yaml), [contracts/permissions.md](contracts/permissions.md)
and [data-model.md](data-model.md).

## Prerequisites

- Docker Desktop (Compose v2)
- Git
- Nothing else: Python and Node run inside containers.

## Start

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

```bash
docker compose exec api flask db upgrade
```

```bash
docker compose exec api flask bos seed-demo
```

```bash
docker compose exec -e BOS_OPERATOR_PASSWORD api flask bos create-operator --email ops@example.test
```

The operator password is read from the `BOS_OPERATOR_PASSWORD` environment variable, so it
never appears in the command line or shell history.

| Service | Address |
|---|---|
| Web app | http://localhost:3000 |
| Operator area | http://localhost:3000/ops |
| API | http://localhost:3000/api/v1 (proxied; the API and database publish no ports of their own) |
| Captured email (Mailpit) | http://localhost:8025 |

Demo sign-ins are listed in `.env.example` (one user per role in the demo business).

## Automated checks

```bash
docker compose exec api pytest
```

```bash
docker compose exec api pytest tests/isolation -q
```

```bash
docker compose exec web npm test
```

```bash
docker compose exec web npx playwright test
```

Expected: all pass. The isolation suite must report one or more cases for **every** registered
route; a route with no isolation case fails the suite by design.

## Manual validation scenarios

Run each on a phone-sized window (360 px wide), once in English and once in Arabic.

### 1. Business setup and owner activation (User Story 1)

1. Sign in at `/ops` as the operator. Create a business "Test Merchant" with store "Main",
   edition BOS Social, and an owner phone number.
2. Copy the activation link shown. Confirm it is not shown again after leaving the page.
3. Open the link in a private window. Set a password and choose Arabic.
4. **Expect**: land on the home shell of "Test Merchant" in Arabic, right-to-left.
5. Open the same link again. **Expect**: "link no longer valid".
6. Sign out, then sign in using the phone number typed in a different format (for example
   with and without `+961`). **Expect**: success both ways.
7. Enter a wrong password six times, then the correct one. **Expect**: the same generic
   message every time, including for the correct password while the 15-minute block lasts;
   the message never says whether the account exists or that it is blocked.
8. In the operator area, open "Test Merchant". **Expect**: only name, edition, status, owner
   contact and counts. No staff list, no settings, no history.
9. As the operator, set up another business using the same owner phone number. **Expect**:
   refused, because a phone number identifies one user across BOS.

### 2. Isolation between businesses (User Story 1, SC-003)

1. Sign in as the demo owner in one browser and as the "Test Merchant" owner in another.
2. Copy a store ID and a staff member ID from the demo business (from the address bar or
   network tab).
3. As the "Test Merchant" owner, request those IDs directly.
4. **Expect**: "not found" for every one, identical to a made-up ID. The demo owner's history
   shows nothing about "Test Merchant"; "Test Merchant" history shows `access.denied_tenant`.
   (Until the History screen exists in User Story 4, read history through `GET /api/v1/audit`.)

### 3. Employees, roles and store access (User Story 2)

1. As the demo owner, invite a sales agent limited to Store A and a packing agent for both
   stores. Open each link in a separate private window and set passwords.
2. **Expect**: the sales agent opens on Sales and sees only Store A; the packing agent opens
   on Packing and sees both stores. Neither sees Employees or Settings under More.
3. As the sales agent, call the staff list endpoint directly. **Expect**: refused, and the
   refusal appears in the owner's history.
4. As the owner, remove the sales role from the sales agent. Without refreshing, have the
   sales agent tap anything. **Expect**: their tabs change on that next action.
5. Deactivate the packing agent. **Expect**: their next action sends them to sign-in.
6. Try to deactivate the only owner. **Expect**: refused with an explanation.
7. Sign in as a manager and try to change the owner's roles. **Expect**: refused.
8. Invite someone, then revoke before they accept; open the link. **Expect**: no longer valid.
9. Invite someone using a phone number that already belongs to a user of the *other* demo
   business. **Expect**: the invitation is created with no warning; opening the link and
   setting a password is refused with a neutral "use a different phone number or email".
10. As a manager, try to change your own roles. **Expect**: refused.

### 4. Stores and settings (User Story 3)

1. As the owner, add a store with a WhatsApp number typed as `70 000 111`, and upload a logo.
2. **Expect**: the number is stored and shown as `+961 70 000 111`; the logo displays.
3. Add another store with the same number. **Expect**: refused as already in use.
4. Upload a 5 MB file and a PDF as a logo. **Expect**: both refused with clear messages.
5. Change the exchange rate and default delivery fee. **Expect**: saved, and the history shows
   who changed what, with old and new values.
6. Deactivate a store that has employees. **Expect**: a warning listing them before confirming.

### 5. Shell, language and install (User Story 4)

1. Sign in as owner, sales agent and packing agent. **Expect**: tabs and starting tab match
   [contracts/permissions.md](contracts/permissions.md).
2. Switch language in More. **Expect**: immediate change of text and direction; still applied
   after signing out and in on another browser.
3. Open tabs that later milestones fill. **Expect**: a clear "coming soon" state, not an error.
4. Install the app from the browser menu on `localhost` (desktop Chrome with a phone-sized
   window). **Expect**: app icon; opens in its own window. Installing on a real phone needs
   HTTPS and is checked on staging, not in local development.
5. Turn off the network and try to save a setting. **Expect**: a clear failure message and the
   value not shown as saved.

## Exit gate for M0

- All automated checks above pass, with output captured.
- Scenarios 1–5 demonstrated in both languages.
- `README.md` documents startup, environment template, seed data, demo sign-ins and test
  commands.
- No secrets or real customer data in the repository.

## Demonstrating on a real phone (development only)

Set `BOS_WEB_BIND=0.0.0.0` and keep `BOS_COOKIE_SECURE=false` in `.env`, restart the web
service, and open `http://<this-PC's-LAN-address>:3000` on a phone on the same network.
Never use these two settings outside local development.
