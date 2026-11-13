import { describe, expect, it, vi } from "vitest";

import type { Business } from "@/lib/business";
import { fetchServerData, isBusiness, isStaffList, isStoreList } from "@/lib/serverData";
import type { CookieReader } from "@/lib/serverMe";

import { HADI, LIST, SAMER } from "../helpers/staff";
import { STORE_A, STORE_C } from "../helpers/stores";

const TOKEN = "AbC-123_xyzTOKENvalue";

const BUSINESS: Business = {
  id: "b1",
  name: "Demo Denim House Group",
  edition: "commerce",
  default_currency: "USD",
  usd_lbp_rate: "89500.00",
  default_delivery_fee: "3.00",
  default_delivery_fee_currency: "USD",
  timezone: "Asia/Beirut",
};

function jar(values: Record<string, string>): CookieReader {
  return { get: (name) => (name in values ? { value: values[name]! } : undefined) };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = (answer: () => Response | Promise<Response>) => vi.fn<typeof fetch>(async () => answer());

// The three screens' loaders, each with its path, validator and a good body.
const LOADERS = [
  ["/staff", isStaffList, LIST()],
  ["/stores", isStoreList, [STORE_A, STORE_C]],
  ["/business", isBusiness, BUSINESS],
] as const;

describe.each(LOADERS)("server-side GET %s", (path, valid, good) => {
  const load = (cookies: CookieReader, fetchImpl: typeof fetch, timeoutMs?: number) =>
    fetchServerData(cookies, path, valid as (body: unknown) => body is unknown, { baseUrl: "http://api.internal:5100/", fetchImpl, timeoutMs });

  it("returns the body on 200 and sends only the business session cookie", async () => {
    const fetchImpl = fakeFetch(() => json(200, good));
    expect(await load(jar({ bos_session: TOKEN, bos_ops_session: "ops", NEXT_LOCALE: "en", other: "x" }), fetchImpl)).toEqual(good);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`http://api.internal:5100/api/v1${path}`);
    expect(init?.method).toBe("GET");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({ Accept: "application/json", Cookie: `bos_session=${TOKEN}` });
  });

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [403, "business_suspended"],
    [404, "not_found"],
    [500, "internal_error"],
  ])("leaves a %i (%s) to the screen", async (status, code) => {
    expect(await load(jar({ bos_session: TOKEN }), fakeFetch(() => json(status, { error: { code } })))).toBeNull();
  });

  it("leaves it to the screen when the API is too slow", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
    );
    expect(await load(jar({ bos_session: TOKEN }), fetchImpl, 50)).toBeNull();
  });

  it("leaves it to the screen when the API cannot be reached", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await load(jar({ bos_session: TOKEN }), fetchImpl)).toBeNull();
  });

  it.each([
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["the wrong shape", () => json(200, { unexpected: true })],
    ["null", () => json(200, null)],
  ])("leaves a 200 with %s to the screen", async (_name, answer) => {
    expect(await load(jar({ bos_session: TOKEN }), fakeFetch(answer))).toBeNull();
  });

  it("asks nothing without a session cookie, or with one that is not a session token", async () => {
    const fetchImpl = fakeFetch(() => json(200, good));
    expect(await load(jar({}), fetchImpl)).toBeNull();
    expect(await load(jar({ bos_ops_session: "ops" }), fetchImpl)).toBeNull();
    expect(await load(jar({ bos_session: "abc\r\nX-Evil: 1" }), fetchImpl)).toBeNull();
    expect(await load(jar({ bos_session: "abc; other=1" }), fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("shape checks", () => {
  it("accepts the screens' contracts and rejects broken entries", () => {
    expect(isStaffList(LIST({ invitations: [HADI] }))).toBe(true);
    expect(isStaffList({ members: [{ ...SAMER, status: "gone" }], invitations: [] })).toBe(false);
    expect(isStaffList({ members: [], invitations: [{ ...HADI, expires_at: 3 }] })).toBe(false);
    expect(isStoreList([])).toBe(true);
    expect(isStoreList([{ ...STORE_A, has_logo: "yes" }])).toBe(false);
    expect(isBusiness({ ...BUSINESS, default_currency: "EUR" })).toBe(false);
    expect(isBusiness({ ...BUSINESS, usd_lbp_rate: 89500 })).toBe(false);
  });
});
