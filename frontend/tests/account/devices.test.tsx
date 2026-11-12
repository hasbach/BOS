import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DevicesScreen } from "@/app/[locale]/(shell)/more/devices/DevicesScreen";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import type { Call } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { meWith, renderMe } from "../helpers/shell";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

// Thursday 12 November 2026, noon in Beirut.
beforeEach(() => {
  resetNavigation("/more/devices");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const session = (over: Record<string, unknown>) => ({
  id: "s-0",
  browser: "Chrome",
  os: "Android",
  created_at: "2026-11-01T08:00:00Z",
  last_seen_at: "2026-11-12T09:59:00Z",
  current: false,
  ...over,
});

const SESSIONS = [
  // The current one is listed last on purpose: this device is shown first whatever the server order.
  session({ id: "s-safari", browser: "Safari", os: "iPhone", last_seen_at: "2026-11-12T06:15:00Z" }),
  session({ id: "s-edge", browser: "Edge", os: "Windows", last_seen_at: "2026-11-03T17:40:00Z" }),
  session({ id: "s-here", current: true }),
];

function api(sessions = SESSIONS, handler: (call: Call) => Response | Promise<Response> = () => reply(204)) {
  return mockApi((call) => (call.url === "/api/v1/me/sessions" && call.method === "GET" ? reply(200, sessions) : handler(call)));
}

describe("Devices (screens 115 to 118)", () => {
  it("lists this device first in words, then the others with when they were last active in Beirut time", async () => {
    api();
    renderMe(<DevicesScreen />);
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("Chrome on Android")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("This device")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("Active now")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).queryByRole("button")).not.toBeInTheDocument();

    expect(within(rows[1] as HTMLElement).getByText("Safari on iPhone")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Last active Today, 08:15")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Edge on Windows")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Last active 3 Nov 2026, 19:40")).toBeInTheDocument();
    expect(screen.getByText("To sign out on this phone, use Sign out in More.")).toBeInTheDocument();
  });

  it("shows Unknown device when neither the browser nor the system is known", async () => {
    api([session({ id: "s-here", current: true, browser: null, os: null })]);
    renderMe(<DevicesScreen />);
    expect(await screen.findByText("Unknown device")).toBeInTheDocument();
    expect(screen.getByText("No other devices are signed in to your account.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out all other devices" })).not.toBeInTheDocument();
  });

  it("ends one device at once without asking, and shows the result only after the server answers", async () => {
    let release: (value: Response) => void = () => undefined;
    const calls = api(SESSIONS, () => new Promise<Response>((resolve) => (release = resolve)));
    renderMe(<DevicesScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out on Safari on iPhone" }));

    expect(calls.at(-1)).toMatchObject({ url: "/api/v1/me/sessions/s-safari", method: "DELETE" });
    // Not yet: the server has not answered.
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
    expect(screen.queryByText("Signed out on Safari on iPhone.")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    release(reply(204));
    expect(await screen.findByText("Signed out on Safari on iPhone.")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps the device and says it didn't go through when ending it fails", async () => {
    api(SESSIONS, () => networkFailure());
    renderMe(<DevicesScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out on Safari on iPhone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Didn’t go through. Nothing was saved because we couldn’t reach BOS.");
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText("Signed out on Safari on iPhone.")).not.toBeInTheDocument();
  });

  it("treats a device that is already gone (404) as an error to show, not as success", async () => {
    api(SESSIONS, () => apiError(404, "not_found"));
    renderMe(<DevicesScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out on Edge on Windows" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("asks before ending every other device, and says this phone stays signed in (screen 117)", async () => {
    const calls = api();
    renderMe(<DevicesScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out all other devices" }));
    const sheet = await screen.findByRole("dialog", { name: "Sign out all other devices?" });
    expect(sheet).toHaveTextContent("You stay signed in on this phone. The 2 other devices will need your password to sign in again.");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);

    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  it("ends the others after confirmation and then leaves only this device and no button (screen 118)", async () => {
    const calls = api();
    renderMe(<DevicesScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out all other devices" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Sign out others" }));

    expect(await screen.findByText("Signed out on 2 other devices.")).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({ url: "/api/v1/me/sessions", method: "DELETE" });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Sign out all other devices" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("leaves everything as it was, with a clear message, when ending the others fails", async () => {
    api(SESSIONS, () => networkFailure());
    renderMe(<DevicesScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out all other devices" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sign out others" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Didn’t go through");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText(/Signed out on 2 other devices/)).not.toBeInTheDocument();
  });

  it("offers Try again when the list cannot be loaded", async () => {
    let fail = true;
    mockApi(() => (fail ? networkFailure() : reply(200, SESSIONS)));
    renderMe(<DevicesScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load your devices");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Chrome on Android")).toBeInTheDocument();
  });

  it("reads in Arabic with the translated device label", async () => {
    api();
    renderMe(<DevicesScreen />, meWith({ user: { locale: "ar" } }), "ar");
    expect(await screen.findByText("Chrome على Android")).toBeInTheDocument();
    expect(screen.getByText("آخر نشاط اليوم، 08:15")).toBeInTheDocument();
    expect(screen.getByText("آخر نشاط 3 تشرين الثاني 2026، 19:40")).toBeInTheDocument();
    expect(screen.getByText("هذا الجهاز")).toBeInTheDocument();
  });
});
