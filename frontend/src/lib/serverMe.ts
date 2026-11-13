// GET /me asked by the web server while it renders a signed-in page (SC-009, T088), so the shell frame,
// the screen title and the tab bar arrive in the HTML instead of after the scripts and a client round
// trip. Server only: it never runs in the browser.
//
// Outcomes, mirroring what the client guard (SessionGuard) does with the same answer:
// - "ready": the person; the page renders with it and the guard does not ask again.
// - "sign-in": the answer the guard turns into a move to sign-in (no session, or a session it rejects
//   with one of SIGN_IN_CODES). The layout redirects on the server.
// - "unknown": anything else (API down, slow, 5xx, an unexpected body, a case only the browser can
//   judge). The page renders without a person and the client guard runs exactly as before.
//
// Only the business session cookie is forwarded: no other cookie, header or token of the visitor's.
// Never log or return the cookie value.

import { SIGN_IN_CODES } from "./identity";
import type { Me } from "./types";

export const SESSION_COOKIE = "bos_session";
export const OPS_SESSION_COOKIE = "bos_ops_session";
/** The page waits at most this long for the API before falling back to the client guard. */
export const SERVER_ME_TIMEOUT_MS = 2_000;
/** Same default as the /api/v1 forward in next.config.ts. Never port 8000 on the development PC. */
export const DEFAULT_API_URL = "http://127.0.0.1:5100";

export type ServerMe = { k: "ready"; me: Me } | { k: "sign-in" } | { k: "unknown" };

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export interface ServerMeOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// The API issues secrets.token_urlsafe tokens. Anything else is not forwarded (and cannot smuggle
// another header or cookie into the request); the client guard handles it.
export const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Enough of the shape to render the shell; an answer without it is left to the client. */
function looksLikeMe(value: unknown): value is Me {
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.business)) return false;
  return (
    typeof value.user.id === "string" &&
    typeof value.user.locale === "string" &&
    typeof value.business.name === "string" &&
    isStringArray(value.permissions) &&
    isStringArray(value.tabs) &&
    typeof value.start_tab === "string" &&
    Array.isArray(value.stores)
  );
}

function errorCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === "string") return parsed.error.code;
  } catch {
    // not JSON
  }
  return null;
}

export async function fetchServerMe(cookies: CookieReader, options: ServerMeOptions = {}): Promise<ServerMe> {
  const token = cookies.get(SESSION_COOKIE)?.value ?? "";
  const hasOpsSession = (cookies.get(OPS_SESSION_COOKIE)?.value ?? "") !== "";

  if (token === "") {
    // The browser would send no session either and get 401, unless it holds an operator session:
    // then the API answers 404 and the guard shows its error. Leave that case to the guard.
    return hasOpsSession ? { k: "unknown" } : { k: "sign-in" };
  }
  if (!TOKEN.test(token)) return { k: "unknown" };

  const base = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  let text: string;
  try {
    response = await doFetch(`${base}/api/v1/me`, {
      method: "GET",
      headers: { Accept: "application/json", Cookie: `${SESSION_COOKIE}=${token}` },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? SERVER_ME_TIMEOUT_MS),
    });
    text = await response.text();
  } catch {
    // Unreachable, refused or too slow: the page still renders and the guard tries from the browser.
    return { k: "unknown" };
  }

  if (response.status === 200) {
    try {
      const body: unknown = JSON.parse(text);
      return looksLikeMe(body) ? { k: "ready", me: body } : { k: "unknown" };
    } catch {
      return { k: "unknown" };
    }
  }

  if (response.status === 401 || response.status === 403) {
    const code = errorCode(text);
    if (code === null || !SIGN_IN_CODES.has(code)) return { k: "unknown" };
    // With an operator cookie too, the browser's own request could be answered differently (404
    // for a session of the wrong kind), so only the guard can tell. Suspended and pending come from
    // the business session itself and are the same either way.
    if (code === "unauthenticated" && hasOpsSession) return { k: "unknown" };
    return { k: "sign-in" };
  }
  return { k: "unknown" };
}
