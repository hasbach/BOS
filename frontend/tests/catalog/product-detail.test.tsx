import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductDetail } from "@/app/[locale]/(shell)/more/catalog/[productId]/ProductDetail";

import { JEANS, catalogApi, catalogOwner, catalogStaff, variant } from "../helpers/catalog";
import type { Call } from "../helpers/fetch";
import { apiError, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/catalog/p-jeans"));
afterEach(() => vi.unstubAllGlobals());

const BELT = {
  ...JEANS,
  id: "p-belt",
  code: "BL-LTH",
  name_en: "Leather belt",
  name_ar: "حزام جلد",
  photos: [],
  options: [],
  has_history: false,
  variants: [variant({ id: "v-belt", sku: "BL-LTH", option_values: [], price: "89500000", currency: "LBP", has_history: false, stock: { on_hand: 0, allocated: 0, available: 0, version: 1 }, stock_state: "out" })],
};

function serve(product = JEANS, other: (call: Call) => Response | Promise<Response> = () => reply(404)) {
  return catalogApi((call) => {
    if (call.method === "GET" && call.url === `/api/v1/catalog/products/${product.id}`) return reply(200, product);
    return other(call);
  });
}

const open = async (id = "p-jeans", me = catalogOwner(), locale: "en" | "ar" = "en", saved?: "created" | "updated") => {
  renderMe(<ProductDetail productId={id} saved={saved} />, me, locale);
  await screen.findByRole("table");
};

const rowOf = (name: string) => screen.getByRole("row", { name: new RegExp(name) });
const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");

describe("product detail (screens 140 to 145)", () => {
  it("shows each variant with its option values, SKU and on hand, reserved and available", async () => {
    serve();
    await open();
    expect(screen.getByRole("heading", { level: 1, name: "Slim blue jeans" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Variant", "On hand", "Reserved", "Available"]);
    const reserved = rowOf("32 · Blue");
    expect(within(reserved).getAllByRole("cell").slice(1).map((cell) => cell.textContent)).toEqual(["2", "1", "1"]);
    expect(within(reserved).getByText("Low")).toBeInTheDocument();
    expect(within(rowOf("34 · Blue")).getByText("Out")).toBeInTheDocument();
    expect(within(rowOf("30 · Blue")).queryByText(/Low|Out/)).not.toBeInTheDocument();
    expect(screen.getByText("JN-SLIM-32-BLUE")).toBeInTheDocument();
    expect(screen.getByText("Available = on hand − reserved")).toBeInTheDocument();
  });

  it("shows the large photo, the price with the approximate other currency, stores and code", async () => {
    serve();
    await open();
    expect(screen.getByRole("img", { name: "Photo 1 of 2" })).toHaveAttribute("src", "/api/v1/catalog/photos/ph-1/large");
    expect(screen.getByText("$45.00")).toBeInTheDocument();
    expect(await screen.findByText("≈ LBP 4,027,500 · approximate, at 89,500 LBP per USD")).toBeInTheDocument();
    expect(screen.getByText("Store A")).toBeInTheDocument();
    expect(screen.getByText("JN-SLIM")).toBeInTheDocument();
    expect(screen.getByText("Slim fit stretch denim, mid rise.")).toBeInTheDocument();
  });

  it("writes an LBP price of 89500000 with thousands separators in English and Arabic", async () => {
    serve(BELT);
    await open("p-belt");
    expect(screen.getByText("LBP 89,500,000")).toBeInTheDocument();
    expect(await screen.findByText(/≈ \$1,000\.00/)).toBeInTheDocument();
  });

  it("writes the LBP price in Arabic with Latin digits and separators", async () => {
    serve(BELT);
    await open("p-belt", catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }), "ar");
    expect(screen.getByText("89,500,000 ل.ل.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "حزام جلد" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: ar.catalog.stock.reserved })).toBeInTheDocument();
  });

  it("gives staff the same facts with no edit, archive, delete or adjust controls", async () => {
    serve();
    await open("p-jeans", catalogStaff());
    expect(rowOf("32 · Blue")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Edit product/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archive/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Adjust stock/)).not.toBeInTheDocument();
    expect(screen.queryByText("Product status")).not.toBeInTheDocument();
  });

  it("gives owners and managers Edit product and Archive, and Delete only for a product with no history", async () => {
    serve();
    await open();
    expect(screen.getAllByRole("link", { name: /Edit product/ })[0]).toHaveAttribute("href", "/more/catalog/p-jeans/edit");
    expect(screen.getByRole("button", { name: /Archive product/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete product/ })).not.toBeInTheDocument();
  });

  it("archives after confirming, with the version, and says so only after the server answers", async () => {
    let release: (response: Response) => void = () => {};
    const calls = serve(JEANS, () => new Promise<Response>((resolve) => (release = resolve)));
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Archive product/ }));
    const sheet = screen.getByRole("dialog", { name: "Archive Slim blue jeans?" });
    fireEvent.click(within(sheet).getByRole("button", { name: /^Archive$/ }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ url: "/api/v1/catalog/products/p-jeans/archive", method: "POST", body: { version: 4 } });
    expect(screen.queryByText(/Hidden from sales search/)).not.toBeInTheDocument();

    release(reply(200, { ...JEANS, status: "archived", version: 5 }));
    expect(await screen.findByText(/Archived\. Hidden from sales search/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restore product/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Edit product/ })).not.toBeInTheDocument();
  });

  it("says why archiving was refused when stock is reserved", async () => {
    serve(JEANS, () => apiError(409, "variant_has_allocations"));
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Archive product/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Archive$/ }));
    expect(await screen.findByText(/stock of this product is reserved/)).toBeInTheDocument();
  });

  it("shows the current product when someone else changed it", async () => {
    serve(JEANS, () => reply(409, { error: { code: "product_changed", message: "x", fields: {}, current: { ...JEANS, name_en: "Slim jeans (new)", version: 6 } } }));
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Archive product/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Archive$/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Slim jeans (new)" })).toBeInTheDocument();
    expect(screen.getByText(/Someone else changed this product/)).toBeInTheDocument();
  });

  it("deletes a product that never had stock and goes back to the catalog", async () => {
    const calls = serve(BELT, () => reply(204));
    await open("p-belt");
    fireEvent.click(screen.getByRole("button", { name: /Delete product/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete Leather belt?" })).getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/more/catalog"));
    expect(writes(calls)[0]).toMatchObject({ method: "DELETE", url: "/api/v1/catalog/products/p-belt?version=4" });
  });

  it("restores an archived product", async () => {
    const calls = serve({ ...JEANS, status: "archived" }, () => reply(200, { ...JEANS, version: 5 }));
    await open();
    expect(screen.getByText(/Archived\. Hidden from sales search/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Restore product/ }));
    expect(await screen.findByText("Restored. It is back in sales search.")).toBeInTheDocument();
    expect(writes(calls)[0]).toMatchObject({ url: "/api/v1/catalog/products/p-jeans/restore", body: { version: 4 } });
  });

  it("does not claim success when an action gets no answer", async () => {
    serve(JEANS, () => networkFailure());
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Archive product/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Archive$/ }));
    expect(await screen.findByText(/Nothing was saved/)).toBeInTheDocument();
    expect(screen.queryByText(/Archived\. Hidden/)).not.toBeInTheDocument();
  });

  it("shows the saved message after the form created the product", async () => {
    serve();
    await open("p-jeans", catalogOwner(), "en", "created");
    expect(screen.getByText("Saved. 3 variants and 5 units of opening stock.")).toBeInTheDocument();
  });

  it("shows Not found for a product outside the person's catalog (screen 145)", async () => {
    catalogApi(() => apiError(404, "not_found"));
    renderMe(<ProductDetail productId="p-gone" />, catalogStaff());
    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to catalog" })).toHaveAttribute("href", "/more/catalog");
  });

  it("offers a retry when the product could not load", async () => {
    let fail = true;
    catalogApi((call) => (fail ? networkFailure() : call.url.endsWith("/p-jeans") ? reply(200, JEANS) : reply(404)));
    renderMe(<ProductDetail productId="p-jeans" />, catalogOwner());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load this product");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });
});
