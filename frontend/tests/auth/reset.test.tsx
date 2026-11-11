import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResetForm } from "@/app/[locale]/(auth)/reset/ResetForm";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { visit } from "../helpers/setup-url";
import { renderWithIntl } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);
vi.mock("@/lib/navigate", () => ({ hardNavigate: vi.fn() }));

const TOKEN = "reset-token-not-real-1234";

beforeEach(() => {
  resetNavigation("/reset");
  visit("/en/reset");
});
afterEach(() => {
  vi.unstubAllGlobals();
  visit("/");
});

describe("forgot password (request)", () => {
  async function request(email: string) {
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: email } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
  }

  it("asks for the email and shows the sent screen after the server accepts", async () => {
    const calls = mockApi(() => reply(204));
    renderWithIntl(<ResetForm />);
    expect(await screen.findByText("No email on your account?")).toBeInTheDocument();
    await request("name@demo.example");

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(calls[0]).toMatchObject({
      url: "/api/v1/auth/password-reset/request",
      method: "POST",
      body: { email: "name@demo.example" },
    });
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/sign-in");
  });

  it("goes back to the form from Use another email", async () => {
    mockApi(() => reply(204));
    renderWithIntl(<ResetForm />);
    await request("name@demo.example");
    fireEvent.click(await screen.findByRole("button", { name: "Use another email" }));
    expect(await screen.findByLabelText("Email")).toHaveValue("");
  });

  it("does not claim the link was sent when the request failed", async () => {
    mockApi(networkFailure);
    renderWithIntl(<ResetForm />);
    await request("name@demo.example");

    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Check your email" })).not.toBeInTheDocument();
  });

  it("rejects an empty or malformed email without calling the API", async () => {
    const calls = mockApi(() => reply(204));
    renderWithIntl(<ResetForm />);
    await request("");
    expect(screen.getByText("Required")).toBeInTheDocument();
    await request("not-an-email");
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe("set a new password (from the link)", () => {
  beforeEach(() => visit(`/en/reset#${TOKEN}`));

  function fillPasswords(password: string, confirm = password) {
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
  }

  const save = () => fireEvent.click(screen.getByRole("button", { name: "Save new password" }));

  it("saves with the token in the body only, removes it from the address bar and ends on Sign in", async () => {
    const calls = mockApi(() => reply(204));
    renderWithIntl(<ResetForm />);
    await screen.findByLabelText("New password");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);

    fillPasswords("a long enough password");
    save();

    expect(await screen.findByRole("heading", { name: "Password changed" })).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/auth/password-reset/complete");
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(calls[0]?.body).toEqual({ token: TOKEN, new_password: "a long enough password" });
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  });

  it("warns that other devices will be signed out", async () => {
    renderWithIntl(<ResetForm />);
    expect(await screen.findByText("You will be signed out of BOS on all your other devices.")).toBeInTheDocument();
  });

  it("checks length and matching before sending", async () => {
    const calls = mockApi(() => reply(204));
    renderWithIntl(<ResetForm />);
    await screen.findByLabelText("New password");
    fillPasswords("short");
    save();
    expect(screen.getByText("Use at least 10 characters.")).toBeInTheDocument();
    fillPasswords("a long enough password", "different one entirely");
    save();
    expect(screen.getByText("The two passwords do not match.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("shows weak_password under the field", async () => {
    mockApi(() => apiError(400, "weak_password"));
    renderWithIntl(<ResetForm />);
    await screen.findByLabelText("New password");
    fillPasswords("password123456");
    save();
    expect(await screen.findByText(/That password is too weak/)).toBeInTheDocument();
  });

  it("shows the invalid-link screen for link_invalid", async () => {
    mockApi(() => apiError(410, "link_invalid"));
    renderWithIntl(<ResetForm />);
    await screen.findByLabelText("New password");
    fillPasswords("a long enough password");
    save();
    expect(await screen.findByRole("heading", { name: "This link is no longer valid" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Forgot password" })).toHaveAttribute("href", "/reset");
  });

  it("does not show success when the request failed", async () => {
    mockApi(networkFailure);
    renderWithIntl(<ResetForm />);
    await screen.findByLabelText("New password");
    fillPasswords("a long enough password");
    save();
    await waitFor(() => expect(screen.getByText(/Can't reach the server/)).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Password changed" })).not.toBeInTheDocument();
  });
});
