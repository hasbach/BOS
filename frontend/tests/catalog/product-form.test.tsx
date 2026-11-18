import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditProduct, NewProduct } from "@/app/[locale]/(shell)/more/catalog/ProductForm";

import { JEANS, catalogApi, catalogOwner, catalogStaff } from "../helpers/catalog";
import type { Call } from "../helpers/fetch";
import { apiError, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";
import { imageFile, installFakeXhr, lastUpload } from "../helpers/stores";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => {
  resetNavigation("/more/catalog/new");
  installFakeXhr();
});
afterEach(() => vi.unstubAllGlobals());

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");
const saveButton = () => screen.getByRole("button", { name: "Save product" });

async function openNew(locale: "en" | "ar" = "en") {
  const me = catalogOwner({ user: { ...catalogOwner().user, locale } });
  renderMe(<NewProduct />, me, locale);
  await screen.findByLabelText(locale === "en" ? "Product code" : ar.catalog.form.code);
}

function addOption() {
  fireEvent.click(screen.getByRole("button", { name: /Add an option/ }));
}

function nameOption(n: number, name: string) {
  fireEvent.change(screen.getAllByLabelText("Option name")[n - 1]!, { target: { value: name } });
}

function addValue(n: number, label: string) {
  const input = screen.getByLabelText(`Add a value to option ${n}`);
  fireEvent.change(input, { target: { value: label } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function fillBasics() {
  type("Name in English", "Slim blue jeans");
  type("Product code", "JN-SLIM");
  type("Price", "45");
}

const created = (over: Partial<typeof JEANS> = {}) => reply(201, { ...JEANS, id: "p-new", ...over });

describe("product form: create (screens 164 to 173)", () => {
  it("builds one variant per combination of option values and follows the values", async () => {
    catalogApi(() => reply(404));
    await openNew();
    addOption();
    nameOption(1, "Size");
    addValue(1, "30");
    addValue(1, "32");
    addOption();
    nameOption(2, "Color");
    addValue(2, "Blue");
    addValue(2, "Black");
    expect(screen.getByText("2 × 2 = 4 variants. Each gets its own SKU and stock.")).toBeInTheDocument();
    for (const name of ["30 · Blue", "30 · Black", "32 · Blue", "32 · Black"]) expect(screen.getByLabelText(`Opening stock for ${name}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove 32" }));
    expect(screen.queryByLabelText("Opening stock for 32 · Blue")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Opening stock for 30 · Black")).toBeInTheDocument();
    expect(screen.getByText("2 variants · 0 units of opening stock")).toBeInTheDocument();
  });

  it("applies one price to every variant, accepts Arabic-Indic digits, and leaves an empty SKU to the server", async () => {
    const calls = catalogApi(() => created());
    await openNew();
    type("Name in English", "Slim blue jeans");
    type("Product code", "JN-SLIM");
    type("Price", "٤٥٫٥٠");
    addOption();
    nameOption(1, "Size");
    addValue(1, "30");
    addValue(1, "32");
    type("Opening stock for 30", "٣");
    type("Opening stock for 32", "12");
    expect(screen.getByText("2 variants · 15 units of opening stock")).toBeInTheDocument();
    fireEvent.click(saveButton());

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const call = writes(calls)[0]!;
    expect(call).toMatchObject({ url: "/api/v1/catalog/products", method: "POST" });
    expect(call.body).toMatchObject({
      code: "JN-SLIM",
      name_en: "Slim blue jeans",
      name_ar: null,
      store_ids: ["st-a", "st-b"],
      photo_ids: [],
      options: [{ name: "Size", values: [{ label: "30" }, { label: "32" }] }],
      variants: [
        { option_values: ["30"], sku: null, price: "45.50", currency: "USD", low_stock_level: null, photo_id: null, opening_quantity: 3 },
        { option_values: ["32"], sku: null, price: "45.50", currency: "USD", low_stock_level: null, photo_id: null, opening_quantity: 12 },
      ],
    });
  });

  it("shows the approximate other currency and refuses decimals in an LBP price", async () => {
    const calls = catalogApi(() => created());
    await openNew();
    fillBasics();
    expect(await screen.findByText(/≈ LBP 4,027,500 at 89,500 LBP per USD/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Currency" })).getByRole("radio", { name: "LBP" }));
    type("Price", "1,200,000.5");
    fireEvent.click(saveButton());
    expect(screen.getByLabelText("Price")).toHaveAccessibleDescription(/whole pounds/);
    expect(writes(calls)).toHaveLength(0);
  });

  it("shows the server's field errors next to their fields, dotted paths included", async () => {
    catalogApi(() => apiError(400, "validation_failed", { code: "invalid", "variants.0.sku": "invalid", "variants.0.opening_quantity": "too_large" }));
    await openNew();
    fillBasics();
    type("SKU (optional)", "JN-SLIM-X");
    fireEvent.click(saveButton());
    expect(await screen.findByText("3 things to fix before saving.")).toBeInTheDocument();
    expect(screen.getByLabelText("Product code")).toHaveAccessibleDescription(/Use only letters A–Z, digits and - _ \. \/ with no spaces/);
    expect(screen.getByLabelText("SKU (optional)")).toHaveAccessibleDescription(/up to 64/);
    expect(screen.getByLabelText("Opening stock")).toHaveAccessibleDescription(/whole number from 0 to 1,000,000/);
    expect(screen.getByLabelText("Name in English")).toHaveValue("Slim blue jeans");
  });

  it("puts a used SKU on its variant row with the product that has it", async () => {
    catalogApi(() =>
      reply(409, {
        error: {
          code: "sku_in_use",
          message: "x",
          fields: { "variants.1.sku": "in_use" },
          conflicts: [{ sku: "JN-SLIM-32", product_id: "p-wide", product_name: "Wide-leg black jeans" }],
        },
      }),
    );
    await openNew();
    fillBasics();
    addOption();
    nameOption(1, "Size");
    addValue(1, "30");
    addValue(1, "32");
    fireEvent.click(saveButton());
    expect(await screen.findByText("Not saved. 1 SKU is already used in your business.")).toBeInTheDocument();
    expect(screen.getByText("Already used by Wide-leg black jeans. Use a different SKU, or clear it for an automatic one.")).toBeInTheDocument();
  });

  it("checks the basics before calling the server", async () => {
    const calls = catalogApi(() => created());
    await openNew();
    type("Product code", "JN SLIM");
    type("Price", "45");
    fireEvent.click(saveButton());
    expect(screen.getByText("2 things to fix before saving.")).toBeInTheDocument();
    expect(screen.getByLabelText("Name in English")).toHaveAccessibleDescription(/Enter a name in English or in Arabic/);
    expect(writes(calls)).toHaveLength(0);
  });

  it("shows nothing as saved before the server confirms, then opens the product", async () => {
    let release: (response: Response) => void = () => {};
    const calls = catalogApi(() => new Promise<Response>((resolve) => (release = resolve)));
    await openNew();
    fillBasics();
    fireEvent.click(saveButton());
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();

    release(created());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/more/catalog/p-new?saved=created"));
  });

  it("sends the same Idempotency-Key when a save that got no answer is tried again", async () => {
    let fail = true;
    const calls = catalogApi(() => (fail ? networkFailure() : created()));
    await openNew();
    fillBasics();
    fireEvent.click(saveButton());
    expect(await screen.findByText(/Nothing was saved/)).toBeInTheDocument();
    expect(screen.getByLabelText("Product code")).toHaveValue("JN-SLIM");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    const keys = writes(calls).map((call) => call.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("uploads a photo as soon as it is picked and sends its id with the product", async () => {
    const calls = catalogApi(() => created());
    await openNew();
    fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [imageFile("front.jpg", "image/jpeg")] } });
    const xhr = lastUpload();
    expect(xhr).toMatchObject({ method: "POST", url: "/api/v1/catalog/photos" });
    xhr.progress(6, 10);
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60"));
    expect(screen.getByRole("button", { name: "Waiting for 1 photo…" })).toBeDisabled();
    xhr.respond(201, { id: "ph-new", width: 1080, height: 1080 });
    expect(await screen.findByText("Main")).toBeInTheDocument();
    fillBasics();
    fireEvent.click(saveButton());
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toMatchObject({ photo_ids: ["ph-new"] });
  });

  it("keeps the form when a photo fails to upload and offers retry", async () => {
    const calls = catalogApi(() => created());
    await openNew();
    fillBasics();
    fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [imageFile("front.jpg", "image/jpeg")] } });
    lastUpload().fail();
    expect(await screen.findByText(/1 photo didn’t upload/)).toBeInTheDocument();
    expect(screen.getByLabelText("Name in English")).toHaveValue("Slim blue jeans");
    // Save waits for the failed photo to be retried or removed (screen 171).
    expect(screen.getByRole("button", { name: "Waiting for 1 photo…" })).toBeDisabled();
    expect(writes(calls)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    lastUpload().respond(201, { id: "ph-again", width: 10, height: 10 });
    await screen.findByText("Main");
    fireEvent.click(saveButton());
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toMatchObject({ photo_ids: ["ph-again"] });
  });

  it("refuses a file that is not an image without uploading it, and it blocks saving until removed", async () => {
    const calls = catalogApi(() => created());
    await openNew();
    fillBasics();
    const before = (await import("../helpers/stores")).FakeXhr.instances.length;
    fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [imageFile("IMG_2231.heic", "image/heic")] } });
    expect((await import("../helpers/stores")).FakeXhr.instances.length).toBe(before);
    expect(screen.getByText("IMG_2231.heic is not a PNG, JPEG or WebP image. Remove it to save.")).toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(screen.getByText("1 thing to fix before saving.")).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
  });

  it("shows a photo the server refused as a field error", async () => {
    catalogApi(() => created());
    await openNew();
    fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [imageFile("big.png", "image/png")] } });
    lastUpload().respond(400, { error: { code: "file_too_large", message: "x", fields: {} } });
    expect(await screen.findByText("big.png is over 5 MB. Remove it to save.")).toBeInTheDocument();
  });

  it("is only for owners and managers", async () => {
    catalogApi(() => reply(404));
    renderMe(<NewProduct />, catalogStaff());
    expect(screen.getByText("Only owners and managers can change products")).toBeInTheDocument();
  });

  it("is available in Arabic", async () => {
    catalogApi(() => reply(404));
    await openNew("ar");
    expect(screen.getByRole("heading", { level: 1, name: ar.catalog.form.addTitle })).toBeInTheDocument();
    expect(screen.getByLabelText(ar.catalog.form.nameAr)).toBeInTheDocument();
  });
});

describe("product form: edit (screens 174 and 175)", () => {
  function serveEdit(onWrite: (call: Call) => Response | Promise<Response>) {
    return catalogApi((call) => {
      if (call.method === "GET" && call.url === "/api/v1/catalog/products/p-jeans") return reply(200, JEANS);
      return onWrite(call);
    });
  }

  async function openEdit() {
    renderMe(<EditProduct productId="p-jeans" />, catalogOwner());
    await screen.findByLabelText("Product code");
  }

  it("fills the form and sends the version, existing ids and no opening quantity", async () => {
    const calls = serveEdit(() => reply(200, { ...JEANS, version: 5 }));
    await openEdit();
    expect(screen.getByLabelText("Product code")).toHaveValue("JN-SLIM");
    expect(screen.getByLabelText("Price")).toHaveValue("45.00");
    addValue(1, "36");
    expect(screen.getByText("36 · Blue")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Opening stock for/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const body = writes(calls)[0]!.body as { version: number; options: unknown[]; variants: Array<Record<string, unknown>> };
    expect(writes(calls)[0]).toMatchObject({ url: "/api/v1/catalog/products/p-jeans", method: "PUT" });
    expect(body.version).toBe(4);
    expect(body.options[0]).toEqual({ id: "o-size", name: "Size", values: [{ id: "val-30", label: "30" }, { id: "val-32", label: "32" }, { id: "val-34", label: "34" }, { label: "36" }] });
    expect(body.variants.map((v) => v.id ?? null)).toEqual(["v-30", "v-32", "v-34", null]);
    expect(body.variants.every((v) => !("opening_quantity" in v))).toBe(true);
    expect(body.variants[0]).toMatchObject({ sku: "JN-SLIM-30-BLUE", price: "45.00", status: "active" });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/more/catalog/p-jeans?saved=updated"));
  });

  it("marks removed values whose variants have history as to be archived", async () => {
    serveEdit(() => reply(200, JEANS));
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Remove 34" }));
    expect(screen.getByText("34 has stock history: its variants will be archived, not deleted.")).toBeInTheDocument();
    expect(screen.getByText("Will be archived")).toBeInTheDocument();
    expect(screen.getByText("No new variants · 1 to archive")).toBeInTheDocument();
  });

  it("shows the current product and its version after product_changed, and saves with that version", async () => {
    let first = true;
    const calls = serveEdit(() => {
      if (first) {
        first = false;
        return reply(409, { error: { code: "product_changed", message: "x", fields: {}, current: { ...JEANS, name_en: "Slim jeans by Karim", version: 7 } } });
      }
      return reply(200, { ...JEANS, version: 8 });
    });
    await openEdit();
    type("Name in English", "My change");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Not saved\. Someone else changed this product at/)).toBeInTheDocument();
    expect(screen.getByLabelText("Name in English")).toHaveValue("Slim jeans by Karim");
    expect(router.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect((writes(calls)[1]!.body as { version: number }).version).toBe(7);
  });
});
