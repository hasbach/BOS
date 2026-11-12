import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmployeesList } from "@/app/[locale]/(shell)/more/employees/EmployeesList";
import { InviteForm } from "@/app/[locale]/(shell)/more/employees/invite/InviteForm";

import { resetNavigation } from "../helpers/navigation";
import { DANA, LIST, renderAs } from "../helpers/staff";
import { STORE_A, STORE_B, STORE_C } from "../helpers/stores";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/employees"));
afterEach(() => vi.unstubAllGlobals());

// GET /me lists only active stores and is read once per session. The employee screens take the
// stores from GET /stores instead, so a store added or deactivated since then is right (R36).
describe("employee screens and the stores list", () => {
  it("names a deactivated store on the person who is still assigned to it", async () => {
    const calls = staffApiWith([STORE_A, STORE_B, STORE_C]);
    renderAs(<EmployeesList />);
    expect(await screen.findByText("Dana Demo")).toBeInTheDocument();
    expect(await screen.findByText("Store C")).toBeInTheDocument();
    expect(calls.some((call) => call.url === "/api/v1/stores")).toBe(true);
  });

  it("offers a store added after sign-in when inviting, and not an inactive one", async () => {
    const added = { id: "st-new", name: "Store New", whatsapp_number: null, has_logo: false, status: "active" as const };
    staffApiWith([STORE_A, STORE_B, STORE_C, added]);
    renderAs(<InviteForm />);
    expect(await screen.findByRole("checkbox", { name: /Store New/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Store C/ })).not.toBeInTheDocument();
  });

  it("falls back to the stores from /me when the list cannot be read", async () => {

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/staff") return new Response(JSON.stringify(LIST({ members: [DANA], invitations: [] })), { status: 200 });
      throw new TypeError("Failed to fetch");
    }));
    renderAs(<EmployeesList />);
    expect(await screen.findByText("Dana Demo")).toBeInTheDocument();
    expect(await screen.findByText("Store A")).toBeInTheDocument();
  });
});

function staffApiWith(stores: Array<typeof STORE_A>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/v1/stores") return new Response(JSON.stringify(stores), { status: 200 });
      if (url === "/api/v1/staff") {
        return new Response(JSON.stringify(LIST({ members: [{ ...DANA, store_ids: ["st-c"] }], invitations: [] })), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return calls;
}
