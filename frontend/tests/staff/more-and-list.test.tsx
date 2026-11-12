import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmployeesList } from "@/app/[locale]/(shell)/more/employees/EmployeesList";
import { MoreMenu } from "@/app/[locale]/(shell)/more/MoreMenu";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { LIST, SAMER, TALA, renderAs, staffApi } from "../helpers/staff";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more"));
afterEach(() => vi.unstubAllGlobals());

describe("More menu", () => {
  it("shows Employees to an owner and a manager", () => {
    for (const kind of ["owner", "manager"] as const) {
      const view = renderAs(<MoreMenu />, kind);
      expect(screen.getByRole("link", { name: /Employees and roles/ })).toHaveAttribute("href", "/more/employees");
      expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("shows a sales agent no Employees or Settings entry, only Stores and Sign out", () => {
    renderAs(<MoreMenu />, "sales");
    expect(screen.queryByText(/Employees/)).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/more/stores"]);
    expect(screen.getByText("Dana Demo · Sales")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("signs out through the server and only then leaves", async () => {
    const calls = mockApi(() => reply(204));
    renderAs(<MoreMenu />, "owner");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"));
    expect(calls[0]).toMatchObject({ url: "/api/v1/auth/sign-out", method: "POST" });
  });

  it("says so and stays when sign-out is not confirmed", async () => {
    mockApi(networkFailure);
    renderAs(<MoreMenu />, "owner");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reach the server/);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("is available in Arabic with the confirmed role names", () => {
    renderAs(<MoreMenu />, "owner", "ar");
    expect(screen.getByText("الموظفون والأدوار")).toBeInTheDocument();
    expect(screen.getByText(/Samer Demo · مالك/)).toBeInTheDocument();
  });
});

describe("employees list", () => {
  it("groups people as Active, Inactive, Pending and Expired with words for the status", async () => {
    staffApi(LIST());
    renderAs(<EmployeesList />);

    const active = await screen.findByRole("region", { name: "Active" });
    expect(within(active).getByText("Samer Demo")).toBeInTheDocument();
    expect(within(active).getByText("You")).toBeInTheDocument();
    expect(within(active).getAllByText("Active")).toHaveLength(5);
    expect(within(active).getByText("Dana Demo")).toBeInTheDocument();
    expect(within(active).getAllByText("Store A").length).toBeGreaterThan(0);
    expect(within(active).getAllByText("Sales").length).toBeGreaterThan(0);
    expect(within(active).getByText("Packing")).toBeInTheDocument();

    const inactive = screen.getByRole("region", { name: "Inactive" });
    expect(within(inactive).getByText("Omar Demo")).toBeInTheDocument();
    expect(within(inactive).getByText("Inactive")).toBeInTheDocument();

    const pending = screen.getByRole("region", { name: "Pending invitations" });
    expect(within(pending).getByText("Hadi Demo")).toBeInTheDocument();
    expect(within(pending).getByText("Expires 18 Nov 2026")).toBeInTheDocument();

    const expired = screen.getByRole("region", { name: "Expired invitations" });
    expect(within(expired).getByText("Rita Demo")).toBeInTheDocument();
    expect(within(expired).getByText("Expired on 4 Nov 2026")).toBeInTheDocument();
    expect(within(expired).getByText("All stores")).toBeInTheDocument();
  });

  it("opens an employee and an invitation from their rows", async () => {
    staffApi(LIST());
    renderAs(<EmployeesList />);
    await screen.findByText("Dana Demo");
    expect(screen.getByRole("link", { name: /Dana Demo/ })).toHaveAttribute("href", "/more/employees/u-dana");
    expect(screen.getByRole("link", { name: /Hadi Demo/ })).toHaveAttribute("href", "/more/employees/invitations/inv-hadi");
    expect(screen.getByRole("link", { name: /Invite someone/ })).toHaveAttribute("href", "/more/employees/invite");
  });

  it("shows the only-you empty state with the next step", async () => {
    staffApi(LIST({ members: [SAMER], invitations: [] }));
    renderAs(<EmployeesList />);
    expect(await screen.findByText("It’s just you so far")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Invite someone/ })).toBeInTheDocument();
  });

  it("shows a loading state with Invite visible but unavailable", () => {
    mockApi(() => new Promise<Response>(() => {}));
    renderAs(<EmployeesList />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading employees…");
    expect(screen.getByRole("button", { name: /Invite someone/ })).toBeDisabled();
  });

  it("offers retry when the list cannot be loaded, and says nothing was changed", async () => {
    let fail = true;
    const calls = mockApi(() => {
      if (fail) return networkFailure();
      return reply(200, LIST());
    });
    renderAs(<EmployeesList />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load employees");
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to More" })).toHaveAttribute("href", "/more");

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Dana Demo")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/v1/staff")).toHaveLength(2);
  });

  it("shows the not-allowed screen when the server answers forbidden", async () => {
    mockApi(() => apiError(403, "forbidden"));
    renderAs(<EmployeesList />);
    expect(await screen.findByText("You can’t open Employees")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to More" })).toBeInTheDocument();
  });

  it("shows the not-allowed screen to a sales agent without asking the server for anyone", () => {
    const calls = mockApi(() => reply(200, LIST()));
    renderAs(<EmployeesList />, "sales");
    expect(screen.getByText("You can’t open Employees")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("lets a manager see another owner and the Invite button", async () => {
    staffApi(LIST({ members: [SAMER, TALA], invitations: [] }));
    renderAs(<EmployeesList />, "manager");
    expect(await screen.findByText("Tala Demo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Invite someone/ })).toBeInTheDocument();
  });

  it("renders in Arabic with the confirmed role names, Latin digits and names as typed", async () => {
    staffApi(LIST());
    renderAs(<EmployeesList />, "owner", "ar");
    const active = await screen.findByRole("region", { name: "نشطون" });
    expect(within(active).getAllByText("مالك").length).toBeGreaterThan(0);
    expect(within(active).getByText("مدير")).toBeInTheDocument();
    expect(within(active).getAllByText("موظف مبيعات").length).toBeGreaterThan(0);
    expect(within(active).getByText("موظف تجهيز")).toBeInTheDocument();
    expect(within(active).getByText("موظف توصيل وتحصيل")).toBeInTheDocument();
    expect(within(active).getByText("Dana Demo")).toBeInTheDocument();
    expect(screen.getByText(/^تنتهي في 18 .* 2026$/)).toBeInTheDocument();
  });
});
