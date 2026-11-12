import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LocaleLayout from "@/app/[locale]/layout";
import { BottomNav } from "@/components/BottomNav";
import { dirFor } from "@/i18n/routing";

import { resetNavigation } from "../helpers/navigation";
import { TAB_ORDER, meWith, renderMe } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn(), getTranslations: vi.fn() }));
vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/sales"));

type Tab = (typeof TAB_ORDER)[number];
const TAB_LABEL: Record<Tab, string> = { sales: "Sales", packing: "Packing", delivery: "Delivery", orders: "Orders", more: "More" };

/**
 * The "Shell tabs (M0)" table of contracts/permissions.md, read from the file so this test and the
 * contract cannot drift apart: which roles see each tab.
 */
function contractTabs(): Record<Tab, string[]> {
  const text = readFileSync(resolve(process.cwd(), "../specs/001-platform-foundation/contracts/permissions.md"), "utf-8");
  const section = text.split("## Shell tabs (M0)")[1]?.split("\n## ")[0] ?? "";
  const visible = {} as Record<Tab, string[]>;
  for (const line of section.split(/\r?\n/)) {
    const cells = line.split("|").map((cell) => cell.trim());
    const tab = cells[1]?.toLowerCase() as Tab | undefined;
    if (!tab || !TAB_ORDER.includes(tab)) continue;
    const who = (cells[2] ?? "").toLowerCase();
    visible[tab] = who === "everyone" ? ["owner", "manager", "sales", "packing", "dispatch"] : who.split(",").map((role) => role.trim());
  }
  return visible;
}

/** What the server sends in `tabs` for a person holding `roles`: the union of what each role sees. */
function tabsFor(roles: string[]): Tab[] {
  const visible = contractTabs();
  return TAB_ORDER.filter((tab) => roles.some((role) => visible[tab]?.includes(role)));
}

const names = () => within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").map((link) => link.textContent);

describe("bottom navigation", () => {
  it.each([
    [["owner"], ["Sales", "Packing", "Delivery", "Orders", "More"]],
    [["manager"], ["Sales", "Packing", "Delivery", "Orders", "More"]],
    [["sales"], ["Sales", "Orders", "More"]],
    [["packing"], ["Packing", "Orders", "More"]],
    [["dispatch"], ["Delivery", "Orders", "More"]],
    [["sales", "packing"], ["Sales", "Packing", "Orders", "More"]],
    [["packing", "dispatch"], ["Packing", "Delivery", "Orders", "More"]],
  ])("shows exactly the contract's tabs for %j", (roles, expected) => {
    const tabs = tabsFor(roles);
    expect(tabs.map((tab) => TAB_LABEL[tab])).toEqual(expected);
    renderMe(<BottomNav />, meWith({ tabs, user: { roles: roles as never } }));
    expect(names()).toEqual(expected);
  });

  it("shows only the tabs the server sent, even when the person's permissions would allow more", () => {
    renderMe(<BottomNav />, meWith({ tabs: ["packing", "more"], start_tab: "packing" }));
    expect(names()).toEqual(["Packing", "More"]);
  });

  it("ignores a tab name it does not know", () => {
    renderMe(<BottomNav />, meWith({ tabs: ["sales", "reports", "more"] }));
    expect(names()).toEqual(["Sales", "More"]);
  });

  it("links every tab to its own page", () => {
    renderMe(<BottomNav />);
    const hrefs = within(screen.getByRole("navigation", { name: "Main" }))
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["/sales", "/packing", "/delivery", "/orders", "/more"]);
  });

  it("marks the current tab with aria-current and nothing else", () => {
    resetNavigation("/orders");
    renderMe(<BottomNav />);
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Orders"]);
  });

  it("keeps More current on every screen under /more", () => {
    resetNavigation("/more/language");
    renderMe(<BottomNav />);
    expect(screen.getByRole("link", { name: "More" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Sales" })).not.toHaveAttribute("aria-current");
  });

  it("shows the active tab by shape and weight as well as colour: a marked icon plate and its own style", () => {
    renderMe(<BottomNav />);
    const active = screen.getByRole("link", { name: "Sales" });
    const other = screen.getByRole("link", { name: "Packing" });
    // The class names come from a CSS module; what matters is that the two differ in more than colour.
    expect(active.className).not.toBe(other.className);
    expect(active.querySelector("[data-plate]")).toHaveAttribute("data-plate", "on");
    expect(other.querySelector("[data-plate]")).toHaveAttribute("data-plate", "off");
  });

  it("uses Arabic tab names", () => {
    renderMe(<BottomNav />, meWith({ user: { locale: "ar" } }), "ar");
    const nav = screen.getByRole("navigation", { name: ar.tabs.aria });
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual([ar.tabs.sales, ar.tabs.packing, ar.tabs.delivery, ar.tabs.orders, ar.tabs.more]);
  });
});

describe("page direction", () => {
  it("is right-to-left for Arabic and left-to-right for English", async () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
    const arabic = await LocaleLayout({ children: null, params: Promise.resolve({ locale: "ar" }) });
    const english = await LocaleLayout({ children: null, params: Promise.resolve({ locale: "en" }) });
    expect(arabic.props).toMatchObject({ lang: "ar", dir: "rtl" });
    expect(english.props).toMatchObject({ lang: "en", dir: "ltr" });
  });
});
