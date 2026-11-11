import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActivateForm } from "@/app/[locale]/(auth)/activate/ActivateForm";
import { hardNavigate } from "@/lib/navigate";

import { ME, PREVIEW, apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { visit } from "../helpers/setup-url";
import { renderWithIntl } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);
vi.mock("@/lib/navigate", () => ({ hardNavigate: vi.fn() }));

const TOKEN = "Xk3-demo-0000-not-a-real-token";

beforeEach(() => {
  resetNavigation("/activate");
  vi.mocked(hardNavigate).mockReset();
  visit(`/en/activate#${TOKEN}`);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  visit("/");
});

function fillPasswords(password: string, confirm = password) {
  fireEvent.change(document.querySelector('input[name="new-password"]')!, { target: { value: password } });
  fireEvent.change(document.querySelector('input[name="confirm-password"]')!, { target: { value: confirm } });
}

const activate = () => fireEvent.click(screen.getByRole("button", { name: "Activate and sign in" }));
const isPreview = (url: string) => url.endsWith("/preview");

describe("activate screen", () => {
  it("previews the link, then activates and signs in", async () => {
    const calls = mockApi(({ url }) => (isPreview(url) ? reply(200, PREVIEW) : reply(200, ME("en"))));
    renderWithIntl(<ActivateForm />, "en");

    expect(await screen.findByText("Demo Denim House Group")).toBeInTheDocument();
    expect(screen.getByText("Welcome, Dana Demo")).toBeInTheDocument();
    expect(screen.getByText("Added by your manager")).toBeInTheDocument();
    expect(screen.getByText("Sales")).toBeInTheDocument();
    expect(screen.getByText("Packing")).toBeInTheDocument();

    fillPasswords("a long enough password");
    activate();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/", { locale: "en" }));
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/invitations/preview", "/api/v1/invitations/accept"]);
    expect(calls[0]?.body).toEqual({ token: TOKEN });
    expect(calls[1]?.body).toEqual({ token: TOKEN, password: "a long enough password", locale: "en" });
  });

  it("reads the token from the fragment, removes it from the address bar and never puts it in a URL", async () => {
    const calls = mockApi(({ url }) => (isPreview(url) ? reply(200, PREVIEW) : reply(200, ME())));
    renderWithIntl(<ActivateForm />);
    await screen.findByText("Welcome, Dana Demo");

    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);

    fillPasswords("a long enough password");
    activate();
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(call.url).not.toContain("?");
    }
  });

  it("goes to the shell in the saved language of the user after an owner activates", async () => {
    mockApi(({ url }) => (isPreview(url) ? reply(200, { ...PREVIEW, kind: "owner_activation" }) : reply(200, ME("ar"))));
    renderWithIntl(<ActivateForm />, "ar");
    await screen.findByText("أعدّته Beta Marketing Solutions");
    fillPasswords("a long enough password");
    fireEvent.click(screen.getByRole("button", { name: "فعّل الحساب وسجّل الدخول" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/", { locale: "ar" }));
  });

  it("sends the page language as the chosen language", async () => {
    const calls = mockApi(({ url }) => (isPreview(url) ? reply(200, PREVIEW) : reply(200, ME("ar"))));
    renderWithIntl(<ActivateForm />, "ar");
    await screen.findByText(/مرحباً بك/);
    fillPasswords("a long enough password");
    fireEvent.click(screen.getByRole("button", { name: "فعّل الحساب وسجّل الدخول" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(calls[1]?.body).toMatchObject({ locale: "ar" });
  });

  it("switches the language on the page and keeps the token in the new address", async () => {
    mockApi(() => reply(200, PREVIEW));
    renderWithIntl(<ActivateForm />, "en");
    await screen.findByText("Welcome, Dana Demo");
    fireEvent.click(screen.getByRole("radio", { name: "العربية" }));

    expect(hardNavigate).toHaveBeenCalledWith(`/ar/activate#${TOKEN}`);
  });

  it("shows field errors for a short password and for passwords that do not match, sending nothing", async () => {
    const calls = mockApi(() => reply(200, PREVIEW));
    renderWithIntl(<ActivateForm />);
    await screen.findByText("Welcome, Dana Demo");

    fillPasswords("short");
    activate();
    expect(screen.getByText("Use at least 10 characters.")).toBeInTheDocument();

    fillPasswords("a long enough password", "something else entirely");
    activate();
    expect(screen.getByText("The two passwords do not match.")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("shows the weak_password message under the password field", async () => {
    mockApi(({ url }) => (isPreview(url) ? reply(200, PREVIEW) : apiError(400, "weak_password")));
    renderWithIntl(<ActivateForm />);
    await screen.findByText("Welcome, Dana Demo");
    fillPasswords("password123456");
    activate();

    expect(await screen.findByText(/That password is too weak/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["link_invalid", "This link is no longer valid"],
    ["link_already_used", "This link was already used"],
  ])("shows the designed screen when the preview says %s", async (code, title) => {
    mockApi(() => apiError(410, code));
    renderWithIntl(<ActivateForm />);
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
  });

  it.each([
    ["link_invalid", "This link is no longer valid"],
    ["link_already_used", "This link was already used"],
  ])("shows the designed screen when accepting says %s", async (code, title) => {
    mockApi(({ url }) => (isPreview(url) ? reply(200, PREVIEW) : apiError(410, code)));
    renderWithIntl(<ActivateForm />);
    await screen.findByText("Welcome, Dana Demo");
    fillPasswords("a long enough password");
    activate();
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
  });

  it("shows the different-phone-or-email screen for identifier_unavailable, without a reason", async () => {
    mockApi(({ url }) => (isPreview(url) ? reply(200, PREVIEW) : apiError(409, "identifier_unavailable")));
    renderWithIntl(<ActivateForm />);
    await screen.findByText("Welcome, Dana Demo");
    fillPasswords("a long enough password");
    activate();

    expect(await screen.findByRole("heading", { name: "Use a different phone number or email" })).toBeInTheDocument();
    expect(screen.getByText("Please invite me again with a different phone number or email.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/sign-in");
  });

  it("copies the ready message on the different-phone-or-email screen", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockApi(({ url }) => (isPreview(url) ? reply(200, PREVIEW) : apiError(409, "identifier_unavailable")));
    renderWithIntl(<ActivateForm />);
    await screen.findByText("Welcome, Dana Demo");
    fillPasswords("a long enough password");
    activate();
    fireEvent.click(await screen.findByRole("button", { name: "Copy message" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Please invite me again with a different phone number or email."),
    );
    expect(await screen.findByText("Message copied")).toBeInTheDocument();
  });

  it("offers the WhatsApp button on the link screens when a number is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_BOS_SUPPORT_WHATSAPP", "+96170123456");
    mockApi(() => apiError(410, "link_invalid"));
    renderWithIntl(<ActivateForm />);
    expect(await screen.findByRole("link", { name: "Message Beta on WhatsApp" })).toHaveAttribute(
      "href",
      "https://wa.me/96170123456",
    );
  });

  it("shows the plain Beta contact on the link screens when no number is set", async () => {
    mockApi(() => apiError(410, "link_invalid"));
    renderWithIntl(<ActivateForm />);
    expect(await screen.findByText("Contact Beta Marketing Solutions")).toBeInTheDocument();
  });

  it("shows the invalid-link screen without calling the API when there is no token", async () => {
    visit("/en/activate");
    const calls = mockApi(() => reply(200, PREVIEW));
    renderWithIntl(<ActivateForm />);
    expect(await screen.findByRole("heading", { name: "This link is no longer valid" })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("offers retry when the preview cannot be loaded", async () => {
    let first = true;
    mockApi(() => {
      if (first) {
        first = false;
        return networkFailure();
      }
      return reply(200, PREVIEW);
    });
    renderWithIntl(<ActivateForm />);
    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Welcome, Dana Demo")).toBeInTheDocument();
  });

  it("shows a network failure on accept as an error and signs nobody in", async () => {
    mockApi(({ url }) => (isPreview(url) ? reply(200, PREVIEW) : networkFailure()));
    renderWithIntl(<ActivateForm />);
    await screen.findByText("Welcome, Dana Demo");
    fillPasswords("a long enough password");
    activate();

    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
