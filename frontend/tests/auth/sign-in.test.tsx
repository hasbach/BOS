import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignInForm } from "@/app/[locale]/(auth)/sign-in/SignInForm";

import { ME, apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { renderWithIntl } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);
vi.mock("@/lib/navigate", () => ({ hardNavigate: vi.fn() }));

beforeEach(() => resetNavigation("/sign-in"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fill(identifier: string, password: string) {
  fireEvent.change(screen.getByLabelText("Phone or email"), { target: { value: identifier } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

const submit = () => fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

describe("sign-in screen", () => {
  it("signs in and goes to the shell in the saved language of the user", async () => {
    const calls = mockApi(() => reply(200, ME("ar")));
    renderWithIntl(<SignInForm />, "en");
    fill(" +961 70 000 111 ", "correct horse battery");
    submit();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/", { locale: "ar" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "/api/v1/auth/sign-in",
      method: "POST",
      body: { identifier: "+961 70 000 111", password: "correct horse battery" },
    });
    expect(calls[0]?.headers["X-BOS-CSRF"]).toBe("1");
  });

  it("goes nowhere before the server has answered", async () => {
    let release: (response: Response) => void = () => {};
    mockApi(() => new Promise<Response>((resolve) => (release = resolve)));
    renderWithIntl(<SignInForm />);
    fill("a@b.example", "password-123");
    submit();

    await waitFor(() => expect(screen.getByRole("button", { name: /Sign in/ })).toBeDisabled());
    expect(router.replace).not.toHaveBeenCalled();
    release(reply(200, ME()));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
  });

  it("shows one generic message for invalid_credentials", async () => {
    mockApi(() => apiError(401, "invalid_credentials"));
    renderWithIntl(<SignInForm />);
    fill("+96170000111", "nope");
    submit();

    expect(await screen.findByText("Wrong phone, email or password. Check them and try again.")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("shows the suspended message with the plain Beta contact when no WhatsApp number is set", async () => {
    mockApi(() => apiError(403, "business_suspended"));
    renderWithIntl(<SignInForm />);
    fill("+96170000111", "password-123");
    submit();

    expect(await screen.findByText("This business account is suspended.")).toBeInTheDocument();
    expect(screen.getByText("Contact Beta Marketing Solutions")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /WhatsApp/ })).not.toBeInTheDocument();
  });

  it("offers the WhatsApp button on the suspended message when a number is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_BOS_SUPPORT_WHATSAPP", "+96170123456");
    mockApi(() => apiError(403, "business_suspended"));
    renderWithIntl(<SignInForm />);
    fill("+96170000111", "password-123");
    submit();

    const link = await screen.findByRole("link", { name: "Message Beta on WhatsApp" });
    expect(link).toHaveAttribute("href", "https://wa.me/96170123456");
  });

  it("shows the not-activated message for business_pending", async () => {
    mockApi(() => apiError(403, "business_pending"));
    renderWithIntl(<SignInForm />);
    fill("+96170000111", "password-123");
    submit();

    expect(await screen.findByText(/This business is not activated yet/)).toBeInTheDocument();
  });

  it("shows the offline notice and a Try again button after a network failure, keeping what was typed", async () => {
    mockApi(networkFailure);
    renderWithIntl(<SignInForm />);
    fill("+96170000111", "password-123");
    submit();

    expect(await screen.findByText(/No connection\. Check your internet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByLabelText("Phone or email")).toHaveValue("+96170000111");
    expect(screen.getByLabelText("Password")).toHaveValue("password-123");
  });

  it("shows the rate-limit message for too_many_requests", async () => {
    mockApi(() => apiError(429, "too_many_requests"));
    renderWithIntl(<SignInForm />);
    fill("+96170000111", "password-123");
    submit();

    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
  });

  it("asks for both fields without sending anything", () => {
    const calls = mockApi(() => reply(200, ME()));
    renderWithIntl(<SignInForm />);
    submit();

    expect(screen.getByText("Enter your phone or email.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("shows and hides the password", () => {
    renderWithIntl(<SignInForm />);
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("links to Forgot password", () => {
    renderWithIntl(<SignInForm />);
    expect(screen.getByRole("link", { name: "Forgot password" })).toHaveAttribute("href", "/reset");
  });

  it("is available in Arabic", () => {
    renderWithIntl(<SignInForm />, "ar");
    expect(screen.getByLabelText("الهاتف أو البريد الإلكتروني")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تسجيل الدخول" })).toBeInTheDocument();
  });
});
