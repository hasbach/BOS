import { vi } from "vitest";

import type { InvitationPreview, Me, OpsBusiness, OpsMe } from "@/lib/types";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** Replaces fetch with a handler and returns the list of calls it received. */
export function mockApi(handler: Handler): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

export const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

export const apiError = (status: number, code: string, fields: Record<string, string> = {}) =>
  reply(status, { error: { code, message: code, fields } });

export const networkFailure = () => {
  throw new TypeError("Failed to fetch");
};

export const ME = (locale: "en" | "ar" = "en"): Me => ({
  user: { id: "u1", name: "Dana Demo", phone: "+96170000111", email: null, locale, roles: ["owner"] },
  business: { id: "b1", name: "Demo Denim House Group", edition: "commerce" },
  permissions: [],
  all_stores: true,
  stores: [],
  tabs: ["sales"],
  start_tab: "sales",
});

export const PREVIEW: InvitationPreview = {
  kind: "employee",
  business_name: "Demo Denim House Group",
  invitee_name: "Dana Demo",
  roles: ["sales", "packing"],
  expires_at: "2026-11-18T10:00:00Z",
};

export const OPS_ME: OpsMe = { id: "o1", name: "Layla Demo", email: "layla@beta.example" };

export const BUSINESS = (over: Partial<OpsBusiness> = {}): OpsBusiness => ({
  id: "biz-1",
  name: "Demo Denim House Group",
  edition: "commerce",
  status: "active",
  is_demo: false,
  owners: [{ user_id: "own-1", name: "Samer Demo", contact: "+961 70 000 011", has_email: true }],
  pending_owner_contact: null,
  store_count: 2,
  user_count: 5,
  created_at: "2026-11-01T10:00:00Z",
  ...over,
});
