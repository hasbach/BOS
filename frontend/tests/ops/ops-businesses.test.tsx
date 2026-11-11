import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpsBusinesses } from "@/app/[locale]/ops/OpsBusinesses";

import { BUSINESS, OPS_ME, apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import type { Call } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { renderWithIntl } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);
vi.mock("@/lib/navigate", () => ({ hardNavigate: vi.fn() }));

const ACTIVE = BUSINESS();
const PENDING = BUSINESS({
  id: "biz-2",
  name: "Demo Linen Corner",
  edition: "social",
  status: "pending",
  owners: [],
  pending_owner_contact: "+961 70 000 012",
  store_count: 1,
  user_count: 0,
});
const SUSPENDED = BUSINESS({
  id: "biz-3",
  name: "Demo Shoe Bazaar",
  edition: "social",
  status: "suspended",
  owners: [{ user_id: "own-3", name: "Rami Demo", contact: "rami@demo.example", has_email: true }],
});
const NO_EMAIL = BUSINESS({
  id: "biz-4",
  name: "Demo Bakery Box",
  edition: "social",
  owners: [{ user_id: "own-4", name: "Maya Demo", contact: "+961 70 000 014", has_email: false }],
  store_count: 1,
  user_count: 2,
});
const ALL = [ACTIVE, PENDING, SUSPENDED, NO_EMAIL];

beforeEach(() => resetNavigation("/ops"));
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
});

function api(handler: (call: Call) => Response | Promise<Response> = () => reply(404)) {
  return mockApi((call) => {
    if (call.url.endsWith("/ops/me")) return reply(200, OPS_ME);
    if (call.url.endsWith("/ops/businesses") && call.method === "GET") return reply(200, ALL);
    return handler(call);
  });
}

const card = (name: string) => screen.getByRole("heading", { name }).closest("article") as HTMLElement;

describe("operator business list", () => {
  it("shows account-level fields only, with the status as a word", async () => {
    api();
    renderWithIntl(<OpsBusinesses />);

    const active = await screen.findByRole("heading", { name: "Demo Denim House Group" });
    expect(active).toBeInTheDocument();
    const a = within(card("Demo Denim House Group"));
    expect(a.getByText("Active")).toBeInTheDocument();
    expect(a.getByText("BOS Commerce")).toBeInTheDocument();
    expect(a.getByText("Samer Demo", { exact: false })).toBeInTheDocument();
    expect(a.getByText("+961 70 000 011")).toBeInTheDocument();

    expect(within(card("Demo Linen Corner")).getByText("Pending")).toBeInTheDocument();
    expect(within(card("Demo Linen Corner")).getByText("Owner (not activated yet)")).toBeInTheDocument();
    expect(within(card("Demo Shoe Bazaar")).getByText("Suspended")).toBeInTheDocument();
    expect(screen.getByText(/You see account details only/)).toBeInTheDocument();
    expect(screen.getByText("Layla Demo")).toBeInTheDocument();
  });

  it("offers each action only where it applies", async () => {
    api();
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Denim House Group" });

    expect(within(card("Demo Denim House Group")).getByRole("button", { name: /Suspend/ })).toBeInTheDocument();
    expect(within(card("Demo Denim House Group")).queryByRole("button", { name: /reset link/ })).not.toBeInTheDocument();
    expect(within(card("Demo Linen Corner")).getByRole("button", { name: /Resend activation link/ })).toBeInTheDocument();
    expect(within(card("Demo Shoe Bazaar")).getByRole("button", { name: /Reactivate/ })).toBeInTheDocument();
    expect(within(card("Demo Bakery Box")).getByRole("button", { name: /Issue owner reset link/ })).toBeInTheDocument();
    expect(within(card("Demo Bakery Box")).getByText("No email")).toBeInTheDocument();
  });

  it("filters by status on the device", async () => {
    const calls = api();
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Denim House Group" });

    expect(screen.getByRole("button", { name: "All 4" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Suspended 1" }));
    expect(screen.queryByRole("heading", { name: "Demo Denim House Group" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Demo Shoe Bazaar" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pending 1" }));
    expect(screen.getByRole("heading", { name: "Demo Linen Corner" })).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith("/ops/businesses"))).toHaveLength(1);
  });

  it("asks before suspending, then updates the card from the server answer", async () => {
    const calls = api(() => reply(200, { ...ACTIVE, status: "suspended" }));
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Denim House Group" });

    fireEvent.click(within(card("Demo Denim House Group")).getByRole("button", { name: /Suspend/ }));
    const dialog = await screen.findByRole("dialog", { name: "Suspend Demo Denim House Group?" });
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: /^Suspend$/ }));
    await waitFor(() => expect(within(card("Demo Denim House Group")).getByText("Suspended")).toBeInTheDocument());
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toMatchObject({ url: "/api/v1/ops/businesses/biz-1", body: { status: "suspended" } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can be cancelled without sending anything", async () => {
    const calls = api();
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Denim House Group" });
    fireEvent.click(within(card("Demo Denim House Group")).getByRole("button", { name: /Suspend/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("reactivates after confirming", async () => {
    const calls = api(() => reply(200, { ...SUSPENDED, status: "active" }));
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Shoe Bazaar" });
    fireEvent.click(within(card("Demo Shoe Bazaar")).getByRole("button", { name: /Reactivate/ }));
    const dialog = await screen.findByRole("dialog", { name: "Reactivate Demo Shoe Bazaar?" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Reactivate/ }));

    await waitFor(() => expect(within(card("Demo Shoe Bazaar")).getByText("Active")).toBeInTheDocument());
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "active" });
  });

  it("shows the server error when a status change is refused and keeps the old status", async () => {
    api(() => apiError(409, "business_pending"));
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Denim House Group" });
    fireEvent.click(within(card("Demo Denim House Group")).getByRole("button", { name: /Suspend/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^Suspend$/ }));

    expect(await screen.findByText("This business is not active yet.")).toBeInTheDocument();
    expect(within(card("Demo Denim House Group")).getByText("Active")).toBeInTheDocument();
  });

  it("resends the activation link and shows it once, with Done as the only way out", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const calls = api(() => reply(201, { link: "https://app.example/en/activate#NEWTOKEN", expires_at: "2026-11-18T10:00:00Z" }));
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Linen Corner" });
    fireEvent.click(within(card("Demo Linen Corner")).getByRole("button", { name: /Resend activation link/ }));

    expect(await screen.findByTestId("one-time-link")).toHaveTextContent("https://app.example/en/activate#NEWTOKEN");
    expect(calls.find((c) => c.method === "POST")?.url).toBe("/api/v1/ops/businesses/biz-2/owner-activation");
    expect(screen.getByText("Copy it now. This link will not be shown again.")).toBeInTheDocument();
    expect(screen.getByText("Works once, within 7 days (until 18 Nov 2026).")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Back" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://app.example/en/activate#NEWTOKEN"));
    expect(await screen.findByText("Link copied")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("heading", { name: "Demo Linen Corner" })).toBeInTheDocument();
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
  });

  it("issues an owner reset link only for the owner without an email", async () => {
    const calls = api(() => reply(201, { link: "https://app.example/en/reset#RESETTOKEN", expires_at: "2026-11-11T11:00:00Z" }));
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Bakery Box" });
    fireEvent.click(within(card("Demo Bakery Box")).getByRole("button", { name: /Issue owner reset link/ }));

    expect(await screen.findByTestId("one-time-link")).toHaveTextContent("RESETTOKEN");
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({ url: "/api/v1/ops/businesses/biz-4/owner-password-reset", body: { owner_user_id: "own-4" } });
    expect(screen.getByText("Works once, within 1 hour.")).toBeInTheDocument();
    expect(screen.getByText(/recorded in the business's history/)).toBeInTheDocument();
    expect(screen.getByText("Password reset link for Maya Demo")).toBeInTheDocument();
  });

  it("shows owner_has_email and invitation_closed errors from the server", async () => {
    api((call) => (call.url.includes("owner-password-reset") ? apiError(409, "owner_has_email") : apiError(409, "invitation_closed")));
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Bakery Box" });
    fireEvent.click(within(card("Demo Bakery Box")).getByRole("button", { name: /Issue owner reset link/ }));
    expect(await screen.findByText("This owner has an email. Use the email reset instead.")).toBeInTheDocument();

    fireEvent.click(within(card("Demo Linen Corner")).getByRole("button", { name: /Resend activation link/ }));
    expect(await screen.findByText("This invitation is no longer open.")).toBeInTheDocument();
  });

  it("shares through the share sheet when the browser has one, and falls back to copy when it does not", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    api(() => reply(201, { link: "https://app.example/en/activate#T", expires_at: "2026-11-18T10:00:00Z" }));
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Linen Corner" });
    fireEvent.click(within(card("Demo Linen Corner")).getByRole("button", { name: /Resend activation link/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Share link" }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ url: "https://app.example/en/activate#T" }));
    expect(writeText).not.toHaveBeenCalled();

    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    fireEvent.click(screen.getByRole("button", { name: "Share link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://app.example/en/activate#T"));
  });

  it("says when copying failed", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    api(() => reply(201, { link: "https://app.example/en/activate#T", expires_at: "2026-11-18T10:00:00Z" }));
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Linen Corner" });
    fireEvent.click(within(card("Demo Linen Corner")).getByRole("button", { name: /Resend activation link/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(await screen.findByText(/Couldn't copy/)).toBeInTheDocument();
  });

  it("shows the empty state with the one next step", async () => {
    mockApi((call) => (call.url.endsWith("/ops/me") ? reply(200, OPS_ME) : reply(200, [])));
    renderWithIntl(<OpsBusinesses />);
    expect(await screen.findByText("No businesses yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Set up a business/ })).toHaveAttribute("href", "/ops/new");
  });

  it("offers retry when the list cannot be loaded", async () => {
    let failed = false;
    mockApi((call) => {
      if (call.url.endsWith("/ops/me")) return reply(200, OPS_ME);
      if (!failed) {
        failed = true;
        return networkFailure();
      }
      return reply(200, ALL);
    });
    renderWithIntl(<OpsBusinesses />);
    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Demo Denim House Group" })).toBeInTheDocument();
  });

  it("sends an unauthenticated visitor to operator sign-in", async () => {
    mockApi(() => apiError(401, "unauthenticated"));
    renderWithIntl(<OpsBusinesses />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/ops/sign-in"));
  });

  it("signs the operator out", async () => {
    const calls = api(() => reply(204));
    renderWithIntl(<OpsBusinesses />);
    await screen.findByRole("heading", { name: "Demo Denim House Group" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/ops/sign-in"));
    expect(calls.find((c) => c.method === "POST")?.url).toBe("/api/v1/ops/auth/sign-out");
  });

  it("is available in Arabic", async () => {
    api();
    renderWithIntl(<OpsBusinesses />, "ar");
    expect(await screen.findByText("بانتظار التفعيل 1")).toBeInTheDocument();
  });
});
