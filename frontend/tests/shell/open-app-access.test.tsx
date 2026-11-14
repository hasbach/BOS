import { act, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BottomNav } from "@/components/BottomNav";
import { ME_REFRESH_MIN_INTERVAL_MS, OpsGuard, SessionGuard } from "@/components/SessionGuard";
import { TabPlaceholder } from "@/app/[locale]/(shell)/TabPlaceholder";
import { DevicesScreen } from "@/app/[locale]/(shell)/more/devices/DevicesScreen";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import type { Me } from "@/lib/types";

import { OPS_ME, apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import type { Call } from "../helpers/fetch";
import { nav, resetNavigation, router } from "../helpers/navigation";
import { meWith } from "../helpers/shell";
import { en } from "../utils";

/** Renders in English; rerender keeps the provider (a move between screens re-renders the same tree). */
const renderWithIntl = (ui: React.ReactElement) =>
  render(ui, {
    wrapper: ({ children }) => (
      <NextIntlClientProvider locale="en" messages={en}>
        {children}
      </NextIntlClientProvider>
    ),
  });

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

// SC-005 / exit-gate P1: the already-open app follows a change to the person's access on their next
// action, without a page load. The API is mocked; the guard is seeded as the server would seed it.

let now = 1_000_000;

beforeEach(() => {
  resetNavigation("/sales");
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const agent = (tabs: string[], start = tabs[0]!): Me =>
  meWith({ user: { id: "u-agent", name: "Rami Demo", roles: ["sales"] }, permissions: ["business.view", "store.view"], tabs, start_tab: start });

const SALES = agent(["sales", "orders", "more"]);
const PACKING = agent(["packing", "orders", "more"], "packing");

const meCalls = (calls: Call[]) => calls.filter((call) => call.url === "/api/v1/me");

function Shell({ initialMe = SALES, children }: { initialMe?: Me; children?: React.ReactNode }) {
  return (
    <SessionGuard initialMe={initialMe}>
      {children}
      <BottomNav />
    </SessionGuard>
  );
}

const tabNames = () => screen.getAllByRole("link").map((link) => link.textContent);

/** Moves the open app to another screen, as a tab tap does. */
function goTo(rerender: (ui: React.ReactElement) => void, pathname: string, ui: React.ReactElement = <Shell />) {
  nav.pathname = pathname;
  rerender(ui);
}

describe("a session that ends while the app is open", () => {
  it("sends the person to sign-in when any screen's request is answered 401", async () => {
    mockApi((call) => (call.url === "/api/v1/me/sessions" ? apiError(401, "unauthenticated") : reply(200, SALES)));
    renderWithIntl(
      <Shell>
        <DevicesScreen />
      </Shell>,
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"));
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Your session has ended. Taking you to sign in…")).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t load your devices")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it.each([
    [403, "business_suspended"],
    [403, "business_pending"],
  ])("does the same for %s %s", async (status, code) => {
    mockApi(() => apiError(status, code));
    renderWithIntl(<Shell />);
    await act(async () => {
      await api.post("/stores", {}).catch(() => undefined);
    });
    expect(router.replace).toHaveBeenCalledWith("/sign-in");
  });

  it("still says 'couldn't reach' when there is no answer at all", async () => {
    mockApi((call) => (call.url === "/api/v1/me/sessions" ? networkFailure() : reply(200, SALES)));
    renderWithIntl(
      <Shell>
        <DevicesScreen />
      </Shell>,
    );
    expect(await screen.findByText("Couldn’t load your devices")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("does not treat a refused password or other 401 codes as the end of the session", async () => {
    mockApi(() => apiError(401, "wrong_password"));
    renderWithIntl(<Shell />);
    await act(async () => {
      await api.post("/me/password", {}).catch(() => undefined);
    });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("goes to sign-in on the next tab tap after a deactivation (the /me refresh answers 401)", async () => {
    mockApi(() => apiError(401, "unauthenticated"));
    const { rerender } = renderWithIntl(<Shell />);
    goTo(rerender, "/orders");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"));
    expect(screen.getByText("Your session has ended. Taking you to sign in…")).toBeInTheDocument();
  });

  it("leaves operator requests to the operator guard, which sends them to operator sign-in", async () => {
    mockApi((call) => (call.url === "/api/v1/ops/me" ? reply(200, OPS_ME) : apiError(401, "unauthenticated")));
    renderWithIntl(
      <OpsGuard>
        <p>console</p>
      </OpsGuard>,
    );
    expect(await screen.findByText("console")).toBeInTheDocument();
    await act(async () => {
      await api.get("/ops/businesses").catch(() => undefined);
    });
    expect(router.replace).toHaveBeenCalledWith("/ops/sign-in");
    expect(router.replace).not.toHaveBeenCalledWith("/sign-in");
  });

  it("the business guard ignores operator requests", async () => {
    mockApi(() => apiError(401, "unauthenticated"));
    renderWithIntl(<Shell />);
    await act(async () => {
      await api.get("/ops/businesses").catch(() => undefined);
    });
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("access changes while the app is open", () => {
  it("does not ask /me again on the first, server-seeded render", async () => {
    const calls = mockApi(() => reply(200, SALES));
    renderWithIntl(<Shell />);
    await act(async () => undefined);
    expect(meCalls(calls)).toHaveLength(0);
    expect(tabNames()).toEqual(["Sales", "Orders", "More"]);
  });

  it("asks /me on the next move between screens and updates the tab bar", async () => {
    const calls = mockApi(() => reply(200, PACKING));
    const { rerender } = renderWithIntl(<Shell />);
    goTo(rerender, "/orders");
    await waitFor(() => expect(tabNames()).toEqual(["Packing", "Orders", "More"]));
    expect(meCalls(calls)).toHaveLength(1);
  });

  it("asks on every move between screens, however close together (no interval)", async () => {
    const calls = mockApi(() => reply(200, SALES));
    const { rerender } = renderWithIntl(<Shell />);
    goTo(rerender, "/orders");
    await waitFor(() => expect(meCalls(calls)).toHaveLength(1));
    now += 1;
    goTo(rerender, "/more");
    await waitFor(() => expect(meCalls(calls)).toHaveLength(2));
    goTo(rerender, "/sales");
    await waitFor(() => expect(meCalls(calls)).toHaveLength(3));
  });

  it("covers a move made while a request is on its way with exactly one more request after it", async () => {
    const answers: Array<(response: Response) => void> = [];
    const calls = mockApi(() => new Promise<Response>((resolve) => answers.push(resolve)));
    const { rerender } = renderWithIntl(<Shell />);
    goTo(rerender, "/orders");
    goTo(rerender, "/more");
    goTo(rerender, "/sales");
    expect(meCalls(calls)).toHaveLength(1);
    // The first answer predates the later moves (still the old access) ...
    await act(async () => answers[0]!(reply(200, SALES)));
    await waitFor(() => expect(meCalls(calls)).toHaveLength(2));
    // ... the follow-up carries the change.
    await act(async () => answers[1]!(reply(200, PACKING)));
    await waitFor(() => expect(tabNames()).toEqual(["Packing", "Orders", "More"]));
    expect(meCalls(calls)).toHaveLength(2);
  });

  it("the role-change race: tap, change elsewhere, tap again a moment later shows the new tabs", async () => {
    let access = SALES;
    const calls = mockApi(() => reply(200, access));
    const { rerender } = renderWithIntl(<Shell />);
    goTo(rerender, "/orders");
    await waitFor(() => expect(meCalls(calls)).toHaveLength(1));
    access = PACKING; // the owner changes the role
    now += 1_000;
    goTo(rerender, "/more");
    await waitFor(() => expect(tabNames()).toEqual(["Packing", "Orders", "More"]));
  });

  it("focus and visibility do not add a request while one is on its way", async () => {
    let answer: (response: Response) => void = () => undefined;
    const calls = mockApi(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { rerender } = renderWithIntl(<Shell />);
    goTo(rerender, "/orders");
    now += ME_REFRESH_MIN_INTERVAL_MS * 2;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(meCalls(calls)).toHaveLength(1);
    await act(async () => answer(reply(200, PACKING)));
    await waitFor(() => expect(tabNames()).toEqual(["Packing", "Orders", "More"]));
    expect(meCalls(calls)).toHaveLength(1);
  });

  it("does not ask on the focus a page load brings with it", async () => {
    const calls = mockApi(() => reply(200, PACKING));
    renderWithIntl(<Shell />);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => undefined);
    expect(meCalls(calls)).toHaveLength(0);
  });

  it("asks /me when the window comes back into view or gets focus, at most once per interval", async () => {
    const calls = mockApi(() => reply(200, PACKING));
    renderWithIntl(<Shell />);
    now += ME_REFRESH_MIN_INTERVAL_MS;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(tabNames()).toEqual(["Packing", "Orders", "More"]));
    now += ME_REFRESH_MIN_INTERVAL_MS - 1;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => undefined);
    expect(meCalls(calls)).toHaveLength(1);
    now += 1;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(meCalls(calls)).toHaveLength(2));
  });

  it("keeps the tab bar when the refresh gets no answer", async () => {
    mockApi(() => networkFailure());
    const { rerender } = renderWithIntl(<Shell />);
    goTo(rerender, "/orders");
    await act(async () => undefined);
    expect(tabNames()).toEqual(["Sales", "Orders", "More"]);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("asks /me after a 403 forbidden, even right after another refresh", async () => {
    const calls = mockApi((call) => (call.url === "/api/v1/me" ? reply(200, PACKING) : apiError(403, "forbidden")));
    const { rerender } = renderWithIntl(<Shell />);
    goTo(rerender, "/orders");
    await waitFor(() => expect(meCalls(calls)).toHaveLength(1));
    await act(async () => {
      await api.get("/staff").catch(() => undefined);
    });
    await waitFor(() => expect(meCalls(calls)).toHaveLength(2));
  });

  it("moves off a tab the person no longer has (existing not-allowed redirect)", async () => {
    mockApi(() => reply(200, PACKING));
    nav.pathname = "/orders";
    // A new element each time, as a navigation re-renders the tree (an identical element would bail out).
    const ui = () => (
      <Shell>
        <TabPlaceholder tab="sales" />
      </Shell>
    );
    const { rerender } = renderWithIntl(ui());
    goTo(rerender, "/sales", ui());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/packing"));
  });

  it("an unchanged answer does not render the screens again", async () => {
    const calls = mockApi(() => reply(200, SALES));
    // Each distinct person object the screens were given; an unchanged answer must keep the same one.
    const given = new Set<Me>();
    function Counter() {
      const me = useMe();
      useEffect(() => {
        given.add(me);
      }, [me]);
      return null;
    }
    const ui = () => (
      <Shell>
        <Counter />
      </Shell>
    );
    const { rerender } = renderWithIntl(ui());
    goTo(rerender, "/orders", ui());
    await act(async () => undefined);
    await act(async () => undefined);
    expect(meCalls(calls)).toHaveLength(1);
    expect(given.size).toBe(1);
  });
});
