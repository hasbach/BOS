import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InviteForm } from "@/app/[locale]/(shell)/more/employees/invite/InviteForm";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import type { Call } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { HADI, LINK, renderAs } from "../helpers/staff";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/employees/invite"));
afterEach(() => vi.unstubAllGlobals());

const CREATED = { ...LINK, invitation: HADI };
const post = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url === "/api/v1/staff/invitations");

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const tick = (name: RegExp | string) => fireEvent.click(screen.getByRole("checkbox", { name }));
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));

function fillHadi() {
  type("Name", "Hadi Demo");
  type("Phone", "+961 70 000 025");
  tick(/^Sales agent/);
  tick("Store B");
}

describe("invite form", () => {
  it("creates the invitation and ends on the link screen, shown once", async () => {
    const calls = mockApi(() => reply(201, CREATED));
    renderAs(<InviteForm />);
    fillHadi();
    submit();

    expect(await screen.findByTestId("one-time-link")).toHaveTextContent(LINK.link);
    expect(post(calls)).toHaveLength(1);
    expect(post(calls)[0]!.body).toEqual({
      name: "Hadi Demo",
      roles: ["sales"],
      phone: "+961 70 000 025",
      all_stores: false,
      store_ids: ["st-b"],
    });
    expect(post(calls)[0]!.headers["Idempotency-Key"]).toBeTruthy();
    expect(screen.getByText("Invitation created for Hadi Demo. It stays Pending until they accept.")).toBeInTheDocument();
    expect(screen.getByText("Works once, within 7 days (until 19 Nov 2026).")).toBeInTheDocument();
    expect(screen.getByText("Copy it now. This link will not be shown again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Share link/ })).toBeInTheDocument();

    // Done is the only way out, and it goes back to the list; the link is not kept anywhere.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(router.replace).toHaveBeenCalledWith("/more/employees");
  });

  it("shows no success and no link until the server has answered 2xx", async () => {
    let release: (response: Response) => void = () => {};
    mockApi(() => new Promise<Response>((resolve) => (release = resolve)));
    renderAs(<InviteForm />);
    fillHadi();
    submit();

    expect(screen.getByRole("button", { name: /Creating/ })).toBeDisabled();
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
    release(reply(201, CREATED));
    expect(await screen.findByTestId("one-time-link")).toBeInTheDocument();
  });

  it("offers Owner only to someone who may manage owners", () => {
    const owner = renderAs(<InviteForm />, "owner");
    expect(screen.getByRole("checkbox", { name: /^Owner/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^Manager/ })).toBeInTheDocument();
    owner.unmount();

    renderAs(<InviteForm />, "manager");
    expect(screen.queryByRole("checkbox", { name: /^Owner/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^Manager/ })).toBeInTheDocument();
    expect(screen.getByText("Only an owner can invite another owner.")).toBeInTheDocument();
  });

  it("forces All stores, shown ticked and locked with the reason, for Manager and Owner", async () => {
    const calls = mockApi(() => reply(201, CREATED));
    renderAs(<InviteForm />);
    type("Name", "Sami Demo");
    type("Email", "sami@demo.example");
    tick(/^Manager/);

    const all = screen.getByRole("checkbox", { name: /All stores/ });
    expect(all).toHaveAttribute("aria-checked", "true");
    expect(all).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Owners and managers always have all stores.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Store A" })).not.toBeInTheDocument();

    submit();
    await screen.findByTestId("one-time-link");
    expect(post(calls)[0]!.body).toEqual({ name: "Sami Demo", roles: ["manager"], email: "sami@demo.example", all_stores: true, store_ids: [] });
  });

  it("sends All stores for a store-limited role and dims the single stores", async () => {
    const calls = mockApi(() => reply(201, CREATED));
    renderAs(<InviteForm />);
    type("Name", "Hadi Demo");
    type("Phone", "+961 70 000 025");
    tick(/^Packing agent/);
    tick(/All stores/);
    expect(screen.getByRole("checkbox", { name: "Store A" })).toHaveAttribute("aria-disabled", "true");
    submit();
    await screen.findByTestId("one-time-link");
    expect(post(calls)[0]!.body).toMatchObject({ roles: ["packing"], all_stores: true, store_ids: [] });
  });

  it("shows each validation_failed field next to its field, with a count of what to fix", async () => {
    mockApi(() => apiError(400, "validation_failed", { name: "required", phone: "required", roles: "required" }));
    renderAs(<InviteForm />);
    submit();

    expect(await screen.findByText("3 things to fix before you continue.")).toBeInTheDocument();
    expect(screen.getByText("Enter the person’s name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a phone number or an email.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one role.")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
  });

  it("explains an invalid phone, an invalid email and missing stores (store_ids, not stores)", async () => {
    mockApi(() => apiError(400, "validation_failed", { phone: "invalid_phone", email: "invalid_email", store_ids: "required" }));
    renderAs(<InviteForm />);
    type("Name", "Hadi Demo");
    tick(/^Sales agent/);
    submit();

    expect(await screen.findByText(/This phone number is not valid/)).toBeInTheDocument();
    expect(screen.getByText(/This email is not valid/)).toBeInTheDocument();
    expect(screen.getByText("Choose at least one store, or All stores.")).toBeInTheDocument();
  });

  it("explains an unknown or inactive store", async () => {
    mockApi(() => apiError(400, "validation_failed", { store_ids: "invalid" }));
    renderAs(<InviteForm />);
    submit();
    expect(await screen.findByText("One of the chosen stores is not available. Choose again.")).toBeInTheDocument();
  });

  it("reports already_member on the phone field and says the invitation was not created", async () => {
    mockApi(() => apiError(409, "already_member"));
    renderAs(<InviteForm />);
    fillHadi();
    submit();

    expect(await screen.findByText("The invitation was not created.")).toBeInTheDocument();
    expect(screen.getByText(/Someone in your business already uses this phone number or email/)).toBeInTheDocument();
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
  });

  it("reports already_member on the email field when only an email was given", async () => {
    mockApi(() => apiError(409, "already_member"));
    renderAs(<InviteForm />);
    type("Name", "Rita Demo");
    type("Email", "rita@demo.example");
    tick(/^Packing agent/);
    tick(/All stores/);
    submit();
    await screen.findByText("The invitation was not created.");
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  });

  it.each([
    ["forbidden", 403, "You don't have permission to do this."],
    ["idempotency_conflict", 409, "This request was already sent with different details. Reload the page and try again."],
  ])("shows the message for %s", async (code, status, text) => {
    mockApi(() => apiError(status, code));
    renderAs(<InviteForm />);
    fillHadi();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("reuses the Idempotency-Key when the same invitation is retried, and uses a new one when the details change", async () => {
    let attempts = 0;
    const calls = mockApi(() => {
      attempts += 1;
      if (attempts <= 2) return networkFailure();
      return reply(201, CREATED);
    });
    renderAs(<InviteForm />);
    fillHadi();

    submit();
    await screen.findByText(/reach the server/);
    submit();
    await waitFor(() => expect(post(calls)).toHaveLength(2));
    await screen.findByText(/reach the server/);

    const [first, second] = post(calls).map((c) => c.headers["Idempotency-Key"]);
    expect(first).toBeTruthy();
    expect(second).toBe(first);

    type("Name", "Hadi Demo Jr");
    submit();
    await screen.findByTestId("one-time-link");
    const third = post(calls)[2]!.headers["Idempotency-Key"];
    expect(third).toBeTruthy();
    expect(third).not.toBe(first);
  });

  it("shows the not-allowed screen to someone who cannot manage staff", () => {
    const calls = mockApi(() => reply(201, CREATED));
    renderAs(<InviteForm />, "sales");
    expect(screen.getByText("You can’t open Employees")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("is available in Arabic with the confirmed role names", () => {
    renderAs(<InviteForm />, "owner", "ar");
    expect(screen.getByRole("checkbox", { name: /^مالك/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^مدير/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^موظف مبيعات/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^موظف تجهيز/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^موظف توصيل وتحصيل/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إنشاء الدعوة" })).toBeInTheDocument();
  });
});
