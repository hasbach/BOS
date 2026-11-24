import { expect, test, type FileChooser, type Locator, type Page, type Request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createTranslator } from "next-intl";
import ar from "../messages/ar.json";
import en from "../messages/en.json";
import type { Locale } from "../e2e/fixtures";
import { captureTiming, installTiming } from "./timing";

const catalog = "/more/catalog";
const screenBudget = 3000;
const searchBudget = 1000;
const slimName = { en: "Slim Jeans", ar: "جينز ضيق" };
const broadQuery = { en: "Performance Denim", ar: "جينز الأداء" };
const importsPath = "/api/v1/catalog/imports";
const probeTimeout = 1_500;
const assertionTimeout = 15_000;
const diagnostics = new WeakMap<Page, string[]>();

function isImportPost(request: Request, path?: string) {
  const pathname = new URL(request.url()).pathname;
  return request.method() === "POST" && (path ? pathname === path : pathname === importsPath || pathname.startsWith(`${importsPath}/`));
}

test.beforeEach(async ({ context, page, baseURL }, info) => {
  const locale = info.project.name as Locale;
  const password = process.env.BOS_T107_PASSWORD;
  if (baseURL !== process.env.BOS_T107_ORIGIN || !password || !/^bos_t107_[0-9a-f]{12}$/.test(process.env.BOS_T107_DB ?? "")) {
    throw new Error("Run only against the explicitly configured disposable T107 stack");
  }
  const email = info.title === "catalog search" ? "owner@second.demo.bos.test" : "owner@demo.bos.test";
  const headers = { "X-BOS-CSRF": "1" };
  const signedIn = await context.request.post("/api/v1/auth/sign-in", { headers, data: { identifier: email, password } });
  expect(signedIn.status(), "isolated demo owner sign-in").toBe(200);
  const saved = await context.request.patch("/api/v1/me", { headers, data: { locale } });
  expect(saved.status(), "saved owner locale").toBe(200);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  // Applied throttling for a live DOM/action metric (not Lantern's simulated LCP).
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8,
    connectionType: "cellular4g",
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await installTiming(page);
  if (/^(adjustment sheet|CSV (upload|preview|result))$/.test(info.title)) {
    const log: string[] = [];
    diagnostics.set(page, log);
    page.on("pageerror", (error) => log.push(`page error: ${error.message}`));
    page.on("request", (request) => {
      if (isImportPost(request)) log.push(`sent POST ${new URL(request.url()).pathname}`);
    });
    page.on("response", (response) => {
      if (isImportPost(response.request())) {
        log.push(`received ${response.status()} ${new URL(response.url()).pathname}, request ID ${response.headers()["x-request-id"] ?? "unavailable"}`);
      }
    });
    page.on("requestfailed", (request) => {
      if (isImportPost(request)) log.push(`failed POST ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`);
    });
  }
  await page.addInitScript(() => {
    for (const type of ["click", "input", "change"]) {
      document.addEventListener(type, (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("[data-t107-trigger]")) {
          performance.mark("t107-trigger");
          target.closest("[data-t107-trigger]")?.removeAttribute("data-t107-trigger");
        }
      }, true);
    }
  });
});

test.afterEach(async ({ page }, info) => {
  const log = diagnostics.get(page);
  if (!log) return;
  await info.attach("action-evidence", { body: log.join("\n") || "No recorded action or import POST", contentType: "text/plain" });
});

async function navigate(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "commit" });
  expect(response?.status(), path).toBe(200);
}

async function arm(locator: Locator) {
  await locator.evaluate((el) => {
    performance.clearMarks("t107-trigger");
    el.setAttribute("data-t107-trigger", "");
  });
}

async function assertTrigger(page: Page) {
  const trigger = await page.evaluate(() => performance.getEntriesByName("t107-trigger")[0]?.startTime);
  diagnostics.get(page)?.push(trigger === undefined ? "No browser trigger recorded" : `Browser trigger at ${trigger.toFixed(1)} ms after navigation`);
  expect(trigger, "Harness must capture the dispatched browser event").toBeDefined();
}

async function readyMs(page: Page, interaction: boolean) {
  return page.evaluate(async (fromAction) => {
    const start = fromAction ? performance.getEntriesByName("t107-trigger")[0]?.startTime : 0;
    if (start === undefined) throw new Error("Expected browser action was not observed");
    // Wait for a rendering opportunity after the real content passes its readiness assertion.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return performance.now() - start;
  }, interaction);
}

async function finish(page: Page, budget: number, interaction = false) {
  await record(page, await readyMs(page, interaction), budget, interaction);
}

async function record(page: Page, ms: number, budget: number, interaction: boolean) {
  const info = test.info();
  console.log(`T107 ${JSON.stringify({ locale: info.project.name, check: info.title, repeat: info.repeatEachIndex + 1, ms: Number(ms.toFixed(1)), budget })}`);
  await captureTiming(page, ms, interaction, info.title, info.project.name, info.repeatEachIndex + 1);
  expect(ms, `${info.title} readiness (ms)`).toBeLessThan(budget);
}

function labels() {
  const locale = test.info().project.name as Locale;
  return { locale, t: createTranslator({ locale, messages: locale === "ar" ? ar : en }), url: (path: string) => `/${locale}${path}` };
}

type Product = { id: string; variants: { id: string; sku: string }[] };
async function slim(page: Page) {
  const list = await page.request.get("/api/v1/catalog/products", { params: { q: "DEMO-SLIM" } });
  expect(list.status()).toBe(200);
  const { items } = await list.json() as { items: { id: string; code: string }[] };
  const id = items.find(({ code }) => code === "DEMO-SLIM")?.id;
  expect(id, "demo product for stock and edit").toBeTruthy();
  const response = await page.request.get(`/api/v1/catalog/products/${id}`);
  expect(response.status()).toBe(200);
  const product = await response.json() as Product;
  const variant = product.variants[0];
  if (!variant) throw new Error("DEMO-SLIM has no variant");
  return { id: product.id, variant };
}

test("catalog search", async ({ page }) => {
  const { locale, t, url } = labels();
  await navigate(page, url(catalog));
  const list = page.getByRole("list", { name: t("catalog.title") });
  await expect(list.getByRole("listitem").first()).toBeVisible();
  const input = page.getByRole("searchbox", { name: t("catalog.search") });
  // Start from no results so a stale/default row cannot satisfy the result assertion.
  // SSR rows can appear before the input is hydrated. Retry only this untimed setup action.
  await expect(async () => {
    await input.clear();
    await input.fill("t107-no-match-fixture");
    await expect(page.getByRole("heading", { name: t("catalog.noMatch.title") })).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  await arm(input);
  await page.evaluate(({ prefix, query }) => {
    const deadline = performance.now() + 15_000;
    const poll = () => {
      const from = performance.getEntriesByName("t107-trigger")[0];
      const row = [...document.querySelectorAll<HTMLAnchorElement>(`ul li a[href^="${prefix}/"]`)]
        .find((link) => link.textContent?.includes(query) && link.checkVisibility({ checkVisibilityCSS: true }));
      if (from && row) requestAnimationFrame(() => performance.mark("t107-search-result"));
      else if (performance.now() < deadline) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }, { prefix: url(catalog), query: broadQuery[locale] });
  await input.fill(broadQuery[locale]);
  await expect(list.getByRole("link", { name: new RegExp(broadQuery[locale]) }).first()).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("t107-search-result").length > 0, undefined, { timeout: 15000 });
  await record(page, await page.evaluate(() => performance.measure("t107-search", "t107-trigger", "t107-search-result").duration), searchBudget, true);
});

test("catalog list", async ({ page }) => {
  const { locale, t, url } = labels();
  await navigate(page, url(catalog));
  await expect(page.getByRole("list", { name: t("catalog.title") }).getByText(slimName[locale], { exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: t("catalog.search") })).toBeEnabled();
  await finish(page, screenBudget);
});

test("product detail", async ({ page }) => {
  const { url } = labels();
  const product = await slim(page);
  await navigate(page, url(`${catalog}/${product.id}`));
  await expect(page.getByRole("table").getByText(product.variant.sku, { exact: true })).toBeVisible();
  await finish(page, screenBudget);
});

test("create product", async ({ page }) => {
  const { t, url } = labels();
  await navigate(page, url(`${catalog}/new`));
  await expect(page.getByLabel(t("catalog.form.nameEn"), { exact: true })).toBeEditable();
  await expect(page.getByRole("checkbox", { name: "Store A", exact: true })).toBeVisible();
  await finish(page, screenBudget);
});

test("edit product", async ({ page }) => {
  const { t, url } = labels();
  const product = await slim(page);
  await navigate(page, url(`${catalog}/${product.id}/edit`));
  await expect(page.getByLabel(t("catalog.form.code"), { exact: true })).toHaveValue("DEMO-SLIM");
  await expect(page.getByLabel(t("catalog.form.nameEn"), { exact: true })).toBeEditable();
  await finish(page, screenBudget);
});

test("adjustment sheet", async ({ page }) => {
  const { locale, t, url } = labels();
  const product = await slim(page);
  await navigate(page, url(`${catalog}/${product.id}`));
  // Prove the same ProductDetail client handles events without opening the measured sheet or changing stock.
  const archive = page.getByRole("button", { name: t("catalog.detail.archive"), exact: true });
  const archiveDialog = page.getByRole("dialog", { name: t("catalog.detail.archiveTitle", { name: slimName[locale] }), exact: true });
  await test.step("untimed detail interactivity: open and cancel archive", async () => {
    let attempts = 0;
    try {
      await expect(async () => {
        if (await archiveDialog.isHidden()) {
          attempts += 1;
          await archive.click({ timeout: probeTimeout });
        }
        await expect(archiveDialog, "Archive opens without any stock mutation").toBeVisible({ timeout: probeTimeout });
      }).toPass({ timeout: assertionTimeout });
    } finally {
      diagnostics.get(page)?.push(`Untimed archive interactivity: ${attempts} click attempt(s)`);
    }
    await archiveDialog.getByRole("button", { name: t("catalog.detail.cancel"), exact: true }).click();
    await expect(archiveDialog).toBeHidden();
    diagnostics.get(page)?.push("Untimed detail interactivity verified");
  });
  const opener = page.getByRole("button", { name: t("catalog.detail.adjust"), exact: true });
  await arm(opener);
  await opener.click();
  await assertTrigger(page);
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: t("catalog.adjust.title") })).toBeVisible();
  await expect(sheet.getByLabel(t("catalog.adjust.quantity"), { exact: true })).toBeEditable();
  await finish(page, screenBudget, true);
});

test("stock history", async ({ page }) => {
  const { t, url } = labels();
  const product = await slim(page);
  await navigate(page, url(`${catalog}/${product.id}/variants/${product.variant.id}/history`));
  await expect(page.getByText(t("catalog.reasons.opening"), { exact: true })).toBeVisible();
  await finish(page, screenBudget);
});

test("low stock list", async ({ page }) => {
  const { t, url } = labels();
  await navigate(page, url(`${catalog}/low-stock`));
  const list = page.getByRole("list", { name: t("catalog.lowStock.title") });
  await expect(list.getByText(t("catalog.stock.low"), { exact: true }).first()).toBeVisible();
  await expect(list.getByText(t("catalog.stock.out"), { exact: true }).first()).toBeVisible();
  await finish(page, screenBudget);
});

test("start-tab low stock row", async ({ page }) => {
  const { t, url } = labels();
  await navigate(page, url("/sales"));
  const link = page.getByRole("region", { name: t("catalog.lowStock.row.label") }).getByRole("link");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", url(`${catalog}/low-stock`));
  await finish(page, screenBudget);
});

async function openImport(page: Page) {
  const { t, url } = labels();
  await navigate(page, url(`${catalog}/import`));
  await expect(page.getByRole("link", { name: t("catalog.import.template") })).toBeVisible();
  const choose = page.getByRole("button", { name: t("catalog.import.choose") });
  await expect(choose).toBeVisible();
  await expect(choose).toBeEnabled();
  return choose;
}

async function chooseFile(page: Page, choose: Locator, timeout: number, armed = false) {
  // Register before clicking. The native chooser proves the button's handler ran.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout }),
    (async () => {
      await choose.click({ timeout });
      if (armed) await assertTrigger(page);
    })(),
  ]);
  return chooser;
}

async function prepareFileChooser(page: Page, choose: Locator) {
  return test.step("untimed import interactivity: open the native file chooser", async () => {
    let attempts = 0;
    let chooser: FileChooser | undefined;
    try {
      await expect(async () => {
        attempts += 1;
        chooser = await chooseFile(page, choose, probeTimeout);
      }).toPass({ timeout: assertionTimeout });
    } finally {
      diagnostics.get(page)?.push(`Untimed chooser: ${chooser ? "opened" : "did not open"} after ${attempts} click attempt(s)`);
    }
    if (!chooser) throw new Error("Untimed file chooser was not captured");
    return chooser;
  });
}

async function importBatch(page: Page, path: string, status: "previewed" | "committed") {
  const response = await page.waitForResponse((response) => isImportPost(response.request(), path), { timeout: assertionTimeout });
  expect(response.ok(), `POST ${path} returned HTTP ${response.status()}`).toBe(true);
  const batch = await response.json() as { id: string };
  expect(batch, `POST ${path} ${status} one valid row`).toMatchObject({
    status, row_count: 1, products: 1, variants: 1, opening_units: 1, errors: [],
  });
  expect(batch.id, `POST ${path} batch ID`).toBeTruthy();
  return batch;
}

async function preview(page: Page, choose: Locator, timed: boolean) {
  const { t } = labels();
  const input = page.getByTestId("csv-input");
  const code = `T107-${randomUUID().slice(0, 8)}`;
  const chooser = await prepareFileChooser(page, choose);
  if (timed) await arm(input);
  const confirm = page.getByRole("button", { name: t("catalog.import.confirm", { count: 1 }), exact: true });
  const [batch, ms] = await Promise.all([
    importBatch(page, importsPath, "previewed"),
    (async () => {
      await chooser.setFiles({ name: "catalog.csv", mimeType: "text/csv", buffer: Buffer.from(
        `product_code,name_en,name_ar,sku,price,currency,opening_quantity\r\n${code},Imported hat,قبعة مستوردة,${code},12,USD,1\r\n`,
      ) });
      if (timed) await assertTrigger(page);
      await expect(page.getByRole("group", { name: t("catalog.import.ifImport") })).toBeVisible();
      await expect(confirm).toBeVisible();
      await expect(confirm).toBeEnabled();
      return timed ? readyMs(page, true) : undefined;
    })(),
  ]);
  if (ms !== undefined) await record(page, ms, screenBudget, true);
  return { batch, confirm };
}

test("CSV upload", async ({ page }) => {
  const choose = await openImport(page);
  // Cold navigation: verify the first enabled click; no warm-up, no retry, and no clock reset.
  await test.step("cold upload usability: first enabled click opens the native chooser", async () => {
    await arm(choose);
    await chooseFile(page, choose, assertionTimeout, true);
  });
  await finish(page, screenBudget);
});

test("CSV preview", async ({ page }) => {
  const choose = await openImport(page);
  await preview(page, choose, true);
});

test("CSV result", async ({ page }) => {
  const { t } = labels();
  const choose = await openImport(page);
  const { batch, confirm } = await test.step("untimed result fixture: preview a fresh one-row file", () => preview(page, choose, false));
  await arm(confirm);
  const [confirmed, ms] = await Promise.all([
    importBatch(page, `${importsPath}/${batch.id}/confirm`, "committed"),
    (async () => {
      await confirm.click();
      await assertTrigger(page);
      await expect(page.getByRole("heading", { name: t("catalog.import.done.title") })).toBeVisible();
      await expect(page.getByText(t("catalog.import.done.text", { products: 1, variants: 1, units: 1 }), { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: t("catalog.import.done.viewCatalog") })).toBeVisible();
      return readyMs(page, true);
    })(),
  ]);
  expect(confirmed.id).toBe(batch.id);
  await record(page, ms, screenBudget, true);
});
