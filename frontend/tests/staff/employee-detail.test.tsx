import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmployeeDetail } from "@/app/[locale]/(shell)/more/employees/[userId]/EmployeeDetail";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import type { Call } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { DANA, KARIM, LIST, LINK, OMAR, SAMER, TALA, renderAs, staffApi } from "../helpers/staff";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/employees/u-dana"));
afterEach(() => vi.unstubAllGlobals());

const patches = (calls: Call[]) => calls.filter((c) => c.method === "PATCH");
const tick = (name: RegExp | string) => fireEvent.click(screen.getByRole("checkbox", { name }));
const open = async (id: string, kind: "owner" | "manager" = "owner", locale: "en" | "ar" = "en") => {
  renderAs(<EmployeeDetail userId={id} />, kind, locale);
  await screen.findByRole("heading", { level: 1, name: (name) => name !== "Employees" && name !== "الموظفون" });
};

describe("employee detail: editing", () => {
  it("shows roles and stores for editing, with Save off until something changes", async () => {
    staffApi(LIST());
    await open("u-dana");

    expect(screen.getByRole("heading", { level: 1, name: "Dana Demo" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^Sales agent/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: /^Packing agent/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: /^Manager/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("checkbox", { name: "Store A" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "Store B" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Changes take effect on their next action.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("saves roles and stores together and shows success only after the server answers 2xx", async () => {
    let release: (response: Response) => void = () => {};
    const calls = staffApi(LIST(), () => new Promise<Response>((resolve) => (release = resolve)));
    await open("u-dana");

    tick(/^Packing agent/);
    tick("Store B");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]).toMatchObject({
      url: "/api/v1/staff/u-dana",
      body: { roles: ["sales"], all_stores: false, store_ids: ["st-a", "st-b"] },
    });
    expect(screen.queryByText(/Changes saved/)).not.toBeInTheDocument();

    release(reply(200, { ...DANA, roles: ["sales"], store_ids: ["st-a", "st-b"] }));
    expect(await screen.findByText("Changes saved. They take effect on their next action.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("does not show success when the save fails", async () => {
    mockApi((call) => (call.method === "GET" ? reply(200, LIST()) : networkFailure()));
    await open("u-dana");
    tick(/^Packing agent/);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reach the server/);
    expect(screen.queryByText(/Changes saved/)).not.toBeInTheDocument();
  });

  it("shows validation_failed next to the roles and stores", async () => {
    staffApi(LIST(), () => apiError(400, "validation_failed", { roles: "required", store_ids: "required" }));
    await open("u-dana");
    tick(/^Packing agent/);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("2 things to fix before saving.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one role.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one store, or All stores.")).toBeInTheDocument();
  });

  it("forces All stores, ticked and locked, when Manager is chosen", async () => {
    const calls = staffApi(LIST(), () => reply(200, { ...DANA, roles: ["manager"], all_stores: true, store_ids: [] }));
    await open("u-dana");
    tick(/^Manager/);
    const all = screen.getByRole("checkbox", { name: /All stores/ });
    expect(all).toHaveAttribute("aria-checked", "true");
    expect(all).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Changes saved/);
    expect(patches(calls)[0]!.body).toMatchObject({ roles: ["manager", "sales", "packing"], all_stores: true, store_ids: [] });
  });

  it("gives a manager no Owner role to hand out", async () => {
    staffApi(LIST());
    await open("u-dana", "manager");
    expect(screen.queryByRole("checkbox", { name: /^Owner/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^Manager/ })).toBeInTheDocument();
  });

  it("offers Owner to an owner", async () => {
    staffApi(LIST());
    await open("u-dana", "owner");
    expect(screen.getByRole("checkbox", { name: /^Owner/ })).toBeInTheDocument();
  });

  it.each([
    ["forbidden", 403, "You don't have permission to do this."],
    ["cannot_modify_self", 403, "You can't do this to your own account."],
    ["last_owner", 409, "A business must keep at least one active owner. Make someone else an owner first."],
  ])("shows %s on top when the server refuses the save", async (code, status, text) => {
    const calls = staffApi(LIST(), () => apiError(status, code));
    await open("u-dana");
    tick(/^Packing agent/);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(patches(calls)).toHaveLength(1);
    expect(screen.queryByText(/Changes saved/)).not.toBeInTheDocument();
  });

  it("shows the not-found screen when the server says the person is gone", async () => {
    staffApi(LIST(), () => apiError(404, "not_found"));
    await open("u-dana");
    tick(/^Packing agent/);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to employees" })).toHaveAttribute("href", "/more/employees");
  });

  it("shows the not-found screen for a person who is not in the list", async () => {
    staffApi(LIST());
    renderAs(<EmployeeDetail userId="nobody" />);
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });

  it("shows the not-allowed screen to a sales agent", () => {
    const calls = staffApi(LIST());
    renderAs(<EmployeeDetail userId="u-dana" />, "sales");
    expect(screen.getByText("You can’t open Employees")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe("employee detail: deactivate and reactivate", () => {
  it("asks first, then deactivates and shows the person as inactive", async () => {
    const calls = staffApi(LIST(), () => reply(200, { ...DANA, status: "inactive" }));
    await open("u-dana");

    fireEvent.click(screen.getByRole("button", { name: /Deactivate/ }));
    const dialog = await screen.findByRole("dialog", { name: "Deactivate Dana Demo?" });
    expect(within(dialog).getByText(/signed out on every device right away/)).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: /Deactivate/ }));
    expect(await screen.findByText("Dana Demo is deactivated and signed out everywhere.")).toBeInTheDocument();
    expect(patches(calls)[0]).toMatchObject({ url: "/api/v1/staff/u-dana", body: { status: "inactive" } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Inactive. This person cannot sign in.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reactivate/ })).toBeInTheDocument();
  });

  it("can be cancelled without sending anything", async () => {
    const calls = staffApi(LIST());
    await open("u-dana");
    fireEvent.click(screen.getByRole("button", { name: /Deactivate/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
  });

  it("reactivates an inactive person", async () => {
    const calls = staffApi(LIST(), () => reply(200, { ...OMAR, status: "active" }));
    await open("u-omar");
    expect(screen.getByText("Inactive. This person cannot sign in.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reactivate/ }));
    expect(await screen.findByText("Omar Demo can sign in again.")).toBeInTheDocument();
    expect(patches(calls)[0]).toMatchObject({ url: "/api/v1/staff/u-omar", body: { status: "active" } });
    expect(screen.getByRole("button", { name: /Deactivate/ })).toBeInTheDocument();
  });

  it("shows last_owner on top when the server refuses a deactivation, and changes nothing", async () => {
    staffApi(LIST(), () => apiError(409, "last_owner"));
    await open("u-tala");
    fireEvent.click(screen.getByRole("button", { name: /Deactivate/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Deactivate/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A business must keep at least one active owner. Make someone else an owner first.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Inactive. This person cannot sign in.")).not.toBeInTheDocument();
  });
});

describe("employee detail: reset link", () => {
  it("issues a link once, with no confirmation step, and shows it for one hour", async () => {
    const calls = staffApi(LIST(), () => reply(201, LINK));
    await open("u-nour");
    fireEvent.click(screen.getByRole("button", { name: /Issue password-reset link/ }));

    expect(await screen.findByTestId("one-time-link")).toHaveTextContent(LINK.link);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.find((c) => c.method === "POST")!.url).toBe("/api/v1/staff/u-nour/password-reset");
    expect(screen.getByText("Works once, within 1 hour.")).toBeInTheDocument();
    expect(screen.getByText("Reset link created for Nour Demo.")).toBeInTheDocument();
    expect(screen.getByText("Copy it now. This link will not be shown again.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Nour Demo" })).toBeInTheDocument();
  });

  it("is offered for people who have an email too", async () => {
    staffApi(LIST());
    await open("u-karim");
    expect(screen.getByRole("button", { name: /Issue password-reset link/ })).toBeInTheDocument();
  });

  it("is not offered for an inactive person", async () => {
    staffApi(LIST());
    await open("u-omar");
    expect(screen.queryByRole("button", { name: /Issue password-reset link/ })).not.toBeInTheDocument();
  });

  it.each([
    ["user_inactive", 409, "This person is deactivated. Reactivate them first."],
    ["forbidden", 403, "You don't have permission to do this."],
  ])("shows %s without a link", async (code, status, text) => {
    staffApi(LIST(), () => apiError(status, code));
    await open("u-nour");
    fireEvent.click(screen.getByRole("button", { name: /Issue password-reset link/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
  });
});

describe("employee detail: rules shown up front", () => {
  it("shows your own row read only, with the reason and no actions", async () => {
    staffApi(LIST());
    await open("u-samer");
    expect(screen.getByText("You can’t change your own roles, stores or status. Ask another owner.")).toBeInTheDocument();
    expect(screen.getByText("Roles · read only")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Deactivate|Save|reset/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/only owner/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to employees" })).toBeInTheDocument();
  });

  it("tells the only owner what to do first", async () => {
    staffApi(LIST({ members: [SAMER, KARIM, DANA] }));
    await open("u-samer");
    expect(screen.getByText("You are the only owner. To step down, first make someone else an owner.")).toBeInTheDocument();
  });

  it("shows an owner read only to a manager, with no Deactivate and no reset", async () => {
    staffApi(LIST());
    await open("u-tala", "manager");
    expect(screen.getByText("Only an owner can change an owner’s access or reset their password.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Deactivate|reset link/ })).not.toBeInTheDocument();
  });

  it("disables Deactivate and the Owner role up front for the only active owner", async () => {
    const calls = mockApi(() => reply(200, { members: [{ ...SAMER, status: "inactive" }, TALA, DANA], invitations: [] }));
    await open("u-tala");

    expect(screen.getByRole("button", { name: /Deactivate/ })).toBeDisabled();
    expect(screen.getByText(/can’t be deactivated\. Make someone else an owner first/)).toBeInTheDocument();
    const owner = screen.getByRole("checkbox", { name: /^Owner/ });
    expect(owner).toHaveAttribute("aria-disabled", "true");
    expect(owner).toHaveAttribute("aria-checked", "true");
    fireEvent.click(owner);
    expect(owner).toHaveAttribute("aria-checked", "true");
    expect(patches(calls)).toHaveLength(0);
  });

  it("leaves Deactivate and the Owner role open when there are two active owners", async () => {
    staffApi(LIST());
    await open("u-tala");
    expect(screen.getByRole("button", { name: /Deactivate/ })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /^Owner/ })).not.toHaveAttribute("aria-disabled");
  });
});

describe("employee detail: Arabic", () => {
  it("shows the confirmed role names and Deactivate = إلغاء التفعيل", async () => {
    staffApi(LIST());
    renderAs(<EmployeeDetail userId="u-dana" />, "owner", "ar");
    expect(await screen.findByRole("checkbox", { name: /^موظف مبيعات/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: /^موظف تجهيز/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^موظف توصيل وتحصيل/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^مالك/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^مدير/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /إلغاء التفعيل/ })).toBeInTheDocument();
  });
});
