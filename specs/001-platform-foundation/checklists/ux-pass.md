# M0 accessibility and RTL pass (T087)

**Date**: 2026-11-12
**Scope**: every M0 screen, in `en` and `ar`, on a 360×740 viewport (Microsoft Edge through Playwright)
**Method**: automated (axe-core 4.x via `@axe-core/playwright`, WCAG 2.2 A/AA + best-practice rules,
light and dark colour scheme; a scripted keyboard walk on every screen; token contrast computed from
`src/styles/tokens.css`) and manual review of every screen component, the shared components and the
CSS. Reference rules: WCAG 2.2 AA and the `ui-ux-pro-max` accessibility/touch/forms rules
(contrast 4.5:1, 44×44 targets with 8px spacing, focus rings, visible labels, error next to the field,
`focus-management`: focus the first invalid field after a failed submit, reduced motion).

## Automated checks (what `e2e/a11y.spec.ts` does)

The spec signs a fresh business up through the operator API (like the other stories), then visits each
screen below in the project's language and on each one:

1. **axe** with tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice` in light mode, and the
   `color-contrast` rule again with `prefers-color-scheme: dark` (the Next dev overlay is excluded).
   Serious or critical findings fail the test; all findings are printed as `a11y <locale> <screen>: …`.
2. **Keyboard walk**: from the top of the page, Tab through every focusable element until focus comes
   back to the first; each must show an outline or focus ring (fails the test otherwise) and is
   measured against 44×44 px (inline links in running text excepted).
3. **Page title**: every route's `<title>` is `<screen> · BOS`.
4. **Sheets** (history event filter, history person filter, devices confirm, profile password): opened
   from the keyboard; must be `role="dialog"`, `aria-modal`, named; 12 Tabs never leave it; Escape closes
   it and focus returns to the button that opened it.
5. **Errors**: sign-in submitted empty → the identifier field is `aria-invalid`, described by its error
   and focused; invite submitted empty → summary alert; axe re-run on both.
6. **Failure states**: Settings with `/api/v1/business` aborted (load error), Profile saved with the
   network off (offline notice + "didn't go through" alert); axe re-run on both.
7. **Security headers** (review finding F-03, added to this spec on request): a page, the manifest,
   `sw.js` and a forwarded `/api/v1/health` answer all carry the five headers.

## Results by screen

Legend: ✅ pass · 🔧 failed and fixed in this pass · ➖ not applicable. "axe" = no serious/critical
finding (light, dark contrast). "Focus" = every focusable element shows a focus indicator. "Names" =
every field labelled, every icon-only control named. "Targets" = interactive targets ≥ 44×44 px.
"RTL" = layout mirrors, directional icons flip, numbers/phones/dates isolated. "Structure" = one
`h1`, `main` landmark, page title.

| Screen | axe | Focus | Names | Contrast (light/dark) | Targets | RTL | Structure |
|---|---|---|---|---|---|---|---|
| Sign-in (+ errors, offline notice) | ✅ | ✅ | ✅ | 🔧 field borders | ✅ | ✅ | 🔧 title, main; 🔧 error focus |
| Password reset — request / sent | ✅ | ✅ | ✅ | 🔧 field borders | ✅ | ✅ | 🔧 title, main, two `h1` |
| Password reset — new password / done | ✅ | ✅ | ✅ | 🔧 field borders | ✅ | ✅ | 🔧 title, main, two `h1`; 🔧 error focus |
| Activation / invitation (+ link invalid / used) | ✅ | ✅ | ✅ | 🔧 field borders | ✅ | ✅ | 🔧 title, main; 🔧 error focus |
| Operator sign-in | ✅ | 🔧 ring on dark bar | ✅ | 🔧 field borders | ✅ | ✅ | 🔧 title, main; 🔧 error focus |
| Operator businesses list (+ suspend sheet) | ✅ | 🔧 ring on dark bar | ✅ | ✅ | ✅ | ✅ | 🔧 title, main |
| Operator new business / one-time link | ✅ | 🔧 ring on dark bar | ✅ | 🔧 field borders | ✅ | ✅ (link box `ltr`) | 🔧 title, main |
| Shell: Sales / Packing / Delivery / Orders (coming soon) + tab bar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔧 title, main |
| More | 🔧 target-size | ✅ | ✅ | ✅ | 🔧 (row under tab bar) | ✅ | 🔧 title, main |
| Employees list | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔧 title, main |
| Invite (+ errors, one-time link) | ✅ | ✅ | ✅ | 🔧 field + tick-box borders | ✅ | ✅ | 🔧 title, main |
| Employee detail (+ deactivate sheet) | ✅ | ✅ | ✅ | 🔧 tick-box borders | ✅ | ✅ | 🔧 title, main |
| Invitation detail (+ revoke sheet) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔧 title, main |
| Stores list | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔧 title, main |
| New store / store detail / edit + logo | ✅ | ✅ | 🔧 upload progress bar | 🔧 field borders | ✅ | ✅ | 🔧 title, main |
| Store deactivation sheet | ✅ (component tests) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Settings (+ load error) | ✅ | ✅ | ✅ | 🔧 field borders | ✅ | ✅ (rate `ltr`) | 🔧 title, main |
| History (+ event and person filter sheets) | ✅ | ✅ | ✅ | 🔧 radio rings | ✅ | ✅ (times `bdi`) | 🔧 title, main |
| Devices (+ confirm sheet) | ✅ | ✅ | ✅ | ✅ | ✅ | 🔧 sign-out arrow | 🔧 title, main |
| Language | ✅ | ✅ | ✅ | 🔧 radio rings | ✅ | ✅ | 🔧 title, main |
| Profile (+ password sheet, offline failed save) | ✅ | ✅ | ✅ | 🔧 field borders | ✅ | ✅ (phone `bdi`/`ltr`) | 🔧 title, main |
| Change password (+ done) | ✅ | ✅ | ✅ | 🔧 field borders | ✅ | ✅ | 🔧 title, main, two `h1` |
| Install card | ✅ (static) | ✅ | ✅ (region named) | ✅ | ✅ (44 px buttons) | ✅ | ✅ |
| Loading / error / empty states | ✅ | ✅ | ✅ (`role=status` / `alert`) | ✅ | ✅ | ✅ | ✅ |

Not reachable by the spec and reviewed in code only: store deactivation sheet (appears only when
employees lose their last store), operator suspend/reactivate sheets, the one-time-link screens,
install card (needs `beforeinstallprompt`), logo upload progress. All use the shared `Sheet`, `Button`,
`Banner` and `Field` components that the spec does reach; `tests/components/Sheet.test.tsx` covers the
dialog role, name, focus in, Tab trap, Escape and focus return.

Global checks: `<html lang dir>` set per locale (`ltr`/`rtl`) ✅; dark mode supported through
`prefers-color-scheme` and `data-theme` (tokens.css) ✅; `prefers-reduced-motion` disables animations and
transitions (`base.css`) ✅; no information by colour alone (chips, tab bar, banners all carry text or
icons + `aria-current` / `aria-checked`) ✅; no physical `left`/`right` CSS left ✅; no horizontal scroll at
360 px (covered by `us4-shell.spec.ts`) ✅.

## Token contrast (computed from `src/styles/tokens.css`)

Text pairs, required 4.5:1 — all pass in both schemes:

| Pair | Light | Dark |
|---|---|---|
| `--fg` on `--bg` / `--surface` / `--surface-2` | 17.06 / 17.85 / 16.30 | 17.09 / 15.54 / 13.56 |
| `--fg-2` (muted) on `--bg` / `--surface` / `--surface-2` | 7.24 / 7.58 / 6.92 | 8.53 / 7.76 / 6.77 |
| `--on-accent` on `--accent` (primary button) | 5.48 | 7.71 |
| `--on-ink` on `--ink` (ink button, operator bar, selected pill) | 14.63 | 14.48 |
| ok / warn / bad / info chip & banner (`-fg` on `-soft`) | 6.78 / 6.37 / 6.80 / 7.15 | 8.17 / 9.06 / 7.82 / 7.71 |
| store A / store B chips | 8.06 / 6.38 | 9.28 / 8.03 |
| `--danger` on `--surface` (danger button) | 6.47 | 6.16 |
| `--danger-fg` on `--bg` / `--surface` (field errors) | 7.94 / 8.31 | 9.86 / 8.97 |

UI component boundaries and focus indicators, required 3:1:

| Pair | Light | Dark | Result |
|---|---|---|---|
| `--accent` focus ring on `--surface` / `--bg` | 5.48 / 5.24 | 8.86 / 9.74 | ✅ |
| `--accent` focus ring on `--ink` (operator app bar) | 2.67 | 1.56 | 🔧 F5 → `--on-ink` ring, 14.6 / 14.5 |
| `--border-strong` field/tick-box/radio outline on `--surface` / `--bg` | 1.48 / 1.42 | 1.92 / 2.11 | 🔧 F3 → new `--control-border` |
| `--control-border` (new: `#7C8BA1` light, `#64748B` dark) on `--surface` / `--bg` / `--surface-2` | 3.46 / 3.31 / 3.16 | 3.58 / 3.93 / 3.12 | ✅ |
| `--danger` invalid-field border | 6.47 | 6.16 | ✅ |
| `--accent-soft` focus halo around fields | 1.13 | 1.37 | ➖ decorative; the border turns `--accent` and the 2px outline is drawn too |

`--border-strong` stays as it was for ghost buttons, pills and the sheet grab handle: those carry text, so
their outline is not what identifies them (WCAG 1.4.11 does not require it).

## Findings

| ID | Severity | Where | Finding (WCAG) | Fix |
|---|---|---|---|---|
| F1 | Serious | all routes | Every route had the same `<title>` ("BOS — Beta Orders Solutions"), so tabs, history and screen-reader page announcements could not tell screens apart (2.4.2, A) | `src/lib/metadata.ts` `titleFrom(key)`; every `page.tsx` exports `generateMetadata = titleFrom(…)` from existing translation keys (new `meta.activate` key in `messages/en.json`, `ar.json`); `app/[locale]/layout.tsx` title template `%s · BOS`. Tests: `tests/a11y/a11y-pass.test.tsx`, title asserted in the e2e spec |
| F2 | Serious | text fields, tick boxes, radios, all screens | Control outlines `--border-strong` 1.48:1 light / 1.92:1 dark against the page; the outline is the only thing that shows where a field is (1.4.11, AA) | New token `--control-border` (light `#7C8BA1`, dark `#64748B`) in `src/styles/tokens.css`, used by `components/Field.module.css`, `more/account.module.css` (radio), `more/language/language.module.css` (radio), `more/employees/employees.module.css` (tick box). Slightly darker outline; the approved look is otherwise unchanged |
| F3 | Moderate | sign-in, operator sign-in, reset (request + new password), activation | Field errors appeared silently: no summary alert on these forms and focus stayed on the submit button, so screen-reader users were not told (3.3.1, 4.1.3); others forms already have a summary `role="alert"` | `src/lib/focus.ts` `useFocusFirstInvalid()`: after a failed submit (client check or `invalid_credentials` / `weak_password`) focus moves to the first `aria-invalid` field, which reads its label and linked error. Wired into `SignInForm.tsx`, `OpsSignInForm.tsx`, `ResetForm.tsx`, `ActivateForm.tsx`. Unit tests in `tests/a11y/a11y-pass.test.tsx`; e2e asserts it on sign-in |
| F4 | Moderate | operator screens (dark app bar) | Accent focus ring on the `--ink` bar: 2.67:1 light, 1.56:1 dark (2.4.7 / 1.4.11) | `components/AppBar.module.css`: `.ops :focus-visible { outline-color: var(--on-ink) }` |
| F5 | Moderate | all screens | No `main` landmark anywhere (1.3.1, axe `landmark-one-main` / `region`) | `components/Screen.tsx`: `Screen` renders `<main>` (tests: `tests/a11y/a11y-pass.test.tsx`) |
| F6 | Serious (axe) / Moderate | More (both languages); any screen with the tab bar or a sticky footer | axe `target-size`: the last More row (Language) sat half under the sticky tab bar; keyboard focus could likewise land on an element hidden under the tab bar or a sticky form footer (2.4.11, 2.5.8) | `src/styles/base.css`: `html { scroll-padding-block-end: 96px }` so focused/scrolled-to elements stop above the bars; the spec checks targets with the page scrolled to the end (where the bar is in its own place) |
| F7 | Moderate | logo upload | The upload `role="progressbar"` had no accessible name (4.1.2; axe `aria-progressbar-name`) — not reachable in the e2e run | `more/stores/LogoField.tsx`: `aria-label` = the field label ("Logo") |
| F8 | Minor | reset sent/done, change-password done, employee/store/settings/history not-allowed and load-error screens | Two `h1`s: the app bar title and the status heading (best practice, `page-has-heading-one`/heading order) | `components/Screen.tsx` `StatusHeader` is `h2` by default, `level={1}` only on the link screens without an app bar (`components/LinkScreens.tsx`) |
| F9 | Minor | Devices (ar) | The "sign out all other devices" arrow pointed right in RTL (directional icon not mirrored) | `more/devices/DevicesScreen.tsx` + `.flipRtl` in `more/account.module.css` |
| F10 | Minor | password fields | `PasswordField` dropped an `aria-describedby` passed by the caller (unlike `Field`) | `components/PasswordField.tsx` merges it |
| F11 | Minor | one-time link box | Physical `text-align: left` (the box is `direction: ltr`, so no visible change) | `components/OneTimeLink.module.css`: `text-align: start` |
| F12 | Minor | History filter sheets | Options are `role="radio"` buttons that are each a Tab stop; arrow keys do not move between them as the ARIA radio-group pattern describes | **Not fixed**: fully operable by Tab/Enter, names and `aria-checked` are right; adopting roving focus is a behaviour change for the approved sheet — candidate for the shared `SegmentedControl`-style keyboard handling in M1 |
| F13 | Minor | shell start-up | The session check's loading/error states (`SessionGuard`) render outside a `main` landmark | **Not fixed**: transient (≤ one request) and announced through `role="status"`/`role="alert"` |
| F14 | Info | fields | The 3px `--accent-soft` focus halo is 1.13:1 / 1.37:1 | **No fix needed**: supplementary; the field border turns `--accent` (≥5.2:1) and the global 2px outline is drawn |
| F15 | Info | dark mode | Dark tokens exist and were checked; no in-app theme switch (follows the system). `theme-color` meta is the light accent in both schemes | Recorded only |

Count by severity: **Serious 3** (F1, F2, F6 as reported by axe), **Moderate 4** (F3, F4, F5, F7),
**Minor 6** (F8–F13), **Info 2** (F14, F15). Fixed: 11. Not fixed (with reason): F12, F13; no fix
needed: F14, F15.

## Tool output summary

First run of `e2e/a11y.spec.ts` (after the static fixes F1–F5, F7, F8 were already in): every screen
clean except one finding per language —

```
a11y en more (light): target-size[serious] x1 (a[href$="language"])
a11y en summary: 1 axe violations; 0 focus problems; 0 targets under 44px
a11y ar more (light): target-size[serious] x1 (a[href$="language"])
a11y ar summary: 1 axe violations; 0 focus problems; 0 targets under 44px
```

→ F6. Final run (full suite, after F6): **0 axe violations of any impact, 0 focus problems, 0 targets
under 44 px** in both languages —

```
a11y en summary: 0 axe violations; 0 focus problems; 0 targets under 44px
a11y ar summary: 0 axe violations; 0 focus problems; 0 targets under 44px
```

## Final verification

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | 0 errors / 0 problems |
| `npx vitest run` | `554 passed` (47 files), incl. `tests/a11y/a11y-pass.test.tsx` (6) and `tests/security-headers.test.ts` (2) |
| `npx playwright test` (Edge, 360×740) | **10 passed** (19.5 min): the 8 existing US1–US4 stories in `en` and `ar` + `e2e/a11y.spec.ts` in `en` (4.9 min) and `ar` (4.5 min) |

`e2e/a11y.spec.ts` stays in the suite; it ran green in the full run. It adds about 9–10 minutes on the
development disk. `e2e/global-setup.ts` now also warms `/reset` and the invitation-detail route.

Also done in this pass, at the security review's request (F-03 in `security.md`, not edited here):
`frontend/next.config.ts` `headers()` sends `Content-Security-Policy: frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin` and
`Permissions-Policy: camera=(), microphone=(), geolocation=()` on every route. Unit test
`tests/security-headers.test.ts`; the e2e spec requests `/<locale>/sign-in`, `/manifest.webmanifest` and
`/sw.js` from the test server and checks all five, and checks `/api/v1/health` still answers 200 through
the rewrite. Answers proxied to the API keep the API's own headers (Next does not add config headers to
proxied external rewrites); the API sets `nosniff` and `no-store` itself (F-02).
