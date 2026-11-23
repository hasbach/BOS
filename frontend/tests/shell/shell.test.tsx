import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartRedirect } from "@/app/[locale]/(shell)/StartRedirect";
import { TabPlaceholder } from "@/app/[locale]/(shell)/TabPlaceholder";
import { AppShell } from "@/components/AppShell";

import { nav, resetNavigation, router } from "../helpers/navigation";
import { meWith, renderMe, salesAgent } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/"));

describe("opening the app", () => {
  it.each([
    ["sales", "/sales"],
    ["packing", "/packing"],
    ["delivery", "/delivery"],
  ])("goes to the start tab the server chose (%s)", async (start, path) => {
    renderMe(<StartRedirect />, meWith({ start_tab: start }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(path));
  });

  it("shows a loading state while it moves", () => {
    renderMe(<StartRedirect />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("coming-soon placeholder (screen 106)", () => {
  it.each([
    ["sales", "Sales", "Here you will create orders from your customers’ chats and confirm them."],
    ["packing", "Packing", "Here you will see the orders to pack and check off each item."],
    ["delivery", "Delivery", "Here you will hand parcels to couriers and record delivery results and cash."],
    ["orders", "Orders", "Here you will find every order with its packing, delivery and payment status."],
  ] as const)("shows a calm placeholder for %s, not an error", (tab, title, text) => {
    resetNavigation(`/${tab}`);
    renderMe(<TabPlaceholder tab={tab} />);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText("Nothing is wrong. This part of BOS is switched on in a later update.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.getByText("Demo Denim House Group")).toBeInTheDocument();
  });

  it("lists what already works, limited to what this person may open", () => {
    renderMe(<TabPlaceholder tab="orders" />);
    const ready = screen.getByRole("region", { name: "Ready now, under More" });
    expect(within(ready).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/more/stores", "/more/employees", "/more/settings"]);
  });

  it("offers a sales agent only their stores", () => {
    renderMe(<TabPlaceholder tab="sales" />, salesAgent());
    const ready = screen.getByRole("region", { name: "Ready now, under More" });
    expect(within(ready).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/more/stores"]);
  });

  it("omits the list when nothing is open to this person", () => {
    renderMe(<TabPlaceholder tab="sales" />, meWith({ permissions: [] }));
    expect(screen.queryByRole("region", { name: "Ready now, under More" })).not.toBeInTheDocument();
  });

  it("sends a person to their start tab when the tab is not one of theirs", async () => {
    renderMe(<TabPlaceholder tab="delivery" />, meWith({ tabs: ["packing", "orders", "more"], start_tab: "packing" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/packing"));
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("reads in Arabic", () => {
    renderMe(<TabPlaceholder tab="packing" />, meWith({ user: { locale: "ar" } }), "ar");
    expect(screen.getByRole("heading", { level: 1, name: ar.tabs.packing })).toBeInTheDocument();
    expect(screen.getByText(ar.soon.chip)).toBeInTheDocument();
    expect(screen.getByText(ar.soon.packing)).toBeInTheDocument();
  });
});

describe("shell frame", () => {
  const onLine = vi.spyOn(window.navigator, "onLine", "get");
  afterEach(() => onLine.mockReset());

  it.each(["/", "/sales", "/packing", "/delivery", "/orders", "/more", "/more/language"])("shows the tab bar on %s", (path) => {
    onLine.mockReturnValue(true);
    resetNavigation(path);
    renderMe(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getByText("page")).toBeInTheDocument();
  });

  it.each(["/more/employees", "/more/stores/new", "/more/history", "/more/devices", "/more/profile", "/more/profile/password"])(
    "leaves the tab bar out of the inner screen %s",
    (path) => {
      onLine.mockReturnValue(true);
      resetNavigation(path);
      renderMe(
        <AppShell>
          <p>page</p>
        </AppShell>,
      );
      expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
      expect(screen.getByText("page")).toBeInTheDocument();
    },
  );

  it("shows the offline notice above every screen while there is no connection, and clears it when it is back", () => {
    onLine.mockReturnValue(false);
    resetNavigation("/more/history");
    const { container } = renderMe(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    const notice = container.querySelector("[aria-live]");
    expect(notice).toHaveTextContent("You’re offline.");
    expect(notice).toHaveTextContent("nothing can be saved until you’re back online");
    expect(nav.pathname).toBe("/more/history");

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(container.querySelector("[aria-live]")).toBe(notice);
    expect(notice).toBeEmptyDOMElement();
  });
});
