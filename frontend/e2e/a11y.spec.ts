import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Page } from "@playwright/test";

import { createBusinessApi, expect, me, newApi, newContext, operatorSignInApi, operatorSignInUi, rebase, test, text, unique, uniquePhone, userSignInApi } from "./fixtures";
import type { Locale } from "./fixtures";

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

test("every M0 screen passes axe, shows focus and keeps sheets accessible", async ({ browser, baseURL, env, locale }) => {
  test.setTimeout(900_000);
  const origin = baseURL ?? "";
  const lang = locale as Locale;
  const t = (key: string, values?: Record<string, string>) => text(lang, key, values);
  const requests: string[] = [];
  const contexts: BrowserContext[] = [];
  const context = async () => {
    const created = await newContext(browser, origin, requests);
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

    // ---- The owner, with a second signed-in device and one pending invitation -----------------------
    const ownerContext = await context();
    const accepted = await ownerContext.request.post("/api/v1/invitations/accept", {
      data: { token: link.token, password: OWNER_PASSWORD, locale: lang },
    });
    expect(accepted.status(), "owner activation").toBe(200);
    const otherDevice = await newApi(origin);
    await userSignInApi(otherDevice, business.ownerPhoneInternational, OWNER_PASSWORD);
    await otherDevice.dispose();
    const invited = await ownerContext.request.post("/api/v1/staff/invitations", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { name: `E2E Invitee ${unique()}`, phone: uniquePhone().national, roles: ["sales"], all_stores: true },
    });
    expect(invited.status(), "invite").toBe(201);
    const invitationId = ((await invited.json()) as { invitation: { invitation_id: string } }).invitation.invitation_id;

    const owner = await ownerContext.newPage();
    await owner.goto(`/${lang}/more`);
    await settled(owner);
    const mine = (await me(owner)).body;
    if (!mine) throw new Error("no /me for the owner");
    const storeId = mine.stores[0]?.id ?? "";

    for (const tab of ["sales", "packing", "delivery", "orders"]) await visit(owner, lang, `/${tab}`, `${tab} (coming soon)`);
    await visit(owner, lang, "/more", "more");
    await visit(owner, lang, "/more/employees", "employees");
    await visit(owner, lang, "/more/employees/invite", "invite");
    await owner.getByRole("button", { name: t("staff.form.submit") }).click();
    await expect(owner.getByRole("alert").first()).toBeVisible();
    await check(owner, "invite with errors", false);
    await visit(owner, lang, `/more/employees/${mine.user.id}`, "employee detail");
    await visit(owner, lang, `/more/employees/invitations/${invitationId}`, "invitation detail");
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

    // ---- Load error, offline notice and a save that did not go through ------------------------------
    await owner.route("**/api/v1/business", (route) => route.abort());
    await owner.goto(`/${lang}/more/settings`);
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
    report(lang);
    for (const created of contexts) await created.close();
  }

  const blocking = findings.filter((f) => f.impact === "serious" || f.impact === "critical");
  expect(blocking, "serious or critical axe violations").toEqual([]);
  expect(focusProblems, "focusable elements without a visible focus indicator").toEqual([]);
});
