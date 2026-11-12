import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

import {
  createBusinessApi,
  expect,
  newApi,
  operatorSignInApi,
  rebase,
  test,
  text,
  unique,
  uniquePhone,
  userSignInUi,
} from "./fixtures";
import type { Locale } from "./fixtures";

// User Story 2 (T058, quickstart scenario 3): the owner invites a Sales agent limited to a store, the
// agent accepts and sees only what the role allows, a role change shows on the agent's next request
// without signing in again, and deactivation sends the agent to sign-in. Runs once per language
// project (en, ar), each time on a business of its own (created through the operator API).
//
// There is no store API yet, so the business has only its first store: the agent is limited to that
// one store and the "cannot see the other store" part waits for User Story 3.

const OWNER_PASSWORD = "e2e-Owner-pass-9071";
const AGENT_PASSWORD = "e2e-Agent-pass-4417";
const CSRF = { "X-BOS-CSRF": "1" };

interface MeBody {
  user: { id: string; roles: string[] };
  stores: Array<{ id: string; name: string }>;
  tabs: string[];
  permissions: string[];
}

async function newContext(browser: Browser, baseURL: string, requests: string[]): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: CSRF,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  context.on("request", (request) => requests.push(request.url()));
  return context;
}

/** A role or store tick box: its name starts with the label and goes on with the description. */
function tick(page: Page, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("checkbox", { name: new RegExp(`^${escaped}`) });
}

async function me(page: Page): Promise<{ status: number; body: MeBody | null }> {
  const response = await page.request.get("/api/v1/me");
  return { status: response.status(), body: response.ok() ? ((await response.json()) as MeBody) : null };
}

test("owner invites a sales agent, changes the role, deactivates", async ({ browser, baseURL, env, locale }) => {
  const origin = baseURL ?? "";
  const t = (key: string, values?: Record<string, string>) => text(locale as Locale, key, values);
  const requests: string[] = [];
  const tokens: string[] = [];

  // ---- 0. A fresh business, activated by its owner (through the API: US1 covers the screens) -----
  const ops = await newApi(origin);
  await operatorSignInApi(ops, env);
  const business = await createBusinessApi(ops);
  await ops.dispose();
  const ownerLink = rebase(business.link, origin);
  tokens.push(ownerLink.token);

  const ownerContext = await newContext(browser, origin, requests);
  const accepted = await ownerContext.request.post("/api/v1/invitations/accept", {
    data: { token: ownerLink.token, password: OWNER_PASSWORD, locale },
  });
  expect(accepted.status(), "owner activation").toBe(200);
  const owner = await ownerContext.newPage();

  // ---- 1. More -> Employees -> Invite (there is no link to More from Home yet: go by address) -----
  await owner.goto(`/${locale}/more`);
  await expect(owner.getByRole("heading", { name: t("more.title") })).toBeVisible();
  await owner.getByRole("link", { name: t("more.employees") }).click();
  await expect(owner).toHaveURL(new RegExp(`/${locale}/more/employees$`));
  await expect(owner.getByRole("heading", { name: t("staff.title") })).toBeVisible();
  await expect(owner.getByText(business.ownerName)).toBeVisible();
  await owner.getByRole("link", { name: t("staff.invite") }).click();
  await expect(owner).toHaveURL(new RegExp(`/${locale}/more/employees/invite$`));

  // ---- 2. Invite a Sales agent limited to the store -----------------------------------------------
  const agentName = `E2E Agent ${unique()}`;
  const agentPhone = uniquePhone();
  await owner.getByLabel(t("staff.form.name"), { exact: true }).fill(agentName);
  await owner.getByLabel(t("staff.form.phone"), { exact: true }).fill(agentPhone.national);
  await tick(owner, t("staff.roleFull.sales")).click();
  await expect(tick(owner, t("staff.roleFull.sales"))).toHaveAttribute("aria-checked", "true");
  await tick(owner, business.storeName).click();
  await expect(tick(owner, business.storeName)).toHaveAttribute("aria-checked", "true");
  await owner.getByRole("button", { name: t("staff.form.submit") }).click();

  // ---- 3. The one-time link: shown, copied --------------------------------------------------------
  const linkBox = owner.getByTestId("one-time-link");
  await expect(linkBox).toBeVisible();
  const shown = (await linkBox.innerText()).trim();
  await owner.getByRole("button", { name: t("ops.link.copy") }).click();
  await expect(owner.getByText(t("ops.link.copied"))).toBeVisible();
  expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(shown);
  const agentLink = rebase(shown, origin);
  expect(agentLink.token.length).toBeGreaterThan(20);
  tokens.push(agentLink.token);
  await owner.getByRole("button", { name: t("ops.link.done") }).click();
  await expect(owner).toHaveURL(new RegExp(`/${locale}/more/employees$`));
  const pending = owner.locator("section", { has: owner.getByRole("heading", { name: new RegExp(t("staff.groups.pending")) }) });
  await expect(pending).toContainText(agentName);

  // ---- 4. The agent opens the link in a fresh browser and lands on the shell -----------------------
  const agentContext = await newContext(browser, origin, requests);
  const agent = await agentContext.newPage();
  await agent.goto(`/${locale}/activate#${agentLink.token}`);
  await expect(agent.getByText(business.businessName)).toBeVisible();
  await expect(agent.getByText(t("auth.activate.welcome", { name: agentName }))).toBeVisible();
  await expect(agent).not.toHaveURL(new RegExp(agentLink.token));
  await agent.getByLabel(t("auth.activate.password"), { exact: true }).fill(AGENT_PASSWORD);
  await agent.getByLabel(t("auth.activate.confirm"), { exact: true }).fill(AGENT_PASSWORD);
  await agent.getByRole("button", { name: t("auth.activate.submit") }).click();
  await expect(agent).toHaveURL(new RegExp(`/${locale}/?$`));
  await expect(agent.getByRole("heading", { name: t("shell.homeTitle") })).toBeVisible();
  await expect(agent.getByText(agentName)).toBeVisible();

  // ---- 5. No Employees entry in the agent's More menu; the page itself refuses -------------------
  await agent.goto(`/${locale}/more`);
  await expect(agent.getByRole("heading", { name: t("more.title") })).toBeVisible();
  await expect(agent.getByText(business.businessName)).toBeVisible();
  await expect(agent.getByRole("link", { name: t("more.employees") })).toHaveCount(0);
  await agent.goto(`/${locale}/more/employees`);
  await expect(agent.getByText(t("staff.notAllowed.title"))).toBeVisible();

  // ---- 6. /me lists only the permitted store, and only the Sales role's tabs ---------------------
  const first = await me(agent);
  expect(first.status).toBe(200);
  expect(first.body?.user.roles).toEqual(["sales"]);
  expect(first.body?.stores.map((s) => s.name)).toEqual([business.storeName]);
  expect(first.body?.tabs).toContain("sales");
  expect(first.body?.tabs).not.toContain("packing");
  expect(first.body?.permissions).not.toContain("staff.view");

  // ---- 7. The owner removes Sales and adds Packing; the agent's next request reflects it ----------
  await owner.reload();
  await owner.getByRole("link", { name: new RegExp(agentName) }).click();
  await expect(owner.getByRole("heading", { name: agentName })).toBeVisible();
  await tick(owner, t("staff.roleFull.sales")).click();
  await tick(owner, t("staff.roleFull.packing")).click();
  await expect(tick(owner, t("staff.roleFull.sales"))).toHaveAttribute("aria-checked", "false");
  await expect(tick(owner, t("staff.roleFull.packing"))).toHaveAttribute("aria-checked", "true");
  await owner.getByRole("button", { name: t("staff.detail.save") }).click();
  await expect(owner.getByText(t("staff.detail.saved"))).toBeVisible();

  const second = await me(agent); // the same session: no new sign-in
  expect(second.status).toBe(200);
  expect(second.body?.user.roles).toEqual(["packing"]);
  expect(second.body?.tabs).toContain("packing");
  expect(second.body?.tabs).not.toContain("sales");
  expect(second.body?.stores.map((s) => s.name)).toEqual([business.storeName]);
  await agent.goto(`/${locale}/more`);
  await expect(agent.getByRole("heading", { name: t("more.title") })).toBeVisible();
  await expect(agent).toHaveURL(new RegExp(`/${locale}/more$`));
  await expect(agent.getByText(t("staff.role.packing"), { exact: false }).first()).toBeVisible();

  // ---- 8. The owner deactivates the agent; the agent's next request lands on sign-in -------------
  await owner.getByRole("button", { name: t("staff.detail.deactivate") }).click();
  const sheet = owner.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: t("staff.detail.deactivate") }).click();
  await expect(owner.getByText(t("staff.detail.deactivated", { name: agentName }))).toBeVisible();

  const gone = await me(agent);
  expect(gone.status).toBe(401);
  await agent.reload();
  await expect(agent).toHaveURL(new RegExp(`/${locale}/sign-in`));
  // ... and they cannot sign back in while deactivated.
  const back = await agentContext.newPage();
  await userSignInUi(back, locale as Locale, agentPhone.national, AGENT_PASSWORD);
  await expect(back.getByText(t("auth.signIn.wrong"))).toBeVisible();
  await expect(back).toHaveURL(new RegExp(`/${locale}/sign-in`));
  await agentContext.close();

  // ---- 9. The owner's own record: read-only, and the only owner cannot be deactivated ------------
  await owner.goto(`/${locale}/more/employees`);
  await owner.getByRole("link", { name: new RegExp(business.ownerName) }).click();
  await expect(owner.getByText(t("staff.detail.self"))).toBeVisible();
  await expect(owner.getByText(t("staff.detail.rolesReadOnly"))).toBeVisible();
  await expect(owner.getByText(t("staff.detail.selfOnlyOwner"))).toBeVisible();
  await expect(owner.getByRole("checkbox")).toHaveCount(0);
  await expect(owner.getByRole("button", { name: t("staff.detail.save") })).toHaveCount(0);
  const ownerDeactivate = owner.getByRole("button", { name: t("staff.detail.deactivate") });
  // The screen offers no Deactivate for oneself at all; if it ever does, it must be disabled.
  if ((await ownerDeactivate.count()) > 0) await expect(ownerDeactivate).toBeDisabled();

  // The server refuses it as well (no API call is needed for the screen check above).
  const ownerMe = (await (await owner.request.get("/api/v1/me")).json()) as MeBody;
  const refused = await owner.request.patch(`/api/v1/staff/${ownerMe.user.id}`, { data: { status: "inactive" } });
  expect(refused.status()).toBeGreaterThanOrEqual(400);
  expect(refused.status()).toBeLessThan(500);
  expect((await owner.request.get("/api/v1/me")).status()).toBe(200);
  await ownerContext.close();

  // ---- 10. No token ever appeared in a request URL ------------------------------------------------
  expect(requests.length).toBeGreaterThan(0);
  for (const token of tokens) {
    expect(requests.filter((url) => url.includes(token))).toEqual([]);
  }
});
