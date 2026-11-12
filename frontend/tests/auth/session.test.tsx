import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignOutButton } from "@/components/SignOutButton";
import { useMe } from "@/lib/session";
import { SessionGuard } from "@/components/SessionGuard";

import { ME, apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { nav, resetNavigation, router } from "../helpers/navigation";
import { renderWithIntl } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/"));
afterEach(() => vi.unstubAllGlobals());

// Stands in for any signed-in screen: names the business and the person and offers Sign out.
function TestHome() {
  const me = useMe();
  return (
    <div>
      <p>{me.business.name}</p>
      <p>{me.user.name}</p>
      <SignOutButton />
    </div>
  );
}

const guarded = () => (
  <SessionGuard>
    <TestHome />
  </SessionGuard>
);

describe("session guard", () => {
  it("sends a visitor without a session to sign-in and shows nothing of the shell", async () => {
    mockApi(() => apiError(401, "unauthenticated"));
    renderWithIntl(guarded());

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"));
    expect(screen.queryByText("Demo Denim House Group")).not.toBeInTheDocument();
  });

  it.each(["business_suspended", "business_pending"])("sends the visitor to sign-in for %s", async (code) => {
    mockApi(() => apiError(403, code));
    renderWithIntl(guarded());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"));
  });

  it("loads /me and shows the business name and the user name", async () => {
    const calls = mockApi(() => reply(200, ME("en")));
    renderWithIntl(guarded(), "en");

    expect(await screen.findByText("Demo Denim House Group")).toBeInTheDocument();
    expect(screen.getByText("Dana Demo")).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ url: "/api/v1/me", method: "GET" });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("moves to the saved language of the user when the address has another one (FR-027a)", async () => {
    nav.pathname = "/";
    mockApi(() => reply(200, ME("ar")));
    renderWithIntl(guarded(), "en");

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/", { locale: "ar" }));
    expect(screen.queryByText("Demo Denim House Group")).not.toBeInTheDocument();
  });

  it("shows the shell in Arabic when the saved language is Arabic and the address agrees", async () => {
    mockApi(() => reply(200, ME("ar")));
    renderWithIntl(guarded(), "ar");

    expect(await screen.findByText("Demo Denim House Group")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تسجيل الخروج" })).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("offers retry when /me cannot be reached", async () => {
    let first = true;
    mockApi(() => {
      if (first) {
        first = false;
        return networkFailure();
      }
      return reply(200, ME());
    });
    renderWithIntl(guarded());

    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Dana Demo")).toBeInTheDocument();
  });
});

describe("home and sign out", () => {
  it("signs out with POST /auth/sign-out and goes to sign-in once the server answered", async () => {
    const calls = mockApi(({ url }) => (url.endsWith("/me") ? reply(200, ME()) : reply(204)));
    renderWithIntl(guarded());
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"));
    expect(calls[1]).toMatchObject({ url: "/api/v1/auth/sign-out", method: "POST" });
    expect(calls[1]?.headers["X-BOS-CSRF"]).toBe("1");
  });

  it("stays signed in and says so when sign-out failed", async () => {
    mockApi(({ url }) => (url.endsWith("/me") ? reply(200, ME()) : networkFailure()));
    renderWithIntl(guarded());
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });
});
