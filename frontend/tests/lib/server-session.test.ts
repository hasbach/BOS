import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ME } from "../helpers/fetch";
import { LIST } from "../helpers/staff";

// The request-scoped loaders: the screen's data is asked only when /me answered with the person, in the
// address's language, with the screen's permission.
const cookieJar = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name in cookieJar.values ? { value: cookieJar.values[name] } : undefined) }),
}));

const { getServerStaff, getServerBusiness, toSeed } = await import("@/lib/serverSession");

let me = ME("en");
const urls: string[] = [];

beforeEach(() => {
  cookieJar.values = { bos_session: "AbC-123_xyzTOKENvalue" };
  me = { ...ME("en"), permissions: ["staff.view"] };
  urls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url.replace(/^https?:\/\/[^/]+/, ""));
      if (url.endsWith("/api/v1/me")) return new Response(JSON.stringify(me), { status: 200 });
      if (url.endsWith("/api/v1/staff")) return new Response(JSON.stringify(LIST()), { status: 200 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("server-side screen data", () => {
  it("loads the list for a person with the permission, in their language", async () => {
    expect(await getServerStaff("en")).toEqual(LIST());
    expect(urls).toEqual(["/api/v1/me", "/api/v1/staff"]);
  });

  it("asks nothing for a screen the person may not see", async () => {
    expect(await getServerBusiness("en")).toBeNull();
    expect(urls).toEqual(["/api/v1/me"]);
  });

  it("asks nothing when the address has another language (the guard moves the page first)", async () => {
    expect(await getServerStaff("ar")).toBeNull();
    expect(urls).toEqual(["/api/v1/me"]);
  });

  it("asks nothing without a session", async () => {
    cookieJar.values = {};
    expect(await getServerStaff("en")).toBeNull();
    expect(urls).toEqual([]);
  });

  it("gives each render's data a new seed id, and no seed for null", () => {
    const a = toSeed(LIST());
    const b = toSeed(LIST());
    expect(a?.value).toEqual(LIST());
    expect(a?.id).not.toBe(b?.id);
    expect(toSeed(null)).toBeUndefined();
  });
});
