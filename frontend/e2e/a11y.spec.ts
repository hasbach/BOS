import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import type { RunOptions } from "axe-core";
import { createTranslator } from "next-intl";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import { createBusinessApi, expect, me, newApi, newContext, operatorSignInApi, operatorSignInUi, rebase, test, text, unique, uniquePhone, userSignInApi } from "./fixtures";
import type { E2eEnv } from "./env";
import type { Locale, NewBusiness } from "./fixtures";
import { catalogWorld, escapeRegExp } from "./m1-fixtures";
import type { ProductPage } from "../src/lib/catalog";

// Task T087: the accessibility pass over every M0 screen, in the language of the project (en, ar), at
// 360 x 740. On each screen: axe (WCAG 2.2 A/AA and best practice) in light mode, axe colour contrast
// again in dark mode, and a keyboard walk that tabs through every focusable element and checks it shows
// a focus indicator. Serious and critical axe findings and missing focus indicators fail the test;
// everything else is printed (one "a11y" line per screen) for specs/001-platform-foundation/checklists/ux-pass.md.

const OWNER_PASSWORD = "e2e-A11y-owner-4410";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

interface Finding {
  screen: string;
  id: string;
  impact: string;
  nodes: number;
  where: string;
}

const findings: Finding[] = [];
const focusProblems: string[] = [];
const smallTargets: string[] = [];

/** Waits until the screen has its heading and no loading state is left. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.locator('[role="status"]:has([class*="spinner"])')).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function axe(page: Page, screen: string): Promise<void> {
  // At the end of the page the sticky tab bar and footers sit in their own place, not over the content
  // (axe's target-size rule otherwise counts a row half under the bar as an overlapped target).
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const light = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await new AxeBuilder({ page }).withRules(["color-contrast"]).exclude("nextjs-portal").analyze();
  await page.emulateMedia({ colorScheme: "light" });
  for (const [mode, result] of [["light", light], ["dark", dark]] as const) {
    for (const v of result.violations) {
      findings.push({
        screen: `${screen} (${mode})`,
        id: v.id,
        impact: v.impact ?? "unknown",
        nodes: v.nodes.length,
        where: v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" | "),
      });
    }
  }
}

/**
 * Tabs through the screen (or the open sheet) and checks every element that takes focus shows an outline
 * or a focus ring, and is at least 44 x 44 px (inline links in running text excepted; those are listed).
 */
async function keyboardWalk(page: Page, screen: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen = new Set<string>();
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el.tagName.toLowerCase() === "nextjs-portal") return null;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const outlined = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
      const ring = style.boxShadow !== "none";
      const inlineText = el.tagName === "A" && style.display === "inline";
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("name") ?? el.tagName).trim().slice(0, 40);
      return {
        key: `${el.tagName}|${name}|${Math.round(rect.x + window.scrollX)}|${Math.round(rect.y + window.scrollY)}`,
        name: `${el.tagName.toLowerCase()} "${name}"`,
        visible: outlined || ring,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        inlineText,
      };
    });
    if (!info) continue;
    if (seen.has(info.key)) break; // back at the start: every element was visited
    seen.add(info.key);
    if (!info.visible) focusProblems.push(`${screen}: ${info.name} has no visible focus indicator`);
    if (!info.inlineText && (info.width < 44 || info.height < 44)) smallTargets.push(`${screen}: ${info.name} ${info.width}x${info.height}`);
  }
}

async function check(page: Page, screen: string, walk = true): Promise<void> {
  await settled(page);
  await axe(page, screen);
  if (walk) await keyboardWalk(page, screen);
}

async function visit(page: Page, locale: Locale, path: string, screen: string): Promise<void> {
  await page.goto(`/${locale}${path}`);
  await check(page, screen);
  // Every route names its own browser tab.
  await expect(page).toHaveTitle(/ · BOS$/);
}

/** Opens a sheet, checks it, closes it with Escape and checks focus went back to the opener. */
async function sheet(page: Page, opener: ReturnType<Page["getByRole"]>, screen: string): Promise<void> {
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toHaveAccessibleName(/.+/);
  await axe(page, screen);
  // Focus stays inside the sheet while tabbing.
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement)), `${screen}: focus left the sheet`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
}

function report(locale: string): void {
  const byScreen = new Map<string, Finding[]>();
  for (const f of findings) byScreen.set(f.screen, [...(byScreen.get(f.screen) ?? []), f]);
  for (const [screen, list] of byScreen) {
    console.log(`a11y ${locale} ${screen}: ${list.map((f) => `${f.id}[${f.impact}] x${f.nodes} (${f.where})`).join("; ")}`);
  }
  console.log(`a11y ${locale} summary: ${findings.length} axe violations; ${focusProblems.length} focus problems; ${smallTargets.length} targets under 44px`);
  for (const line of [...focusProblems, ...smallTargets]) console.log(`a11y ${locale} ${line}`);
}

// The pass is split into four tests (one screen group each, in each language project) so each has its
// own time budget: on the slow development machine every first page load of a signed-in screen is a
// server render of several seconds, and one walk over every screen came close to a single test's limit.
// Each test checks its own screens with the same rules and fails on its own serious findings.

const TEST_TIMEOUT_MS = 600_000;

test.beforeEach(() => {
  findings.length = 0;
  focusProblems.length = 0;
  smallTargets.length = 0;
});

/** The same verdict as before, for the screens of this test only. */
function verdict(locale: string, group: string): void {
  report(`${locale} [${group}]`);
  const blocking = findings.filter((f) => f.impact === "serious" || f.impact === "critical");
  expect(blocking, "serious or critical axe violations").toEqual([]);
  expect(focusProblems, "focusable elements without a visible focus indicator").toEqual([]);
}

interface Owner {
  page: Page;
  context: BrowserContext;
  business: NewBusiness;
  invitationId: string;
  userId: string;
  storeId: string;
}

/** A fresh business whose owner is signed in on a second device too and has one pending invitation. */
async function ownerSetup(browser: Browser, origin: string, env: E2eEnv, lang: Locale, contexts: BrowserContext[]): Promise<Owner> {
  const ops = await newApi(origin);
  await operatorSignInApi(ops, env);
  const business = await createBusinessApi(ops);
  await ops.dispose();
  const link = rebase(business.link, origin);

  const context = await newContext(browser, origin, []);
  contexts.push(context);
  const accepted = await context.request.post("/api/v1/invitations/accept", {
    data: { token: link.token, password: OWNER_PASSWORD, locale: lang },
  });
  expect(accepted.status(), "owner activation").toBe(200);
  const otherDevice = await newApi(origin);
  await userSignInApi(otherDevice, business.ownerPhoneInternational, OWNER_PASSWORD);
  await otherDevice.dispose();
  const invited = await context.request.post("/api/v1/staff/invitations", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { name: `E2E Invitee ${unique()}`, phone: uniquePhone().national, roles: ["sales"], all_stores: true },
  });
  expect(invited.status(), "invite").toBe(201);
  const invitationId = ((await invited.json()) as { invitation: { invitation_id: string } }).invitation.invitation_id;

  const page = await context.newPage();
  await page.goto(`/${lang}/more`);
  await settled(page);
  const mine = (await me(page)).body;
  if (!mine) throw new Error("no /me for the owner");
  return { page, context, business, invitationId, userId: mine.user.id, storeId: mine.stores[0]?.id ?? "" };
}

test("public pages and the operator console pass axe and show focus", async ({ browser, baseURL, env, locale }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const origin = baseURL ?? "";
  const lang = locale as Locale;
  const t = (key: string, values?: Record<string, string>) => text(lang, key, values);
  const contexts: BrowserContext[] = [];
  const context = async () => {
    const created = await newContext(browser, origin, []);
    contexts.push(created);
    return created;
  };

  try {
    // ---- Security headers (security review F-03) on a page and the PWA files ------------------------
    // Answers forwarded to the API by the /api/v1 rewrite keep the API's own headers (Next does not add
    // config headers to proxied answers); the API sets nosniff and no-store itself (F-02). The rewrite
    // must still work.
    const probe = await newApi(origin);
    for (const path of [`/${lang}/sign-in`, "/manifest.webmanifest", "/sw.js"]) {
      const response = await probe.get(path);
      expect(response.status(), path).toBe(200);
      const headers = response.headers();
      expect(headers["content-security-policy"], path).toBe("frame-ancestors 'none'");
      expect(headers["x-frame-options"], path).toBe("DENY");
      expect(headers["x-content-type-options"], path).toBe("nosniff");
      expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
      expect(headers["permissions-policy"], path).toBe("camera=(), microphone=(), geolocation=()");
    }
    expect((await probe.get("/api/v1/health")).status(), "/api/v1 rewrite").toBe(200);
    await probe.dispose();

    // ---- A fresh business; its owner link is opened (not yet used) in a signed-out browser ------------
    const ops = await newApi(origin);
    await operatorSignInApi(ops, env);
    const business = await createBusinessApi(ops);
    await ops.dispose();
    const link = rebase(business.link, origin);

    const visitor = await (await context()).newPage();
    await visitor.goto(`/${lang}/sign-in`);
    await check(visitor, "sign-in");
    await expect(visitor).toHaveTitle(/ · BOS$/);
    await visitor.getByRole("button", { name: t("auth.signIn.submit") }).click();
    // Errors: shown next to the field, linked to it, and focus moves to the first one.
    const identifier = visitor.getByLabel(t("auth.signIn.identifier"));
    await expect(identifier).toHaveAttribute("aria-invalid", "true");
    await expect(identifier).toBeFocused();
    await check(visitor, "sign-in with errors", false);
    await visit(visitor, lang, "/reset", "reset request");
    await visitor.goto(`/${lang}/reset#not-a-real-token`);
    await check(visitor, "reset new password");
    await visitor.goto(link.url);
    await expect(visitor.getByRole("button", { name: t("auth.activate.submit") })).toBeVisible();
    await check(visitor, "activation");
    await visitor.goto(`/${lang}/activate#not-a-real-token`);
    await check(visitor, "activation link invalid");

    // ---- Operator console ---------------------------------------------------------------------------
    const operator = await (await context()).newPage();
    await visit(operator, lang, "/ops/sign-in", "ops sign-in");
    await operatorSignInUi(operator, lang, env);
    await check(operator, "ops businesses");
    await visit(operator, lang, "/ops/new", "ops new business");
  } finally {
    for (const created of contexts) await created.close();
  }
  verdict(lang, "public and operator");
});

test("the owner's tab screens, More and Employees pass axe and show focus", async ({ browser, baseURL, env, locale }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const origin = baseURL ?? "";
  const lang = locale as Locale;
  const t = (key: string, values?: Record<string, string>) => text(lang, key, values);
  const contexts: BrowserContext[] = [];

  try {
    const { page: owner, invitationId, userId } = await ownerSetup(browser, origin, env, lang, contexts);
    for (const tab of ["sales", "packing", "delivery", "orders"]) await visit(owner, lang, `/${tab}`, `${tab} (coming soon)`);
    await visit(owner, lang, "/more", "more");
    await visit(owner, lang, "/more/employees", "employees");
    await visit(owner, lang, "/more/employees/invite", "invite");
    await owner.getByRole("button", { name: t("staff.form.submit") }).click();
    await expect(owner.getByRole("alert").first()).toBeVisible();
    await check(owner, "invite with errors", false);
    await visit(owner, lang, `/more/employees/${userId}`, "employee detail");
    await visit(owner, lang, `/more/employees/invitations/${invitationId}`, "invitation detail");
  } finally {
    for (const created of contexts) await created.close();
  }
  verdict(lang, "tabs and employees");
});

test("the owner's Stores, Settings, History, Devices, Language and Profile pass axe and keep sheets accessible", async ({ browser, baseURL, env, locale }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const origin = baseURL ?? "";
  const lang = locale as Locale;
  const t = (key: string, values?: Record<string, string>) => text(lang, key, values);
  const contexts: BrowserContext[] = [];

  try {
    const { page: owner, storeId } = await ownerSetup(browser, origin, env, lang, contexts);
    await visit(owner, lang, "/more/stores", "stores");
    await visit(owner, lang, "/more/stores/new", "new store");
    await visit(owner, lang, `/more/stores/${storeId}`, "store detail");
    await visit(owner, lang, "/more/settings", "settings");
    await visit(owner, lang, "/more/history", "history");
    await sheet(owner, owner.getByRole("button", { name: t("history.allEvents") }), "history event filter sheet");
    await sheet(owner, owner.getByRole("button", { name: t("history.everyone") }), "history person filter sheet");
    await visit(owner, lang, "/more/devices", "devices");
    await sheet(owner, owner.getByRole("button", { name: t("devices.signOutOthers") }), "devices confirm sheet");
    await visit(owner, lang, "/more/language", "language");
    await visit(owner, lang, "/more/profile/password", "change password");
    await visit(owner, lang, "/more/profile", "profile");
    await owner.getByLabel(t("profile.email"), { exact: true }).fill(`a11y-${unique()}@example.com`);
    await sheet(owner, owner.getByRole("button", { name: t("profile.save") }), "profile password sheet");
  } finally {
    for (const created of contexts) await created.close();
  }
  verdict(lang, "account and setup");
});

test("a load error, the offline notice and a save that did not go through pass axe", async ({ browser, baseURL, env, locale }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const origin = baseURL ?? "";
  const lang = locale as Locale;
  const t = (key: string, values?: Record<string, string>) => text(lang, key, values);
  const contexts: BrowserContext[] = [];

  try {
    const { page: owner, context: ownerContext, business } = await ownerSetup(browser, origin, env, lang, contexts);
    // The saved settings come in the server's HTML (SC-009). The browser loads them itself when the page
    // comes back from the router's cache (the Back button), and that request is the one cut here.
    await owner.goto(`/${lang}/more/settings`);
    await settled(owner);
    await owner.getByRole("link", { name: t("common.back") }).click();
    await expect(owner).toHaveURL(new RegExp(`/${lang}/more$`));
    await settled(owner);
    await owner.route("**/api/v1/business", (route) => route.abort());
    await owner.goBack();
    await expect(owner).toHaveURL(new RegExp(`/${lang}/more/settings$`));
    await expect(owner.getByRole("alert").filter({ hasText: t("settings.loadError.title") })).toBeVisible();
    await check(owner, "settings load error", false);
    await owner.unroute("**/api/v1/business");

    await owner.goto(`/${lang}/more/profile`);
    await settled(owner);
    await ownerContext.setOffline(true);
    await owner.getByLabel(t("profile.name"), { exact: true }).fill(`${business.ownerName} A`);
    await owner.getByRole("button", { name: t("profile.save") }).click();
    await expect(owner.getByRole("alert").filter({ hasText: t("ui.writeFailed").slice(0, 12) })).toBeVisible();
    await expect(owner.getByText(t("ui.offlineTitle"))).toBeVisible();
    await check(owner, "profile offline, save failed", false);
    await ownerContext.setOffline(false);
  } finally {
    for (const created of contexts) await created.close();
  }
  verdict(lang, "errors and offline");
});

// T106 uses separate checks/evidence so M0's findings and verdict don't change.
const M1_CONTROLS = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=radio], [role=checkbox], summary, [tabindex]';
// axe.run deep-merges built-in check options; axe.configure would replace them.
// RunOptions does not currently declare the per-check override accepted by axe.run.
const M1_CONTRAST = { 'color-contrast': { options: { contrastRatio: { large: { expected: 4.5 } } } } };

async function m1Keyboard(page: Page, root: Locator, dialog: boolean, label: string) {
  if (dialog) {
    await expect.soft(root, `${label}: initial dialog focus`).toBeFocused();
  } else {
    // Reset sequential navigation and leave all controls unfocused for the style baseline.
    await page.evaluate(() => {
      const start = document.createElement('span');
      start.tabIndex = -1;
      document.body.prepend(start);
      start.focus();
      start.remove();
    });
  }

  // Measure all rendered controls (including radio choices that are not Tab stops).
  const controls = await root.locator(M1_CONTROLS).evaluateAll((nodes) => nodes.flatMap((node, index) => {
    if (node.closest('nextjs-portal, [inert], [hidden]') || node.matches(':disabled, [aria-disabled=true]')) return [];
    const style = getComputedStyle(node);
    const { width, height } = node.getBoundingClientRect();
    if (style.visibility !== 'visible' || !width || !height) return [];
    const label = node.matches('input[type=checkbox], input[type=radio]') ? (node as HTMLInputElement).labels?.[0] : null;
    const target = label && label.contains(node) ? label.getBoundingClientRect() : { width, height };
    const description = node.getAttribute('aria-label') || label?.textContent?.trim() || node.textContent?.trim() || node.outerHTML.slice(0, 140);
    const inlineLink = node.matches('p a') && style.display === 'inline';
    const visuallyHiddenPicker = node.matches('input[type=file][tabindex="-1"]') && width <= 1 && height <= 1;
    if (visuallyHiddenPicker) return []; // the visible picker button is the interactive target
    return [{ index, description: description.slice(0, 140), tab: (node as HTMLElement).tabIndex >= 0, width: target.width, height: target.height, inlineLink,
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`, shadow: style.boxShadow }];
  }));
  const small = controls.filter((c) => !c.inlineLink && (c.width < 44 || c.height < 44));
  expect.soft(small.map(({ description, width, height }) => ({ description, width, height })), `${label}: targets below 44 × 44 CSS px`).toEqual([]);

  const expected = controls.filter((c) => c.tab).map((c) => c.index);
  expect.soft(expected.length, `${label}: keyboard controls present`).toBeGreaterThan(0);

  const seen: number[] = [];
  const missingFocus: string[] = [];
  let wrapped = false;
  for (let step = 0; step <= expected.length + 2; step += 1) {
    await page.keyboard.press('Tab');
    const focus = await root.evaluate((scope, selector) => {
      const active = document.activeElement;
      if (active === document.body) return null; // normal browser chrome stop between page cycles
      if (!active) return null;
      if (active.closest('nextjs-portal')) return { index: -2, visible: false, outline: null, shadow: null };
      const style = getComputedStyle(active);
      const outlined = !['none', 'hidden'].includes(style.outlineStyle) && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)';
      return {
        index: Array.from(scope.querySelectorAll(selector)).indexOf(active),
        visible: active.matches(':focus-visible'),
        outline: outlined ? `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}` : null,
        shadow: style.boxShadow === 'none' ? null : style.boxShadow,
      };
    }, M1_CONTROLS);
    if (!focus && !dialog) continue;
    // Next's development-only shadow UI is not an app control.
    if (!dialog && focus?.index === -2) continue;
    if (!focus || focus.index < 0) break;
    if (seen.includes(focus.index)) {
      wrapped = focus.index === seen[0];
      break;
    }
    seen.push(focus.index);
    const baseline = controls.find((c) => c.index === focus.index);
    const changed = baseline && ((focus.outline && focus.outline !== baseline.outline) || (focus.shadow && focus.shadow !== baseline.shadow));
    if (!focus.visible || !changed) missingFocus.push(baseline?.description ?? `control ${focus.index}`);
  }
  expect.soft(seen, `${label}: Tab follows the rendered control order without skipping controls`).toEqual(expected);
  expect.soft(wrapped, `${label}: Tab returns to the first control${dialog ? ' without leaving the dialog' : ''}`).toBe(true);
  expect.soft(missingFocus, `${label}: no visible keyboard focus indicator`).toEqual([]);
  if (dialog && wrapped && expected.length > 0) {
    await page.keyboard.press('Shift+Tab');
    const last = root.locator(M1_CONTROLS).nth(expected[expected.length - 1]!);
    await expect.soft(last, `${label}: reverse Tab wraps within the dialog`).toBeFocused();
    // Native focus scrolling can expose the button but leave its outer focus ring clipped.
    const bottom = await last.evaluate((element) => {
      const style = getComputedStyle(element);
      const outset = ['none', 'hidden'].includes(style.outlineStyle)
        ? 0 : Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
      const dialog = element.closest('[role="dialog"]')!;
      return {
        ring: element.getBoundingClientRect().bottom + outset,
        clip: Math.min(innerHeight, dialog.getBoundingClientRect().top + dialog.clientHeight),
      };
    });
    expect.soft(bottom.ring, `${label}: reverse Tab leaves the last focus ring inside the sheet viewport`).toBeLessThanOrEqual(bottom.clip);
  }
}

// Axe does not report the search placeholder, which supplies the visible search hint.
async function checkSearchPlaceholder(search: Locator, info: TestInfo, label: string) {
  const contrast = await search.evaluate((input: HTMLInputElement) => {
    if (input.value) return null;
    const placeholder = getComputedStyle(input, '::placeholder');
    const foreground = placeholder.color;
    const background = getComputedStyle(input).backgroundColor === 'rgba(0, 0, 0, 0)'
      ? getComputedStyle(input.parentElement!).backgroundColor
      : getComputedStyle(input).backgroundColor;
    const rgba = (color: string) => {
      const channels = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(color);
      if (!channels) throw new Error(`Expected an sRGB color, got ${color}`);
      return [Number(channels[1]), Number(channels[2]), Number(channels[3]), Number(channels[4] ?? 1)];
    };
    const bg = rgba(background);
    if (bg[3] !== 1) throw new Error(`Expected an opaque search background, got ${background}`);
    const fg = rgba(foreground);
    const alpha = fg[3]! * Number(placeholder.opacity);
    const blended = bg.slice(0, 3).map((channel, i) => alpha * fg[i]! + (1 - alpha) * channel);
    const luminance = (channels: number[]) => channels.slice(0, 3).reduce((sum, channel, i) => {
      const c = channel / 255;
      return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!;
    }, 0);
    const [bright, dim] = [luminance(blended), luminance(bg)].sort((a, b) => b - a);
    return { ratio: (bright! + 0.05) / (dim! + 0.05), foreground, background };
  });
  if (contrast) {
    await info.attach(`${label} search placeholder contrast`, { body: JSON.stringify(contrast), contentType: 'application/json' });
    expect.soft(contrast.ratio, `${label}: search placeholder contrast (${contrast.foreground} on ${contrast.background})`).toBeGreaterThanOrEqual(4.5);
  }
}

async function m1Audit(page: Page, info: TestInfo, locale: Locale, label: string, dialog?: Locator) {
  await settled(page);
  const html = page.locator('html');
  const scope = dialog ?? page.locator('body');
  await expect.soft(html).toHaveAttribute('lang', locale);
  await expect.soft(html).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  await expect.soft(page.getByRole('main')).toHaveCount(1);
  await expect.soft(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect.soft(page).toHaveTitle(/ · BOS$/);
  try {
    for (const mode of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: mode });
      const width = await scope.evaluate((node, modal) => ({
        viewport: window.innerWidth,
        page: document.documentElement.scrollWidth,
        dialog: modal ? node.scrollWidth - node.clientWidth : 0,
      }), !!dialog);
      expect.soft(width.viewport, `${label}: mobile viewport`).toBe(360);
      expect.soft(width.page, `${label} (${mode}): page has horizontal overflow`).toBeLessThanOrEqual(width.viewport);
      expect.soft(width.dialog, `${label} (${mode}): dialog has horizontal overflow`).toBeLessThanOrEqual(0);

      // Match M0's rule set, but enforce T106's 4.5:1 even for large text.
      const options: RunOptions & { checks: typeof M1_CONTRAST } = {
        checks: M1_CONTRAST,
        runOnly: mode === 'light' ? { type: 'tag', values: AXE_TAGS } : { type: 'rule', values: ['color-contrast'] },
      };
      const result = await new AxeBuilder({ page }).options(options).exclude('nextjs-portal').analyze();
      await info.attach(`${label} (${mode}) axe`, { body: JSON.stringify({ violations: result.violations, needsReview: result.incomplete }, null, 2), contentType: 'application/json' });
      const blocking = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'color-contrast');
      expect.soft(blocking.map((v) => ({ rule: v.id, nodes: v.nodes.map((n) => n.target) })), `${label} (${mode}): axe violations`).toEqual([]);
      const search = scope.getByRole('searchbox');
      if (!dialog && await search.count()) await checkSearchPlaceholder(search, info, `${label} (${mode})`);
      if (dialog) await dialog.focus();
      await m1Keyboard(page, scope, !!dialog, `${label} (${mode})`);
    }
  } finally {
    await page.emulateMedia({ colorScheme: 'light' });
  }
}

async function m1Sheet(page: Page, opener: Locator, name: string, info: TestInfo, locale: Locale) {
  await opener.press('Enter');
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  await expect.soft(dialog).toHaveAttribute('aria-modal', 'true');
  await expect.soft(dialog, `${name}: focus starts inside the sheet`).toBeFocused();
  await expect.soft(dialog.getByRole('button', { name: text(locale, 'ui.close') })).toBeVisible();
  await m1Audit(page, info, locale, name, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.soft(opener, `${name}: Escape restores focus to the opener`).toBeFocused();
}

test('T106 M1 catalog, stock and start tab accessibility at 360 px', async ({ browser, baseURL, env, locale }, info) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const world = await catalogWorld(browser, baseURL ?? '', env, locale);
  const { page, context } = world.owner;
  const t = createTranslator({ locale, messages: locale === 'ar' ? ar : en });
  const catalog = `/${locale}/more/catalog`;
  const audit = (label: string) => m1Audit(page, info, locale, label);
  await page.setViewportSize({ width: 360, height: 740 }); // catalogWorld creates its own context

  try {
    await page.goto(catalog);
    await expect(page.getByRole('heading', { name: t('catalog.empty.title') })).toBeVisible();
    await audit('Catalog empty');

    const response = await context.request.post('/api/v1/catalog/products', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: {
        code: 'A11Y-JEANS', name_en: 'Blue jeans · extra long', name_ar: 'جينز أزرق طويل جداً',
        store_ids: [world.storeA.id], photo_ids: [], options: [{ name: 'Size', values: [{ label: '30' }, { label: '32' }] }],
        variants: ['30', '32'].map((size, i) => ({ option_values: [size], sku: `A11Y-JEANS-${size}`, price: '89500000', currency: 'LBP', low_stock_level: 2, photo_id: null, opening_quantity: i ? 0 : 1 })),
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    const product = await response.json() as { id: string; variants: { id: string; sku: string }[] };
    const withStock = product.variants.find((variant) => variant.sku === 'A11Y-JEANS-30')!;
    const detail = `${catalog}/${product.id}`;

    await page.reload();
    const list = page.getByRole('list', { name: t('catalog.title') });
    await expect(list.getByText(t('catalog.stock.low'), { exact: true })).toBeVisible();
    const search = page.getByRole('searchbox', { name: t('catalog.search') });
    // Start from an empty search result so a server-seeded row can't satisfy the next wait.
    const searchFor = async (query: string) => {
      const [result] = await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === 'GET' && url.pathname === '/api/v1/catalog/products' && url.searchParams.get('q') === query;
        }),
        search.fill(query),
      ]);
      expect(result.ok(), `catalog search for ${query}`).toBe(true);
      return (await result.json() as ProductPage).items.map(({ id }) => id);
    };
    // Server-rendered rows can be visible before the search handler attaches.
    // Retry only this untimed setup; the actual SKU search must succeed once.
    await expect(async () => {
      await search.fill('');
      await search.fill('NO-A11Y-MATCH');
      await expect(page.getByRole('heading', { name: t('catalog.noMatch.title') })).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
    expect(await searchFor(withStock.sku)).toEqual([product.id]);
    const row = list.getByRole('link').and(page.locator(`a[href="${detail}"]`));
    await expect(row.getByText(t('catalog.stock.low'), { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: t('catalog.clearSearch') })).toBeVisible();
    await audit('Catalog populated with search');
    const stockGroup = page.getByRole('radiogroup', { name: t('catalog.stockFilter') });
    const all = stockGroup.getByRole('radio', { name: new RegExp(`^${escapeRegExp(t('catalog.filters.all'))}\\s`), checked: true });
    const inStock = stockGroup.getByRole('radio', { name: new RegExp(`^${escapeRegExp(t('catalog.filters.inStock'))}\\s`) });
    const [firstBox, nextBox] = await Promise.all([all.boundingBox(), inStock.boundingBox()]);
    expect.soft(firstBox && nextBox && (locale === 'ar' ? firstBox.x > nextBox.x : firstBox.x < nextBox.x), 'Stock options mirror in RTL').toBe(true);
    await all.press(locale === 'ar' ? 'ArrowLeft' : 'ArrowRight');
    await expect.soft(inStock).toBeFocused();
    await expect.soft(inStock).toHaveAttribute('aria-checked', 'true');
    await inStock.press('Home');
    await expect(all).toBeFocused();
    await m1Sheet(page, page.getByRole('button', { name: t('catalog.allStores'), exact: true }), t('catalog.storeMenu'), info, locale);
    await m1Sheet(page, page.getByRole('button', { name: t('catalog.moreFilters'), exact: true }), t('catalog.moreFilters'), info, locale);

    await page.goto(detail);
    const table = page.getByRole('table').first();
    await expect(table.getByText(t('catalog.stock.low'), { exact: true })).toBeVisible();
    await expect(table.getByText(t('catalog.stock.out'), { exact: true })).toBeVisible();
    await expect(table.getByText('A11Y-JEANS-30', { exact: true })).toHaveAttribute('dir', 'ltr');
    await audit('Product detail');
    await m1Sheet(page, page.getByRole('button', { name: t('catalog.detail.adjust'), exact: true }), t('catalog.adjust.title'), info, locale);

    await page.goto(`${detail}/variants/${withStock.id}/history`);
    await expect(page.getByText(t('catalog.reasons.opening'), { exact: true })).toBeVisible();
    await audit('Stock history');

    await page.goto(`${catalog}/new`);
    await expect(page.getByLabel(t('catalog.form.nameEn'), { exact: true })).toHaveAttribute('dir', 'ltr');
    await expect(page.getByLabel(t('catalog.form.nameAr'), { exact: true })).toHaveAttribute('dir', 'rtl');
    await audit('Create product');
    await page.getByRole('button', { name: t('catalog.form.save'), exact: true }).press('Enter');
    const name = page.getByLabel(t('catalog.form.nameEn'), { exact: true });
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription(/\S/);
    await audit('Create product with errors');

    await page.goto(`${detail}/edit`);
    await expect(page.getByLabel(t('catalog.form.code'), { exact: true })).toHaveValue('A11Y-JEANS');
    await expect(page.getByRole('button', { name: t('catalog.form.details', { variant: '30' }), exact: true })).toBeVisible();
    await audit('Edit product with variants');

    await page.goto(`${catalog}/low-stock`);
    const warnings = page.getByRole('list', { name: t('catalog.lowStock.title') });
    await expect(warnings.getByText(t('catalog.stock.low'), { exact: true })).toBeVisible();
    await expect(warnings.getByText(t('catalog.stock.out'), { exact: true })).toBeVisible();
    await audit('Low stock list');

    await page.goto(`/${locale}/sales`);
    const shortcut = page.getByRole('region', { name: t('catalog.lowStock.row.label') }).getByRole('link');
    await expect(shortcut).toHaveAccessibleName(new RegExp(escapeRegExp(t('catalog.lowStock.row.count', { count: 2 }))));
    await expect(shortcut).toHaveAttribute('href', `${catalog}/low-stock`);
    await audit('Start tab with Needs attention');
  } finally {
    await world.close();
  }
});

test('T106 M1 CSV import accessibility at 360 px', async ({ browser, baseURL, env, locale }, info) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const world = await catalogWorld(browser, baseURL ?? '', env, locale);
  const { page } = world.owner;
  const t = createTranslator({ locale, messages: (locale === 'ar' ? ar : en).catalog.import });
  const audit = (label: string) => m1Audit(page, info, locale, label);
  await page.setViewportSize({ width: 360, height: 740 });
  const upload = (price: string) => page.getByTestId('csv-input').setInputFiles({
    name: 'catalog.csv', mimeType: 'text/csv',
    buffer: Buffer.from(`product_code,name_en,name_ar,sku,price,currency,opening_quantity\r\nA11Y-CSV,Imported hat,قبعة مستوردة,A11Y-CSV-SKU,${price},USD,١\r\n`),
  });

  try {
    await page.goto(`/${locale}/more/catalog/import`);
    await expect(page.getByRole('link', { name: t('template') })).toBeVisible();
    await expect(page.getByRole('button', { name: t('choose') })).toBeEnabled();
    await audit('CSV upload');

    await upload('');
    await expect(page.getByRole('list', { name: `${t('problems')} · 1` }).getByRole('listitem')).toContainText(t('row', { row: 2 }));
    await expect(page.getByRole('button', { name: t('importBlocked', { count: 1 }) })).toBeDisabled();
    await audit('CSV preview with row errors');

    await upload('12');
    await expect(page.getByRole('group', { name: t('ifImport') })).toBeVisible();
    const confirm = page.getByRole('button', { name: t('confirm', { count: 1 }) });
    await expect(confirm).toBeEnabled();
    await audit('CSV valid preview');
    await confirm.press('Enter');
    await expect(page.getByRole('heading', { name: t('done.title') })).toBeVisible();
    await expect(page.getByRole('link', { name: t('done.viewCatalog') })).toBeVisible();
    await audit('CSV import result');
  } finally {
    await world.close();
  }
});
