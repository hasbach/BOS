import { fieldErrorMessageKey } from "@/lib/errors";

type Translate = (key: string) => string;

// Messages written for these fields, taken from the approved designs (screens 52, 53, 58).
const SPECIFIC: Record<string, Record<string, string>> = {
  name: { required: "staff.fe.name" },
  phone: { required: "staff.fe.contact", invalid_phone: "staff.fe.phone" },
  email: { invalid_email: "staff.fe.email" },
  roles: { required: "staff.fe.roles", invalid: "staff.fe.roles" },
  store_ids: { required: "staff.fe.stores", invalid: "staff.fe.storesInvalid" },
};

/**
 * Turns the `fields` map of a validation_failed answer into text next to each field. The request
 * has no `stores` property: the store choice is `all_stores` plus `store_ids`, shown as one box.
 */
export function fieldMessages(t: Translate, fields: Record<string, string>): { messages: Record<string, string>; count: number } {
  const messages: Record<string, string> = {};
  for (const [field, code] of Object.entries(fields)) {
    const target = field === "all_stores" ? "store_ids" : field;
    messages[target] = t(SPECIFIC[field]?.[code] ?? fieldErrorMessageKey(code));
  }
  return { messages, count: Object.keys(messages).length };
}
