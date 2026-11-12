import {
  createBusinessApi,
  expect,
  me,
  newApi,
  newContext,
  operatorSignInApi,
  rebase,
  test,
  tick,
  text,
  unique,
  uniquePhone,
} from "./fixtures";
import type { Locale } from "./fixtures";

// User Story 3 (T067, quickstart scenario 4): the owner adds a second store with a number typed in a
// local format and a logo, changes the exchange rate typed with a comma, invites a Sales agent limited
// to the first store, and checks what the agent can and cannot see. Then the owner deactivates the
// first store: the warning lists the agent, and afterwards the agent has no store. Runs once per
// language project (en, ar), each time on a business of its own (created through the operator API).

const OWNER_PASSWORD = "e2e-Owner-pass-9071";
const AGENT_PASSWORD = "e2e-Agent-pass-4417";

// A valid 1 x 1 PNG, generated from its base64 text so no file is needed.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

interface StoreBody {
  id: string;
  name: string;
  whatsapp_number: string | null;
  has_logo: boolean;
  status: "active" | "inactive";
}

test("owner adds a store with a logo, sets the rate, limits an agent to the first store, deactivates it", async ({
  browser,
  baseURL,
  env,
  locale,
}) => {
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

  // ---- 1. More -> Stores: the first store is there, and Add store ---------------------------------
  await owner.goto(`/${locale}/more`);
  await expect(owner.getByRole("link", { name: t("more.settings") })).toBeVisible();
  await owner.getByRole("link", { name: t("more.stores") }).click();
  await expect(owner).toHaveURL(new RegExp(`/${locale}/more/stores$`));
  await expect(owner.getByRole("heading", { name: t("stores.title"), level: 1 })).toBeVisible();
  await expect(owner.getByText(business.storeName)).toBeVisible();
  await expect(owner.getByText(t("stores.one.title"))).toBeVisible();
  await owner.getByRole("link", { name: t("stores.add") }).click();
  await expect(owner).toHaveURL(new RegExp(`/${locale}/more/stores/new$`));

  // ---- 2. A second store: number typed as "70 000 1xx", shown normalized, with a logo -------------
  const suffix = String(Math.floor(10 + Math.random() * 89));
  const typedNumber = `70 000 1${suffix}`;
  const shownNumber = `+961 70 000 1${suffix}`;
  const secondName = `E2E Second ${unique()}`;
  await owner.getByLabel(t("stores.form.name"), { exact: true }).fill(secondName);
  await owner.getByLabel(t("stores.form.whatsapp"), { exact: true }).fill(typedNumber);
  await owner.getByTestId("logo-input").setInputFiles({ name: "second-logo.png", mimeType: "image/png", buffer: PNG });
  await expect(owner.getByText("second-logo.png")).toBeVisible();
  await owner.getByRole("button", { name: t("stores.form.save") }).click();

  await expect(owner).toHaveURL(new RegExp(`/${locale}/more/stores$`));
  const secondRow = owner.getByRole("link", { name: new RegExp(secondName) });
  await expect(secondRow).toContainText(shownNumber);
  const logo = owner.getByRole("img", { name: t("stores.logoOf", { name: secondName }) });
  await expect(logo).toBeVisible();
  // The image really arrived (the API served it), it is not a broken picture.
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(owner.getByText(t("stores.one.title"))).toHaveCount(0);

  // The edit screen shows the same number, still normalized, and the logo.
  await secondRow.click();
  await expect(owner.getByRole("heading", { name: t("stores.form.editTitle"), level: 1 })).toBeVisible();
  await expect(owner.getByLabel(t("stores.form.whatsapp"), { exact: true })).toHaveValue(shownNumber);
  await expect(owner.getByText(t("stores.logo.current"))).toBeVisible();

  const stores = (await (await owner.request.get("/api/v1/stores")).json()) as StoreBody[];
  expect(stores).toHaveLength(2);
  const first = stores.find((store) => store.name === business.storeName);
  const second = stores.find((store) => store.name === secondName);
  expect(first, "first store").toBeTruthy();
  expect(second?.whatsapp_number).toBe(shownNumber.replaceAll(" ", ""));
  expect(second?.has_logo).toBe(true);
  const logoResponse = await owner.request.get(`/api/v1/stores/${second?.id}/logo`);
  expect(logoResponse.status()).toBe(200);
  expect(logoResponse.headers()["content-type"]).toContain("image/webp");

  // ---- 3. Settings: the rate typed with a comma is saved as a plain decimal ------------------------
  await owner.goto(`/${locale}/more`);
  await owner.getByRole("link", { name: t("more.settings") }).click();
  await expect(owner).toHaveURL(new RegExp(`/${locale}/more/settings$`));
  const rate = owner.getByLabel(t("settings.rate"));
  await expect(rate).toHaveValue("89,500");
  await rate.fill("90,500");
  await owner.getByRole("button", { name: t("settings.save") }).click();
  await expect(owner.getByText(t("settings.saved"))).toBeVisible();
  await expect(rate).toHaveValue("90,500");
  const saved = (await (await owner.request.get("/api/v1/business")).json()) as { usd_lbp_rate: string };
  expect(saved.usd_lbp_rate).toBe("90500.00");
  await owner.reload();
  await expect(owner.getByLabel(t("settings.rate"))).toHaveValue("90,500");

  // ---- 4. Invite a Sales agent limited to the FIRST store; the agent accepts ----------------------
  await owner.goto(`/${locale}/more/employees/invite`);
  const agentName = `E2E Agent ${unique()}`;
  const agentPhone = uniquePhone();
  await owner.getByLabel(t("staff.form.name"), { exact: true }).fill(agentName);
  await owner.getByLabel(t("staff.form.phone"), { exact: true }).fill(agentPhone.national);
  await tick(owner, t("staff.roleFull.sales")).click();
  // The second store (added a moment ago) is offered too: the screen reads the current store list.
  await expect(tick(owner, secondName)).toBeVisible();
  await tick(owner, business.storeName).click();
  await expect(tick(owner, business.storeName)).toHaveAttribute("aria-checked", "true");
  await expect(tick(owner, secondName)).toHaveAttribute("aria-checked", "false");
  await owner.getByRole("button", { name: t("staff.form.submit") }).click();
  const linkBox = owner.getByTestId("one-time-link");
  await expect(linkBox).toBeVisible();
  const agentLink = rebase((await linkBox.innerText()).trim(), origin);
  tokens.push(agentLink.token);
  await owner.getByRole("button", { name: t("ops.link.done") }).click();
  await expect(owner).toHaveURL(new RegExp(`/${locale}/more/employees$`));

  const agentContext = await newContext(browser, origin, requests);
  const acceptedAgent = await agentContext.request.post("/api/v1/invitations/accept", {
    data: { token: agentLink.token, password: AGENT_PASSWORD, locale },
  });
  expect(acceptedAgent.status(), "agent activation").toBe(200);
  const agent = await agentContext.newPage();

  // ---- 5. The agent sees only the first store; no Add store; no logo of the second; no Settings ----
  await agent.goto(`/${locale}/more`);
  await expect(agent.getByRole("heading", { name: t("more.title"), level: 1 })).toBeVisible();
  await expect(agent.getByRole("link", { name: t("more.settings") })).toHaveCount(0);
  await expect(agent.getByRole("link", { name: t("more.employees") })).toHaveCount(0);
  await agent.getByRole("link", { name: t("more.stores") }).click();
  await expect(agent.getByRole("heading", { name: t("stores.title"), level: 1 })).toBeVisible();
  await expect(agent.getByText(business.storeName)).toBeVisible();
  await expect(agent.getByText(secondName)).toHaveCount(0);
  await expect(agent.getByText(t("stores.agentNote"))).toBeVisible();
  await expect(agent.getByRole("link", { name: t("stores.add") })).toHaveCount(0);

  // Read-only page for their own store; the other store is simply not there.
  await agent.getByRole("link", { name: new RegExp(business.storeName) }).click();
  await expect(agent.getByText(t("stores.detail.readOnly"))).toBeVisible();
  await expect(agent.getByRole("textbox")).toHaveCount(0);
  await agent.goto(`/${locale}/more/stores/${second?.id}`);
  await expect(agent.getByText(t("stores.notFound.title"))).toBeVisible();
  await agent.goto(`/${locale}/more/stores/new`);
  await expect(agent.getByText(t("stores.notAllowed.title"))).toBeVisible();
  await agent.goto(`/${locale}/more/settings`);
  await expect(agent.getByText(t("settings.notAllowed.title"))).toBeVisible();

  const hidden = await agent.request.get(`/api/v1/stores/${second?.id}/logo`);
  expect(hidden.status(), "second store's logo, from the agent").toBe(404);
  const agentList = (await (await agent.request.get("/api/v1/stores")).json()) as StoreBody[];
  expect(agentList.map((store) => store.name)).toEqual([business.storeName]);
  const before = await me(agent);
  expect(before.body?.stores.map((store) => store.name)).toEqual([business.storeName]);
  expect(before.body?.permissions).not.toContain("settings.manage");

  // ---- 6. The owner deactivates the first store: the sheet lists the agent ------------------------
  await owner.goto(`/${locale}/more/stores`);
  await owner.getByRole("link", { name: new RegExp(business.storeName) }).click();
  await expect(owner.getByRole("heading", { name: t("stores.form.editTitle"), level: 1 })).toBeVisible();
  await owner.getByRole("button", { name: t("stores.state.deactivate") }).click();
  const sheet = owner.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(agentName)).toBeVisible();
  await expect(sheet.getByText(t("staff.role.sales"))).toBeVisible();
  // Nothing has changed yet.
  expect((await me(agent)).body?.stores.map((store) => store.name)).toEqual([business.storeName]);
  await sheet.getByRole("button", { name: t("stores.deactivate.confirm"), exact: true }).click();
  await expect(owner.getByText(t("stores.deactivate.done", { name: business.storeName }))).toBeVisible();
  await expect(owner.getByRole("button", { name: t("stores.state.reactivate") })).toBeVisible();

  // The agent keeps their sign-in but has no store now.
  const after = await me(agent);
  expect(after.status).toBe(200);
  expect(after.body?.stores).toEqual([]);
  await agent.goto(`/${locale}/more/stores`);
  await expect(agent.getByText(t("stores.none.title"))).toBeVisible();

  // The owner still sees both stores, the first one inactive; reactivating gives the agent the store back.
  await owner.goto(`/${locale}/more/stores`);
  await expect(owner.getByRole("link", { name: new RegExp(business.storeName) })).toContainText(t("stores.status.inactive"));
  await owner.getByRole("link", { name: new RegExp(business.storeName) }).click();
  await owner.getByRole("button", { name: t("stores.state.reactivate") }).click();
  await expect(owner.getByText(t("stores.reactivated", { name: business.storeName }))).toBeVisible();
  expect((await me(agent)).body?.stores.map((store) => store.name)).toEqual([business.storeName]);

  await agentContext.close();
  await ownerContext.close();

  // ---- 7. No token ever appeared in a request URL ------------------------------------------------
  expect(requests.length).toBeGreaterThan(0);
  for (const token of tokens) {
    expect(requests.filter((url) => url.includes(token))).toEqual([]);
  }
});
