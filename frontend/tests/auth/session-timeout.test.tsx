import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_TIMEOUT_MS, OpsGuard, SessionGuard } from "@/components/SessionGuard";

import { ME, OPS_ME, reply } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { renderWithIntl } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

// A /me (or /ops/me) request that never answers must not leave the guard on "Checking your
// session..." forever: after IDENTITY_TIMEOUT_MS it shows the error state with Try again, and an
// answer that arrives too late is ignored (no success shown by accident).

interface Pending {
  signal: AbortSignal | undefined;
  resolve: (response: Response) => void;
}

/** fetch that never settles on its own; each call is recorded so the test can answer it later. */
function hangingFetch(): Pending[] {
  const pending: Pending[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push({ signal: init?.signal ?? undefined, resolve });
        }),
    ),
  );
  return pending;
}

/** Lets resolved promises and the React updates they cause run. */
async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  resetNavigation("/");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CHECKING = "Checking your session…";
const UNREACHABLE = /Can't reach the server/;

describe("session guard deadline", () => {
  it("keeps checking until the deadline, then offers Try again and cancels the request", async () => {
    const pending = hangingFetch();
    renderWithIntl(
      <SessionGuard>
        <p>shell</p>
      </SessionGuard>,
    );
    await flush();
    const first = pending.at(-1);
    expect(first).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(IDENTITY_TIMEOUT_MS - 1);
    });
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText(UNREACHABLE)).toBeInTheDocument();
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
    expect(first?.signal?.aborted).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();

    // A late answer does not turn the error into a signed-in page.
    first?.resolve(reply(200, ME()));
    await flush();
    expect(screen.queryByText("shell")).not.toBeInTheDocument();
    expect(screen.getByText(UNREACHABLE)).toBeInTheDocument();

    // Try again sends a new request; this time the server answers.
    const before = pending.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(pending.length).toBeGreaterThan(before);
    pending.at(-1)?.resolve(reply(200, ME()));
    await flush();
    expect(screen.getByText("shell")).toBeInTheDocument();

    // The answered attempt's deadline is cleared: nothing changes when it would have fired.
    await act(async () => {
      vi.advanceTimersByTime(IDENTITY_TIMEOUT_MS * 2);
    });
    expect(screen.getByText("shell")).toBeInTheDocument();
  });

  it("does not time out a request that answers in time", async () => {
    const pending = hangingFetch();
    renderWithIntl(
      <SessionGuard>
        <p>shell</p>
      </SessionGuard>,
    );
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(IDENTITY_TIMEOUT_MS - 100);
    });
    pending.at(-1)?.resolve(reply(200, ME()));
    await flush();
    expect(screen.getByText("shell")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(IDENTITY_TIMEOUT_MS);
    });
    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("operator guard deadline", () => {
  it("offers Try again when /ops/me never answers", async () => {
    const pending = hangingFetch();
    renderWithIntl(
      <OpsGuard>
        <p>console</p>
      </OpsGuard>,
    );
    await flush();
    expect(screen.getByText(CHECKING)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(IDENTITY_TIMEOUT_MS);
    });
    expect(screen.getByText(UNREACHABLE)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    pending.at(-1)?.resolve(reply(200, OPS_ME));
    await flush();
    expect(screen.getByText("console")).toBeInTheDocument();
  });
});
