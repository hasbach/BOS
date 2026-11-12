// Shapes and helpers for the store screens (contracts/openapi.yaml: /stores, /stores/{id}/logo).

import { useCallback, useEffect, useState } from "react";

import { ApiError, api } from "./api";
import type { AffectedPerson } from "./api";
import type { Role } from "./types";

export interface Store {
  id: string;
  name: string;
  /** E.164, for example "+96170000031". */
  whatsapp_number: string | null;
  has_logo: boolean;
  status: "active" | "inactive";
}

export interface StoreChange {
  name?: string;
  whatsapp_number?: string | null;
  status?: "active" | "inactive";
  confirm?: boolean;
}

export const STORES = "/more/stores";

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/** The error code the server would give this file, or null when it looks fine. The server still decides. */
export function checkLogoFile(file: { type: string; size: number }): "file_not_image" | "file_too_large" | null {
  if (!LOGO_TYPES.includes(file.type)) return "file_not_image";
  if (file.size > LOGO_MAX_BYTES) return "file_too_large";
  return null;
}

/** Address of a store's logo image. `version` changes after an upload or removal so the browser asks again. */
export function logoUrl(storeId: string, version = 0): string {
  return `/api/v1/stores/${storeId}/logo${version > 0 ? `?v=${version}` : ""}`;
}

/** Characters to show when a store has no logo (or it cannot be read): first letters of up to two words. */
export function storeInitials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("") || "?"
  );
}

/**
 * A stored E.164 number written the way people read it: "+96170000031" becomes "+961 70 000 031".
 * Anything that is not a plain Lebanese number is returned with only the "+" and digits kept.
 */
export function formatWhatsapp(e164: string): string {
  const match = /^\+961(\d{7,8})$/.exec(e164.replace(/\s+/g, ""));
  if (!match) return e164;
  const national = match[1] ?? "";
  const lead = national.length === 8 ? 2 : 1;
  return `+961 ${national.slice(0, lead)} ${national.slice(lead, lead + 3)} ${national.slice(lead + 3)}`;
}

export type { AffectedPerson, Role };

export type StoresState = { k: "loading" } | { k: "error"; error: unknown } | { k: "ready"; value: Store[] };

/** Loads GET /stores. Owners and managers get every store; everyone else only their active ones. */
export function useStoresList() {
  const [state, setState] = useState<StoresState>({ k: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.get<Store[]>("/stores", { signal: controller.signal }).then(
      (value) => setState(Array.isArray(value) ? { k: "ready", value } : { k: "error", error: new ApiError({ status: 200, code: "unexpected_response" }) }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ k: "error", error });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => {
    setState({ k: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { state, reload };
}
