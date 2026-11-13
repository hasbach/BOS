// Shapes and helpers for the employee screens (contracts/openapi.yaml: /staff, /staff/invitations).

import { useCallback, useEffect, useState } from "react";

import { api } from "./api";
import { useSeed } from "./seed";
import type { Seed } from "./seed";
import type { Role } from "./types";

export type { Role } from "./types";

export const ROLES: readonly Role[] = ["owner", "manager", "sales", "packing", "dispatch"];

export interface StaffMember {
  user_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  roles: Role[];
  all_stores: boolean;
  store_ids: string[];
  status: "active" | "inactive";
}

export interface StaffInvitation {
  invitation_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  roles: Role[];
  all_stores: boolean;
  store_ids: string[];
  status: "pending" | "expired";
  expires_at: string;
}

export interface StaffList {
  members: StaffMember[];
  invitations: StaffInvitation[];
}

export interface StaffLink {
  link: string;
  expires_at: string;
}

export interface InviteResult extends StaffLink {
  invitation: StaffInvitation;
}

export interface StaffUpdate {
  roles?: Role[];
  all_stores?: boolean;
  store_ids?: string[];
  status?: "active" | "inactive";
}

/** Owners and managers always have every store, so their store choice is forced. */
export const forcesAllStores = (roles: readonly Role[]): boolean => roles.includes("owner") || roles.includes("manager");

export const sortRoles = (roles: readonly Role[]): Role[] => ROLES.filter((role) => roles.includes(role));

/** One key per submission attempt; a retry of the same attempt reuses it. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export type StaffState = { k: "loading" } | { k: "error"; error: unknown } | { k: "ready"; value: StaffList };

/** Loads GET /staff; `update` edits the loaded list after a confirmed change, `reload` fetches it again. */
export function useStaffList(seed?: Seed<StaffList>) {
  // What the server already loaded for this page, if it has not been shown before (lib/seed.ts).
  const initial = useSeed(seed);
  const [state, setState] = useState<StaffState>(() => (initial !== undefined ? { k: "ready", value: initial } : { k: "loading" }));
  const [attempt, setAttempt] = useState(0);
  const [seeded] = useState(initial !== undefined);

  useEffect(() => {
    // The server's answer stands for the first load; reload (attempt > 0) always asks again.
    if (seeded && attempt === 0) return;
    const controller = new AbortController();
    api.get<StaffList>("/staff", { signal: controller.signal }).then(
      (value) => setState({ k: "ready", value }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ k: "error", error });
      },
    );
    return () => controller.abort();
  }, [attempt, seeded]);

  const reload = useCallback(() => {
    setState({ k: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const update = useCallback((change: (list: StaffList) => StaffList) => {
    setState((current) => (current.k === "ready" ? { k: "ready", value: change(current.value) } : current));
  }, []);

  return { state, reload, update };
}
