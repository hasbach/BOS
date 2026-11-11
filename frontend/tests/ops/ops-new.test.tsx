import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpsNewBusiness } from "@/app/[locale]/ops/new/OpsNewBusiness";

import { BUSINESS, OPS_ME, apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import type { Call } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { renderWithIntl } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);
vi.mock("@/lib/navigate", () => ({ hardNavigate: vi.fn() }));

beforeEach(() => resetNavigation("/ops/new"));
afterEach(() => vi.unstubAllGlobals());

const CREATED = {
  business: BUSINESS({ id: "biz-9", name: "Demo Linen Corner", status: "pending" }),
  link: "https://app.example/en/activate#CREATEDTOKEN",
  expires_at: "2026-11-18T10:00:00Z",
};

function api(handler: (call: Call) => Response | Promise<Response>) {
  return mockApi((call) => (call.url.endsWith("/ops/me") ? reply(200, OPS_ME) : handler(call)));
}

async function fillForm(over: Partial<Record<string, string>> = {}) {
  const values: Record<string, string> = {
    "Business name": "Demo Linen Corner",
    "First store name": "Main store",
    "USD → LBP rate (required)": "89500",
    "Owner name": "Layla Demo",
    "Owner phone": "+961 70 000 013",
    "Owner email": "",
    ...over,
  };
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(await screen.findByLabelText(label), { target: { value } });
  }
}

const create = () => fireEvent.click(screen.getByRole("button", { name: "Create business and link" }));
const posts = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/ops/businesses") && c.method === "POST");

describe("operator set-up form", () => {
  it("creates the business with the details, shows the link once and ends on Done", async () => {
    const calls = api(() => reply(201, CREATED));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm();
    fireEvent.click(screen.getByRole("radio", { name: "BOS Commerce" }));
    fireEvent.click(screen.getByRole("radio", { name: "LBP" }));
    create();

    expect(await screen.findByTestId("one-time-link")).toHaveTextContent("CREATEDTOKEN");
    const [post] = posts(calls);
    expect(post?.body).toEqual({
      business_name: "Demo Linen Corner",
      store_name: "Main store",
      edition: "commerce",
      default_currency: "LBP",
      usd_lbp_rate: "89500",
      owner_name: "Layla Demo",
      owner_phone: "+961 70 000 013",
    });
    expect(post?.headers["X-BOS-CSRF"]).toBe("1");
    expect(post?.headers["Idempotency-Key"]).toMatch(/^[\w-]{8,}$/);
    expect(screen.getByText("Demo Linen Corner is set up. Status: Pending until the owner activates.")).toBeInTheDocument();
    expect(screen.getByText("Activation link for Layla Demo")).toBeInTheDocument();
    expect(screen.getByText("Copy it now. This link will not be shown again.")).toBeInTheDocument();
    expect(screen.getByText("Works once, within 7 days (until 18 Nov 2026).")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(router.replace).toHaveBeenCalledWith("/ops");
  });

  it("shows no link and no success before the server answered", async () => {
    let release: (response: Response) => void = () => {};
    api(() => new Promise<Response>((resolve) => (release = resolve)));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm();
    create();

    await waitFor(() => expect(screen.getByRole("button", { name: /Create business and link/ })).toBeDisabled());
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
    release(reply(201, CREATED));
    expect(await screen.findByTestId("one-time-link")).toBeInTheDocument();
  });

  it("checks required fields on the device and counts what to fix", async () => {
    const calls = api(() => reply(201, CREATED));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm({ "Business name": "", "USD → LBP rate (required)": "", "Owner phone": "" });
    create();

    expect(screen.getByText("Enter the business name.")).toBeInTheDocument();
    expect(screen.getByText("Enter the rate, for example 89500.")).toBeInTheDocument();
    expect(screen.getByText("Enter a phone number or an email.")).toBeInTheDocument();
    expect(screen.getByText("3 things to fix before you continue.")).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
  });

  it("accepts an email alone as the owner contact", async () => {
    const calls = api(() => reply(201, CREATED));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm({ "Owner phone": "", "Owner email": "owner@demo.example" });
    create();

    await screen.findByTestId("one-time-link");
    expect(posts(calls)[0]?.body).toMatchObject({ owner_email: "owner@demo.example" });
    expect(posts(calls)[0]?.body).not.toHaveProperty("owner_phone");
  });

  it("rejects a rate that is not a number", async () => {
    api(() => reply(201, CREATED));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm({ "USD → LBP rate (required)": "89,500 LBP" });
    create();
    expect(screen.getByText("Enter the rate as a number, for example 89500.")).toBeInTheDocument();
  });

  it("tells the operator when the owner phone is unavailable", async () => {
    api(() => apiError(409, "identifier_unavailable"));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm();
    create();

    expect(await screen.findByText(/This phone number cannot be used/)).toBeInTheDocument();
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
  });

  it("maps field errors from validation_failed under the fields", async () => {
    api(() => apiError(400, "validation_failed", { owner_phone: "invalid_phone", business_name: "required" }));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm();
    create();

    expect(await screen.findByText("Enter a valid phone number")).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByText("2 things to fix before you continue.")).toBeInTheDocument();
  });

  it("shows other server errors in a banner", async () => {
    api(() => apiError(500, "internal_error"));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm();
    create();
    expect(await screen.findByText("Something went wrong on our side. Please try again.")).toBeInTheDocument();
  });

  it("reuses the same Idempotency-Key when the same details are sent again after a failure", async () => {
    let attempts = 0;
    const calls = api(() => {
      attempts += 1;
      return attempts === 1 ? networkFailure() : reply(201, CREATED);
    });
    renderWithIntl(<OpsNewBusiness />);
    await fillForm();
    create();
    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    create();
    await screen.findByTestId("one-time-link");

    const keys = posts(calls).map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("uses a new key when the details were changed after a failure", async () => {
    let attempts = 0;
    const calls = api(() => {
      attempts += 1;
      return attempts === 1 ? apiError(500, "internal_error") : reply(201, CREATED);
    });
    renderWithIntl(<OpsNewBusiness />);
    await fillForm();
    create();
    await screen.findByText("Something went wrong on our side. Please try again.");
    fireEvent.change(screen.getByLabelText("Owner name"), { target: { value: "Layla D." } });
    create();
    await screen.findByTestId("one-time-link");

    const keys = posts(calls).map((c) => c.headers["Idempotency-Key"]);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("shows idempotency_conflict as an error", async () => {
    api(() => apiError(409, "idempotency_conflict"));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm();
    create();
    expect(await screen.findByText(/already sent with different details/)).toBeInTheDocument();
  });

  it("is available in Arabic with names as typed", async () => {
    api(() => reply(201, CREATED));
    renderWithIntl(<OpsNewBusiness />, "ar");
    fireEvent.change(await screen.findByLabelText("اسم النشاط التجاري"), { target: { value: "Demo Linen Corner" } });
    expect(screen.getByLabelText("اسم النشاط التجاري")).toHaveValue("Demo Linen Corner");
    expect(screen.getByRole("button", { name: "إنشاء النشاط والرابط" })).toBeInTheDocument();
  });

  it("leaves the page with a warning while the link is on screen", async () => {
    api(() => reply(201, CREATED));
    renderWithIntl(<OpsNewBusiness />);
    await fillForm();
    create();
    await screen.findByTestId("one-time-link");

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
