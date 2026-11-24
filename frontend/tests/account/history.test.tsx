import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryScreen } from "@/app/[locale]/(shell)/more/history/HistoryScreen";

import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import type { Call } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { MANAGER_PERMISSIONS, meWith, renderMe } from "../helpers/shell";
import { DANA, KARIM, OMAR, SAMER } from "../helpers/staff";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

// Thursday 12 November 2026, noon in Beirut.
const NOW = new Date("2026-11-12T10:00:00Z");

beforeEach(() => {
  resetNavigation("/more/history");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const item = (over: Record<string, unknown>) => ({
  id: String(Math.random()),
  at: "2026-11-12T07:41:00Z",
  event: "tenant.settings_changed",
  actor_type: "user",
  actor_id: "u-samer",
  actor_name: "Samer Demo",
  target_type: null,
  target_id: null,
  target_name: null,
  data: {},
  ...over,
});

const PAGE_1 = {
  items: [
    item({ at: "2026-11-12T07:41:00Z", event: "tenant.settings_changed", data: { before: { usd_lbp_rate: "89500.00" }, after: { usd_lbp_rate: "90000.00" } } }),
    item({ at: "2026-11-12T07:12:00Z", event: "invitation.created", actor_id: "u-karim", actor_name: "Karim Demo", target_name: "Hadi Demo" }),
    item({ at: "2026-11-11T16:05:00Z", event: "store.updated", actor_id: "u-karim", actor_name: "Karim Demo", target_name: "Store B", data: { before: { whatsapp_number: "+96170000001" }, after: { whatsapp_number: "+96170000002" } } }),
    item({ at: "2026-11-10T14:02:00Z", event: "auth.password_reset_issued", actor_type: "operator", actor_id: null, actor_name: null }),
  ],
  next_cursor: "cursor-2",
};

const PAGE_2 = {
  items: [item({ at: "2026-11-10T09:00:00Z", event: "auth.sign_in", actor_id: "u-dana", actor_name: "Dana Demo" })],
  next_cursor: null,
};

const STAFF = { members: [SAMER, KARIM, DANA, OMAR], invitations: [] };

function api(handler: (call: Call) => Response | Promise<Response> = () => reply(404)) {
  return mockApi(async (call) => {
    if (call.url === "/api/v1/staff") return reply(200, STAFF);
    if (call.url.startsWith("/api/v1/audit")) {
      const url = new URL(call.url, "http://x");
      if (url.searchParams.get("cursor") === "cursor-2") return reply(200, PAGE_2);
      const answer = await handler(call);
      return answer.status === 404 ? reply(200, PAGE_1) : answer;
    }
    return handler(call);
  });
}

const auditCalls = (calls: Call[]) => calls.filter((call) => call.url.startsWith("/api/v1/audit")).map((call) => new URL(call.url, "http://x"));

describe("History (screens 109 to 114)", () => {
  it("is for owners: anyone without audit.view gets the not-allowed screen and no request is made", () => {
    const calls = api();
    renderMe(<HistoryScreen />, meWith({ user: { roles: ["manager"] }, permissions: MANAGER_PERMISSIONS }));
    expect(screen.getByText("Only owners can see the history")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to More" })).toHaveAttribute("href", "/more");
    expect(calls).toHaveLength(0);
  });

  it("shows the server's 403 as the same not-allowed screen", async () => {
    mockApi(() => apiError(403, "forbidden"));
    renderMe(<HistoryScreen />);
    expect(await screen.findByText("Only owners can see the history")).toBeInTheDocument();
  });

  it("groups entries by Beirut day, newest first, with translated names, times, details and who", async () => {
    const calls = api();
    renderMe(<HistoryScreen />);

    const today = await screen.findByRole("region", { name: "Today · Thu 12 Nov" });
    expect(within(today).getByText("Settings changed")).toBeInTheDocument();
    expect(within(today).getByText("09:41")).toBeInTheDocument();
    expect(within(today).getByText(/Exchange rate:.*89,500.*90,000.*LBP/)).toBeInTheDocument();
    expect(within(today).getByText("By Samer Demo")).toBeInTheDocument();
    expect(within(today).getByText("Invitation sent")).toBeInTheDocument();
    expect(within(today).getByText("By Karim Demo")).toBeInTheDocument();

    const yesterday = screen.getByRole("region", { name: "Yesterday · Wed 11 Nov" });
    expect(within(yesterday).getByText("Store changed")).toBeInTheDocument();
    expect(within(yesterday).getByText("18:05")).toBeInTheDocument();
    expect(within(yesterday).getByText("Store B · WhatsApp number")).toBeInTheDocument();

    const older = screen.getByRole("region", { name: "Tue 10 Nov" });
    expect(within(older).getByText("Reset link issued")).toBeInTheDocument();
    expect(within(older).getByText("By the Beta team")).toBeInTheDocument();

    expect(screen.getByText("Newest first. Times are Beirut time.")).toBeInTheDocument();
    expect(auditCalls(calls)[0]?.search).toBe("");
  });

  it("shows an event it has no name for by its code, and never fails on an odd shape", async () => {
    api(() => reply(200, { items: [item({ event: "billing.something_new", data: { before: "x" } })], next_cursor: null }));
    renderMe(<HistoryScreen />);
    expect(await screen.findByText("billing.something_new")).toBeInTheDocument();
  });

  it("names someone not signed in and BOS itself", async () => {
    api(() =>
      reply(200, {
        items: [
          item({ event: "auth.sign_in_failed", actor_type: "anonymous", actor_id: null, actor_name: null, target_name: "Dana Demo" }),
          item({ event: "email.sent", actor_type: "system", actor_id: null, actor_name: null }),
        ],
        next_cursor: null,
      }),
    );
    renderMe(<HistoryScreen />);
    expect(await screen.findByText("By someone not signed in")).toBeInTheDocument();
    expect(screen.getByText("Dana Demo’s account")).toBeInTheDocument();
    expect(screen.getByText("By BOS, automatically")).toBeInTheDocument();
  });

  it("loads more with next_cursor, keeps what is shown, and removes the button when there is no next page", async () => {
    const calls = api();
    renderMe(<HistoryScreen />);
    await screen.findByText("Settings changed");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Sign-in")).toBeInTheDocument();
    expect(screen.getByText("Settings changed")).toBeInTheDocument();
    expect(auditCalls(calls).map((url) => url.searchParams.get("cursor"))).toEqual([null, "cursor-2"]);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows placeholders and a busy button while the next page loads", async () => {
    let release: (value: Response) => void = () => undefined;
    mockApi((call) => {
      if (call.url === "/api/v1/staff") return reply(200, STAFF);
      if (call.url.includes("cursor=")) return new Promise<Response>((resolve) => (release = resolve));
      return reply(200, PAGE_1);
    });
    renderMe(<HistoryScreen />);
    await screen.findByText("Settings changed");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("button", { name: "Loading more…" })).toBeDisabled();
    expect(screen.getByText("Settings changed")).toBeInTheDocument();
    release(reply(200, PAGE_2));
    expect(await screen.findByText("Sign-in")).toBeInTheDocument();
  });

  it("keeps the entries and says so when the next page cannot be loaded", async () => {
    mockApi((call) => {
      if (call.url.includes("cursor=")) return networkFailure();
      return reply(200, PAGE_1);
    });
    renderMe(<HistoryScreen />);
    await screen.findByText("Settings changed");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Couldn’t load more. Check your connection and try again.")).toBeInTheDocument();
    expect(screen.getByText("Settings changed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("filters by one event type through the sheet (screen 110)", async () => {
    const calls = api((call) => {
      const url = new URL(call.url, "http://x");
      return url.searchParams.get("event") === "user.roles_changed" ? reply(200, { items: [item({ event: "user.roles_changed", target_name: "Dana Demo", data: { before: ["sales"], after: ["sales", "packing"] } })], next_cursor: null }) : reply(404);
    });
    renderMe(<HistoryScreen />);
    await screen.findByText("Settings changed");

    fireEvent.click(screen.getByRole("button", { name: /All events/ }));
    const sheet = await screen.findByRole("dialog", { name: "Show events" });
    expect(within(sheet).getByRole("radiogroup", { name: "Employees and invitations" })).toBeInTheDocument();
    // The M1 "Catalog and stock" group is offered with its events.
    expect(within(sheet).getByRole("radiogroup", { name: "Catalog and stock" })).toBeInTheDocument();
    expect(within(sheet).getByRole("radio", { name: "Catalog imported" })).toBeInTheDocument();
    // Operator sign-ins and maintenance runs are platform events and are never offered.
    expect(within(sheet).queryByRole("radio", { name: /Beta team sign-in|Maintenance/ })).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("radio", { name: "Roles changed" }));
    expect(within(sheet).getByRole("radio", { name: "Roles changed" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(sheet).getByRole("button", { name: "Show results" }));

    expect(await screen.findByText("Dana Demo · Sales → Sales, Packing")).toBeInTheDocument();
    expect(screen.queryByText("Settings changed")).not.toBeInTheDocument();
    expect(auditCalls(calls).at(-1)?.searchParams.get("event")).toBe("user.roles_changed");
    expect(screen.getByRole("button", { name: /Roles changed/ })).toBeInTheDocument();
  });

  it("filters by person from the employee list, including inactive people (screen 111)", async () => {
    const calls = api();
    renderMe(<HistoryScreen />);
    await screen.findByText("Settings changed");

    fireEvent.click(screen.getByRole("button", { name: /Everyone/ }));
    const sheet = await screen.findByRole("dialog", { name: "Show entries by" });
    const group = await within(sheet).findByRole("radiogroup", { name: "Person" });
    expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Everyone", "Samer DemoYou", "Karim Demo", "Dana Demo", "Omar DemoInactive"]);
    expect(within(sheet).getByText(/can’t be filtered by person/)).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("radio", { name: /Karim Demo/ }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Show results" }));

    await waitFor(() => expect(auditCalls(calls).at(-1)?.searchParams.get("actor_id")).toBe("u-karim"));
    expect(screen.getByRole("button", { name: /Karim Demo/ })).toBeInTheDocument();
  });

  it("shows Clear while a filter is on, and Clear returns to everything", async () => {
    const calls = api((call) => (call.url.includes("actor_id") ? reply(200, { items: [], next_cursor: null }) : reply(404)));
    renderMe(<HistoryScreen />);
    await screen.findByText("Settings changed");
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Everyone/ }));
    const sheet = await screen.findByRole("dialog", { name: "Show entries by" });
    fireEvent.click(await within(sheet).findByRole("radio", { name: /Dana Demo/ }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Show results" }));

    // Nothing matches (screen 113), with the one way out.
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    expect(screen.getByText("No entries by Dana Demo. Try another person.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(await screen.findByText("Settings changed")).toBeInTheDocument();
    expect(auditCalls(calls).at(-1)?.search).toBe("");
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });

  it("says what was filtered when both filters match nothing", async () => {
    api((call) => (call.url.includes("event=") ? reply(200, { items: [], next_cursor: null }) : reply(404)));
    renderMe(<HistoryScreen />);
    await screen.findByText("Settings changed");
    fireEvent.click(screen.getByRole("button", { name: /Everyone/ }));
    let sheet = await screen.findByRole("dialog", { name: "Show entries by" });
    fireEvent.click(await within(sheet).findByRole("radio", { name: /Dana Demo/ }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Show results" }));
    await screen.findByRole("button", { name: /Dana Demo/ });
    fireEvent.click(screen.getByRole("button", { name: /All events/ }));
    sheet = await screen.findByRole("dialog", { name: "Show events" });
    fireEvent.click(within(sheet).getByRole("radio", { name: "Store deactivated" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Show results" }));
    expect(await screen.findByText("No “Store deactivated” entries by Dana Demo. Try another event type or person.")).toBeInTheDocument();
  });

  it("offers Try again when the first load fails, and shows nothing as loaded", async () => {
    let fail = true;
    mockApi(() => (fail ? networkFailure() : reply(200, PAGE_1)));
    renderMe(<HistoryScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load the history");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Settings changed")).toBeInTheDocument();
  });

  it("moves between event options with the arrow keys in every radio group of the filter sheet (F12)", async () => {
    api();
    renderMe(<HistoryScreen />);
    await screen.findByText("Settings changed");
    fireEvent.click(screen.getByRole("button", { name: /All events/ }));
    const sheet = await screen.findByRole("dialog", { name: "Show events" });

    const groups = within(sheet).getAllByRole("radiogroup");
    expect(groups.length).toBeGreaterThan(2);
    for (const group of groups) {
      // One Tab stop per group.
      const radios = within(group).getAllByRole("radio");
      expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
      if (radios.length < 2) continue;
      // Down selects and focuses the next radio; Up goes back; Home and End jump.
      fireEvent.keyDown(radios[0]!, { key: "ArrowDown" });
      expect(radios[1]).toHaveAttribute("aria-checked", "true");
      expect(radios[1]).toHaveFocus();
      expect(radios[1]!.tabIndex).toBe(0);
      expect(radios[0]!.tabIndex).toBe(-1);
      fireEvent.keyDown(radios[1]!, { key: "End" });
      expect(radios.at(-1)).toHaveAttribute("aria-checked", "true");
      fireEvent.keyDown(radios.at(-1)!, { key: "ArrowDown" });
      expect(radios[0]).toHaveAttribute("aria-checked", "true");
      expect(radios[0]).toHaveFocus();
    }
  });

  it("moves between people with the arrow keys and applies the one chosen (F12)", async () => {
    const calls = api();
    renderMe(<HistoryScreen />);
    await screen.findByText("Settings changed");
    fireEvent.click(screen.getByRole("button", { name: /Everyone/ }));
    const sheet = await screen.findByRole("dialog", { name: "Show entries by" });
    const group = await within(sheet).findByRole("radiogroup", { name: "Person" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    fireEvent.keyDown(radios[0]!, { key: "ArrowDown" });
    fireEvent.keyDown(radios[1]!, { key: "ArrowDown" });
    expect(radios[2]).toHaveAttribute("aria-checked", "true");
    expect(radios[2]).toHaveFocus();
    fireEvent.keyDown(radios[2]!, { key: "Home" });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[0]!, { key: "ArrowUp" });
    expect(radios[4]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[4]!, { key: "Home" });
    fireEvent.keyDown(radios[0]!, { key: "ArrowDown" });
    fireEvent.keyDown(radios[1]!, { key: "ArrowDown" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Show results" }));
    await waitFor(() => expect(auditCalls(calls).at(-1)?.searchParams.get("actor_id")).toBe("u-karim"));
  });

  it("reverses Left and Right in Arabic (F12)", async () => {
    // The page sets dir on <html>; jsdom has no layout, so set it as the app does.
    document.documentElement.setAttribute("dir", "rtl");
    try {
      api();
      renderMe(<HistoryScreen />, meWith({ user: { locale: "ar" } }), "ar");
      fireEvent.click(await screen.findByRole("button", { name: new RegExp(ar.history.allEvents) }));
      const sheet = await screen.findByRole("dialog");
      const group = within(sheet).getAllByRole("radiogroup")[1]!;
      const radios = within(group).getAllByRole("radio");
      fireEvent.keyDown(radios[0]!, { key: "ArrowLeft" });
      expect(radios[1]).toHaveAttribute("aria-checked", "true");
      fireEvent.keyDown(radios[1]!, { key: "ArrowRight" });
      expect(radios[0]).toHaveAttribute("aria-checked", "true");
    } finally {
      document.documentElement.removeAttribute("dir");
    }
  });

  it("reads in Arabic with Arabic event names, day headings and Beirut times", async () => {
    api();
    renderMe(<HistoryScreen />, meWith({ user: { locale: "ar" } }), "ar");
    expect(await screen.findByRole("region", { name: "اليوم · الخميس 12 تشرين الثاني" })).toBeInTheDocument();
    expect(screen.getByText(ar.history.event.tenant_settings_changed)).toBeInTheDocument();
    expect(screen.getByText("09:41")).toBeInTheDocument();
    expect(screen.getByText("بواسطة فريق Beta")).toBeInTheDocument();
  });
});
