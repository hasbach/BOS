import { expect, test, text } from "./fixtures";
import type { Locale } from "./fixtures";
import { catalogWorld, expectNoSidewaysScroll } from "./m1-fixtures";
import type { Person } from "./m1-fixtures";

// M1 User Story 2 (T063, quickstart scenario 2): a manager records received +5, damaged −1 and a
// count of 12 on a variant that opened with 10, each previewed before saving; the variant's stock
// history lists the four movements, which sum to 12. With the adjust sheet open twice, the second save
// is refused with the new numbers and goes through when repeated. Removing 20 is refused. A double
// tap on Save records one movement. The packing agent's direct POST answers 403. Runs once per
// language project (en, ar), each time on a business of its own, at 360 px.

interface Movement {
  reason: string;
  quantity: number;
  counted_quantity: number | null;
  on_hand_after: number;
}

interface ProductBody {
  id: string;
  variants: Array<{ id: string; sku: string; stock: { on_hand: number; allocated: number; available: number; version: number } }>;
}

test("manager adjusts stock; history adds up; stale, too large and double saves are handled; packing is refused", async ({
  browser,
  baseURL,
  env,
  locale,
}) => {
  const origin = baseURL ?? "";
  const t = (key: string, values?: Record<string, string>) => text(locale as Locale, key, values);
  const world = await catalogWorld(browser, origin, env, locale as Locale);

  try {
    // ---- 0. A product with one variant and 10 opening units (the owner, through the API) ------------
    const created = await world.owner.context.request.post("/api/v1/catalog/products", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        code: "TEE-STOCK",
        name_en: "Stock tee",
        name_ar: "قميص المخزون",
        store_ids: [world.storeA.id],
        photo_ids: [],
        options: [],
        variants: [{ option_values: [], sku: null, price: "12", currency: "USD", low_stock_level: null, photo_id: null, opening_quantity: 10 }],
      },
    });
    expect(created.status(), "create the product").toBe(201);
    const product = (await created.json()) as ProductBody;
    const variantId = product.variants[0]?.id ?? "";
    const address = `/${locale}/more/catalog/${product.id}`;

    const manager = await world.staff("manager", []);
    const page = manager.page;
    const movements = async (): Promise<Movement[]> => {
      const response = await page.request.get(`/api/v1/catalog/variants/${variantId}/movements`);
      expect(response.status()).toBe(200);
      return ((await response.json()) as { items: Movement[] }).items;
    };
    const onHand = async (): Promise<number> => {
      const body = (await (await page.request.get(`/api/v1/catalog/products/${product.id}`)).json()) as ProductBody;
      return body.variants[0]?.stock.on_hand ?? -1;
    };

    /** Opens the adjust sheet from the product screen and chooses the kind of change and reason. */
    async function openSheet(person: Person, mode: "add" | "remove" | "count", reason?: string) {
      await person.page.getByRole("button", { name: t("catalog.detail.adjust"), exact: true }).click();
      const sheet = person.page.getByRole("dialog");
      await expect(sheet.getByRole("heading", { name: t("catalog.adjust.title") })).toBeVisible();
      if (mode !== "add") await sheet.getByRole("radio", { name: t(`catalog.adjust.modes.${mode}`), exact: true }).click();
      if (reason) await sheet.getByRole("radio", { name: t(`catalog.reasons.${reason}`), exact: true }).click();
      return sheet;
    }
    const quantity = (sheet: ReturnType<typeof page.getByRole>) => sheet.getByLabel(t("catalog.adjust.quantity"), { exact: true });
    const save = (sheet: ReturnType<typeof page.getByRole>) => sheet.getByRole("button", { name: t("catalog.adjust.save"), exact: true });
    const savedText = (onHandNow: number) =>
      t("catalog.adjust.saved", { variant: t("catalog.detail.onlyVariant"), onHand: String(onHandNow), available: String(onHandNow) });

    await page.goto(address);
    const row = page.getByRole("table").getByRole("row").filter({ hasText: t("catalog.detail.onlyVariant") });
    await expect(row.getByRole("cell")).toHaveText([/.+/, "10", "0", "10"]);
    await expectNoSidewaysScroll(page, "product screen (manager)");

    // ---- 1. Add, received, 5: preview, then on hand 15 --------------------------------------------
    let sheet = await openSheet(manager, "add", "received");
    await quantity(sheet).fill("5");
    await expect(sheet.getByText(t("catalog.adjust.preview", { onHand: "15", available: "15" }))).toBeVisible();
    await expectNoSidewaysScroll(page, "adjust sheet");
    await save(sheet).click();
    await expect(page.getByText(savedText(15))).toBeVisible();
    await expect(row.getByRole("cell")).toHaveText([/.+/, "15", "0", "15"]);

    // ---- 2. Remove, damaged, 1 (typed in Arabic-Indic digits): on hand 14 --------------------------
    sheet = await openSheet(manager, "remove", "damaged");
    await quantity(sheet).fill("١");
    await expect(sheet.getByText(t("catalog.adjust.preview", { onHand: "14", available: "14" }))).toBeVisible();
    await save(sheet).click();
    await expect(page.getByText(savedText(14))).toBeVisible();

    // ---- 3. Set count 12: recorded as −2 with counted 12 ---------------------------------------------
    sheet = await openSheet(manager, "count");
    await sheet.getByLabel(t("catalog.adjust.counted"), { exact: true }).fill("12");
    await expect(sheet.getByText(t("catalog.adjust.previewCount", { change: "−2", onHand: "12", available: "12" }))).toBeVisible();
    await save(sheet).click();
    await expect(page.getByText(savedText(12))).toBeVisible();
    await expect(row.getByRole("cell")).toHaveText([/.+/, "12", "0", "12"]);

    // ---- 4. The stock history: four movements, newest first, summing to 12 -------------------------
    const recorded = await movements();
    expect(recorded.map((m) => [m.reason, m.quantity, m.on_hand_after])).toEqual([
      ["count_correction", -2, 12],
      ["damaged", -1, 14],
      ["received", 5, 15],
      ["opening", 10, 10],
    ]);
    expect(recorded[0]?.counted_quantity).toBe(12);
    expect(recorded.reduce((sum, m) => sum + m.quantity, 0)).toBe(12);

    sheet = await openSheet(manager, "add");
    await sheet.getByRole("link", { name: t("catalog.adjust.history") }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/more/catalog/${product.id}/variants/${variantId}/history$`));
    await expect(page.getByRole("heading", { name: t("catalog.history.title") }).or(page.getByText(t("catalog.history.title")).first())).toBeVisible();
    const items = page.locator("section ul > li");
    await expect(items).toHaveCount(4);
    for (const [reason, change] of [
      ["count_correction", "−2"],
      ["damaged", "−1"],
      ["received", "+5"],
      ["opening", "+10"],
    ] as const) {
      await expect(items.filter({ hasText: t(`catalog.reasons.${reason}`) })).toContainText(change);
    }
    await expect(items.first()).toContainText(t("catalog.history.counted", { n: "12" }));
    await expect(page.getByText(t("catalog.history.end"))).toBeVisible();
    await expectNoSidewaysScroll(page, "stock history");

    // ---- 5. Two sheets open: the second save is refused with the new numbers, then goes through ------
    const second: Person = { context: manager.context, page: await manager.context.newPage() };
    await page.goto(address);
    await second.page.goto(address);
    const sheetA = await openSheet(manager, "add", "received");
    const sheetB = await openSheet(second, "add", "received");
    await quantity(sheetA).fill("1");
    await quantity(sheetB).fill("1");
    await save(sheetA).click();
    await expect(page.getByText(savedText(13))).toBeVisible();
    await save(sheetB).click();
    await expect(sheetB.getByText(t("catalog.adjust.changed"))).toBeVisible();
    await expect(sheetB.getByRole("group", { name: t("catalog.adjust.numbers") })).toContainText("13");
    await expect(sheetB.getByText(t("catalog.adjust.preview", { onHand: "14", available: "14" }))).toBeVisible();
    expect(await onHand()).toBe(13);
    await save(sheetB).click(); // knowingly, with the new numbers
    await expect(second.page.getByText(savedText(14))).toBeVisible();
    expect(await onHand()).toBe(14);
    await second.page.close();

    // ---- 6. Remove 20 is refused: no more than is on hand ---------------------------------------------
    await page.reload();
    sheet = await openSheet(manager, "remove", "damaged");
    await quantity(sheet).fill("20");
    await save(sheet).click();
    await expect(sheet.getByText(t("catalog.adjust.fe.maxRemoveAll", { max: "14" }))).toBeVisible();
    await expect(sheet).toBeVisible();
    expect(await onHand()).toBe(14);
    const tooMany = await page.request.post(`/api/v1/catalog/variants/${variantId}/adjustments`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { reason: "damaged", quantity: 20, balance_version: product.variants[0]?.stock.version ?? 0 },
    });
    expect(tooMany.status()).toBeGreaterThanOrEqual(400);
    expect(tooMany.status()).toBeLessThan(500);
    expect(await onHand()).toBe(14);
    await sheet.getByRole("button", { name: t("ui.close") }).click().catch(() => undefined);

    // ---- 7. A double tap on Save records one movement ------------------------------------------------
    await page.reload();
    const before = (await movements()).length;
    sheet = await openSheet(manager, "add", "found");
    await quantity(sheet).fill("2");
    await save(sheet).dblclick();
    await expect(page.getByText(savedText(16))).toBeVisible();
    await page.waitForTimeout(1500); // a second request, if any, would have been answered by now
    expect((await movements()).length).toBe(before + 1);
    expect(await onHand()).toBe(16);

    // ---- 8. The packing agent's direct POST answers 403 and changes nothing -------------------------
    const packing = await world.staff("packing", [world.storeA.id]);
    const refused = await packing.page.request.post(`/api/v1/catalog/variants/${variantId}/adjustments`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { reason: "received", quantity: 1, balance_version: 0 },
    });
    expect(refused.status()).toBe(403);
    expect(await onHand()).toBe(16);
  } finally {
    await world.close();
  }
});
