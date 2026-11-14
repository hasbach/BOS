// History entries (contracts/openapi.yaml: GET /audit) and how each one is described.

import { formatMoney } from "./money";

export interface AuditEntry {
  id: string;
  at: string;
  event: string;
  actor_type: "user" | "operator" | "system" | "anonymous";
  actor_id: string | null;
  actor_name: string | null;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  data: Record<string, unknown>;
}

export interface AuditPage {
  items: AuditEntry[];
  next_cursor: string | null;
}

type Translate = ((key: string, values?: Record<string, string | number>) => string) & { has: (key: string) => boolean };

export type EventIcon = "user" | "alert" | "logout" | "phone" | "lock" | "edit" | "send" | "check" | "x" | "users" | "ban" | "store" | "gear" | "flag";

export const EVENT_ICONS: Record<string, { icon: EventIcon; flip?: boolean }> = {
  "auth.sign_in": { icon: "user" },
  "auth.sign_in_failed": { icon: "alert" },
  "auth.sign_out": { icon: "logout", flip: true },
  "auth.session_revoked": { icon: "phone" },
  "auth.password_changed": { icon: "lock" },
  "auth.password_reset_issued": { icon: "lock" },
  "auth.identifier_changed": { icon: "edit" },
  "invitation.created": { icon: "send", flip: true },
  "invitation.accepted": { icon: "check" },
  "invitation.revoked": { icon: "x" },
  "invitation.resent": { icon: "send", flip: true },
  "invitation.code_sent": { icon: "send", flip: true },
  "invitation.code_failed": { icon: "alert" },
  "user.roles_changed": { icon: "users" },
  "user.stores_changed": { icon: "users" },
  "user.deactivated": { icon: "ban" },
  "user.reactivated": { icon: "check" },
  "store.created": { icon: "store" },
  "store.updated": { icon: "store" },
  "store.deactivated": { icon: "ban" },
  "store.reactivated": { icon: "store" },
  "tenant.settings_changed": { icon: "gear" },
  "tenant.created": { icon: "flag" },
  "tenant.suspended": { icon: "ban" },
  "tenant.reactivated": { icon: "check" },
  "access.denied_permission": { icon: "ban" },
  "access.denied_tenant": { icon: "ban" },
  "access.denied_store": { icon: "ban" },
  "email.sent": { icon: "send", flip: true },
  "email.failed": { icon: "alert" },
  "operator.sign_in": { icon: "user" },
  "maintenance.run": { icon: "gear" },
};

/** The filter sheet's groups (screen 110). Platform events (operator sign-in, maintenance) never appear in a business's history. */
export const EVENT_GROUPS: Array<{ key: string; events: string[] }> = [
  { key: "signin", events: ["auth.sign_in", "auth.sign_in_failed", "auth.sign_out", "auth.session_revoked"] },
  { key: "contact", events: ["auth.password_changed", "auth.password_reset_issued", "auth.identifier_changed"] },
  { key: "people", events: ["invitation.created", "invitation.accepted", "invitation.revoked", "invitation.resent", "invitation.code_sent", "invitation.code_failed", "user.roles_changed", "user.stores_changed", "user.deactivated", "user.reactivated"] },
  { key: "stores", events: ["store.created", "store.updated", "store.deactivated", "store.reactivated"] },
  { key: "business", events: ["tenant.settings_changed", "tenant.created", "tenant.suspended", "tenant.reactivated"] },
  { key: "refused", events: ["access.denied_permission", "access.denied_tenant", "access.denied_store"] },
  { key: "emails", events: ["email.sent", "email.failed"] },
];

const eventKey = (event: string) => `history.event.${event.replaceAll(".", "_")}`;

/** The translated event name; an event this version does not know is shown as its code. */
export function eventName(event: string, t: Translate): string {
  const key = eventKey(event);
  return t.has(key) ? t(key) : event;
}

export function actorLabel(entry: Pick<AuditEntry, "actor_type" | "actor_name">, t: Translate): string {
  if (entry.actor_type === "user") return entry.actor_name ?? t("history.actor.unknown");
  return t(`history.actor.${entry.actor_type}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";

// Keeps a number or a masked value in its own reading direction inside Arabic text.
const isolate = (value: string) => `⁨${value}⁩`;

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(isString) ? value : null;
}

/**
 * The extra lines under an entry. Only the shapes known today are described (settings, roles,
 * store fields, masked phone and email, the failed sign-in account); anything else adds nothing and
 * the event name alone is shown.
 */
export function describeEntry(entry: AuditEntry, t: Translate): string[] {
  const { data } = entry;
  const before = isRecord(data.before) ? data.before : null;
  const after = isRecord(data.after) ? data.after : null;
  const lines: string[] = [];

  switch (entry.event) {
    case "tenant.settings_changed": {
      if (!before || !after) return [];
      const money = (value: unknown) => (isString(value) ? isolate(formatMoney(value, { trimZeros: true })) : null);
      const plain = (value: unknown) => (isString(value) ? value : null);
      const rows: Array<[string, string, (value: unknown) => string | null]> = [
        ["usd_lbp_rate", "history.detail.rate", money],
        ["name", "history.detail.name", plain],
        ["default_currency", "history.detail.currency", plain],
        ["default_delivery_fee", "history.detail.fee", money],
        ["default_delivery_fee_currency", "history.detail.feeCurrency", plain],
      ];
      for (const [field, key, show] of rows) {
        const from = show(before[field]);
        const to = show(after[field]);
        if (from !== null && to !== null) lines.push(t(key, { from, to }));
      }
      return lines;
    }
    case "user.roles_changed": {
      const from = stringList(data.before);
      const to = stringList(data.after);
      if (!from || !to || !entry.target_name) return [];
      const names = (roles: string[]) => roles.map((role) => (t.has(`roles.${role}`) ? t(`roles.${role}`) : role)).join(t("history.detail.sep"));
      return [t("history.detail.roles", { name: entry.target_name, from: names(from), to: names(to) })];
    }
    case "store.updated": {
      if (!after || !entry.target_name) return [];
      const fields = Object.keys(after).filter((field) => t.has(`history.detail.field.${field}`));
      if (fields.length === 0) return [];
      return [t("history.detail.store", { name: entry.target_name, fields: fields.map((field) => t(`history.detail.field.${field}`)).join(t("history.detail.sep")) })];
    }
    case "auth.identifier_changed": {
      if (!before || !after) return [];
      for (const [field, key] of [["phone", "history.detail.phone"], ["email", "history.detail.email"]] as const) {
        if (!(field in before) && !(field in after)) continue;
        const show = (value: unknown) => (isString(value) ? isolate(value) : t("history.detail.none"));
        lines.push(t(key, { from: show(before[field]), to: show(after[field]) }));
      }
      return lines;
    }
    case "auth.sign_in_failed":
      return entry.target_name ? [t("history.detail.account", { name: entry.target_name })] : [];
    default:
      return [];
  }
}
