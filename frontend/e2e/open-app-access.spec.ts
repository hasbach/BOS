import {
  createBusinessApi,
  expect,
  newApi,
  newContext,
  openTab,
  operatorSignInApi,
  rebase,
  test,
  text,
  tick,
  unique,
  uniquePhone,
} from "./fixtures";
import type { Locale } from "./fixtures";

// SC-005 in the already-open app (exit-gate finding P1): with the agent's page open in one browser and
// the owner working in another, the agent's next tab tap shows the tabs of the new role, and after a
// deactivation the agent's next tab tap lands on sign-in. The agent's page is never reloaded.
// Runs once per language project (en, ar), each time on a business of its own.

const OWNER_PASSWORD = "e2e-Owner-pass-9071";
const AGENT_PASSWORD = "e2e-Agent-pass-4417";

test("the open app follows a role change and a deactivation on the next tap, without a reload", async ({ browser, baseURL, env, locale }) => {
  const origin = baseURL ?? "";
  const t = (key: string, values?: Record<string, string>) => text(locale as Locale, key, values);
  const requests: string[] = [];

  // ---- 0. A business with its owner and a Sales agent (through the API: other stories cover the screens)
  const ops = await newApi(origin);
  await operatorSignInApi(ops, env);
  const business = await createBusinessApi(ops);
  await ops.dispose();

  const ownerContext = await newContext(browser, origin, requests);
  const accepted = await ownerContext.request.post("/api/v1/invitations/accept", {
    data: { token: rebase(business.link, origin).token, password: OWNER_PASSWORD, locale },
  });
  expect(accepted.status(), "owner activation").toBe(200);

  const agentName = `E2E Agent ${unique()}`;
  const invited = await ownerContext.request.post("/api/v1/staff/invitations", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { name: agentName, phone: uniquePhone().national, roles: ["sales"], all_stores: true },
  });
  expect(invited.status(), "invite the agent").toBe(201);
  const { link } = (await invited.json()) as { link: string };

  const agentContext = await newContext(browser, origin, requests);
  const agentAccepted = await agentContext.request.post("/api/v1/invitations/accept", {
    data: { token: rebase(link, origin).token, password: AGENT_PASSWORD, locale },
  });
  expect(agentAccepted.status(), "agent activation").toBe(200);

  // ---- 1. The agent's app is open on the Sales tab -------------------------------------------------
  const agent = await agentContext.newPage();
  await agent.goto(`/${locale}/sales`);
  const agentNav = agent.getByRole("navigation", { name: t("tabs.aria") });
  await expect(agentNav.getByRole("link", { name: t("tabs.sales") })).toBeVisible();
  await expect(agentNav.getByRole("link", { name: t("tabs.packing") })).toHaveCount(0);
  let loads = 0;
  agent.on("load", () => {
    loads += 1;
  });

  // ---- 2. The owner swaps the agent's role from Sales to Packing in their own browser ----------------
  const owner = await ownerContext.newPage();
  await owner.goto(`/${locale}/more/employees`);
  await owner.getByRole("link", { name: new RegExp(agentName) }).click();
  await expect(owner.getByRole("heading", { name: agentName })).toBeVisible();
  await tick(owner, t("staff.roleFull.sales")).click();
  await tick(owner, t("staff.roleFull.packing")).click();
  await expect(tick(owner, t("staff.roleFull.packing"))).toHaveAttribute("aria-checked", "true");
  await owner.getByRole("button", { name: t("staff.detail.save") }).click();
  await expect(owner.getByText(t("staff.detail.saved"))).toBeVisible();

  // ---- 3. The agent's next tap: the tab bar now shows Packing and no longer Sales --------------------
  await openTab(agent, t("tabs.orders"));
  await expect(agent).toHaveURL(new RegExp(`/${locale}/orders$`));
  await expect(agentNav.getByRole("link", { name: t("tabs.packing") })).toBeVisible();
  await expect(agentNav.getByRole("link", { name: t("tabs.sales") })).toHaveCount(0);

  // ---- 4. The owner deactivates the agent ---------------------------------------------------------
  await owner.getByRole("button", { name: t("staff.detail.deactivate") }).click();
  const sheet = owner.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: t("staff.detail.deactivate") }).click();
  await expect(owner.getByText(t("staff.detail.deactivated", { name: agentName }))).toBeVisible();

  // ---- 5. The agent's next tap lands on sign-in ----------------------------------------------------
  await openTab(agent, t("tabs.more"));
  await expect(agent).toHaveURL(new RegExp(`/${locale}/sign-in`));
  expect(loads, "the agent's page was never loaded again").toBe(0);

  await agentContext.close();
  await ownerContext.close();
});
