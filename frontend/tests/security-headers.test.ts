import { describe, expect, it } from "vitest";

import config from "../next.config";

// Security review F-03: every page and file served by the web app carries the browser security headers.
// (Answers proxied to the API by the /api/v1 rewrite keep the API's own headers.)
describe("security headers (next.config.ts)", () => {
  it("applies the five headers to every route", async () => {
    expect(config.headers).toBeTypeOf("function");
    const rules = await config.headers!();
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule?.source).toBe("/:path*");
    const headers = Object.fromEntries((rule?.headers ?? []).map(({ key, value }) => [key, value]));
    expect(headers).toEqual({
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
  });

  it("keeps forwarding /api/v1 to the API", async () => {
    const rewrites = await config.rewrites!();
    expect(rewrites).toEqual([expect.objectContaining({ source: "/api/v1/:path*" })]);
  });
});
