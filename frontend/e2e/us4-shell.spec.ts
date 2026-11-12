import type { APIRequestContext, Page } from "@playwright/test";

import {
  createBusinessApi,
  expect,
  me,
  newApi,
  newContext,
  openTab,
  operatorSignInApi,
  rebase,
  test,
  text,
  uniquePhone,
  userSignInUi,
} from "./fixtures";
import type { Locale } from "./fixtures";

// User Story 4 (T075, quickstart scenario 5): the app shell on a 360 x 740 phone. An owner, a sales
// agent and a packing agent each open BOS: the right tabs, the right start tab, nothing wider than the
// screen on any M0 screen. The owner switches the language: the layout flips at once, the choice is
// saved to the account, it survives signing out and in from a fresh browser (and wins over the
// language the sign-in page was opened in). With the network off, saving says it did not go through
// and nothing is shown as saved. Runs once per language project (en, ar), each time on a business of
// its own. History and Devices are covered by the unit tests and by the backend suite.

const OWNER_PASSWORD = "e2e-Owner-pass-9071";
const SALES_PASSWORD = "e2e-Sales-pass-5521";
const PACKING_PASSWORD = "e2e-Packing-pass-7732";

interface MeBody {
  user: { name: string; locale: string };
  tabs: string[];
  start_tab: string;
}

/** Invites one person with one role through the owner's session and accepts the link in a fresh browser context. */
async function addPerson(owner: APIRequestContext, origin: string, role: "sales" | "packing", name: string, password: string, locale: Locale) {
  const phone = uniquePhone();
  const invited = await owner.post("/api/v1/staff/invitations", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { name, phone: phone.national, roles: [role], all_stores: true },
  });
  expect(invited.status(), `invite ${role}`).toBe(201);
  const { link } = (await invited.json()) as { link: string };
  return { token: rebase(link, origin).token, password, locale, phone: phone.international };
}

async function noHorizontalScroll(page: Page, where: string): Promise<void> {
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(size.scroll, `horizontal scroll on ${where}`).toBeLessThanOrEqual(size.client);
}

test("owner, sales and packing agents get their tabs and start tab; the language is saved; saving offline says it did not go through", async ({
  browser,
  baseURL,
  env,
  locale,
}) => {
  test.setTimeout(480_000);
  const origin = baseURL ?? "";
  const t = (key: string, values?: Record<string, string>) => text(locale as Locale, key, values);
  const requests: string[] = [];

  // ---- 0. A fresh business with its owner, a sales agent and a packing agent (through the API) -------
  const ops = await newApi(origin);
  await operatorSignInApi(ops, env);
  const business = await createBusinessApi(ops);
  await ops.dispose();

  const ownerContext = await newContext(browser, origin, requests);
  const accepted = await ownerContext.request.post("/api/v1/invitations/accept", {
    data: { token: rebase(business.link, origin).token, password: OWNER_PASSWORD, locale },
  });
  expect(accepted.status(), "owner activation").toBe(200);
  const owner = await ownerContext.newPage();

  const salesName = `E2E Sales ${business.storeName.slice(-6)}`;
  const packingName = `E2E Packing ${business.storeName.slice(-6)}`;
  const salesInvite = await addPerson(ownerContext.request, origin, "sales", salesName, SALES_PASSWORD, locale as Locale);
  const packingInvite = await addPerson(ownerContext.request, origin, "packing", packingName, PACKING_PASSWORD, locale as Locale);

  const salesContext = await newContext(browser, origin, requests);
  expect((await salesContext.request.post("/api/v1/invitations/accept", { data: { token: salesInvite.token, password: SALES_PASSWORD, locale } })).status()).toBe(200);
  const packingContext = await newContext(browser, origin, requests);
  expect((await packingContext.request.post("/api/v1/invitations/accept", { data: { token: packingInvite.token, password: PACKING_PASSWORD, locale } })).status()).toBe(200);
  const sales = await salesContext.newPage();
  const packing = await packingContext.newPage();

  // ---- 1. Tabs and start tab for each person ---------------------------------------------------------
  const people: Array<{ page: Page; who: string; tabs: string[]; start: string }> = [
    { page: owner, who: "owner", tabs: ["sales", "packing", "delivery", "orders", "more"], start: "sales" },
    { page: sales, who: "sales agent", tabs: ["sales", "orders", "more"], start: "sales" },
    { page: packing, who: "packing agent", tabs: ["packing", "orders", "more"], start: "packing" },
  ];
  for (const person of people) {
    const { page } = person;
    await page.goto(`/${locale}`);
    await expect(page, `${person.who} start tab`).toHaveURL(new RegExp(`/${locale}/${person.start}$`));
    const nav = page.getByRole("navigation", { name: t("tabs.aria") });
    await expect(nav.getByRole("link")).toHaveText(person.tabs.map((tab) => t(`tabs.${tab}`)));
    await expect(nav.getByRole("link", { name: t(`tabs.${person.start}`) })).toHaveAttribute("aria-current", "page");
    // The coming-soon placeholder, not an error.
    await expect(page.getByRole("heading", { name: t(`tabs.${person.start}`), level: 1 })).toBeVisible();
    await expect(page.getByText(t("soon.chip"))).toBeVisible();
    // (Next adds an alert region of its own for route changes, so look for the retry button instead.)
    await expect(page.getByRole("button", { name: t("ui.retry") })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");

    const body = (await me(page)).body as unknown as MeBody;
    expect(body.tabs, `${person.who} tabs from /me`).toEqual(person.tabs);
    expect(body.start_tab).toBe(person.start);

    // A tab that is not theirs is not shown; the address takes them to their own start tab.
    if (!person.tabs.includes("delivery")) {
      await page.goto(`/${locale}/delivery`);
      await expect(page).toHaveURL(new RegExp(`/${locale}/${person.start}$`));
    }
  }

  // ---- 2. No horizontal scroll on any M0 screen, for each person --------------------------------------
  const common: Array<[string, string]> = [
    ["/more", t("more.title")],
    ["/more/language", t("language.title")],
    ["/more/profile", t("profile.title")],
    ["/more/profile/password", t("changePassword.title")],
  ];
  for (const person of people) {
    const screens: Array<[string, string]> = [...person.tabs.filter((tab) => tab !== "more").map((tab): [string, string] => [`/${tab}`, t(`tabs.${tab}`)]), ...common];
    for (const [path, heading] of screens) {
      await person.page.goto(`/${locale}${path}`);
      await expect(person.page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
      await noHorizontalScroll(person.page, `${person.who} ${path}`);
    }
  }
  for (const [path, heading] of [
    ["/more/stores", t("stores.title")],
    ["/more/settings", t("settings.title")],
    ["/more/employees", t("staff.title")],
  ] as Array<[string, string]>) {
    await owner.goto(`/${locale}${path}`);
    await expect(owner.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await noHorizontalScroll(owner, `owner ${path}`);
  }

  // The More menu follows permissions: the owner has History, the agents do not; everyone has the account entries.
  await owner.goto(`/${locale}/more`);
  await expect(owner.getByRole("link", { name: t("more.history") })).toBeVisible();
  await expect(owner.getByRole("link", { name: t("more.devices") })).toBeVisible();
  await sales.goto(`/${locale}/more`);
  await expect(sales.getByRole("link", { name: t("more.history") })).toHaveCount(0);
  await expect(sales.getByRole("link", { name: t("more.employees") })).toHaveCount(0);
  await expect(sales.getByRole("link", { name: t("more.profileLink") })).toBeVisible();
  await expect(sales.getByRole("link", { name: t("more.language") })).toBeVisible();

  // ---- 3. Language: flips at once, is saved to the account, and wins at the next sign-in ----------------
  const other: Locale = locale === "en" ? "ar" : "en";
  await owner.goto(`/${locale}/more/language`);
  await expect(owner.getByRole("heading", { name: t("language.title"), level: 1 })).toBeVisible();
  await owner.getByRole("radio", { name: other === "ar" ? /العربية/ : /English/ }).click();
  await expect(owner).toHaveURL(new RegExp(`/${other}/more/language$`));
  await expect(owner.locator("html")).toHaveAttribute("lang", other);
  await expect(owner.locator("html")).toHaveAttribute("dir", other === "ar" ? "rtl" : "ltr");
  await expect(owner.getByRole("heading", { name: text(other, "language.title"), level: 1 })).toBeVisible();
  await expect(owner.getByRole("navigation", { name: text(other, "tabs.aria") })).toBeVisible();
  expect(((await me(owner)).body as unknown as MeBody).user.locale).toBe(other);
  await noHorizontalScroll(owner, "owner language screen after the switch");

  // Fresh browser, sign-in page opened in the ORIGINAL language: the saved language wins after signing in.
  const again = await newContext(browser, origin, requests);
  const second = await again.newPage();
  await userSignInUi(second, locale as Locale, business.ownerPhoneInternational, OWNER_PASSWORD);
  await expect(second).toHaveURL(new RegExp(`/${other}/sales$`));
  await expect(second.locator("html")).toHaveAttribute("dir", other === "ar" ? "rtl" : "ltr");
  await expect(second.getByRole("navigation", { name: text(other, "tabs.aria") })).toBeVisible();

  // Sign out, then sign in again from a fresh context: still the saved language.
  await openTab(second, text(other, "tabs.more"));
  await second.getByRole("button", { name: text(other, "shell.signOut") }).click();
  await expect(second).toHaveURL(new RegExp(`/${other}/sign-in$`));
  await again.close();
  const third = await newContext(browser, origin, requests);
  const thirdPage = await third.newPage();
  await userSignInUi(thirdPage, locale as Locale, business.ownerPhoneInternational, OWNER_PASSWORD);
  await expect(thirdPage).toHaveURL(new RegExp(`/${other}/sales$`));
  await third.close();

  // Put the owner back on the test language for the rest of the story.
  await owner.goto(`/${other}/more/language`);
  await owner.getByRole("radio", { name: locale === "ar" ? /العربية/ : /English/ }).click();
  await expect(owner).toHaveURL(new RegExp(`/${locale}/more/language$`));
  expect(((await me(owner)).body as unknown as MeBody).user.locale).toBe(locale);

  // ---- 4. Offline: saving says it did not go through; nothing is shown as saved -----------------------
  await owner.goto(`/${locale}/more/profile`);
  const nameField = owner.getByLabel(t("profile.name"), { exact: true });
  await expect(nameField).toHaveValue(business.ownerName);
  const newName = `${business.ownerName} Z`;
  await nameField.fill(newName);

  await ownerContext.setOffline(true);
  await expect(owner.getByText(t("ui.offlineTitle"))).toBeVisible();
  await owner.getByRole("button", { name: t("profile.save") }).click();
  await expect(owner.getByText(t("ui.writeFailed"))).toBeVisible();
  await expect(nameField).toHaveValue(newName);
  await expect(owner.getByText(t("profile.saved"), { exact: true })).toHaveCount(0);
  await expect(owner.getByRole("button", { name: t("profile.retry") })).toBeVisible();
  await noHorizontalScroll(owner, "owner profile, offline");

  // Back online: the notice goes away, nothing was saved meanwhile, and Try again saves it.
  await ownerContext.setOffline(false);
  await expect(owner.getByText(t("ui.offlineTitle"))).toHaveCount(0);
  expect(((await me(owner)).body as unknown as { user: { name: string } }).user.name).toBe(business.ownerName);
  await owner.getByRole("button", { name: t("profile.retry") }).click();
  await expect(owner.getByText(t("profile.saved"), { exact: true })).toBeVisible();
  expect(((await me(owner)).body as unknown as { user: { name: string } }).user.name).toBe(newName);

  await packingContext.close();
  await salesContext.close();
  await ownerContext.close();
});
