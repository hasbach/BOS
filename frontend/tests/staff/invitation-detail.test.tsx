import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InvitationDetail } from "@/app/[locale]/(shell)/more/employees/invitations/[invitationId]/InvitationDetail";

import { apiError, reply } from "../helpers/fetch";
import type { Call } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { HADI, LINK, LIST, RITA, renderAs, staffApi } from "../helpers/staff";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/employees/invitations/inv-hadi"));
afterEach(() => vi.unstubAllGlobals());

const OWNER_INVITE = { ...HADI, invitation_id: "inv-owner", name: "Tala Demo", roles: ["owner" as const], all_stores: true, store_ids: [] };
const withOwnerInvite = () => LIST({ invitations: [HADI, RITA, OWNER_INVITE] });

const open = async (id: string, kind: "owner" | "manager" | "sales" = "owner", locale: "en" | "ar" = "en") => {
  renderAs(<InvitationDetail invitationId={id} />, kind, locale);
  await screen.findByRole("heading", { level: 1, name: (name) => name !== "Employees" && name !== "الموظفون" });
};
const resendButton = () => screen.getByRole("button", { name: /Resend link/ });
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("invitation detail", () => {
  it("shows a pending invitation with Resend and Revoke", async () => {
    staffApi(LIST());
    await open("inv-hadi");
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Expires 18 Nov 2026")).toBeInTheDocument();
    expect(screen.getByText("Store B")).toBeInTheDocument();
    expect(screen.getByText(/The link was shown only once/)).toBeInTheDocument();
    expect(resendButton()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Revoke invitation/ })).toBeInTheDocument();
  });

  it("shows an expired invitation with Resend only: it cannot be revoked", async () => {
    staffApi(LIST());
    await open("inv-rita");
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByText("Expired on 4 Nov 2026")).toBeInTheDocument();
    expect(screen.getByText(/The link has expired/)).toBeInTheDocument();
    expect(resendButton()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();
  });

  it("resends, shows the new link once, and goes back to a refreshed invitation", async () => {
    const calls = staffApi(LIST(), () => reply(201, { ...LINK, invitation: HADI }));
    await open("inv-hadi");
    fireEvent.click(resendButton());

    expect(await screen.findByTestId("one-time-link")).toHaveTextContent(LINK.link);
    expect(writes(calls)[0]).toMatchObject({ url: "/api/v1/staff/invitations/inv-hadi/resend", method: "POST" });
    expect(screen.getByText("New link created for Hadi Demo. The old link no longer works.")).toBeInTheDocument();
    expect(screen.getByText("Works once, within 7 days (until 19 Nov 2026).")).toBeInTheDocument();
    expect(screen.getByText("The invitation is Pending again and expires 7 days from now.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Hadi Demo" })).toBeInTheDocument();
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("resends an expired invitation too", async () => {
    const calls = staffApi(LIST(), () => reply(201, { ...LINK, invitation: { ...RITA, status: "pending" } }));
    await open("inv-rita");
    fireEvent.click(resendButton());
    expect(await screen.findByText("New link created for Rita Demo. The old link no longer works.")).toBeInTheDocument();
    expect(writes(calls)[0]!.url).toBe("/api/v1/staff/invitations/inv-rita/resend");
  });

  it("removes the actions and says the invitation is closed when the server answers invitation_closed", async () => {
    staffApi(LIST(), () => apiError(409, "invitation_closed"));
    await open("inv-hadi");
    fireEvent.click(resendButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("This invitation is no longer open. It was accepted, cancelled or has expired, so nothing was changed.");
    expect(screen.queryByRole("button", { name: /Resend|Revoke/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to employees" })).toHaveAttribute("href", "/more/employees");
  });

  it.each([
    ["already_member", 409, "This person is already in your business or has a pending invitation."],
    ["forbidden", 403, "You don't have permission to do this."],
  ])("shows %s when resending is refused", async (code, status, text) => {
    staffApi(LIST(), () => apiError(status, code));
    await open("inv-rita");
    fireEvent.click(resendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByTestId("one-time-link")).not.toBeInTheDocument();
    expect(resendButton()).toBeEnabled();
  });

  it("shows the not-found screen when resending finds nothing", async () => {
    staffApi(LIST(), () => apiError(404, "not_found"));
    await open("inv-hadi");
    fireEvent.click(resendButton());
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });

  it("asks before revoking, then revokes and returns to the list", async () => {
    const calls = staffApi(LIST(), () => reply(204));
    await open("inv-hadi");

    fireEvent.click(screen.getByRole("button", { name: /Revoke invitation/ }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke the invitation for Hadi Demo?" });
    expect(within(dialog).getByText(/stops working at once/)).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: /^Revoke$/ }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/more/employees"));
    expect(writes(calls)[0]).toMatchObject({ url: "/api/v1/staff/invitations/inv-hadi", method: "DELETE" });
  });

  it("can keep the invitation without sending anything", async () => {
    const calls = staffApi(LIST());
    await open("inv-hadi");
    fireEvent.click(screen.getByRole("button", { name: /Revoke invitation/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Keep invitation" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });

  it("shows invitation_closed when the person accepted while the sheet was open", async () => {
    staffApi(LIST(), () => apiError(409, "invitation_closed"));
    await open("inv-hadi");
    fireEvent.click(screen.getByRole("button", { name: /Revoke invitation/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^Revoke$/ }));
    expect(await screen.findByText(/no longer open/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows forbidden when revoking is refused and stays put", async () => {
    staffApi(LIST(), () => apiError(403, "forbidden"));
    await open("inv-hadi");
    fireEvent.click(screen.getByRole("button", { name: /Revoke invitation/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^Revoke$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to do this.");
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("invitation detail: permissions", () => {
  it("lets a manager resend and revoke an ordinary invitation", async () => {
    staffApi(withOwnerInvite());
    await open("inv-hadi", "manager");
    expect(resendButton()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Revoke invitation/ })).toBeInTheDocument();
  });

  it("hides Resend and Revoke from a manager for an invitation that carries the Owner role", async () => {
    staffApi(withOwnerInvite());
    await open("inv-owner", "manager");
    expect(screen.getByText("Only an owner can resend or revoke an invitation for an owner.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resend|Revoke/ })).not.toBeInTheDocument();
  });

  it("lets an owner resend an owner invitation", async () => {
    staffApi(withOwnerInvite());
    await open("inv-owner", "owner");
    expect(resendButton()).toBeInTheDocument();
  });

  it("shows the not-allowed screen to a sales agent", () => {
    const calls = staffApi(LIST());
    renderAs(<InvitationDetail invitationId="inv-hadi" />, "sales");
    expect(screen.getByText("You can’t open Employees")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("shows the not-found screen for an invitation that is not in the list", async () => {
    staffApi(LIST());
    renderAs(<InvitationDetail invitationId="nope" />);
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });
});

describe("invitation detail: Arabic", () => {
  it("uses the Arabic wording and keeps names as typed", async () => {
    staffApi(LIST());
    await open("inv-hadi", "owner", "ar");
    expect(screen.getByText("Hadi Demo", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /إعادة إرسال الرابط/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /إلغاء الدعوة/ })).toBeInTheDocument();
    expect(screen.getByText("بانتظار القبول")).toBeInTheDocument();
  });
});
