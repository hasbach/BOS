import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmployeesList } from "@/app/[locale]/(shell)/more/employees/EmployeesList";
import { SettingsForm } from "@/app/[locale]/(shell)/more/settings/SettingsForm";
import { StoresList } from "@/app/[locale]/(shell)/more/stores/StoresList";
import type { Business } from "@/lib/business";
import type { Seed } from "@/lib/seed";

import type { Call } from "../helpers/fetch";
import { mockApi, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
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
