import AxeBuilder from "@axe-core/playwright";

import { createBusinessApi, emailedCode, expect, me, newApi, newContext, operatorSignInApi, rebase, test, text, unique } from "./fixtures";
import type { Locale } from "./fixtures";

// FR-012a, security.md F-09 (task T093): an employee invited by email asks for a code on the
// invitation page, reads it from the email (the development API writes email to its outbox folder),
// and joins only with the right code. Runs once per language project (en, ar).

const OWNER_PASSWORD = "e2e-Owner-pass-5523";
const AGENT_PASSWORD = "e2e-Agent-pass-8806";

test("an employee invited by email joins with the code emailed to that address", async ({ browser, baseURL, env, locale }) => {
  const origin = baseURL ?? "";
  const t = (key: string, values?: Record<string, string>) => text(locale as Locale, key, values);
  const requests: string[] = [];

  // ---- 0. A business whose owner invites someone by email (through the API: US2 covers the screens) --
  const ops = await newApi(origin);
  await operatorSignInApi(ops, env);
  const business = await createBusinessApi(ops);
  await ops.dispose();
  const ownerContext = await newContext(browser, origin, requests);
  const accepted = await ownerContext.request.post("/api/v1/invitations/accept", {
    data: { token: rebase(business.link, origin).token, password: OWNER_PASSWORD, locale },
  });
  expect(accepted.status(), "owner activation").toBe(200);

  const agentName = `E2E Mail Agent ${unique()}`;
  const address = `e2e-${unique()}@example.test`;
  const invited = await ownerContext.request.post("/api/v1/staff/invitations", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { name: agentName, email: address, roles: ["sales"], all_stores: true },
  });
  expect(invited.status(), "invite by email").toBe(201);
  const { link } = (await invited.json()) as { link: string };

  // ---- 1. The link asks for a code before anything else ---------------------------------------------
  const agentContext = await newContext(browser, origin, requests);
  const agent = await agentContext.newPage();
  await agent.goto(rebase(link, origin).url);
  await expect(agent.getByText(t("auth.activate.welcome", { name: agentName }))).toBeVisible();
  await expect(agent.getByRole("heading", { name: t("auth.activate.codeTitle") })).toBeVisible();
  const codeField = agent.getByLabel(t("auth.activate.code"), { exact: true });
  await agent.getByLabel(t("auth.activate.password"), { exact: true }).fill(AGENT_PASSWORD);
  await agent.getByLabel(t("auth.activate.confirm"), { exact: true }).fill(AGENT_PASSWORD);
  await agent.getByRole("button", { name: t("auth.activate.submit") }).click();
  await expect(agent.getByText(t("auth.activate.codeRequired"))).toBeVisible();
  await expect(codeField).toHaveAttribute("aria-invalid", "true");
  await expect(codeField).toBeFocused();

  // ---- 2. Send code: it arrives at the invited address -----------------------------------------------
  const since = Date.now();
  await agent.getByRole("button", { name: t("auth.activate.sendCode") }).click();
  await expect(agent.getByText(t("auth.activate.codeSent"))).toBeVisible();
  await expect(codeField).toBeFocused();
  await expect(agent.getByRole("button", { name: t("auth.activate.sendNewCode") })).toBeVisible();
  const code = await emailedCode(env, address, since);

  // The code step passes axe (serious and critical findings) in this language.
  const axe = await new AxeBuilder({ page: agent })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("nextjs-portal")
    .analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

  // ---- 3. A wrong code is refused on the form; the right one signs the person in --------------------
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  await codeField.fill(wrong);
  await agent.getByRole("button", { name: t("auth.activate.submit") }).click();
  await expect(agent.getByText(t("errors.code_invalid"))).toBeVisible();
  expect((await me(agent)).status, "not signed in after a wrong code").toBe(401);

  await codeField.fill(code);
  await agent.getByRole("button", { name: t("auth.activate.submit") }).click();
  await expect(agent).toHaveURL(new RegExp(`/${locale}/(sales|packing|delivery)$`));
  await expect(agent.getByRole("navigation", { name: t("tabs.aria") })).toBeVisible();
  const signedIn = await me(agent);
  expect(signedIn.status).toBe(200);
  expect(signedIn.body?.user.roles).toEqual(["sales"]);

  // The link never travelled in an address (the code goes in request bodies only).
  for (const url of requests) expect(url).not.toContain(rebase(link, origin).token);

  await agentContext.close();
  await ownerContext.close();
});
