import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PasswordScreen } from "@/app/[locale]/(shell)/more/profile/password/PasswordScreen";
import { ProfileScreen } from "@/app/[locale]/(shell)/more/profile/ProfileScreen";
import type { Me } from "@/lib/types";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { meWith, renderMe } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/profile"));
afterEach(() => vi.unstubAllGlobals());

const field = (name: string) => screen.getByLabelText(name, { exact: true });
const changed = (me: Me, over: Partial<Me["user"]>): Me => ({ ...me, user: { ...me.user, ...over } });

describe("Profile (screens 120 to 125 and 130)", () => {
  it("shows the person's name, phone, email and roles, and a way to change the password", () => {
    renderMe(<ProfileScreen />, meWith({ user: { email: "samer@demo.example" } }));
    expect(field("Name")).toHaveValue("Samer Demo");
    expect(field("Phone")).toHaveValue("+961 70 000 011");
    expect(field("Email (optional)")).toHaveValue("samer@demo.example");
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Changing your phone or email asks for your current password.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change password" })).toHaveAttribute("href", "/more/profile/password");
  });

  it("shows a stored number the way people read it, and an untouched field is not a change", () => {
    renderMe(<ProfileScreen />, meWith({ user: { phone: "+96171612815" } }));
    expect(field("Phone")).toHaveValue("+961 71 612 815");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // Typing the same number in the stored form is not a change either.
    fireEvent.change(field("Phone"), { target: { value: "+96171612815" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("tells a person without an email why adding one helps", () => {
    renderMe(<ProfileScreen />);
    expect(screen.getByText("Add an email so you can reset your password yourself.")).toBeInTheDocument();
  });

  it("has nothing to save until something changes", () => {
    renderMe(<ProfileScreen />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(field("Name"), { target: { value: "Samer D" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("saves a name-only change straight away, without asking for the password, and shows Saved only after the answer", async () => {
    const me = meWith();
    let release: (value: Response) => void = () => undefined;
    const calls = mockApi(() => new Promise<Response>((resolve) => (release = resolve)));
    const onMe = vi.fn();
    renderMe(<ProfileScreen />, me, "en", onMe);

    fireEvent.change(field("Name"), { target: { value: "Samer Haddad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls[0]).toMatchObject({ url: "/api/v1/me", method: "PATCH", body: { name: "Samer Haddad" } });
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();

    release(reply(200, changed(me, { name: "Samer Haddad" })));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(onMe).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ name: "Samer Haddad" }) }));
  });

  it("asks for the current password when the phone changes, naming the new number (screen 121)", async () => {
    const me = meWith();
    const calls = mockApi(() => reply(200, changed(me, { phone: "+961 70 000 012" })));
    renderMe(<ProfileScreen />, me);

    fireEvent.change(field("Phone"), { target: { value: "+961 70 000 012" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const sheet = await screen.findByRole("dialog", { name: "Confirm it’s you" });
    expect(sheet).toHaveTextContent("Enter your current password to change your phone number to +961 70 000 012.");
    expect(calls).toHaveLength(0);

    fireEvent.change(within(sheet).getByLabelText("Current password"), { target: { value: "old-password-1" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Confirm and save" }));
    expect(await screen.findByText(/Saved. From now on, sign in with/)).toHaveTextContent("Saved. From now on, sign in with +961 70 000 012.");
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { phone: "+961 70 000 012", current_password: "old-password-1" } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends the email, and null for an email that was cleared", async () => {
    const me = meWith({ user: { email: "samer@demo.example" } });
    const calls = mockApi(() => reply(200, changed(me, { email: null })));
    renderMe(<ProfileScreen />, me);
    fireEvent.change(field("Email (optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Current password"), { target: { value: "old-password-1" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Confirm and save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ email: null, current_password: "old-password-1" });
  });

  it("keeps the sheet open with the message under the field for a wrong password (screen 122)", async () => {
    mockApi(() => apiError(400, "wrong_password"));
    renderMe(<ProfileScreen />);
    fireEvent.change(field("Phone"), { target: { value: "+961 70 000 012" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Current password"), { target: { value: "nope" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Confirm and save" }));
    expect(await within(sheet).findByText("That password is not correct. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
    expect(field("Phone")).toHaveValue("+961 70 000 012");
  });

  it("closes the sheet and puts the invalid-phone message under the field with a summary (screen 123)", async () => {
    mockApi(() => apiError(400, "validation_failed", { phone: "invalid_phone" }));
    renderMe(<ProfileScreen />);
    fireEvent.change(field("Phone"), { target: { value: "70 00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Current password"), { target: { value: "old-password-1" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Confirm and save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("This phone number is not valid. Example: +961 70 000 111")).toBeInTheDocument();
    expect(screen.getByText("1 thing to fix before saving.")).toBeInTheDocument();
    expect(field("Phone")).toHaveValue("70 00");
    expect(field("Phone")).toBeInvalid();
  });

  it("uses neutral wording under the field that changed when the identifier is unavailable (screen 124)", async () => {
    const me = meWith();
    mockApi(() => apiError(409, "identifier_unavailable"));
    renderMe(<ProfileScreen />, me);
    fireEvent.change(field("Email (optional)"), { target: { value: "samer@demo.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Current password"), { target: { value: "old-password-1" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Confirm and save" }));

    expect(await screen.findByText("This email can’t be used for your account. Enter a different one.")).toBeInTheDocument();
    expect(screen.getByText("Not saved.")).toBeInTheDocument();
    expect(field("Email (optional)")).toHaveValue("samer@demo.example");
  });

  it("says the same for a phone number that cannot be used", async () => {
    mockApi(() => apiError(409, "identifier_unavailable"));
    renderMe(<ProfileScreen />);
    fireEvent.change(field("Phone"), { target: { value: "+961 70 000 099" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Current password"), { target: { value: "old-password-1" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Confirm and save" }));
    expect(await screen.findByText("This phone number can’t be used for your account. Enter a different one.")).toBeInTheDocument();
  });

  it("refuses an empty phone and email before asking the server (identifier: required)", () => {
    const calls = mockApi(() => reply(200, meWith()));
    renderMe(<ProfileScreen />);
    fireEvent.change(field("Phone"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Keep a phone number or an email so you can sign in.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the server's identifier: required message too", async () => {
    mockApi(() => apiError(400, "validation_failed", { identifier: "required" }));
    renderMe(<ProfileScreen />, meWith({ user: { email: "samer@demo.example" } }));
    fireEvent.change(field("Email (optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Current password"), { target: { value: "old-password-1" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Confirm and save" }));
    expect(await screen.findByText("Keep a phone number or an email so you can sign in.")).toBeInTheDocument();
  });

  it("refuses an empty name", () => {
    const calls = mockApi(() => reply(200, meWith()));
    renderMe(<ProfileScreen />);
    fireEvent.change(field("Name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Enter your name.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("with no connection: says it didn't go through, keeps what was typed, never shows Saved, and offers Try again (screen 130)", async () => {
    const me = meWith();
    let fail = true;
    const calls = mockApi(() => (fail ? networkFailure() : reply(200, changed(me, { name: "Samer Demo Haddad" }))));
    const onMe = vi.fn();
    renderMe(<ProfileScreen />, me, "en", onMe);

    fireEvent.change(field("Name"), { target: { value: "Samer Demo Haddad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Didn’t go through. Nothing was saved because we couldn’t reach BOS. Check your connection and try again. What you typed is still here.");
    expect(field("Name")).toHaveValue("Samer Demo Haddad");
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
    expect(onMe).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(calls).toHaveLength(2);
    expect(onMe).toHaveBeenCalledTimes(1);
  });

  it("keeps the number typed when the connection fails after the password was confirmed", async () => {
    mockApi(() => networkFailure());
    renderMe(<ProfileScreen />);
    fireEvent.change(field("Phone"), { target: { value: "+961 70 000 012" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Current password"), { target: { value: "old-password-1" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Confirm and save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Didn’t go through");
    expect(field("Phone")).toHaveValue("+961 70 000 012");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
  });

  it("reads in Arabic", () => {
    renderMe(<ProfileScreen />, meWith({ user: { locale: "ar" } }), "ar");
    expect(screen.getByLabelText(ar.profile.name)).toBeInTheDocument();
    expect(screen.getByLabelText(ar.profile.phone)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ar.profile.save })).toBeInTheDocument();
  });
});

describe("Change password (screens 126 to 128)", () => {
  const fill = (current: string, next: string, confirm: string) => {
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: current } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  };

  it("says up front that other devices will be signed out", () => {
    renderMe(<PasswordScreen />);
    expect(screen.getByText("You stay signed in on this phone. We sign you out on all your other devices.")).toBeInTheDocument();
  });

  it("catches a short password and a mismatch before sending anything", () => {
    const calls = mockApi(() => reply(204));
    renderMe(<PasswordScreen />);
    fill("old-password-1", "short", "other");
    expect(screen.getByText("Use at least 10 characters.")).toBeInTheDocument();
    expect(screen.getByText("The two passwords do not match.")).toBeInTheDocument();
    expect(screen.getByText("Not changed. 2 things to fix.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("changes the password and then shows the done screen", async () => {
    let release: (value: Response) => void = () => undefined;
    const calls = mockApi(() => new Promise<Response>((resolve) => (release = resolve)));
    renderMe(<PasswordScreen />);
    fill("old-password-1", "a-new-password-9", "a-new-password-9");
    expect(calls[0]).toMatchObject({ url: "/api/v1/me/password", method: "POST", body: { current_password: "old-password-1", new_password: "a-new-password-9" } });
    expect(screen.queryByText("Password changed")).not.toBeInTheDocument();

    release(reply(204));
    expect(await screen.findByText("Password changed")).toBeInTheDocument();
    expect(screen.getByText("You are still signed in here. We signed you out on all your other devices.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to profile" })).toHaveAttribute("href", "/more/profile");
  });

  it("puts wrong_password under the current password", async () => {
    mockApi(() => apiError(400, "wrong_password"));
    renderMe(<PasswordScreen />);
    fill("nope-nope-1", "a-new-password-9", "a-new-password-9");
    expect(await screen.findByText("That password is not correct. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("Password changed")).not.toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveValue("a-new-password-9");
  });

  it("puts weak_password under the new password", async () => {
    mockApi(() => apiError(400, "weak_password"));
    renderMe(<PasswordScreen />);
    fill("old-password-1", "aaaaaaaaaaaa", "aaaaaaaaaaaa");
    expect(await screen.findByText("Use at least 10 characters.")).toBeInTheDocument();
  });

  it("with no connection says it didn't go through, keeps the fields and offers Try again", async () => {
    mockApi(() => networkFailure());
    renderMe(<PasswordScreen />);
    fill("old-password-1", "a-new-password-9", "a-new-password-9");
    expect(await screen.findByRole("alert")).toHaveTextContent("Didn’t go through");
    expect(screen.getByLabelText("New password")).toHaveValue("a-new-password-9");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("Password changed")).not.toBeInTheDocument();
  });
});
