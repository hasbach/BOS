import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResetForm } from "@/app/[locale]/(auth)/reset/ResetForm";
import { SignInForm } from "@/app/[locale]/(auth)/sign-in/SignInForm";
import { Screen, StatusHeader } from "@/components/Screen";
import { titleFrom } from "@/lib/metadata";

import { apiError, mockApi } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { visit } from "../helpers/setup-url";
import { ar, en, renderWithIntl } from "../utils";

// Task T087 (accessibility pass): the behaviour the pass added or relies on.

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);
vi.mock("@/lib/navigate", () => ({ hardNavigate: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ locale }: { locale: "en" | "ar" }) => (key: string) =>
    key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], locale === "ar" ? ar : en),
}));

beforeEach(() => resetNavigation("/sign-in"));
afterEach(() => {
  vi.unstubAllGlobals();
  visit("/");
});

describe("after a submit with errors, focus moves to the first invalid field", () => {
  it("sign-in: an empty form focuses the identifier, then the missing password", async () => {
    renderWithIntl(<SignInForm />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const identifier = screen.getByLabelText("Phone or email");
    await waitFor(() => expect(identifier).toHaveFocus());
    expect(identifier).toHaveAttribute("aria-invalid", "true");
    expect(identifier).toHaveAccessibleDescription(/./);

    fireEvent.change(identifier, { target: { value: "+96170000111" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveFocus());
  });

  it("sign-in: a wrong password focuses the password field, which carries the message", async () => {
    mockApi(() => apiError(401, "invalid_credentials"));
    renderWithIntl(<SignInForm />);
    fireEvent.change(screen.getByLabelText("Phone or email"), { target: { value: "+96170000111" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const password = screen.getByLabelText("Password");
    await waitFor(() => expect(password).toHaveFocus());
    expect(password).toHaveAccessibleDescription(/Wrong phone, email or password/);
  });

  it("reset request: a bad email focuses the email field", async () => {
    visit("/en/reset");
    renderWithIntl(<ResetForm />);
    const email = await screen.findByLabelText("Email");
    fireEvent.change(email, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(email).toHaveFocus());
    expect(email).toHaveAttribute("aria-invalid", "true");
  });
});

describe("page structure", () => {
  it("a screen is the main landmark", () => {
    render(
      <Screen>
        <p>body</p>
      </Screen>,
    );
    expect(screen.getByRole("main")).toHaveTextContent("body");
  });

  it("a status heading is a sub-heading under an app bar, and the page heading only when asked", () => {
    const { rerender } = render(<StatusHeader tone="accent" icon="check" title="Done" text="All set." />);
    expect(screen.getByRole("heading", { name: "Done", level: 2 })).toBeInTheDocument();
    rerender(<StatusHeader tone="accent" icon="check" title="Done" text="All set." level={1} />);
    expect(screen.getByRole("heading", { name: "Done", level: 1 })).toBeInTheDocument();
  });

  it("each page names the browser tab after its screen, in the page language", async () => {
    const generate = titleFrom("staff.title");
    expect(await generate({ params: Promise.resolve({ locale: "en" }) })).toEqual({ title: en.staff.title });
    expect(await generate({ params: Promise.resolve({ locale: "ar" }) })).toEqual({ title: ar.staff.title });
    expect(await generate({ params: Promise.resolve({ locale: "fr" }) })).toEqual({});
  });
});
