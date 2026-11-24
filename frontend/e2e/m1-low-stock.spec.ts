import { expect, test, text } from "./fixtures";
import { catalogWorld, expectNoSidewaysScroll } from "./m1-fixtures";

test("stock adjustments update warnings and sales staff only see catalog chips", async ({ browser, baseURL, env, locale }) => {
  const world = await catalogWorld(browser, baseURL ?? "", env, locale);
  const { page, context } = world.owner;
  const api = context.request;
  const t = (key: string) => text(locale, key);
  const catalog = `/${locale}/more/catalog`;

  async function create(code: string, level: number, quantity: number) {
    const response = await api.post("/api/v1/catalog/products", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        code, name_en: code, name_ar: code, store_ids: [world.storeA.id], photo_ids: [], options: [],
        variants: [{ option_values: [], sku: code, price: "12", currency: "USD", low_stock_level: level, photo_id: null, opening_quantity: quantity }],
      },
    });
    expect(response.status()).toBe(201);
    return await response.json() as { id: string; variants: [{ id: string; stock: { version: number } }] };
  }

  try {
    await page.goto(`/${locale}/more/settings`);
    await expect(page.getByLabel(t("settings.low"))).toHaveValue("2");
    const adjustable = await create("LOW-ADJUST", 3, 5);
    const disabled = await create("LOW-DISABLED", 0, 0);
    await create("LOW-OUT", 2, 0);
    const variant = adjustable.variants[0];
    let version = variant.stock.version;
    async function adjust(reason: "damaged" | "received", quantity: number) {
      const reply = await api.post(`/api/v1/catalog/variants/${variant.id}/adjustments`, {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        data: { reason, quantity, balance_version: version },
      });
      expect(reply.status()).toBe(201);
      version = (await reply.json()).balance.version;
    }

    await adjust("damaged", 2);
    await page.goto(`${catalog}/low-stock`);
    const list = page.getByRole("list", { name: t("catalog.lowStock.title") });
    const rows = list.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("LOW-OUT");
    await expect(rows.last()).toContainText("LOW-ADJUST");
    await expect(rows.last()).toContainText(t("catalog.stock.low"));
    await expect(list).not.toContainText("LOW-DISABLED");
    await expectNoSidewaysScroll(page, "low-stock list");

    const sales = await world.staff("sales", [world.storeA.id]);
    await sales.page.goto(`${catalog}/${disabled.id}`);
    await expect(sales.page.getByText(t("catalog.stock.out"), { exact: true }).first()).toBeVisible();
    await sales.page.goto(catalog);
    await expect(sales.page.getByText(t("catalog.stock.low"), { exact: true }).first()).toBeVisible();
    await expect(sales.page.locator(`a[href='${catalog}/low-stock']`)).toHaveCount(0);
    expect((await sales.context.request.get("/api/v1/catalog/low-stock")).status()).toBe(403);

    await adjust("received", 4);
    await page.reload();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("LOW-OUT");
  } finally {
    await world.close();
  }
});
