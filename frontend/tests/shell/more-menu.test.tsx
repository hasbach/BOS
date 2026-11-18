import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MoreMenu } from "@/app/[locale]/(shell)/more/MoreMenu";

import { resetNavigation } from "../helpers/navigation";
import { AGENT_PERMISSIONS, MANAGER_PERMISSIONS, meWith, renderMe, salesAgent } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more"));

const linksIn = (region: string) => within(screen.getByRole("region", { name: region })).getAllByRole("link").map((link) => link.getAttribute("href"));

describe("More menu (screens 107 and 108)", () => {
  it("gives an owner Employees, Stores, Settings and History, then Profile, Devices and Language", () => {
    renderMe(<MoreMenu />);
    expect(linksIn("Business")).toEqual(["/more/stores", "/more/employees", "/more/settings", "/more/history"]);
    expect(linksIn("Your account")).toEqual(["/more/profile", "/more/devices", "/more/language"]);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("derives History from audit.view: a manager gets the same menu without it", () => {
    renderMe(<MoreMenu />, meWith({ user: { roles: ["manager"] }, permissions: MANAGER_PERMISSIONS }));
    expect(linksIn("Business")).toEqual(["/more/stores", "/more/employees", "/more/settings"]);
  });

  it("derives every entry from permissions, not from role names", () => {
    // An owner role with no permissions gets no business entries; a sales role granted audit.view gets History.
    renderMe(<MoreMenu />, meWith({ permissions: [] }));
    expect(screen.queryByRole("region", { name: "Business" })).not.toBeInTheDocument();
    expect(linksIn("Your account")).toEqual(["/more/profile", "/more/devices", "/more/language"]);
  });

  it("gives a sales agent only their stores, Profile, Devices, Language and Sign out", () => {
    renderMe(<MoreMenu />, salesAgent());
    expect(linksIn("Business")).toEqual(["/more/stores"]);
    expect(linksIn("Your account")).toEqual(["/more/profile", "/more/devices", "/more/language"]);
    expect(screen.queryByText("Employees")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("History")).not.toBeInTheDocument();
    expect(screen.getByText("Dana Demo · Sales")).toBeInTheDocument();
  });

  it("shows the current language in its own name and the person's number", () => {
    renderMe(<MoreMenu />, meWith({ permissions: AGENT_PERMISSIONS }));
    const account = screen.getByRole("region", { name: "Your account" });
    expect(within(account).getByText("English")).toBeInTheDocument();
    expect(within(account).getByText(/Samer Demo/)).toBeInTheDocument();
    expect(within(account).getByText("+961 70 000 011")).toBeInTheDocument();
  });

  it("writes a stored number the way people read it", () => {
    renderMe(<MoreMenu />, meWith({ user: { phone: "+96171612815" } }));
    expect(within(screen.getByRole("region", { name: "Your account" })).getByText("+961 71 612 815")).toBeInTheDocument();
  });

  it("counts the stores on the Stores line", () => {
    renderMe(<MoreMenu />);
    expect(within(screen.getByRole("region", { name: "Business" })).getByText("2 stores")).toBeInTheDocument();
  });

  it("is available in Arabic", () => {
    renderMe(<MoreMenu />, meWith({ user: { locale: "ar" } }), "ar");
    expect(screen.getByRole("region", { name: ar.more.business })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: ar.more.account })).toBeInTheDocument();
    expect(screen.getByText(ar.more.history)).toBeInTheDocument();
    expect(screen.getByText(ar.more.devices)).toBeInTheDocument();
    expect(screen.getByText("العربية")).toBeInTheDocument();
  });

  it("shows Catalog to every catalog.view holder and links to the catalog", () => {
    renderMe(<MoreMenu />, meWith({ permissions: [...AGENT_PERMISSIONS, "catalog.view"] }));
    expect(linksIn("Business")).toEqual(["/more/catalog", "/more/stores"]);
    renderMe(<MoreMenu />, meWith({ permissions: ["catalog.view"] }));
    expect(screen.getAllByRole("link", { name: /Catalog/ }).at(-1)).toHaveAttribute("href", "/more/catalog");
  });

  it("does not show Catalog without catalog.view", () => {
    renderMe(<MoreMenu />, salesAgent());
    expect(screen.queryByRole("link", { name: /Catalog/ })).not.toBeInTheDocument();
  });
});
