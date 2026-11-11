import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpsSignInForm } from "@/app/[locale]/ops/sign-in/OpsSignInForm";
import { OpsGuard } from "@/components/SessionGuard";

import { OPS_ME, apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { renderWithIntl } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);
vi.mock("@/lib/navigate", () => ({ hardNavigate: vi.fn() }));

beforeEach(() => resetNavigation("/ops/sign-in"));
afterEach(() => vi.unstubAllGlobals());

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in to console" }));
}

describe("operator sign-in", () => {
  it("signs in and opens the console", async () => {
    const calls = mockApi(() => reply(200, OPS_ME));
    renderWithIntl(<OpsSignInForm />);
    expect(screen.getByText("Beta staff only")).toBeInTheDocument();
    fill("layla@beta.example", "a long enough password");

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/ops"));
    expect(calls[0]).toMatchObject({
      url: "/api/v1/ops/auth/sign-in",
      method: "POST",
      body: { email: "layla@beta.example", password: "a long enough password" },
    });
  });

  it("shows one message for invalid_credentials", async () => {
    mockApi(() => apiError(401, "invalid_credentials"));
    renderWithIntl(<OpsSignInForm />);
    fill("layla@beta.example", "wrong");

    expect(await screen.findByText("Wrong email or password.")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows a failure to reach the server as such", async () => {
    mockApi(networkFailure);
    renderWithIntl(<OpsSignInForm />);
    fill("layla@beta.example", "whatever-password");

    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("points merchants to their own sign-in", () => {
    renderWithIntl(<OpsSignInForm />);
    expect(screen.getByRole("link", { name: "Go to merchant sign in" })).toHaveAttribute("href", "/sign-in");
  });

  it("is available in Arabic", () => {
    renderWithIntl(<OpsSignInForm />, "ar");
    expect(screen.getByText("لفريق Beta فقط")).toBeInTheDocument();
  });
});

describe("operator guard", () => {
  it("sends a visitor without an operator session to operator sign-in", async () => {
    const calls = mockApi(() => apiError(401, "unauthenticated"));
    renderWithIntl(
      <OpsGuard>
        <p>console</p>
      </OpsGuard>,
    );

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/ops/sign-in"));
    expect(calls[0]).toMatchObject({ url: "/api/v1/ops/me", method: "GET" });
    expect(screen.queryByText("console")).not.toBeInTheDocument();
  });

  it("shows the page for a signed-in operator", async () => {
    mockApi(() => reply(200, OPS_ME));
    renderWithIntl(
      <OpsGuard>
        <p>console</p>
      </OpsGuard>,
    );
    expect(await screen.findByText("console")).toBeInTheDocument();
  });
});
