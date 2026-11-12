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
 * How long the guard waits for its identity endpoint before it gives up and offers Try again.
 * A request that never answers (a stalled proxy, a dropped connection) must not leave the page on
 * "Checking your session..." forever; it is treated like an unreachable server, never as success.
 */
export const IDENTITY_TIMEOUT_MS = 15_000;

/** Loads one identity endpoint, sends unauthenticated visitors to `signInPath`, and offers retry on failure. */
function useIdentity<T>(load: (signal: AbortSignal) => Promise<T>, signInPath: string, redirectCodes: ReadonlySet<string>) {
  const router = useRouter();
  const [state, setState] = useState<State<T>>({ k: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // Exactly one outcome per attempt: the answer, the error, the deadline or the cleanup.
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const timer = setTimeout(() => {
      if (!settle()) return;
      controller.abort();
      setState({ k: "error", error: new ApiError({ status: 0, code: "network_error" }) });
    }, IDENTITY_TIMEOUT_MS);

    load(controller.signal).then(
      (value) => {
        if (settle()) setState({ k: "ready", value });
      },
      (error: unknown) => {
        if (!settle()) return;
        if (isApiError(error) && redirectCodes.has(error.code)) {
          router.replace(signInPath);
          return;
        }
        setState({ k: "error", error });
      },
    );
    return () => {
      settle();
      controller.abort();
    };
    // `load` and `redirectCodes` are module-level constants at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, router, signInPath]);

  const retry = useCallback(() => {
    setState({ k: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const replace = useCallback((value: T) => setState({ k: "ready", value }), []);

  return { state, retry, replace };
}

/**
 * Guards every signed-in page: loads GET /me, sends visitors without a session to sign-in, and
 * moves the page to the user's saved language when the URL differs (FR-027a).
 */
export function SessionGuard({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { state, retry, replace } = useIdentity<Me>(loadMe, "/sign-in", SIGN_IN_CODES);

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
