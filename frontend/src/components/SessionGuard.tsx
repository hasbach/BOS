"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { usePathname, useRouter } from "@/i18n/navigation";
import { ApiError, isApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { MeContext, MeSetterContext, OpsMeContext, SIGN_IN_CODES, loadMe, loadOpsMe } from "@/lib/session";
import type { Me, OpsMe } from "@/lib/types";

import { ErrorState } from "./ErrorState";
import { Loading } from "./Loading";

type State<T> = { k: "loading" } | { k: "error"; error: unknown } | { k: "ready"; value: T };

/**
 * How long the guard waits for one identity attempt. A request that never answers (a stalled proxy,
 * a dropped connection) must not leave the page on "Checking your session..." for long: the hung
 * attempt is aborted and one fresh attempt is sent silently.
 */
export const IDENTITY_ATTEMPT_TIMEOUT_MS = 7_000;
/** Attempts per load (the first plus one silent retry). */
export const IDENTITY_ATTEMPTS = 2;
/** Worst case before the error state with Try again shows. */
export const IDENTITY_TIMEOUT_MS = IDENTITY_ATTEMPT_TIMEOUT_MS * IDENTITY_ATTEMPTS;

interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
}

/** In-flight identity requests, one per endpoint (keyed by its loader). Cleared as soon as they settle. */
const flights = new Map<unknown, Flight<unknown>>();

function dropFlight(key: unknown, flight: Flight<unknown>, abort: boolean) {
  if (flights.get(key) !== flight) return;
  flights.delete(key);
  if (abort) flight.controller.abort();
}

/**
 * Joins the in-flight request for `load`, or starts it. Leaving does not abort right away: only when
 * nobody is subscribed after a grace tick (so a StrictMode remount or a quick navigation reuses it).
 */
function subscribe<T>(load: (signal: AbortSignal) => Promise<T>) {
  let flight = flights.get(load) as Flight<T> | undefined;
  if (!flight) {
    const controller = new AbortController();
    const created: Flight<T> = {
      controller,
      subscribers: 0,
      promise: undefined as unknown as Promise<T>,
    };
    created.promise = load(controller.signal).then(
      (value) => {
        dropFlight(load, created as Flight<unknown>, false);
        return value;
      },
      (error: unknown) => {
        dropFlight(load, created as Flight<unknown>, false);
        throw error;
      },
    );
    flights.set(load, created as Flight<unknown>);
    flight = created;
  }
  const joined = flight;
  joined.subscribers += 1;
  let left = false;
  return {
    promise: joined.promise,
    /** Gives up on a hung request: aborts it and forgets it so the next subscriber sends a new one. */
    cancel() {
      left = true;
      dropFlight(load, joined as Flight<unknown>, true);
    },
    leave() {
      if (left) return;
      left = true;
      joined.subscribers -= 1;
      if (joined.subscribers > 0) return;
      setTimeout(() => {
        if (joined.subscribers === 0) dropFlight(load, joined as Flight<unknown>, true);
      }, 0);
    },
  };
}

/** Loads one identity endpoint, sends unauthenticated visitors to `signInPath`, and offers retry on failure. */
function useIdentity<T>(load: (signal: AbortSignal) => Promise<T>, signInPath: string, redirectCodes: ReadonlySet<string>, initial?: T) {
  const router = useRouter();
  // `initial` is what the server already loaded for this page; only read when the guard mounts.
  const [state, setState] = useState<State<T>>(() => (initial !== undefined ? { k: "ready", value: initial } : { k: "loading" }));
  const [attempt, setAttempt] = useState(0);
  const [seeded] = useState(initial !== undefined);

  useEffect(() => {
    // The server's answer stands for the first load; Try again (attempt > 0) always asks again.
    if (seeded && attempt === 0) return;

    // Exactly one outcome per load: an answer, an error, or the last attempt's deadline. Answers to
    // an attempt that was already given up on (or to an unmounted effect) are ignored.
    let finished = false;
    let current = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: ReturnType<typeof subscribe<T>> | undefined;

    const finish = () => {
      finished = true;
      clearTimeout(timer);
    };

    const run = (n: number) => {
      current = n;
      const sub = subscribe(load);
      active = sub;
      timer = setTimeout(() => {
        if (finished || current !== n) return;
        sub.cancel();
        if (n < IDENTITY_ATTEMPTS) {
          run(n + 1);
          return;
        }
        finish();
        setState({ k: "error", error: new ApiError({ status: 0, code: "network_error" }) });
      }, IDENTITY_ATTEMPT_TIMEOUT_MS);

      sub.promise.then(
        (value) => {
          if (finished || current !== n) return;
          finish();
          setState({ k: "ready", value });
        },
        (error: unknown) => {
          if (finished || current !== n) return;
          finish();
          if (isApiError(error) && redirectCodes.has(error.code)) {
            router.replace(signInPath);
            return;
          }
          setState({ k: "error", error });
        },
      );
    };
    run(1);

    return () => {
      finish();
      active?.leave();
    };
    // `load` and `redirectCodes` are module-level constants at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, router, signInPath, seeded]);

  const retry = useCallback(() => {
    setState({ k: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const replace = useCallback((value: T) => setState({ k: "ready", value }), []);

  return { state, retry, replace };
}

/**
 * Guards every signed-in page: loads GET /me, sends visitors without a session to sign-in, and
 * moves the page to the user's saved language when the URL differs (FR-027a). `initialMe` is GET /me
 * as the server already loaded it for this page (shell layout); the guard then does not load it again.
 */
export function SessionGuard({ children, initialMe }: { children: ReactNode; initialMe?: Me }) {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { state, retry, replace } = useIdentity<Me>(loadMe, "/sign-in", SIGN_IN_CODES, initialMe);

  const savedLocale = state.k === "ready" ? state.value.user.locale : null;
  const mismatch = savedLocale !== null && savedLocale !== locale;

  useEffect(() => {
    if (mismatch && savedLocale) router.replace(pathname, { locale: savedLocale });
  }, [mismatch, savedLocale, pathname, router]);

  if (state.k === "error") return <ErrorState message={errorMessage(t, state.error)} onRetry={retry} />;
  if (state.k === "loading" || mismatch) return <Loading label={t("shell.checking")} />;
  return (
    <MeSetterContext.Provider value={replace}>
      <MeContext.Provider value={state.value}>{children}</MeContext.Provider>
    </MeSetterContext.Provider>
  );
}

const OPS_REDIRECT: ReadonlySet<string> = new Set(["unauthenticated", "forbidden"]);

/** Guards the operator pages: loads GET /ops/me and sends visitors to operator sign-in. */
export function OpsGuard({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const { state, retry } = useIdentity<OpsMe>(loadOpsMe, "/ops/sign-in", OPS_REDIRECT);

  if (state.k === "error") return <ErrorState message={errorMessage(t, state.error)} onRetry={retry} />;
  if (state.k === "loading") return <Loading label={t("shell.checking")} />;
  return <OpsMeContext.Provider value={state.value}>{children}</OpsMeContext.Provider>;
}
