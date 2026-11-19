import type { Browser, BrowserContext, Page } from "@playwright/test";

import { createBusinessApi, expect, newApi, newContext, operatorSignInApi, rebase, unique, uniquePhone } from "./fixtures";
import type { Locale, NewBusiness } from "./fixtures";
import type { E2eEnv } from "./env";

// Shared by the M1 catalog and stock scenarios (m1-catalog.spec.ts, m1-stock.spec.ts): a fresh
// business with two stores and the people the stories need, all set up through the API (M0's stories
// cover those screens), so each run starts from an empty catalog and never collides with another run.

const OWNER_PASSWORD = "e2e-Owner-pass-9071";
const STAFF_PASSWORD = "e2e-Staff-pass-5521";

// A valid 1 x 1 PNG, generated from its base64 text so no file is needed.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

export type StaffRole = "manager" | "sales" | "packing";

export interface Person {
  context: BrowserContext;
  page: Page;
}

export interface CatalogWorld {
  business: NewBusiness;
  storeA: { id: string; name: string };
  storeB: { id: string; name: string };
  owner: Person;
  /** Signs a new staff member in (invited by the owner, limited to the given stores, or all of them when none are given) and returns their browser. */
  staff: (role: StaffRole, storeIds: string[]) => Promise<Person>;
  close: () => Promise<void>;
}

/** A fresh business with Store A (its first store) and Store B, its owner signed in with the given language. */
export async function catalogWorld(browser: Browser, origin: string, env: E2eEnv, locale: Locale): Promise<CatalogWorld> {
  const ops = await newApi(origin);
  await operatorSignInApi(ops, env);
  const business = await createBusinessApi(ops);
  await ops.dispose();

  const contexts: BrowserContext[] = [];
  const requests: string[] = [];
  const ownerContext = await newContext(browser, origin, requests);
  contexts.push(ownerContext);
  const accepted = await ownerContext.request.post("/api/v1/invitations/accept", {
    data: { token: rebase(business.link, origin).token, password: OWNER_PASSWORD, locale },
  });
  expect(accepted.status(), "owner activation").toBe(200);

  const stores = (await (await ownerContext.request.get("/api/v1/stores")).json()) as { items?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;
  const list = Array.isArray(stores) ? stores : (stores.items ?? []);
  const first = list.find((store) => store.name === business.storeName);
  expect(first, "the first store").toBeTruthy();
  const storeBName = `E2E Store B ${unique()}`;
  const created = await ownerContext.request.post("/api/v1/stores", { data: { name: storeBName } });
  expect(created.status(), "create Store B").toBe(201);
  const storeB = (await created.json()) as { id: string; name: string };

  const owner: Person = { context: ownerContext, page: await ownerContext.newPage() };

  async function staff(role: StaffRole, storeIds: string[]): Promise<Person> {
    let link = "";
    for (let attempt = 0; attempt < 5 && link === ""; attempt += 1) {
      const phone = uniquePhone();
      const invited = await ownerContext.request.post("/api/v1/staff/invitations", {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        data: { name: `E2E ${role} ${unique()}`, phone: phone.national, roles: [role], all_stores: storeIds.length === 0, store_ids: storeIds },
      });
      if (invited.status() === 409) continue; // the phone number is taken: try another
      expect(invited.status(), `invite ${role}`).toBe(201);
      link = ((await invited.json()) as { link: string }).link;
    }
    expect(link, `an unused phone number for the ${role}`).not.toBe("");
    const context = await newContext(browser, origin, requests);
    contexts.push(context);
    const joined = await context.request.post("/api/v1/invitations/accept", {
      data: { token: rebase(link, origin).token, password: STAFF_PASSWORD, locale },
    });
    expect(joined.status(), `${role} activation`).toBe(200);
    return { context, page: await context.newPage() };
  }

  return {
    business,
    storeA: { id: first?.id ?? "", name: business.storeName },
    storeB: { id: storeB.id, name: storeB.name },
    owner,
    staff,
    close: async () => {
      for (const context of contexts) await context.close();
    },
  };
}

/** The page is no wider than the screen: nothing scrolls sideways at 360 px. */
export async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(sizes.scroll, `${where} scrolls sideways (${sizes.scroll} > ${sizes.client})`).toBeLessThanOrEqual(sizes.client);
}

/** The part of a message between two of its placeholders, to find it whatever the values are. */
export function fixedPart(message: (values: Record<string, string>) => string, after: string, before: string): string {
  const full = message({ [after]: "\u0001", [before]: "\u0002" });
  return (full.split("\u0001")[1] ?? "").split("\u0002")[0]?.trim() ?? "";
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
