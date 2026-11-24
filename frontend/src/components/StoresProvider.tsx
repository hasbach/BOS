"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { useMe } from "@/lib/session";
import type { Seed } from "@/lib/seed";
import { useStoresList } from "@/lib/stores";
import type { Store } from "@/lib/stores";

const StoresContext = createContext<Store[] | null>(null);

/**
 * The stores to offer and name on the employee screens. GET /me lists only active stores and was
 * read when the session started, so it misses stores added or deactivated since. This loads
 * GET /stores (every store for owners and managers, R36); until it answers, or if it fails, the
 * current list from /me (refreshed on each screen change) is used so the screen is never held up. `initial` is GET /stores as the server already
 * loaded it for this page; then it is not loaded again.
 */
export function StoresProvider({ children, initial }: { children: ReactNode; initial?: Seed<Store[]> }) {
  const { state } = useStoresList(initial);
  return <StoresContext.Provider value={state.k === "ready" ? state.value : null}>{children}</StoresContext.Provider>;
}

/**
 * The stores the person has now: the active ones on the current GET /me. SessionGuard replaces `me`
 * on every screen change, so this follows an access change made by someone else. Use it for lists
 * that are only the person's own stores (the catalog store pills).
 */
export function useMeStores(): Store[] {
  return useMe().stores;
}

export function useStoreChoices(): Store[] {
  const loaded = useContext(StoresContext);
  const me = useMe();
  if (!loaded) return me.stores;
  // Someone who does not see every store got GET /stores once: drop any store /me no longer lists.
  // Owners and managers (all_stores) keep the full list, which includes deactivated stores.
  if (me.all_stores) return loaded;
  const current = new Set(me.stores.map((store) => store.id));
  return loaded.filter((store) => current.has(store.id));
}
