import { productName } from "./catalog";
import type { LowStockPage } from "./stock";

export type LowStockShortcut = { total: number; first: string[] };

/** The Sales shortcut needs display labels and the count, never variant records or a cursor. */
export function lowStockShortcut(page: LowStockPage, locale: string): LowStockShortcut {
  return {
    total: typeof page.total === "number" ? page.total : page.items.length,
    first: page.items.slice(0, 2).map((item) => [
      productName({ name_en: item.product_name_en, name_ar: item.product_name_ar }, locale) || item.sku,
      item.option_values.join(" · "),
    ].filter(Boolean).join(" ")),
  };
}
