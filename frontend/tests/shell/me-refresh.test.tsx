import { render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionGuard } from "@/components/SessionGuard";
import { StoresProvider, useMeStores, useStoreChoices } from "@/components/StoresProvider";
import type { Me } from "@/lib/types";

import { mockApi, networkFailure, reply } from "../helpers/fetch";
import type { Call } from "../helpers/fetch";
import { nav, resetNavigation } from "../helpers/navigation";
import { meWith } from "../helpers/shell";
import { STORE_A, STORE_B } from "../helpers/stores";
import { en } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

// R57 / SC-005: store lists follow the refreshed `me.stores` on the next screen change. The
// refresh itself (useMeRefresh) is covered by open-app-access.test.tsx.

beforeEach(() => resetNavigation("/sales"));
afterEach(() => vi.unstubAllGlobals());

const agent = (stores: Me["stores"]): Me =>
  meWith({ user: { id: "u-agent", name: "Rami Demo", roles: ["sales"] }, permissions: ["business.view", "store.view"], all_stores: false, stores });

const names = (list: Array<{ name: string }>) => list.map((store) => store.name).join(",");

function Choices() {
  return <p data-testid="choices">{names(useStoreChoices())}</p>;
}
function Pills() {
  return <p data-testid="pills">{names(useMeStores())}</p>;
}

function Shell({ stores }: { stores: "provider" | "none" }) {
  const body = (
    <>
      <Choices />
      <Pills />
    </>
  );
  return <SessionGuard initialMe={agent([STORE_A, STORE_B])}>{stores === "provider" ? <StoresProvider>{body}</StoresProvider> : body}</SessionGuard>;
}

const renderShell = (stores: "provider" | "none") => {
  const view = render(<Shell stores={stores} />, {
    wrapper: ({ children }) => (
      <NextIntlClientProvider locale="en" messages={en}>
        {children}
      </NextIntlClientProvider>
    ),
  });
  return (): void => {
    nav.pathname = "/orders";
    view.rerender(<Shell stores={stores} />);
  };
};

const meCalls = (calls: Call[]) => calls.filter((call) => call.url === "/api/v1/me");

describe("store lists after GET /me is refreshed", () => {
  it("drops a removed store from the fallback list while GET /stores has not answered", async () => {
    const calls = mockApi((call) => {
      if (call.url === "/api/v1/stores") return new Promise<Response>(() => undefined);
      return reply(200, agent([STORE_A]));
    });
    const goNext = renderShell("provider");
    expect(screen.getByTestId("choices")).toHaveTextContent("Store A,Store B");
    goNext();
    await waitFor(() => expect(screen.getByTestId("choices")).toHaveTextContent(/^Store A$/));
    expect(meCalls(calls)).toHaveLength(1);
  });

  it("drops a removed store from the fallback list when GET /stores failed", async () => {
    mockApi((call) => (call.url === "/api/v1/stores" ? networkFailure() : reply(200, agent([STORE_A]))));
    const goNext = renderShell("provider");
    goNext();
    await waitFor(() => expect(screen.getByTestId("choices")).toHaveTextContent(/^Store A$/));
  });

  it("drops a removed store from a loaded list too, for a person who does not see every store", async () => {
    mockApi((call) => (call.url === "/api/v1/stores" ? reply(200, [STORE_A, STORE_B]) : reply(200, agent([STORE_A]))));
    const goNext = renderShell("provider");
    await waitFor(() => expect(screen.getByTestId("choices")).toHaveTextContent("Store A,Store B"));
    goNext();
    await waitFor(() => expect(screen.getByTestId("choices")).toHaveTextContent(/^Store A$/));
  });

  it("feeds a store-pill list from the session context", async () => {
    mockApi(() => reply(200, agent([STORE_B])));
    const goNext = renderShell("none");
    expect(screen.getByTestId("pills")).toHaveTextContent("Store A,Store B");
    goNext();
    await waitFor(() => expect(screen.getByTestId("pills")).toHaveTextContent(/^Store B$/));
  });

  it("keeps the last me and shows no error banner when the refresh fails", async () => {
    const calls = mockApi(() => networkFailure());
    const goNext = renderShell("none");
    goNext();
    await waitFor(() => expect(meCalls(calls)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("pills")).toHaveTextContent("Store A,Store B");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
