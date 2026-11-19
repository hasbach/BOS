import { expect, test, text } from "./fixtures";
import type { Locale } from "./fixtures";
import { PNG, catalogWorld, escapeRegExp, expectNoSidewaysScroll, fixedPart } from "./m1-fixtures";

// M1 User Story 1 (T044, quickstart scenario 1): the owner builds a product with two options on the
// phone (quantities typed in Arabic-Indic digits, two photos, listed in Store A only); a Store A sales
// agent finds it by name, code part and SKU part; a Store B agent does not, and its address answers
// "not found"; the packing agent sees no edit controls and is refused by the API; removing a size
// archives its variants and restoring them from the form brings the size back; archiving the product
// hides it from the Store A agent. No catalog screen scrolls sideways at 360 px. Runs once per
// language project (en, ar), each time on a business of its own.

interface ProductBody {
  id: string;
  version: number;
  status: string;
  store_ids: string[];
  photos: Array<{ id: string }>;
  options: Array<{ name: string; values: Array<{ label: string }> }>;
  variants: Array<{ id: string; sku: string; status: string; option_values: string[]; price: string; currency: string; stock: { on_hand: number; allocated: number; available: number } }>;
}

const SIZES = ["30", "32", "34"];
const COLOURS = ["Blue", "Black"];

test("owner builds a product; agents find it only in their store; packing cannot edit; variants restore; archive hides it", async ({
  browser,
  baseURL,
  env,
  locale,
}) => {
  const origin = baseURL ?? "";
  const t = (key: string, values?: Record<string, string>) => text(locale as Locale, key, values);
  const world = await catalogWorld(browser, origin, env, locale as Locale);
  const owner = world.owner.page;

  try {
    // ---- 1. More -> Catalog -> Add product -----------------------------------------------------------
    await owner.goto(`/${locale}/more`);
    await owner.getByRole("link", { name: t("more.catalog") }).click();
    await expect(owner).toHaveURL(new RegExp(`/${locale}/more/catalog$`));
    await expect(owner.getByRole("heading", { name: t("catalog.empty.title") })).toBeVisible();
    await expectNoSidewaysScroll(owner, "empty catalog");
    await owner.getByRole("link", { name: t("catalog.add") }).first().click();
    await expect(owner).toHaveURL(new RegExp(`/${locale}/more/catalog/new$`));

    // ---- 2. JN-TEST, sizes 30/32/34 x Blue/Black, 45 USD, 5 of each typed as "٥", Store A only --------
    await owner.getByLabel(t("catalog.form.nameEn"), { exact: true }).fill("Test jeans");
    await owner.getByLabel(t("catalog.form.nameAr"), { exact: true }).fill("جينز تجريبي");
    await owner.getByLabel(t("catalog.form.code"), { exact: true }).fill("JN-TEST");

    await owner.getByTestId("photo-input").setInputFiles([
      { name: "front.png", mimeType: "image/png", buffer: PNG },
      { name: "back.png", mimeType: "image/png", buffer: PNG },
    ]);

    const storeB = owner.getByRole("checkbox", { name: world.storeB.name, exact: true });
    await expect(owner.getByRole("checkbox", { name: world.storeA.name, exact: true })).toBeChecked();
    await expect(storeB).toBeChecked();
    await storeB.uncheck();
    await expect(storeB).not.toBeChecked();

    const addOption = owner.getByRole("button", { name: t("catalog.form.options.addOption") });
    for (const [n, name, values] of [
      [1, "Size", SIZES],
      [2, "Colour", COLOURS],
    ] as const) {
      await addOption.click();
      await owner.getByLabel(t("catalog.form.options.name"), { exact: true }).nth(n - 1).fill(name);
      const adding = owner.getByLabel(t("catalog.form.options.addValue", { n: String(n) }), { exact: true });
      for (const value of values) {
        await adding.fill(value);
        await adding.press("Enter");
      }
    }
    await owner.getByLabel(t("catalog.form.price"), { exact: true }).fill("45");
    for (const size of SIZES) {
      for (const colour of COLOURS) {
        await owner.getByLabel(t("catalog.form.openingFor", { variant: `${size} · ${colour}` }), { exact: true }).fill("٥");
      }
    }
    // Both photos uploaded: each tile is a button named "Photo n" once its upload is done.
    for (const n of ["1", "2"]) await expect(owner.getByRole("button", { name: t("catalog.form.photos.photo", { n }), exact: true })).toBeVisible();
    await expectNoSidewaysScroll(owner, "add product form");
    await owner.getByRole("button", { name: t("catalog.form.save"), exact: true }).click();

    // ---- 3. The product: six variants with SKUs from the code, 5 / 0 / 5 each, price ≈ LBP -----------
    await expect(owner).toHaveURL(new RegExp(`/${locale}/more/catalog/[0-9a-f-]{36}\\?saved=created$`));
    const productId = /catalog\/([0-9a-f-]{36})/.exec(owner.url())?.[1] ?? "";
    await expect(owner.getByRole("alert").filter({ hasText: /6/ })).toBeVisible();
    const table = owner.getByRole("table").first();
    for (const size of SIZES) {
      for (const colour of COLOURS) await expect(table.getByText(`JN-TEST-${size}-${colour.toUpperCase()}`, { exact: true })).toBeVisible();
    }
    const firstRow = table.getByRole("row").filter({ hasText: `${SIZES[0]} · ${COLOURS[0]}` }).first();
    await expect(firstRow.getByRole("cell")).toHaveText([new RegExp(escapeRegExp(`${SIZES[0]} · ${COLOURS[0]}`)), "5", "0", "5"]);
    const approx = fixedPart((values) => t("catalog.detail.approx", values), "amount", "rate");
    await expect(owner.getByText(new RegExp(escapeRegExp(approx)))).toBeVisible();
    await expect(owner.getByRole("img", { name: t("catalog.detail.photoOf", { n: "1", count: "2" }) })).toBeVisible();
    await expectNoSidewaysScroll(owner, "product screen");

    const saved = (await (await owner.request.get(`/api/v1/catalog/products/${productId}`)).json()) as ProductBody;
    expect(saved.store_ids).toEqual([world.storeA.id]);
    expect(saved.photos).toHaveLength(2);
    expect(saved.variants).toHaveLength(6);
    for (const variant of saved.variants) {
      expect(variant.stock).toMatchObject({ on_hand: 5, allocated: 0, available: 5 });
      expect([variant.price, variant.currency]).toEqual(["45.00", "USD"]);
    }

    // ---- 4. The Store A sales agent finds it by name, code part and SKU part ------------------------
    const agentA = await world.staff("sales", [world.storeA.id]);
    await agentA.page.goto(`/${locale}/more/catalog`);
    const search = agentA.page.getByRole("searchbox", { name: t("catalog.search") }).or(agentA.page.getByLabel(t("catalog.search"), { exact: true }));
    const productLink = agentA.page.locator(`a[href$="/more/catalog/${productId}"]`);
    for (const query of ["test", "jn-te", "32-BLU"]) {
      await search.first().fill(query);
      await expect(productLink).toBeVisible();
      await expect(agentA.page.getByRole("heading", { name: t("catalog.noMatch.title") })).toHaveCount(0);
    }
    await expectNoSidewaysScroll(agentA.page, "catalog search (Store A agent)");
    await productLink.click();
    await expect(agentA.page.getByText("JN-TEST-32-BLUE", { exact: true })).toBeVisible();
    await expect(agentA.page.getByRole("link", { name: t("catalog.detail.edit") })).toHaveCount(0);
    await expectNoSidewaysScroll(agentA.page, "product screen (Store A agent)");

    // ---- 5. A Store B agent does not find it, and its address answers "not found" -------------------
    const agentB = await world.staff("sales", [world.storeB.id]);
    await agentB.page.goto(`/${locale}/more/catalog`);
    const searchB = agentB.page.getByLabel(t("catalog.search"), { exact: true });
    await searchB.fill("test");
    await expect(agentB.page.getByRole("heading", { name: t("catalog.noMatch.title") })).toBeVisible();
    await expect(agentB.page.locator(`a[href$="/more/catalog/${productId}"]`)).toHaveCount(0);
    await agentB.page.goto(`/${locale}/more/catalog/${productId}`);
    await expect(agentB.page.getByText(t("catalog.notFound.title"), { exact: true }).first()).toBeVisible();
    await expectNoSidewaysScroll(agentB.page, "not found (Store B agent)");
    expect((await agentB.page.request.get(`/api/v1/catalog/products/${productId}`)).status()).toBe(404);

    // ---- 6. The packing agent sees no edit or adjust controls and the API refuses a change ----------
    const packing = await world.staff("packing", [world.storeA.id]);
    await packing.page.goto(`/${locale}/more/catalog/${productId}`);
    await expect(packing.page.getByText("JN-TEST-30-BLUE", { exact: true })).toBeVisible();
    for (const name of [t("catalog.detail.edit"), t("catalog.detail.adjust"), t("catalog.detail.archive")]) {
      await expect(packing.page.getByRole("link", { name })).toHaveCount(0);
      await expect(packing.page.getByRole("button", { name })).toHaveCount(0);
    }
    await expectNoSidewaysScroll(packing.page, "product screen (packing agent)");
    await packing.page.goto(`/${locale}/more/catalog/${productId}/edit`);
    await expect(packing.page.getByText(t("catalog.notAllowed.title"))).toBeVisible();
    const put = await packing.page.request.put(`/api/v1/catalog/products/${productId}`, {
      data: { code: "JN-TEST", name_en: "Hacked", store_ids: saved.store_ids, photo_ids: [], options: [], variants: [], version: saved.version },
    });
    expect(put.status()).toBe(403);

    // ---- 7. Removing size 34 archives its variants; restoring them from the form brings 34 back -----
    await owner.goto(`/${locale}/more/catalog/${productId}/edit`);
    await owner.getByRole("button", { name: t("catalog.form.options.removeValue", { value: "34" }), exact: true }).click();
    await expect(owner.getByText(t("catalog.form.options.willArchive", { value: "34" }))).toBeVisible();
    await expectNoSidewaysScroll(owner, "edit product form");
    await owner.getByRole("button", { name: t("catalog.form.saveChanges"), exact: true }).click();
    await expect(owner).toHaveURL(new RegExp(`/${locale}/more/catalog/${productId}\\?saved=updated$`));
    await expect(owner.getByText(`${t("catalog.detail.archivedVariants")} · 2`)).toBeVisible();
    let current = (await (await owner.request.get(`/api/v1/catalog/products/${productId}`)).json()) as ProductBody;
    expect(current.options[0]?.values.map((v) => v.label)).toEqual(["30", "32"]);
    expect(current.variants.filter((v) => v.status === "archived").map((v) => v.sku).sort()).toEqual(["JN-TEST-34-BLACK", "JN-TEST-34-BLUE"]);

    await owner.goto(`/${locale}/more/catalog/${productId}/edit`);
    await expect(owner.getByText(`${t("catalog.form.archivedVariants")} · 2`)).toBeVisible();
    for (const colour of COLOURS) {
      const restore = owner.getByRole("button", { name: t("catalog.form.restoreVariantOf", { variant: `34 · ${colour}` }), exact: true });
      await restore.click();
      await expect(restore).toHaveAttribute("aria-pressed", "true");
    }
    await owner.getByRole("button", { name: t("catalog.form.saveChanges"), exact: true }).click();
    await expect(owner).toHaveURL(new RegExp(`/${locale}/more/catalog/${productId}\\?saved=updated$`));
    await expect(owner.getByText(`${t("catalog.detail.variants")} · 6`)).toBeVisible();
    await expect(owner.getByText(t("catalog.detail.archivedVariants"))).toHaveCount(0);
    current = (await (await owner.request.get(`/api/v1/catalog/products/${productId}`)).json()) as ProductBody;
    expect(current.options[0]?.values.map((v) => v.label)).toEqual(["30", "32", "34"]);
    expect(current.variants.every((v) => v.status === "active")).toBe(true);
    // The same inventory items came back, with their stock.
    for (const sku of ["JN-TEST-34-BLUE", "JN-TEST-34-BLACK"]) {
      expect(current.variants.find((v) => v.sku === sku)?.stock.on_hand).toBe(5);
    }

    // ---- 8. Archive: gone from the Store A agent's search and address; kept for the owner ------------
    await owner.getByRole("button", { name: t("catalog.detail.archive") }).click();
    const sheet = owner.getByRole("dialog");
    await sheet.getByRole("button", { name: t("catalog.detail.archiveConfirm"), exact: true }).click();
    await expect(owner.getByText(t("catalog.detail.archivedBanner"))).toBeVisible();
    await expect(owner.getByRole("button", { name: t("catalog.detail.restore") })).toBeVisible();

    await agentA.page.goto(`/${locale}/more/catalog`);
    await agentA.page.getByLabel(t("catalog.search"), { exact: true }).fill("test");
    await expect(agentA.page.getByRole("heading", { name: t("catalog.noMatch.title") })).toBeVisible();
    await expect(agentA.page.locator(`a[href$="/more/catalog/${productId}"]`)).toHaveCount(0);
    await agentA.page.goto(`/${locale}/more/catalog/${productId}`);
    await expect(agentA.page.getByText(t("catalog.notFound.title"), { exact: true }).first()).toBeVisible();

    // Its SKUs stay taken: a new product cannot reuse one (SC-004).
    const reuse = await owner.request.post("/api/v1/catalog/products", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        code: "JN-TEST2",
        name_en: "Second",
        store_ids: [world.storeA.id],
        photo_ids: [],
        options: [],
        variants: [{ option_values: [], sku: " jn-test-32-blue ", price: "10", currency: "USD", low_stock_level: null, photo_id: null, opening_quantity: 0 }],
      },
    });
    expect(reuse.status()).toBe(409);
    expect(((await reuse.json()) as { error: { code: string } }).error.code).toBe("sku_in_use");
  } finally {
    await world.close();
  }
});
