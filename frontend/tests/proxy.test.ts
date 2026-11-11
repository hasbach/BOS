import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import proxy from "@/proxy";

function visit(path: string, acceptLanguage?: string) {
  const headers = new Headers();
  if (acceptLanguage) headers.set("accept-language", acceptLanguage);
  return proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
}

describe("locale redirect on a first visit", () => {
  it("sends an Arabic device to /ar", async () => {
    const response = await visit("/", "ar-LB,ar;q=0.9,en;q=0.5");
    expect(response.headers.get("location")).toBe("http://localhost:3000/ar");
  });

  it("sends any other device to /en", async () => {
    const response = await visit("/", "fr-FR,fr;q=0.9");
    expect(response.headers.get("location")).toBe("http://localhost:3000/en");
  });

  it("defaults to /en with no language header", async () => {
    const response = await visit("/");
    expect(response.headers.get("location")).toBe("http://localhost:3000/en");
  });

  it("keeps the path when adding the locale", async () => {
    const response = await visit("/dev/components", "ar");
    expect(response.headers.get("location")).toBe("http://localhost:3000/ar/dev/components");
  });

  it("leaves a path that already has a locale alone", async () => {
    const response = await visit("/ar/dev/components", "en");
    expect(response.headers.get("location")).toBeNull();
  });
});
