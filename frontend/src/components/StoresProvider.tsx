"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { useMe } from "@/lib/session";
import { useStoresList } from "@/lib/stores";
import type { Store } from "@/lib/stores";

const StoresContext = createContext<Store[] | null>(null);

/**
 * The stores to offer and name on the employee screens. GET /me lists only active stores and was
 * read when the session started, so it misses stores added or deactivated since. This loads
 * GET /stores (every store for owners and managers, R36); until it answers, or if it fails, the
 * list from /me is used so the screen is never held up.
 */
export function StoresProvider({ children }: { children: ReactNode }) {
  const { state } = useStoresList();
  return <StoresContext.Provider value={state.k === "ready" ? state.value : null}>{children}</StoresContext.Provider>;
}

export function useStoreChoices(): Store[] {
  const loaded = useContext(StoresContext);
  const me = useMe();
  return loaded ?? me.stores;
}
