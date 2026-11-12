import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MoreMenu } from "@/app/[locale]/(shell)/more/MoreMenu";
import { StoresList } from "@/app/[locale]/(shell)/more/stores/StoresList";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderAs } from "../helpers/staff";
import { STORE_A, STORE_B, STORE_C, storesApi } from "../helpers/stores";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/stores"));
afterEach(() => vi.unstubAllGlobals());

describe("More menu entries", () => {
  it("shows Stores and Settings to an owner and a manager", () => {
    for (const kind of ["owner", "manager"] as const) {
      const view = renderAs(<MoreMenu />, kind);
      expect(screen.getByRole("link", { name: "Stores" })).toHaveAttribute("href", "/more/stores");
      expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/more/settings");
      view.unmount();
    }
  });

  it("shows a sales agent Stores but not Settings or Employees", () => {
    renderAs(<MoreMenu />, "sales");
    expect(screen.getByRole("link", { name: "Stores" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Employees/ })).not.toBeInTheDocument();
  });

  it("is in Arabic with the same entries", () => {
    renderAs(<MoreMenu />, "owner", "ar");
    expect(screen.getByRole("link", { name: "المتاجر" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "الإعدادات" })).toBeInTheDocument();
  });
});

describe("stores list (screen 76)", () => {
  it("shows each store with its number normalized, its status in words and Add store", async () => {
    storesApi([STORE_A, STORE_B, STORE_C]);
    renderAs(<StoresList />);

    const group = await screen.findByRole("region", { name: "Stores" });
    expect(within(group).getByText("Store A")).toBeInTheDocument();
    expect(within(group).getByText("+961 70 000 031")).toBeInTheDocument();
    expect(within(group).getByText("+961 70 000 032")).toBeInTheDocument();
    expect(within(group).getByText("No WhatsApp number")).toBeInTheDocument();
    expect(within(group).getAllByText("Active")).toHaveLength(2);
    expect(within(group).getByText("Inactive")).toBeInTheDocument();
    expect(within(group).getByRole("link", { name: /Store B/ })).toHaveAttribute("href", "/more/stores/st-b");
    expect(screen.getByRole("link", { name: /Add store/ })).toHaveAttribute("href", "/more/stores/new");
  });

  it("shows a logo through the logo address, and initials when there is none or it cannot be read", async () => {
    storesApi([STORE_A, STORE_B]);
    renderAs(<StoresList />);
    const image = await screen.findByRole("img", { name: "Logo of Store A" });
    expect(image).toHaveAttribute("src", "/api/v1/stores/st-a/logo");
    expect(screen.getByText("SB")).toBeInTheDocument(); // Store B has no logo

    fireEvent.error(image); // 404 from the logo address
    expect(await screen.findByText("SA")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Logo of Store A" })).not.toBeInTheDocument();
  });

  it("with one store still works, and says how to add another (screen 77)", async () => {
    storesApi([STORE_A]);
    renderAs(<StoresList />);
    expect(await screen.findByText("One store so far")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add store/ })).toBeInTheDocument();
  });

  it("is available in Arabic with names as typed", async () => {
    storesApi([{ ...STORE_B, name: "متجر ب" }]);
    renderAs(<StoresList />, "owner", "ar");
    expect(await screen.findByText("متجر ب")).toBeInTheDocument();
    expect(screen.getByText("متجر واحد حتى الآن")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /إضافة متجر/ })).toBeInTheDocument();
  });

  it("shows loading with Add store unavailable (screen 100)", () => {
    mockApi(() => new Promise<Response>(() => {}));
    renderAs(<StoresList />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading stores…");
    expect(screen.getByRole("button", { name: /Add store/ })).toBeDisabled();
  });

  it("offers retry when the list cannot be loaded, and says nothing was changed (screen 101)", async () => {
    let fail = true;
    const calls = mockApi(() => (fail ? networkFailure() : reply(200, [STORE_A, STORE_B])));
    renderAs(<StoresList />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load stores");
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to More" })).toHaveAttribute("href", "/more");

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Store B")).toBeInTheDocument();
    expect(calls).toHaveLength(2);
  });

  it("shows the not-allowed screen when the server answers forbidden", async () => {
    mockApi(() => apiError(403, "forbidden"));
    renderAs(<StoresList />);
    expect(await screen.findByText("You can’t change stores")).toBeInTheDocument();
  });
});

describe("stores list for a sales agent (screen 96)", () => {
  it("shows only what the server returned, a note, and no Add store", async () => {
    const calls = storesApi([STORE_B]);
    renderAs(<StoresList />, "sales");
    expect(await screen.findByText("Store B")).toBeInTheDocument();
    expect(screen.queryByText("Store A")).not.toBeInTheDocument();
    expect(screen.getByText(/You see only the stores you work in/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Add store/ })).not.toBeInTheDocument();
    expect(screen.queryByText("One store so far")).not.toBeInTheDocument();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("says there is no store when the only store they work in has been deactivated", async () => {
    storesApi([]);
    renderAs(<StoresList />, "sales");
    expect(await screen.findByText("No stores available")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Stores" })).not.toBeInTheDocument();
  });
});
