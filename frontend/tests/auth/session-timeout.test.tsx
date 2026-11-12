import { act, fireEvent, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_ATTEMPT_TIMEOUT_MS as T, OpsGuard, SessionGuard } from "@/components/SessionGuard";

import { ME, OPS_ME, reply } from "../helpers/fetch";
import { resetNavigation, router } from "../helpers/navigation";
import { renderWithIntl } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

// A /me (or /ops/me) request that never answers must not leave the guard on "Checking your
// session..." for long: after one attempt deadline the hung attempt is aborted and one fresh attempt
// is sent silently; if that one hangs too, the error state with Try again shows. An answer that
// arrives after its attempt was given up on is ignored (no success shown by accident).

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

/** The i-th recorded request (fails the test when it was never sent). */
function nth(pending: Pending[], i: number): Pending {
  const p = pending[i];
  if (!p) throw new Error(`request ${i} was never sent`);
  return p;
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
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
  it("retries once silently when the first attempt hangs, and shows the page when the second answers", async () => {
    const pending = hangingFetch();
    renderWithIntl(
      <SessionGuard>
        <p>shell</p>
      </SessionGuard>,
    );
    await flush();
    expect(pending).toHaveLength(1);

    await advance(T - 1);
    expect(pending).toHaveLength(1);
    expect(screen.getByText(CHECKING)).toBeInTheDocument();

    await advance(1);
    expect(pending).toHaveLength(2);
    expect(nth(pending, 0).signal?.aborted).toBe(true);
    expect(nth(pending, 1).signal?.aborted).toBe(false);
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // A late answer to the first attempt is ignored; only the second one counts.
    nth(pending, 0).resolve(reply(200, ME()));
    await flush();
    expect(screen.queryByText("shell")).not.toBeInTheDocument();

    nth(pending, 1).resolve(reply(200, ME()));
    await flush();
    expect(screen.getByText("shell")).toBeInTheDocument();

    await advance(T * 4);
    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(pending).toHaveLength(2);
  });

  it("shows Try again when both attempts hang, cancels them, ignores late answers, and retry works", async () => {
    const pending = hangingFetch();
    renderWithIntl(
      <SessionGuard>
        <p>shell</p>
      </SessionGuard>,
    );
    await flush();

    await advance(T);
    expect(pending).toHaveLength(2);

    await advance(T - 1);
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await advance(1);
    expect(screen.getByText(UNREACHABLE)).toBeInTheDocument();
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
    expect(nth(pending, 1).signal?.aborted).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();

    // Late answers do not turn the error into a signed-in page.
    nth(pending, 0).resolve(reply(200, ME()));
    nth(pending, 1).resolve(reply(200, ME()));
    await flush();
    expect(screen.queryByText("shell")).not.toBeInTheDocument();
    expect(screen.getByText(UNREACHABLE)).toBeInTheDocument();

    // Try again sends a new request; this time the server answers.
    const before = pending.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(pending).toHaveLength(before + 1);
    pending.at(-1)?.resolve(reply(200, ME()));
    await flush();
    expect(screen.getByText("shell")).toBeInTheDocument();

    await advance(T * 4);
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
    await advance(T - 100);
    pending.at(-1)?.resolve(reply(200, ME()));
    await flush();
    expect(screen.getByText("shell")).toBeInTheDocument();
    await advance(T * 4);
    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(pending).toHaveLength(1);
  });

  it("sends exactly one request when the guard mounts twice (StrictMode) and uses its answer", async () => {
    const pending = hangingFetch();
    renderWithIntl(
      <StrictMode>
        <SessionGuard>
          <p>shell</p>
        </SessionGuard>
      </StrictMode>,
    );
    await flush();
    await advance(0);
    expect(pending).toHaveLength(1);
    expect(nth(pending, 0).signal?.aborted).toBe(false);

    nth(pending, 0).resolve(reply(200, ME()));
    await flush();
    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(pending).toHaveLength(1);
  });

  it("aborts the request when the guard unmounts and nobody else is waiting", async () => {
    const pending = hangingFetch();
    const { unmount } = renderWithIntl(
      <SessionGuard>
        <p>shell</p>
      </SessionGuard>,
    );
    await flush();
    unmount();
    await advance(0);
    expect(nth(pending, 0).signal?.aborted).toBe(true);
  });
});

describe("operator guard deadline", () => {
  it("retries once, then offers Try again when /ops/me never answers", async () => {
    const pending = hangingFetch();
    renderWithIntl(
      <OpsGuard>
        <p>console</p>
      </OpsGuard>,
    );
    await flush();
    expect(screen.getByText(CHECKING)).toBeInTheDocument();

    await advance(T);
    expect(pending).toHaveLength(2);
    expect(screen.getByText(CHECKING)).toBeInTheDocument();

    await advance(T);
    expect(screen.getByText(UNREACHABLE)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    pending.at(-1)?.resolve(reply(200, OPS_ME));
    await flush();
    expect(screen.getByText("console")).toBeInTheDocument();
  });

  it("shows the console when the second attempt answers and ignores the first one's late answer", async () => {
    const pending = hangingFetch();
    renderWithIntl(
      <OpsGuard>
        <p>console</p>
      </OpsGuard>,
    );
    await flush();
    await advance(T);
    nth(pending, 0).resolve(reply(200, OPS_ME));
    await flush();
    expect(screen.queryByText("console")).not.toBeInTheDocument();
    nth(pending, 1).resolve(reply(200, OPS_ME));
    await flush();
    expect(screen.getByText("console")).toBeInTheDocument();
  });
});
