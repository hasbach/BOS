import type { Browser, BrowserContext, Page } from "@playwright/test";

import {
  DEMO,
  expect,
  newApi,
  newBusinessDetails,
  operatorSignInApi,
  operatorSignInUi,
  rebase,
  test,
  text,
  userSignInApi,
  userSignInUi,
} from "./fixtures";
import type { Locale } from "./fixtures";

// User Story 1 (T044, quickstart scenarios 1 and 2): the operator sets a business up and gets a
// one-time link; the owner opens it in a fresh browser, chooses a language, sets a password and
// lands in the signed-in home in that language. Runs once per language project (en, ar).

const PASSWORD = "e2e-Owner-pass-9071";

async function freshPage(browser: Browser, baseURL: string, extra: { requests?: string[] } = {}): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  page.on("request", (request) => extra.requests?.push(request.url()));
  return { context, page };
}

test("operator sets up a business and the owner activates it", async ({ browser, baseURL, env, locale }) => {
  const origin = baseURL ?? "";
  const details = newBusinessDetails();
  const t = (key: string, values?: Record<string, string>) => text(locale as Locale, key, values);

  // ---- 1. The operator signs in and sets up the business (screen 37) -----------------------------
  const operatorContext = await browser.newContext({
    baseURL: origin,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const operator = await operatorContext.newPage();
  await operatorSignInUi(operator, locale, env);

  await operator.getByRole("link", { name: t("ops.list.setUp") }).click();
  await expect(operator).toHaveURL(new RegExp(`/${locale}/ops/new$`));
  await operator.getByLabel(t("ops.new.businessName")).fill(details.businessName);
  await operator.getByLabel(t("ops.new.storeName")).fill(details.storeName);
  await operator.getByLabel(t("ops.new.rate")).fill("89500");
  await operator.getByLabel(t("ops.new.ownerName")).fill(details.ownerName);
  await operator.getByLabel(t("ops.new.ownerPhone")).fill(details.ownerPhoneTyped);
  await operator.getByRole("button", { name: t("ops.new.submit") }).click();

  // ---- 2. Screen 38: the one-time link, copied ---------------------------------------------------
  const linkBox = operator.getByTestId("one-time-link");
  await expect(linkBox).toBeVisible();
  const shown = (await linkBox.innerText()).trim();
  await operator.getByRole("button", { name: t("ops.link.copy") }).click();
  await expect(operator.getByText(t("ops.link.copied"))).toBeVisible();
  const copied = await operator.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(shown);
  const { url: activationUrl, token } = rebase(shown, origin);
  expect(token.length).toBeGreaterThan(20);

  await operator.getByRole("button", { name: t("ops.link.done") }).click();
  await expect(operator.getByRole("heading", { name: t("ops.list.title") })).toBeVisible();
  const pendingCard = operator.locator("article", { has: operator.getByRole("heading", { name: details.businessName }) });
  await expect(pendingCard).toContainText(t("ops.list.status.pending"));

  // ---- 3. The owner opens the link in a fresh browser --------------------------------------------
  const requests: string[] = [];
  const { context: ownerContext, page: owner } = await freshPage(browser, origin, { requests });
  await owner.goto(activationUrl);

  await expect(owner.getByText(details.businessName)).toBeVisible();
  await expect(owner.getByText(t("auth.activate.welcome", { name: details.ownerName }))).toBeVisible();
  await expect(owner.getByText(t("roles.owner"), { exact: true })).toBeVisible();
  // The token is removed from the address bar as soon as the page has read it.
  await expect(owner).not.toHaveURL(new RegExp(token));

  // ---- 4. Chooses the language, sets a password ---------------------------------------------------
  await owner.getByRole("radio", { name: locale === "ar" ? "العربية" : "English" }).click();
  await expect(owner).toHaveURL(new RegExp(`/${locale}/activate`));
  await expect(owner.locator("html")).toHaveAttribute("lang", locale);
  await expect(owner.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
  await expect(owner.getByText(details.businessName)).toBeVisible();

  await owner.getByLabel(t("auth.activate.password"), { exact: true }).fill(PASSWORD);
  await owner.getByLabel(t("auth.activate.confirm"), { exact: true }).fill(PASSWORD);
  await owner.getByRole("button", { name: t("auth.activate.submit") }).click();

  // ---- 5. Lands on the signed-in home in the chosen language -------------------------------------
  await expect(owner).toHaveURL(new RegExp(`/${locale}/?$`));
  await expect(owner.getByRole("heading", { name: t("shell.homeTitle") })).toBeVisible();
  await expect(owner.getByText(details.businessName)).toBeVisible();
  await expect(owner.getByText(details.ownerName)).toBeVisible();
  await expect(owner.locator("html")).toHaveAttribute("lang", locale);

  // The token never appeared in any request URL (it travels in request bodies only).
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((url) => url.includes(token))).toEqual([]);
  await ownerContext.close();

  // ---- 6. The same link again: already activated, sign in ----------------------------------------
  const { context: againContext, page: again } = await freshPage(browser, origin);
  await again.goto(activationUrl);
  await expect(again.getByText(t("auth.link.usedTitle"))).toBeVisible();
  await expect(again.getByRole("link", { name: t("common.signIn") })).toBeVisible();
  await againContext.close();

  // ---- 7. Signing in with the phone number in another format works -------------------------------
  const { context: signInContext, page: signIn } = await freshPage(browser, origin);
  await userSignInUi(signIn, locale, details.ownerPhoneInternational, PASSWORD);
  await expect(signIn.getByRole("heading", { name: t("shell.homeTitle") })).toBeVisible();
  await expect(signIn.getByText(details.businessName)).toBeVisible();
  await signInContext.close();

  // ---- 8. A wrong password gets the generic message ---------------------------------------------
  const { context: wrongContext, page: wrong } = await freshPage(browser, origin);
  await userSignInUi(wrong, locale, details.ownerPhoneTyped, `${PASSWORD}-wrong`);
  await expect(wrong.getByText(t("auth.signIn.wrong"))).toBeVisible();
  await expect(wrong).toHaveURL(new RegExp(`/${locale}/sign-in`));
  await wrongContext.close();

  // ---- 9. The operator list shows the business as Active -----------------------------------------
  await operator.reload();
  const activeCard = operator.locator("article", { has: operator.getByRole("heading", { name: details.businessName }) });
  await expect(activeCard).toContainText(t("ops.list.status.active"));
  await expect(activeCard).not.toContainText(t("ops.list.status.pending"));
  await operatorContext.close();

  // ---- 10. Isolation (quickstart scenario 2): the new owner cannot reach a demo business ---------
  // US1 has no store routes yet, so the check uses the tenant-scoped routes that exist: the demo
  // owner's session and history. The answer for another business's record must be the same 404 as
  // for one that never existed, and nothing of the demo business may show up.
  const demoApi = await newApi(origin);
  await userSignInApi(demoApi, DEMO.denimOwner, env.demoPassword);
  const demoSessions = (await (await demoApi.get("/api/v1/me/sessions")).json()) as Array<{ id: string }>;
  const demoUser = (await (await demoApi.get("/api/v1/me")).json()) as { user: { id: string } };
  expect(demoSessions.length).toBeGreaterThan(0);

  const ownerApi = await newApi(origin);
  await userSignInApi(ownerApi, details.ownerPhoneInternational, PASSWORD);
  const madeUp = await ownerApi.delete("/api/v1/me/sessions/00000000-0000-4000-8000-000000000000");
  expect(madeUp.status()).toBe(404);
  for (const session of demoSessions) {
    const response = await ownerApi.delete(`/api/v1/me/sessions/${session.id}`);
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual(await madeUp.json());
  }
  const history = await ownerApi.get(`/api/v1/audit?actor_id=${demoUser.user.id}`);
  expect(history.status()).toBe(200);
  expect(((await history.json()) as { items: unknown[] }).items).toEqual([]);
  const ownHistory = JSON.stringify(await (await ownerApi.get("/api/v1/audit")).json());
  expect(ownHistory).not.toContain("Demo Denim House Group");
  // The demo owner was not signed out by any of this.
  expect((await demoApi.get("/api/v1/me")).status()).toBe(200);
  await demoApi.dispose();
  await ownerApi.dispose();

  // The operator API still lists the business as active (kept for the sake of the contract).
  const opsApi = await newApi(origin);
  await operatorSignInApi(opsApi, env);
  const list = (await (await opsApi.get("/api/v1/ops/businesses")).json()) as Array<{ name: string; status: string }>;
  expect(list.find((b) => b.name === details.businessName)?.status).toBe("active");
  await opsApi.dispose();
});
