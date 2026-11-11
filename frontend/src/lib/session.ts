"use client";

import { createContext, useContext } from "react";

import { api } from "./api";
import type { Me, OpsMe } from "./types";

export const MeContext = createContext<Me | null>(null);
export const OpsMeContext = createContext<OpsMe | null>(null);

/** The signed-in business user. Only valid below SessionGuard. */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe must be used inside SessionGuard");
  return me;
}

/** The signed-in operator. Only valid below OpsGuard. */
export function useOpsMe(): OpsMe {
  const me = useContext(OpsMeContext);
  if (!me) throw new Error("useOpsMe must be used inside OpsGuard");
  return me;
}

export const loadMe = (signal?: AbortSignal) => api.get<Me>("/me", { signal });
export const loadOpsMe = (signal?: AbortSignal) => api.get<OpsMe>("/ops/me", { signal });
export const signOut = () => api.post("/auth/sign-out");
export const opsSignOut = () => api.post("/ops/auth/sign-out");

/** Error codes on /me that mean "go to sign-in". */
export const SIGN_IN_CODES: ReadonlySet<string> = new Set(["unauthenticated", "business_suspended", "business_pending"]);
