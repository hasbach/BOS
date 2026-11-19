import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { EVENT_GROUPS, EVENT_ICONS, actorLabel, describeEntry, eventName } from "@/lib/audit";
import type { AuditEntry } from "@/lib/audit";
import { deviceLabel } from "@/lib/devices";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

const M0_MODEL = resolve(process.cwd(), "../specs/001-platform-foundation/data-model.md");
const M1_MODEL = resolve(process.cwd(), "../specs/002-native-catalog-inventory/data-model.md");

// Event names are the first cell of the events tables: | `product.created` | product | ... |
function eventsIn(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => /^\|\s*`([a-z_]+\.[a-z_]+)`\s*\|/.exec(line)?.[1])
    .filter((event): event is string => Boolean(event));
}

const translator = (locale: "en" | "ar") => createTranslator({ locale, messages: locale === "en" ? en : ar }) as never;

describe("device label", () => {
  it.each([
    ["en", { browser: "Chrome", os: "Android" }, "Chrome on Android"],
    ["ar", { browser: "Chrome", os: "Android" }, "Chrome على Android"],
    ["en", { browser: "Safari", os: null }, "Safari"],
    ["en", { browser: null, os: "Windows" }, "Windows"],
    ["en", { browser: null, os: null }, "Unknown device"],
    ["ar", { browser: null, os: null }, "جهاز غير معروف"],
  ] as const)("in %s composes %j as %s", (locale, session, expected) => {
    expect(deviceLabel(session, translator(locale))).toBe(expected);
  });
});

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: "e1",
  at: "2026-11-12T07:41:00Z",
  event: "tenant.settings_changed",
  actor_type: "user",
  actor_id: "u1",
  actor_name: "Samer Demo",
  target_type: "tenant",
  target_id: "b1",
  target_name: null,
  data: {},
  ...over,
});

describe("history entries", () => {
  const t = translator("en");
  const tAr = translator("ar");

  it("translates every event in both data models and shows an unknown one as its code", () => {
    const events = [...eventsIn(M0_MODEL), ...eventsIn(M1_MODEL)];
    expect(events).toContain("auth.sign_in");
    expect(events).toContain("product.created");
    expect(events).toContain("catalog.imported");
    expect(events).toContain("stock.allocated");
    for (const event of events) {
      expect(eventName(event, t), event).not.toBe(event);
      expect(eventName(event, tAr), event).not.toBe(event);
    }
    expect(eventName("billing.something_new", t)).toBe("billing.something_new");
  });

  it("groups the ten catalog and stock events, each with an icon", () => {
    const group = EVENT_GROUPS.find((g) => g.key === "catalog");
    expect(group?.events).toEqual([
      "product.created", "product.updated", "product.archived", "product.restored", "product.deleted",
      "stock.adjusted", "stock.allocated", "stock.released", "stock.consumed", "catalog.imported",
    ]);
    for (const event of group?.events ?? []) expect(EVENT_ICONS[event], event).toBeDefined();
    expect(en.history.group.catalog).toBe("Catalog and stock");
    expect(ar.history.group.catalog).toBeTruthy();
  });

  it("describes a rate change in LBP (screen 109)", () => {
    const text = describeEntry(entry({ data: { before: { usd_lbp_rate: "89500.00" }, after: { usd_lbp_rate: "90000.00" } } }), t);
    expect(text).toEqual(["Exchange rate: ⁨89,500⁩ → ⁨90,000⁩ LBP"]);
  });

  it("describes a roles change with the role names", () => {
    const text = describeEntry(
      entry({ event: "user.roles_changed", target_name: "Dana Demo", data: { before: ["sales"], after: ["sales", "packing"] } }),
      t,
    );
    expect(text).toEqual(["Dana Demo · Sales → Sales, Packing"]);
  });

  it("describes a store change by the fields that changed", () => {
    const text = describeEntry(
      entry({ event: "store.updated", target_name: "Store B", data: { before: { whatsapp_number: "+96170000001" }, after: { whatsapp_number: "+96170000002" } } }),
      t,
    );
    expect(text).toEqual(["Store B · WhatsApp number"]);
  });

  it("names the account of a failed sign-in", () => {
    expect(describeEntry(entry({ event: "auth.sign_in_failed", actor_type: "anonymous", target_name: "Dana Demo" }), t)).toEqual(["Dana Demo’s account"]);
  });

  it("adds nothing for a shape it does not know", () => {
    expect(describeEntry(entry({ event: "invitation.created", data: { roles: ["sales"], strange: { deep: true } } }), t)).toEqual([]);
    expect(describeEntry(entry({ data: { before: "x", after: { usd_lbp_rate: 5 } } }), t)).toEqual([]);
  });

  it("names the Beta team, the system and an anonymous visitor as the design does", () => {
    expect(actorLabel(entry({ actor_type: "operator", actor_name: null }), t)).toBe("the Beta team");
    expect(actorLabel(entry({ actor_type: "system", actor_name: null }), t)).toBe("BOS, automatically");
    expect(actorLabel(entry({ actor_type: "anonymous", actor_name: null }), t)).toBe("someone not signed in");
    expect(actorLabel(entry({ actor_type: "user", actor_name: "Karim Demo" }), t)).toBe("Karim Demo");
  });
});

describe("identifier changes", () => {
  it("renders masked phone and email changes, and a removed value", () => {
    const t = translator("en");
    const e = entry({ event: "auth.identifier_changed", data: { before: { phone: "••12", email: "••@demo.example" }, after: { phone: "••56", email: null } } });
    expect(describeEntry(e, t)).toEqual(["Phone ⁨••12⁩ → ⁨••56⁩", "Email ⁨••@demo.example⁩ → none"]);
  });
});
