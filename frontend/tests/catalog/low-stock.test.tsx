import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LowStockList } from "@/app/[locale]/(shell)/more/catalog/low-stock/LowStockList";
import type { LowStockItem, LowStockPage } from "@/lib/stock";

import type { Call } from "../helpers/fetch";
import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { catalogApi, catalogOwner, catalogStaff, queryOf } from "../helpers/catalog";
import { resetNavigation } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/catalog/low-stock"));
afterEach(() => vi.unstubAllGlobals());

const item = (over: Partial<LowStockItem> & Pick<LowStockItem, "variant_id">): LowStockItem => ({
  product_id: "p-jeans",
  product_name_en: "Slim blue jeans",
  product_name_ar: "جينز أزرق ضيّق",
  sku: "JN-SLIM-32-BLUE",
  option_values: ["32", "Blue"],
  main_photo_id: "ph-1",
  on_hand: 2,
  allocated: 1,
  available: 1,
  level: 2,
  stock_state: "low",
  ...over,
});

const WIDE_30 = item({
  variant_id: "v-w30",
  product_id: "p-wide",
  product_name_en: "Wide-leg black jeans",
  product_name_ar: "جينز أسود واسع",
  sku: "JN-WIDE-30-BLACK",
  option_values: ["30", "Black"],
  main_photo_id: null,
  on_hand: 0,
  allocated: 0,
  available: 0,
  stock_state: "out",
});
const SLIM_32 = item({ variant_id: "v-32" });
const SHIRT_L = item({ variant_id: "v-l", product_id: "p-shirt", product_name_en: "Linen shirt", product_name_ar: null, sku: "SH-LIN-L-WHITE", option_values: ["L", "White"], on_hand: 3, allocated: 0, available: 3, level: 3 });

const lowPage = (items: LowStockItem[], over: Partial<LowStockPage> = {}): LowStockPage => ({ items, next_cursor: null, total: items.length, ...over });

const lowCalls = (calls: Call[]) => calls.filter((call) => call.method === "GET" && call.url.startsWith("/api/v1/catalog/low-stock"));

describe("low stock list (screens 158 to 161)", () => {
  it("lists variant rows in the server's order, out of stock first, with product, variant, SKU and the numbers", async () => {
    catalogApi(() => reply(200, lowPage([WIDE_30, SLIM_32, SHIRT_L], { total: 3 })));
    renderMe(<LowStockList />, catalogOwner());
    const list = await screen.findByRole("list", { name: "Low stock" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(screen.getByText("3 variants")).toBeInTheDocument();

    const out = within(rows[0]!);
    expect(out.getByText("Wide-leg black jeans")).toBeInTheDocument();
    expect(out.getByText("Out")).toBeInTheDocument();
    expect(out.getByText(/30 · Black/)).toBeInTheDocument();
    expect(out.getByText("JN-WIDE-30-BLACK")).toBeInTheDocument();
    expect(out.getByRole("link")).toHaveAttribute("href", "/more/catalog/p-wide");

    const low = within(rows[1]!);
    expect(low.getByText("Low")).toBeInTheDocument();
    const figures = low.getByRole("group", { name: "Stock numbers" });
    expect(within(figures).getByText("Available").nextSibling).toHaveTextContent("1");
    expect(within(figures).getByText("On hand").nextSibling).toHaveTextContent("2");
    expect(within(figures).getByText("Warn at").nextSibling).toHaveTextContent("2");
    expect(low.getByText(/Reserved 1/)).toBeInTheDocument();

    // A product with no name in the reader's language uses the other one.
    expect(within(rows[2]!).getByText("Linen shirt")).toBeInTheDocument();
    // The business default comes from GET /business.
    expect(await screen.findByText(/Business default: warn at 2 or fewer available/)).toBeInTheDocument();
  });

  it("says nothing is low with the current default, and offers to change it", async () => {
    catalogApi(() => reply(200, lowPage([], { total: 0 })));
    renderMe(<LowStockList />, catalogOwner());
    expect(await screen.findByText("Nothing is low")).toBeInTheDocument();
    expect(await screen.findByText("Every variant has more available than its warning level (2 by default).")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Change the default/ })).toHaveAttribute("href", "/more/settings");
  });

  it("loads 20 more with the cursor and keeps the first ones", async () => {
    const calls = catalogApi((call) => reply(200, call.url.includes("cursor=") ? lowPage([SHIRT_L], { total: undefined }) : lowPage([WIDE_30], { next_cursor: "c-2", total: 21 })));
    renderMe(<LowStockList />, catalogOwner());
    await screen.findByText("Wide-leg black jeans");
    expect(screen.getByText("21 variants")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Linen shirt")).toBeInTheDocument();
    expect(screen.getByText("Wide-leg black jeans")).toBeInTheDocument();
    expect(queryOf(lowCalls(calls)[1]!)).toEqual({ cursor: "c-2" });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.getByText("21 variants")).toBeInTheDocument();
  });

  it("narrows the list to one store from the store menu", async () => {
    const calls = catalogApi(() => reply(200, lowPage([SLIM_32])));
    renderMe(<LowStockList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.click(screen.getByRole("button", { name: /All stores/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Store" })).getByRole("radio", { name: "Store B" }));
    await waitFor(() => expect(lowCalls(calls)).toHaveLength(2));
    expect(queryOf(lowCalls(calls)[1]!)).toEqual({ store_id: "st-b" });
  });

  it("keeps the current rows when the current store is selected again", async () => {
    const calls = catalogApi(() => reply(200, lowPage([SLIM_32])));
    renderMe(<LowStockList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.click(screen.getByRole("button", { name: /All stores/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Store" })).getByRole("radio", { name: "All stores" }));
    expect(screen.getByText("Slim blue jeans")).toBeInTheDocument();
    expect(lowCalls(calls)).toHaveLength(1);
  });

  it("ignores a pending pagination response after the store changes", async () => {
    let complete: (response: Response) => void = () => {};
    catalogApi((call) => {
      if (call.url.includes("cursor=")) return new Promise<Response>((resolve) => { complete = resolve; });
      if (call.url.includes("store_id=st-b")) return reply(200, lowPage([SLIM_32]));
      return reply(200, lowPage([WIDE_30], { next_cursor: "c-2" }));
    });
    renderMe(<LowStockList />, catalogOwner());
    await screen.findByText("Wide-leg black jeans");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(screen.getByRole("button", { name: /All stores/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Store" })).getByRole("radio", { name: "Store B" }));
    await screen.findByText("Slim blue jeans");
    await act(async () => { complete(reply(200, lowPage([SHIRT_L], { next_cursor: "c-3" }))); });
    expect(screen.queryByText("Linen shirt")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows the loading state while the first page loads", () => {
    mockApi(() => new Promise<Response>(() => undefined));
    renderMe(<LowStockList />, catalogOwner());
    expect(screen.getByText("Loading low stock…")).toHaveAttribute("role", "status");
  });

  it("shows the could-not-load state with a retry that loads again", async () => {
    let fail = true;
    catalogApi(() => (fail ? networkFailure() : reply(200, lowPage([SLIM_32]))));
    renderMe(<LowStockList />, catalogOwner());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load low stock");
    expect(screen.getByRole("link", { name: "Back to catalog" })).toHaveAttribute("href", "/more/catalog");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Slim blue jeans")).toBeInTheDocument();
  });

  it("is not for sales, packing or dispatch staff: nothing is loaded", async () => {
    const calls = mockApi(() => reply(200, lowPage([SLIM_32])));
    renderMe(<LowStockList />, catalogStaff());
    expect(screen.getByText("You can’t open the Low stock list")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lowCalls(calls)).toHaveLength(0);
  });

  it("treats a forbidden answer as not allowed", async () => {
    catalogApi(() => apiError(403, "forbidden"));
    renderMe(<LowStockList />, catalogOwner());
    expect(await screen.findByText("You can’t open the Low stock list")).toBeInTheDocument();
  });

  it("is available in Arabic", async () => {
    catalogApi(() => reply(200, lowPage([WIDE_30, SLIM_32], { total: 2 })));
    renderMe(<LowStockList />, catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }), "ar");
    expect(await screen.findByText("جينز أسود واسع")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "المخزون المنخفض" })).toBeInTheDocument();
    expect(screen.getByText("متغيّران")).toBeInTheDocument();
    expect(screen.getByText("نفد")).toBeInTheDocument();
  });
});
