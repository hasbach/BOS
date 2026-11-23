import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createTranslator } from "next-intl";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import { expect, test } from "./fixtures";
import { catalogWorld, expectNoSidewaysScroll } from "./m1-fixtures";

// These tests authenticate with local fixture credentials. Keep their request bodies out of traces.
test.use({ trace: "off" });

const header = "product_code,name_en,name_ar,sku,price,currency,opening_quantity";
const hatRow = "IMP-A,Imported hat,قبعة مستوردة,IMP-A-SKU,12,USD,٥";
const valid = [
  hatRow,
  "IMP-B,Imported bag,حقيبة مستوردة,IMP-B-SKU,14,USD,2",
  "IMP-C,Imported coat,معطف مستورد,IMP-C-SKU,20,USD,3",
  "IMP-D,Imported shoes,حذاء مستورد,IMP-D-SKU,22,USD,1",
];
const invalid = [
  hatRow,
  "IMP-B,Imported bag,حقيبة مستوردة,IMP-A-SKU,14,USD,2",
  "IMP-C,Imported coat,معطف مستورد,IMP-C-SKU,,USD,3",
  "IMP-D,Imported shoes,حذاء مستورد,IMP-D-SKU,22,USD,-1",
];

test("CSV chooser stays disabled until ready; the first activation uploads", async ({ page, env, locale }) => {
  const headers = { "X-BOS-CSRF": "1" };
  const signedIn = await page.request.post("/api/v1/auth/sign-in", {
    headers,
    data: { identifier: "owner@demo.bos.test", password: env.demoPassword },
  });
  expect(signedIn.status()).toBe(200);
  expect((await page.request.patch("/api/v1/me", { headers, data: { locale } })).status()).toBe(200);

  const label = createTranslator({ locale, messages: (locale === "en" ? en : ar).catalog.import });
  const choose = page.getByRole("button", { name: label("choose"), exact: true });
  let releaseScripts!: () => void;
  const scripts = new Promise<void>((resolve) => { releaseScripts = resolve; });
  const requestedScript = page.waitForRequest((request) =>
    request.resourceType() === "script" && new URL(request.url()).pathname.includes("/_next/"),
  );
  await page.route("**/_next/**", async (route) => {
    if (route.request().resourceType() === "script") await scripts;
    await route.continue();
  });
  try {
    const response = await page.goto(`/${locale}/more/catalog/import`, { waitUntil: "commit" });
    expect(response?.status()).toBe(200);
    await requestedScript;
    await expect(page.getByRole("link", { name: label("template") })).toBeVisible();
    await expect(choose).toBeVisible();
    expect(await choose.isDisabled(), "server-rendered chooser with hydration explicitly deferred").toBe(true);
  } finally {
    releaseScripts();
  }

  await expect(choose).toBeEnabled();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    locale === "en" ? choose.click() : choose.press("Enter"),
  ]);
  expect(await chooser.element().getAttribute("data-testid")).toBe("csv-input");
  const code = `READY-${randomUUID().slice(0, 8)}`;
  const [preview] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/catalog/imports"),
    chooser.setFiles({ name: "ready.csv", mimeType: "text/csv", buffer: Buffer.from(`${header}\r\n${code},Ready hat,قبعة,${code},12,USD,1\r\n`) }),
  ]);
  expect(preview.status()).toBe(201);
  expect(await preview.json()).toMatchObject({ status: "previewed", row_count: 1, errors: [] });
  await expect(page.getByRole("button", { name: label("confirm", { count: 1 }) })).toBeEnabled();
});

test("CSV preview rejects bad rows; confirmation creates opening stock once", async ({ browser, baseURL, env, locale }) => {
  const world = await catalogWorld(browser, baseURL ?? "", env, locale);
  const page = world.owner.page;
  const label = createTranslator({ locale, messages: (locale === "en" ? en : ar).catalog.import });
  const address = `/${locale}/more/catalog/import`;
  const api = world.owner.context.request;
  const upload = (rows: string[]) => page.getByTestId("csv-input").setInputFiles({
    name: "catalog.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([header, ...rows].join("\r\n")),
  });
  const catalog = async () => {
    const response = await api.get("/api/v1/catalog/products");
    expect(response.status()).toBe(200);
    return (await response.json() as { items: Array<{ id: string; code: string }> }).items;
  };
  try {
    await page.goto(address);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: label("template") }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const bytes = await readFile(await download.path());
    expect(bytes.toString("utf8")).toMatch(/^\ufeffproduct_code,/);
    expect(bytes.toString("utf8")).toMatch(/[\u0600-\u06ff]/);

    await upload(invalid);
    const problems = page.getByRole("list", { name: `${label("problems")} · 3` });
    await expect(problems.getByRole("listitem")).toHaveCount(3);
    for (const [row, column] of [["3", "sku"], ["4", "price"], ["5", "opening_quantity"]] as const) {
      await expect(problems.getByRole("listitem").filter({ hasText: label("row", { row }) })).toContainText(column);
    }
    await expect(page.getByRole("button", { name: label("importBlocked", { count: "3" }) })).toBeDisabled();
    expect(await catalog()).toHaveLength(0);
    await expectNoSidewaysScroll(page, "CSV validation errors");

    await upload(valid);
    const counts = page.getByRole("group", { name: label("ifImport") });
    for (const [key, value] of [["products", "4"], ["variants", "4"], ["units", "11"]] as const) {
      await expect(counts.getByText(label(key), { exact: true }).locator("..")).toContainText(value);
    }
    expect(await catalog()).toHaveLength(0);
    await expectNoSidewaysScroll(page, "CSV preview");
    await page.getByRole("button", { name: label("confirm", { count: "4" }) }).click();
    await expect(page.getByRole("heading", { name: label("done.title") })).toBeVisible();
    await page.getByRole("link", { name: label("done.viewCatalog") }).click();
    await expect(page.getByText(locale === "en" ? "Imported hat" : "قبعة مستوردة", { exact: true })).toBeVisible();
    const items = await catalog();
    expect(items.map((item) => item.code).sort()).toEqual(["IMP-A", "IMP-B", "IMP-C", "IMP-D"]);
    const hat = items.find((item) => item.code === "IMP-A");
    const detail = await api.get(`/api/v1/catalog/products/${hat?.id}`);
    expect(detail.status()).toBe(200);
    const product = await detail.json() as { variants: Array<{ id: string; stock: { on_hand: number } }> };
    expect(product.variants[0]?.stock.on_hand).toBe(5);
    const movements = await api.get(`/api/v1/catalog/variants/${product.variants[0]?.id}/movements`);
    expect(movements.status()).toBe(200);
    expect((await movements.json()).items).toEqual([expect.objectContaining({ reason: "opening", source: "import", quantity: 5 })]);

    await page.goto(address);
    await upload(valid);
    const duplicateMessage = label("rowsToFix", { count: 4 });
    await expect(page.getByRole("alert").filter({ hasText: duplicateMessage })).toBeVisible();
    expect(await catalog()).toHaveLength(4);
  } finally {
    await world.close();
  }
});
