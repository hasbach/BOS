import { describe, expect, it, vi } from "vitest";

import { fetchServerMe } from "@/lib/serverMe";
import type { CookieReader } from "@/lib/serverMe";

import { ME } from "../helpers/fetch";

const TOKEN = "AbC-123_xyzTOKENvalue";

function jar(values: Record<string, string>): CookieReader {
  return { get: (name) => (name in values ? { value: values[name]! } : undefined) };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const envelope = (code: string) => ({ error: { code, message: code } });

function fakeFetch(answer: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => answer());
}

describe("server-side GET /me", () => {
  it("returns the person on 200 and sends only the business session cookie", async () => {
    const fetchImpl = fakeFetch(() => json(200, ME("ar")));
    const result = await fetchServerMe(jar({ bos_session: TOKEN, NEXT_LOCALE: "ar", other: "x", bos_ops_session: "ops" }), {
      baseUrl: "http://api.internal:5100/",
      fetchImpl,
    });

    expect(result).toEqual({ k: "ready", me: ME("ar") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://api.internal:5100/api/v1/me");
    expect(init?.method).toBe("GET");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Exactly one cookie, the business session; no other header carries anything of the visitor's.
    expect(init?.headers).toEqual({ Accept: "application/json", Cookie: `bos_session=${TOKEN}` });
  });

  it("uses the local API on port 5100 when no address is configured", async () => {
    const fetchImpl = fakeFetch(() => json(200, ME()));
    await fetchServerMe(jar({ bos_session: TOKEN }), { fetchImpl });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://127.0.0.1:5100/api/v1/me");
  });

  it.each(["unauthenticated", "business_suspended", "business_pending"])("sends the visitor to sign-in on %s", async (code) => {
    const fetchImpl = fakeFetch(() => json(code === "unauthenticated" ? 401 : 403, envelope(code)));
    expect(await fetchServerMe(jar({ bos_session: TOKEN }), { fetchImpl })).toEqual({ k: "sign-in" });
  });

  it("sends a visitor without any session cookie to sign-in without asking the API", async () => {
    const fetchImpl = fakeFetch(() => json(200, ME()));
    expect(await fetchServerMe(jar({ NEXT_LOCALE: "en" }), { fetchImpl })).toEqual({ k: "sign-in" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves an operator-only visitor to the client guard (the API would answer 404)", async () => {
    const fetchImpl = fakeFetch(() => json(200, ME()));
    expect(await fetchServerMe(jar({ bos_ops_session: "ops-token" }), { fetchImpl })).toEqual({ k: "unknown" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves a 401 to the client guard when an operator cookie is also present", async () => {
    const fetchImpl = fakeFetch(() => json(401, envelope("unauthenticated")));
    expect(await fetchServerMe(jar({ bos_session: TOKEN, bos_ops_session: "ops" }), { fetchImpl })).toEqual({ k: "unknown" });
  });

  it("does not forward a cookie value that is not a session token", async () => {
    const fetchImpl = fakeFetch(() => json(200, ME()));
    expect(await fetchServerMe(jar({ bos_session: "abc\r\nX-Evil: 1" }), { fetchImpl })).toEqual({ k: "unknown" });
    expect(await fetchServerMe(jar({ bos_session: "abc; other=1" }), { fetchImpl })).toEqual({ k: "unknown" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to the client guard when the API cannot be reached", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchServerMe(jar({ bos_session: TOKEN }), { fetchImpl })).toEqual({ k: "unknown" });
  });

  it("falls back to the client guard when the API is too slow", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
    );
    const started = Date.now();
    expect(await fetchServerMe(jar({ bos_session: TOKEN }), { fetchImpl, timeoutMs: 50 })).toEqual({ k: "unknown" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.each([
    ["a server error", () => json(500, envelope("internal_error"))],
    ["a 404 (session of the wrong kind)", () => json(404, envelope("not_found"))],
    ["a 403 with another code", () => json(403, envelope("forbidden"))],
    ["a 401 without a readable body", () => new Response("<html>", { status: 401 })],
    ["a 200 that is not JSON", () => new Response("<html>", { status: 200 })],
    ["a 200 without the shape of /me", () => json(200, { user: { id: "u1" } })],
  ])("falls back to the client guard on %s", async (_name, answer) => {
    expect(await fetchServerMe(jar({ bos_session: TOKEN }), { fetchImpl: fakeFetch(answer) })).toEqual({ k: "unknown" });
  });
});
