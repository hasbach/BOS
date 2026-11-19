import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmployeesList } from "@/app/[locale]/(shell)/more/employees/EmployeesList";
import { SettingsForm } from "@/app/[locale]/(shell)/more/settings/SettingsForm";
import { StoresList } from "@/app/[locale]/(shell)/more/stores/StoresList";
import { LowStockRow } from "@/app/[locale]/(shell)/sales/LowStockRow";
import { TabPlaceholder } from "@/app/[locale]/(shell)/TabPlaceholder";
import type { Business } from "@/lib/business";
import type { Seed } from "@/lib/seed";

import type { Call } from "../helpers/fetch";
import { mockApi, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { CATALOG_MANAGER, catalogOwner, catalogStaff } from "../helpers/catalog";
import { meWith, renderMe } from "../helpers/shell";
import { LIST, renderAs } from "../helpers/staff";
import { STORE_A, STORE_B } from "../helpers/stores";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more"));
afterEach(() => vi.unstubAllGlobals());

const BUSINESS: Business = {
  id: "b1",
  name: "Demo Denim House Group",
  edition: "commerce",
  default_currency: "USD",
  usd_lbp_rate: "89500.00",
  default_delivery_fee: "3.00",
  default_delivery_fee_currency: "USD",
  timezone: "Asia/Beirut",
};

let n = 0;
const seed = <T,>(value: T): Seed<T> => ({ id: `seed-${(n += 1)}`, value });

/** Answers the three GETs; records every call. */
function api(): Call[] {
  return mockApi((call) => {
    if (call.method !== "GET") return reply(404);
    if (call.url === "/api/v1/staff") return reply(200, LIST());
    if (call.url === "/api/v1/stores") return reply(200, [STORE_A, STORE_B]);
    if (call.url === "/api/v1/business") return reply(200, BUSINESS);
    return reply(404);
  });
}

const gets = (calls: Call[], url: string) => calls.filter((call) => call.method === "GET" && call.url === url);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("screens seeded by the server", () => {
  it("employees: shows the list at once and loads neither /staff nor /stores", async () => {
    const calls = api();
    renderAs(<EmployeesList initial={seed(LIST())} initialStores={seed([STORE_A, STORE_B])} />);
    expect(screen.getByRole("region", { name: "Active" })).toBeInTheDocument();
    await settle();
    expect(gets(calls, "/api/v1/staff")).toHaveLength(0);
    expect(gets(calls, "/api/v1/stores")).toHaveLength(0);
  });

  it("stores: shows the list at once and does not load /stores", async () => {
    const calls = api();
    renderAs(<StoresList initial={seed([STORE_A, STORE_B])} />);
    expect(screen.getByRole("region", { name: "Stores" })).toBeInTheDocument();
    expect(screen.getByText("Store B")).toBeInTheDocument();
    await settle();
    expect(gets(calls, "/api/v1/stores")).toHaveLength(0);
  });

  it("settings: shows the saved values at once and does not load /business", async () => {
    const calls = api();
    renderAs(<SettingsForm initial={seed(BUSINESS)} />);
    expect(screen.getByLabelText("Business name")).toHaveValue("Demo Denim House Group");
    await settle();
    expect(gets(calls, "/api/v1/business")).toHaveLength(0);
  });

  it("loads again when the same seed comes back (browser back or forward reuses the page)", async () => {
    const calls = api();
    const once = seed([STORE_A]);
    const first = renderAs(<StoresList initial={once} />);
    await settle();
    first.unmount();
    renderAs(<StoresList initial={once} />);
    expect(await screen.findByText("Store B")).toBeInTheDocument();
    expect(gets(calls, "/api/v1/stores")).toHaveLength(1);
  });

  it("settings seeded: saving still goes to the server and shows its answer", async () => {
    const calls = mockApi((call) => (call.method === "PATCH" && call.url === "/api/v1/business" ? reply(200, { ...BUSINESS, name: "Renamed" }) : reply(404)));
    renderAs(<SettingsForm initial={seed(BUSINESS)} />);
    fireEvent.change(screen.getByLabelText("Business name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByLabelText("Business name")).toHaveValue("Renamed"));
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(gets(calls, "/api/v1/business")).toHaveLength(0);
  });
});

describe("screens without a seed load in the browser as before", () => {
  it.each([
    ["employees", () => <EmployeesList />, "/api/v1/staff"],
    ["stores", () => <StoresList />, "/api/v1/stores"],
    ["settings", () => <SettingsForm />, "/api/v1/business"],
  ])("%s", async (_name, ui, url) => {
    const calls = api();
    renderAs(ui());
    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(gets(calls, url)).toHaveLength(1));
  });

  it("a person without the permission sees not-allowed whatever the seed (nothing loaded)", async () => {
    const calls = api();
    renderAs(<SettingsForm initial={seed(BUSINESS)} />, "sales");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to More" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Business name")).not.toBeInTheDocument();
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe("start tab: the low-stock row (screen 157)", () => {
  const ITEM = (variant_id: string, name: string, values: string[]) => ({
    product_id: `p-${variant_id}`,
    product_name_en: name,
    product_name_ar: null,
    variant_id,
    sku: `SKU-${variant_id}`,
    option_values: values,
    main_photo_id: null,
    on_hand: 0,
    allocated: 0,
    available: 0,
    level: 2,
    stock_state: "out",
  });
  const FIRST_PAGE = {
    items: [ITEM("v1", "Wide-leg black jeans", ["30", "Black"]), ITEM("v2", "Slim blue jeans", ["34", "Blue"]), ITEM("v3", "Linen shirt", ["L"])],
    next_cursor: null,
    total: 5,
  };
  const lowStock = (body: unknown = FIRST_PAGE) => mockApi((call) => (call.url.startsWith("/api/v1/catalog/low-stock") ? reply(200, body) : reply(404)));
  const salesTab = (me = catalogOwner()) => renderMe(<TabPlaceholder tab="sales" top={<LowStockRow />} />, me);
  const manager = () => meWith({ user: { id: "u-karim", name: "Karim Demo", roles: ["manager"] }, permissions: CATALOG_MANAGER });

  it("shows owners the count and the first two names above Coming soon, linking to the Low stock list", async () => {
    const calls = lowStock();
    salesTab();
    const link = await screen.findByRole("link", { name: /5 variants low or out of stock/ });
    expect(link).toHaveAttribute("href", "/more/catalog/low-stock");
    expect(link).toHaveTextContent("Wide-leg black jeans 30 · Black, Slim blue jeans 34 · Blue and 3 more");
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    expect(calls.filter((call) => call.url.startsWith("/api/v1/catalog/low-stock"))).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/v1/catalog/low-stock");
  });

  it("shows managers the row too", async () => {
    lowStock({ ...FIRST_PAGE, items: FIRST_PAGE.items.slice(0, 1), total: 1 });
    salesTab(manager());
    const link = await screen.findByRole("link", { name: /1 variant low or out of stock/ });
    expect(link).toHaveTextContent("Wide-leg black jeans 30 · Black");
    expect(link).not.toHaveTextContent("more");
  });

  it("is never shown to sales, packing or dispatch staff, and nothing is loaded for them", async () => {
    const calls = lowStock();
    salesTab(catalogStaff());
    await settle();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("is left out when nothing is low", async () => {
    const calls = lowStock({ items: [], next_cursor: null, total: 0 });
    salesTab();
    await waitFor(() => expect(calls).toHaveLength(1));
    await settle();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
  });

  it("is left out when the list cannot load", async () => {
    const calls = mockApi(() => reply(500, { error: { code: "internal_error", message: "x" } }));
    salesTab();
    await waitFor(() => expect(calls).toHaveLength(1));
    await settle();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is in Arabic", async () => {
    lowStock();
    renderMe(<TabPlaceholder tab="sales" top={<LowStockRow />} />, catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }), "ar");
    expect(await screen.findByText("يحتاج متابعة")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /5 متغيّرات مخزونها منخفض أو نافد/ })).toBeInTheDocument();
  });
});
