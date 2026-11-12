import { expect, request as playwrightRequest, test as base } from "@playwright/test";
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from "@playwright/test";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import { loadEnv } from "./env";
import type { E2eEnv } from "./env";

export { expect };

export type Locale = "en" | "ar";

const catalogs: Record<Locale, unknown> = { en, ar };

/** The text of a translation key ("auth.signIn.submit") in a language, with {name} values filled in. */
export function text(locale: Locale, key: string, values: Record<string, string> = {}): string {
  let node: unknown = catalogs[locale];
  for (const part of key.split(".")) {
    node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined;
  }
  if (typeof node !== "string") throw new Error(`No ${locale} text for ${key}`);
  return Object.entries(values).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, value), node);
}

/** Seeded demonstration users (backend/app/services/seed.py); their password is BOS_DEMO_PASSWORD. */
export const DEMO = {
  denimOwner: "+96170000001",
  denimManager: "+96170000002",
  secondOwner: "+96170000011",
} as const;

// ---- API helpers (through the web server /api/v1 proxy, like the browser) -------------------------

const CSRF = { "X-BOS-CSRF": "1" };

export async function newApi(baseURL: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL, extraHTTPHeaders: CSRF });
}

export async function operatorSignInApi(api: APIRequestContext, env: E2eEnv): Promise<void> {
  const response = await api.post("/api/v1/ops/auth/sign-in", {
    data: { email: env.operatorEmail, password: env.operatorPassword },
  });
  expect(response.status(), "operator sign-in").toBe(200);
}

export async function userSignInApi(api: APIRequestContext, identifier: string, password: string): Promise<void> {
  const response = await api.post("/api/v1/auth/sign-in", { data: { identifier, password } });
  expect(response.status(), `sign-in as ${identifier}`).toBe(200);
}

export interface NewBusiness {
  businessName: string;
  storeName: string;
  ownerName: string;
  /** As typed into the setup form (national format). */
  ownerPhoneTyped: string;
  /** The same number in another format, for signing in. */
  ownerPhoneInternational: string;
  /** The activation link exactly as the API returned it. */
  link: string;
}

let counter = 0;

/** A name part that differs on every call and every run, so repeated runs never collide. */
export function unique(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** A valid Lebanese mobile number (71 + 6 digits) that differs on every call. */
export function uniquePhone(): { national: string; international: string } {
  const digits = String(Math.floor(100000 + Math.random() * 899999));
  return { national: `071${digits}`, international: `+961 71 ${digits.slice(0, 3)} ${digits.slice(3)}` };
}

/** Details for a business that does not exist yet. */
export function newBusinessDetails(): Omit<NewBusiness, "link"> {
  const id = unique();
  const phone = uniquePhone();
  return {
    businessName: `E2E Business ${id}`,
    storeName: `E2E Store ${id}`,
    ownerName: `E2E Owner ${id}`,
    ownerPhoneTyped: phone.national,
    ownerPhoneInternational: phone.international,
  };
}

/** Sets a fresh business up through the operator API (not the UI) and returns its owner link. */
export async function createBusinessApi(api: APIRequestContext): Promise<NewBusiness> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const details = newBusinessDetails();
    const response = await api.post("/api/v1/ops/businesses", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        business_name: details.businessName,
        store_name: details.storeName,
        edition: "social",
        default_currency: "USD",
        usd_lbp_rate: "89500",
        owner_name: details.ownerName,
        owner_phone: details.ownerPhoneTyped,
      },
    });
    if (response.status() === 409) continue; // the phone number is taken: try another
    expect(response.status(), "create business").toBe(201);
    const body = (await response.json()) as { link: string };
    return { ...details, link: body.link };
  }
  throw new Error("Could not find an unused phone number for the new business");
}

/** The link rebased onto the test web server: the API may have been started for another origin. */
export function rebase(link: string, baseURL: string): { url: string; token: string } {
  const parsed = new URL(link);
  const token = parsed.hash.replace(/^#/, "");
  return { url: `${baseURL}${parsed.pathname}${parsed.search}${parsed.hash}`, token };
}

// ---- UI helpers -----------------------------------------------------------------------------------

export async function operatorSignInUi(page: Page, locale: Locale, env: E2eEnv): Promise<void> {
  await page.goto(`/${locale}/ops/sign-in`);
  await page.getByLabel(text(locale, "ops.signIn.email")).fill(env.operatorEmail);
  await page.getByLabel(text(locale, "ops.signIn.password"), { exact: true }).fill(env.operatorPassword);
  await page.getByRole("button", { name: text(locale, "ops.signIn.submit") }).click();
  await expect(page.getByRole("heading", { name: text(locale, "ops.list.title") })).toBeVisible();
}

export async function userSignInUi(page: Page, locale: Locale, identifier: string, password: string): Promise<void> {
  await page.goto(`/${locale}/sign-in`);
  await page.getByLabel(text(locale, "auth.signIn.identifier")).fill(identifier);
  await page.getByLabel(text(locale, "auth.signIn.password"), { exact: true }).fill(password);
  await page.getByRole("button", { name: text(locale, "auth.signIn.submit") }).click();
}

/** Signs in as a seeded demonstration user (password from the environment). */
export async function demoSignInUi(page: Page, locale: Locale, env: E2eEnv, identifier: string): Promise<void> {
  await userSignInUi(page, locale, identifier, env.demoPassword);
}

export const test = base.extend<{ env: E2eEnv; locale: Locale }>({
  env: async ({}, provide) => {
    await provide(loadEnv());
  },
  locale: async ({}, provide, testInfo) => {
    await provide(testInfo.project.name === "ar" ? "ar" : "en");
  },
});

// ---- Shared by the staff and store scenarios -------------------------------------------------------

export interface MeBody {
  user: { id: string; roles: string[] };
  stores: Array<{ id: string; name: string; whatsapp_number?: string | null }>;
  tabs: string[];
  permissions: string[];
}

/** A fresh browser context for one person; every request it makes is recorded in `requests`. */
export async function newContext(browser: Browser, baseURL: string, requests: string[]): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: CSRF,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  context.on("request", (request) => requests.push(request.url()));
  return context;
}

/** A role or store tick box: its name starts with the label and goes on with the description. */
export function tick(page: Page, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("checkbox", { name: new RegExp(`^${escaped}`) });
}

export async function me(page: Page): Promise<{ status: number; body: MeBody | null }> {
  const response = await page.request.get("/api/v1/me");
  return { status: response.status(), body: response.ok() ? ((await response.json()) as MeBody) : null };
}

/**
 * Opens a bottom-bar tab. The click is dispatched on the link itself: in a right-to-left page the last
 * tab sits in the bottom-left corner, where the Next.js development indicator (a test-server only overlay)
 * covers it and swallows real pointer clicks.
 */
export async function openTab(page: Page, label: string): Promise<void> {
  await page.getByRole("navigation").getByRole("link", { name: label }).dispatchEvent("click");
}
