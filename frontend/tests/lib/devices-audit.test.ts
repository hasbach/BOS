import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { actorLabel, describeEntry, eventName } from "@/lib/audit";
import type { AuditEntry } from "@/lib/audit";
import { deviceLabel } from "@/lib/devices";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

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

  it("translates every event in data-model.md and shows an unknown one as its code", () => {
    const events = [
      "auth.sign_in", "auth.sign_in_failed", "auth.sign_out", "auth.session_revoked", "auth.password_changed",
      "auth.password_reset_issued", "auth.identifier_changed", "tenant.created", "tenant.suspended",
      "tenant.reactivated", "tenant.settings_changed", "invitation.created", "invitation.accepted",
      "invitation.revoked", "invitation.resent", "invitation.code_sent", "invitation.code_failed", "user.roles_changed", "user.stores_changed",
      "user.deactivated", "user.reactivated", "store.created", "store.updated", "store.deactivated",
      "store.reactivated", "access.denied_permission", "access.denied_tenant", "access.denied_store",
      "email.sent", "email.failed", "operator.sign_in", "maintenance.run",
    ];
    for (const event of events) {
      expect(eventName(event, t), event).not.toBe(event);
      expect(eventName(event, tAr), event).not.toBe(event);
    }
    expect(eventName("billing.something_new", t)).toBe("billing.something_new");
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
