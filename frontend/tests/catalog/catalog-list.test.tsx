import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogList } from "@/app/[locale]/(shell)/more/catalog/CatalogList";

import { catalogOwner, catalogStaff, page, productCalls, queryOf, summary } from "../helpers/catalog";
import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/catalog"));
afterEach(() => vi.unstubAllGlobals());

const JEANS = summary({ id: "p-jeans" });
const TOTE = summary({
  id: "p-tote",
  code: "BG-TOTE",
  name_en: "Canvas tote bag",
  name_ar: null,
  main_photo_id: null,
  store_ids: ["st-a", "st-b"],
  variant_count: 1,
  available_total: 40,
  stock_state: "ok",
  prices: [{ currency: "LBP", min: "89500000", max: "89500000" }],
});
const WIDE = summary({ id: "p-wide", code: "JN-WIDE", name_en: "Wide-leg black jeans", store_ids: [], variant_count: 4, available_total: 0, stock_state: "out" });

const listed = () => screen.getByRole("list", { name: "Catalog" });

describe("catalog list (screens 132 to 139)", () => {
  it("shows each product with its photo, variant count, price, available total, stores and stock words", async () => {
    mockApi(() => reply(200, page([JEANS, TOTE, WIDE])));
    renderMe(<CatalogList />, catalogOwner());
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(3);

    const jeans = within(rows[0]!);
    expect(jeans.getByRole("link")).toHaveAttribute("href", "/more/catalog/p-jeans");
    expect(jeans.getByText("Slim blue jeans")).toBeInTheDocument();
    expect(jeans.getByText(/6 variants/)).toBeInTheDocument();
    expect(jeans.getByText("$45.00")).toBeInTheDocument();
    expect(jeans.getByText("16 available")).toBeInTheDocument();
    expect(jeans.getByText("Store A")).toBeInTheDocument();
    expect(jeans.getByText("Low")).toBeInTheDocument();
    expect(jeans.getByRole("img")).toHaveAttribute("src", "/api/v1/catalog/photos/ph-1/thumb");

    const tote = within(rows[1]!);
    expect(tote.getByText("LBP 89,500,000")).toBeInTheDocument();
    expect(tote.getByText("No photo")).toBeInTheDocument(); // the chip only owners and managers see
    expect(tote.getByText("Store B")).toBeInTheDocument();

    const wide = within(rows[2]!);
    expect(wide.getByText("Out")).toBeInTheDocument();
    expect(wide.getByText("No store")).toBeInTheDocument();
    expect(listed()).toBeInTheDocument();
  });

  it("shows the product name in the reader's language, or the other one when it is empty", async () => {
    mockApi(() => reply(200, page([JEANS, TOTE])));
    renderMe(<CatalogList />, catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }), "ar");
    expect(await screen.findByText("جينز أزرق ضيّق")).toBeInTheDocument();
    expect(screen.getByText("Canvas tote bag")).toBeInTheDocument();
    expect(screen.getByText("89,500,000 ل.ل.")).toBeInTheDocument();
  });

  it("searches by what was typed, with Arabic-Indic digits turned into 0-9", async () => {
    const calls = mockApi(() => reply(200, page([JEANS])));
    renderMe(<CatalogList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search name, code or SKU" }), { target: { value: "jn-٣٢" } });
    await waitFor(() => expect(productCalls(calls).length).toBe(2));
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ q: "jn-32" });

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(productCalls(calls).length).toBe(3));
    expect(queryOf(productCalls(calls)[2]!)).toEqual({});
  });

  it("offers a stock switch with the counts of the first page, as radios with arrow keys", async () => {
    const calls = mockApi(() => reply(200, page([JEANS])));
    renderMe(<CatalogList />, catalogOwner());
    const group = await screen.findByRole("radiogroup", { name: "Stock" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["All86", "In stock85", "Low3", "Out1"]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1]);

    fireEvent.click(radios[2]!);
    await waitFor(() => expect(productCalls(calls).length).toBe(2));
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ stock: "low" });
    expect(within(screen.getByRole("radiogroup", { name: "Stock" })).getAllByRole("radio")[2]).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(within(screen.getByRole("radiogroup", { name: "Stock" })).getAllByRole("radio")[2]!, { key: "ArrowRight" });
    await waitFor(() => expect(productCalls(calls).length).toBe(3));
    expect(queryOf(productCalls(calls)[2]!)).toEqual({ stock: "out" });
  });

  it("lists only the person's current stores (the fresh me.stores) in the store menu", async () => {
    const calls = mockApi(() => reply(200, page([JEANS])));
    const me = catalogOwner({
      stores: [
        { id: "st-a", name: "Store A", whatsapp_number: null, has_logo: false, status: "active" },
        { id: "st-n", name: "New Store", whatsapp_number: null, has_logo: false, status: "active" },
      ],
    });
    renderMe(<CatalogList />, me);
    await screen.findByText("Slim blue jeans");
    fireEvent.click(screen.getByRole("button", { name: /All stores/ }));
    const dialog = screen.getByRole("dialog", { name: "Store" });
    expect(within(dialog).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["All stores", "Store A", "New Store"]);
    fireEvent.click(within(dialog).getByRole("radio", { name: "New Store" }));
    await waitFor(() => expect(productCalls(calls).length).toBe(2));
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ store_id: "st-n" });
    expect(screen.getByRole("button", { name: /New Store/ })).toBeInTheDocument();
  });

  it("gives owners and managers archived and no-photo filters in More filters, with Clear", async () => {
    const calls = mockApi(() => reply(200, page([JEANS])));
    renderMe(<CatalogList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    const dialog = screen.getByRole("dialog", { name: "More filters" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archived products" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Only products without a photo/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Show results" }));
    await waitFor(() => expect(productCalls(calls).length).toBe(2));
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ status: "archived", no_photo: "true" });
    expect(screen.getByRole("button", { name: "Archived, no photo" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(productCalls(calls).length).toBe(3));
    expect(queryOf(productCalls(calls)[2]!)).toEqual({});
  });

  it("gives staff no More filters, no store menu for one store, no Add product and no no-photo chip", async () => {
    mockApi(() => reply(200, page([{ ...TOTE, store_ids: ["st-a"] }])));
    renderMe(<CatalogList />, catalogStaff());
    await screen.findByText("Canvas tote bag");
    expect(screen.queryByRole("button", { name: "More filters" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /All stores/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Add product")).not.toBeInTheDocument();
    expect(screen.queryByText("No photo")).not.toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Stock" })).toBeInTheDocument();
  });

  it("loads 20 more with the cursor and keeps the first ones", async () => {
    const second = summary({ id: "p-2", name_en: "Linen shirt" });
    const calls = mockApi((call) => reply(200, call.url.includes("cursor=") ? page([second], { counts: null }) : page([JEANS], { next_cursor: "c-2" })));
    renderMe(<CatalogList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Linen shirt")).toBeInTheDocument();
    expect(screen.getByText("Slim blue jeans")).toBeInTheDocument();
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ cursor: "c-2" });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    // The counts of the first page stay.
    expect(within(screen.getByRole("radiogroup", { name: "Stock" })).getAllByRole("radio")[0]).toHaveTextContent("86");
  });

  it("explains an empty catalog to an owner and to staff", async () => {
    mockApi(() => reply(200, page([], { counts: { all: 0, in_stock: 0, low: 0, out: 0 } })));
    renderMe(<CatalogList />, catalogOwner());
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    expect(screen.getByText(/Add your first product/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add product/ })).toHaveAttribute("href", "/more/catalog/new");
  });

  it("tells staff products appear when an owner or manager adds them", async () => {
    mockApi(() => reply(200, page([], { counts: { all: 0, in_stock: 0, low: 0, out: 0 } })));
    renderMe(<CatalogList />, catalogStaff());
    expect(await screen.findByText(/No products in your stores yet/)).toBeInTheDocument();
  });

  it("says nothing matches a search and offers to clear it", async () => {
    mockApi((call) => reply(200, call.url.includes("q=") ? page([], { counts: { all: 0, in_stock: 0, low: 0, out: 0 } }) : page([JEANS])));
    renderMe(<CatalogList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "linen dress" } });
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    expect(screen.getByText(/contains “linen dress”/)).toBeInTheDocument();
  });

  it("shows the could-not-load state with a retry that loads again", async () => {
    let fail = true;
    mockApi(() => (fail ? networkFailure() : reply(200, page([JEANS]))));
    renderMe(<CatalogList />, catalogOwner());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load the catalog");
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Slim blue jeans")).toBeInTheDocument();
  });

  it("shows the loading state, with Add product waiting for the list", async () => {
    mockApi(() => new Promise<Response>(() => {}));
    renderMe(<CatalogList />, catalogOwner());
    expect(screen.getByRole("status")).toHaveTextContent("Loading products…");
    expect(screen.getByRole("button", { name: /Add product/ })).toBeDisabled();
  });

  it("treats a refused store as the error state rather than showing other stores", async () => {
    mockApi(() => apiError(404, "not_found"));
    renderMe(<CatalogList />, catalogOwner());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load the catalog");
  });

  it("is available in Arabic", async () => {
    mockApi(() => reply(200, page([JEANS])));
    renderMe(<CatalogList />, catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }), "ar");
    expect(await screen.findByRole("heading", { level: 1, name: ar.catalog.title })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: ar.catalog.stockFilter })).toBeInTheDocument();
    expect(screen.getByText("16 متاح")).toBeInTheDocument();
  });
});
