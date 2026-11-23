import { cookies } from "next/headers";

import { catalogScreenScope } from "./catalogScreenSeed";
import { lowStockShortcut } from "./lowStockShortcut";
import { fetchServerData } from "./serverData";
import { getServerMe, toSeed } from "./serverSession";
import type { LowStockPage } from "./stock";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const nullableString = (value: unknown) => value === null || string(value);

function isLowStockPage(value: unknown): value is LowStockPage {
  return record(value) && nullableString(value.next_cursor) && Array.isArray(value.items) &&
    (value.total === undefined || (typeof value.total === "number" && Number.isSafeInteger(value.total) && value.total >= value.items.length)) &&
    value.items.every((item) => record(item) && [item.product_id, item.variant_id, item.sku].every(string) &&
      [item.product_name_en, item.product_name_ar, item.main_photo_id].every(nullableString) &&
      Array.isArray(item.option_values) && item.option_values.every(string) &&
      [item.on_hand, item.allocated, item.available, item.level].every(Number.isSafeInteger) &&
      (item.stock_state === "out" || item.stock_state === "low"));
}

/** All-stores first page, exactly as the browser loads it, using the shell's request-scoped session. */
async function readLowStock(locale: string, sales = false) {
  const session = await getServerMe();
  if (session.k !== "ready" || session.me.user.locale !== locale || !session.me.permissions.includes("stock.adjust")) return null;
  if (sales && !session.me.tabs.includes("sales")) return null;
  const scope = catalogScreenScope(session.me);
  if (scope === null) return null;
  const page = await fetchServerData(await cookies(), "/catalog/low-stock", isLowStockPage, { baseUrl: process.env.BOS_API_INTERNAL_URL });
  return page === null ? null : { scope, data: page };
}

export async function getServerLowStock(locale: string) {
  return toSeed(await readLowStock(locale));
}

export async function getServerLowStockShortcut(locale: string) {
  const page = await readLowStock(locale, true);
  return toSeed(page && { scope: page.scope, data: lowStockShortcut(page.data, locale) });
}
