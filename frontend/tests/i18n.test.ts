import { describe, expect, it } from "vitest";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import { dirFor, routing } from "@/i18n/routing";

function keys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
}

describe("locales", () => {
  it("supports English and Arabic with English as default", () => {
    expect([...routing.locales]).toEqual(["en", "ar"]);
    expect(routing.defaultLocale).toBe("en");
  });

  it("sets right-to-left for Arabic only", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });

  it("has the same message keys in both languages", () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });

  it("has no empty messages", () => {
    for (const catalog of [en, ar]) {
      for (const key of keys(catalog)) {
        const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], catalog);
        expect(typeof text === "string" && text.trim().length > 0, key).toBe(true);
      }
    }
  });
});
