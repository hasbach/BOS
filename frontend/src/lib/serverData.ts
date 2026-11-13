// First page of a screen's data asked by the web server while it renders the page (SC-009, T088), so
// the list or form is in the HTML instead of after the scripts, hydration and a browser request.
// Server only. Same rules as serverMe.ts: only the business session cookie is forwarded (and only a
// well-formed token), no-store, a short timeout, nothing logged.
//
// The answer is either the data (a 200 whose body has the shape the screen renders) or null. Null
// means "let the screen load it in the browser exactly as before": no session, 401/403 (the screen
// shows sign-in or not-allowed itself), 404, 5xx, a timeout, an unreachable API or an odd body.

import type { Business } from "./business";
import { DEFAULT_API_URL, SESSION_COOKIE, TOKEN } from "./serverMe";
import type { CookieReader } from "./serverMe";
import type { StaffList } from "./staff";
import type { Store } from "./stores";

/** The page waits at most this long for the API before leaving the load to the browser. */
export const SERVER_DATA_TIMEOUT_MS = 2_000;

export interface ServerDataOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): boolean => value === null || typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

/** GET `path` under /api/v1 with the visitor's business session; the body if it is a 200 that passes `valid`. */
export async function fetchServerData<T>(
  cookies: CookieReader,
  path: `/${string}`,
  valid: (body: unknown) => body is T,
  options: ServerDataOptions = {},
): Promise<T | null> {
  const token = cookies.get(SESSION_COOKIE)?.value ?? "";
  if (!TOKEN.test(token)) return null;

  const base = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${base}/api/v1${path}`, {
      method: "GET",
      headers: { Accept: "application/json", Cookie: `${SESSION_COOKIE}=${token}` },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? SERVER_DATA_TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status !== 200) return null;
    const body: unknown = JSON.parse(text);
    return valid(body) ? body : null;
  } catch {
    // Unreachable, too slow or not JSON: the screen loads it from the browser as before.
    return null;
  }
}

// ---- Shapes: enough of each contract (contracts/openapi.yaml) for what the screens render ----------

const STAFF_STATUSES = new Set(["active", "inactive"]);
const INVITATION_STATUSES = new Set(["pending", "expired"]);
const STORE_STATUSES = new Set(["active", "inactive"]);
const CURRENCIES = new Set(["USD", "LBP"]);

function isPersonBase(value: Record<string, unknown>): boolean {
  return (
    isString(value.name) &&
    isNullableString(value.phone) &&
    isNullableString(value.email) &&
    isStringArray(value.roles) &&
    typeof value.all_stores === "boolean" &&
    isStringArray(value.store_ids)
  );
}

export function isStaffList(body: unknown): body is StaffList {
  if (!isRecord(body) || !Array.isArray(body.members) || !Array.isArray(body.invitations)) return false;
  const membersOk = body.members.every(
    (m) => isRecord(m) && isString(m.user_id) && isPersonBase(m) && STAFF_STATUSES.has(String(m.status)),
  );
  const invitationsOk = body.invitations.every(
    (i) => isRecord(i) && isString(i.invitation_id) && isPersonBase(i) && INVITATION_STATUSES.has(String(i.status)) && isString(i.expires_at),
  );
  return membersOk && invitationsOk;
}

export function isStoreList(body: unknown): body is Store[] {
  return (
    Array.isArray(body) &&
    body.every(
      (s) =>
        isRecord(s) &&
        isString(s.id) &&
        isString(s.name) &&
        isNullableString(s.whatsapp_number) &&
        typeof s.has_logo === "boolean" &&
        STORE_STATUSES.has(String(s.status)),
    )
  );
}

export function isBusiness(body: unknown): body is Business {
  return (
    isRecord(body) &&
    isString(body.id) &&
    isString(body.name) &&
    CURRENCIES.has(String(body.default_currency)) &&
    isString(body.usd_lbp_rate) &&
    isString(body.default_delivery_fee) &&
    CURRENCIES.has(String(body.default_delivery_fee_currency))
  );
}
