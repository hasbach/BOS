import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageScreen } from "@/app/[locale]/(shell)/more/language/LanguageScreen";
import { hardNavigate } from "@/lib/navigate";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { meWith, renderMe } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);
vi.mock("@/lib/navigate", () => ({ hardNavigate: vi.fn() }));

beforeEach(() => {
  resetNavigation("/more/language");
  vi.mocked(hardNavigate).mockReset();
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
});

describe("Language (screen 119)", () => {
  it("offers both languages, each written in its own language, with the current one chosen", () => {
    renderMe(<LanguageScreen />);
    const group = screen.getByRole("radiogroup", { name: "Language" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /العربية/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: /English/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Saved to your account. BOS opens in this language on every device you sign in on.")).toBeInTheDocument();
  });

  it("flips the layout at once, saves it to the account, and only then moves the address to the new language", async () => {
    let release: (value: Response) => void = () => undefined;
    const calls = mockApi(() => new Promise<Response>((resolve) => (release = resolve)));
    renderMe(<LanguageScreen />);

    fireEvent.click(screen.getByRole("radio", { name: /العربية/ }));
    // Immediately, before the server has answered:
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
    expect(calls[0]).toMatchObject({ url: "/api/v1/me", method: "PATCH", body: { locale: "ar" } });
    expect(hardNavigate).not.toHaveBeenCalled();

    release(reply(200, meWith({ user: { locale: "ar" } })));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/ar/more/language"));
  });

  it("goes back to English the same way", async () => {
    mockApi(() => reply(200, meWith()));
    renderMe(<LanguageScreen />, meWith({ user: { locale: "ar" } }), "ar");
    fireEvent.click(screen.getByRole("radio", { name: /English/ }));
    expect(document.documentElement.dir).toBe("ltr");
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/en/more/language"));
  });

  it("does nothing when the language that is already in use is chosen", () => {
    const calls = mockApi(() => reply(200, meWith()));
    renderMe(<LanguageScreen />);
    fireEvent.click(screen.getByRole("radio", { name: /English/ }));
    expect(calls).toHaveLength(0);
  });

  it("with no connection: puts the layout back, says it was not saved, offers Try again, and does not move", async () => {
    let fail = true;
    const calls = mockApi(() => (fail ? networkFailure() : reply(200, meWith({ user: { locale: "ar" } }))));
    renderMe(<LanguageScreen />);
    fireEvent.click(screen.getByRole("radio", { name: /العربية/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Didn’t go through. Your language was not saved");
    expect(document.documentElement.dir).toBe("ltr");
    expect(hardNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /العربية/ })).toHaveAttribute("aria-checked", "true");

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/ar/more/language"));
    expect(calls).toHaveLength(2);
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("shows a server error the same way", async () => {
    mockApi(() => apiError(500, "internal_error"));
    renderMe(<LanguageScreen />);
    fireEvent.click(screen.getByRole("radio", { name: /العربية/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(hardNavigate).not.toHaveBeenCalled();
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("reads in Arabic", () => {
    renderMe(<LanguageScreen />, meWith({ user: { locale: "ar" } }), "ar");
    expect(screen.getByRole("radiogroup", { name: ar.language.title })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /العربية/ })).toHaveAttribute("aria-checked", "true");
  });
});
