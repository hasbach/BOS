// Server-only initial reads for product detail and stock history. The Flask endpoints still enforce
// tenant/store scope; only successful, usable data is seeded. All failures keep the client load path.
import { cookies } from "next/headers";

import type { Product } from "./catalog";
import { catalogScreenScope } from "./catalogScreenSeed";
import type { CatalogScreenSeed } from "./catalogScreenSeed";
import { fetchServerData } from "./serverData";
import { getServerMe, toSeed } from "./serverSession";
import type { MovementPage } from "./stock";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const nullableString = (value: unknown) => value === null || string(value);
const stringArray = (value: unknown) => Array.isArray(value) && value.every(string);
const status = (value: unknown) => value === "active" || value === "archived";
const movementReasons = new Set<unknown>(["opening", "received", "found", "damaged", "lost", "count_correction", "other", "allocation_consumed"]);
const movementSources = new Set<unknown>(["manual", "product_form", "import", "allocation"]);

function isProduct(value: unknown): value is Product {
  return record(value) && string(value.id) && string(value.code) && status(value.status) &&
    [value.name_en, value.name_ar, value.description_en, value.description_ar].every(nullableString) &&
    Number.isSafeInteger(value.version) && typeof value.has_history === "boolean" && stringArray(value.store_ids) &&
    Array.isArray(value.photos) && value.photos.every((photo) => record(photo) && string(photo.id)) &&
    Array.isArray(value.options) && Array.isArray(value.variants) && value.variants.every((variant) =>
      record(variant) && string(variant.id) && string(variant.sku) && stringArray(variant.option_values) &&
      string(variant.price) && (variant.currency === "USD" || variant.currency === "LBP") && status(variant.status) &&
      Number.isSafeInteger(variant.effective_low_stock_level) && typeof variant.has_history === "boolean" &&
      (variant.stock_state === "low" || variant.stock_state === "out" || variant.stock_state === "ok") &&
      record(variant.stock) && [variant.stock.on_hand, variant.stock.allocated, variant.stock.available, variant.stock.version].every(Number.isSafeInteger),
    );
}

function isMovementPage(value: unknown): value is MovementPage {
  return record(value) && nullableString(value.next_cursor) && Array.isArray(value.items) && value.items.every((item) =>
    record(item) && string(item.id) && string(item.at) && Number.isFinite(Date.parse(item.at)) &&
    movementReasons.has(item.reason) && movementSources.has(item.source) &&
    (item.actor_type === "user" || item.actor_type === "system") && nullableString(item.actor_name) && nullableString(item.note) &&
    Number.isSafeInteger(item.quantity) && Number.isSafeInteger(item.on_hand_after) &&
    (item.counted_quantity === null || Number.isSafeInteger(item.counted_quantity)),
  );
}

// Route IDs go into an internal API path, never into a query, fragment or another path segment.
const safeId = (id: string) => /^[a-z0-9-]+$/i.test(id);
const productPath = (id: string): `/catalog/products/${string}` => `/catalog/products/${id}`;

async function screenSession(locale: string) {
  const session = await getServerMe();
  if (session.k !== "ready" || session.me.user.locale !== locale || !session.me.permissions.includes("catalog.view")) return null;
  const scope = catalogScreenScope(session.me);
  return scope === null ? null : { scope, permissions: session.me.permissions };
}

export async function getServerProductDetail(locale: string, productId: string): Promise<CatalogScreenSeed<Product> | undefined> {
  if (!safeId(productId)) return undefined;
  const session = await screenSession(locale);
  if (!session) return undefined;
  const product = await fetchServerData(await cookies(), productPath(productId), isProduct, { baseUrl: process.env.BOS_API_INTERNAL_URL });
  return toSeed(product && product.id.toLowerCase() === productId.toLowerCase() ? { scope: session.scope, data: product } : null);
}

export async function getServerStockHistory(locale: string, productId: string, variantId: string) {
  if (!safeId(productId) || !safeId(variantId)) return undefined;
  const session = await screenSession(locale);
  if (!session?.permissions.includes("stock.adjust")) return undefined;

  const jar = await cookies();
  const options = { baseUrl: process.env.BOS_API_INTERNAL_URL };
  const [product, page] = await Promise.all([
    fetchServerData(jar, productPath(productId), isProduct, options),
    fetchServerData(jar, `/catalog/variants/${variantId}/movements`, isMovementPage, options),
  ]);
  if (!product || !page || product.id.toLowerCase() !== productId.toLowerCase() || !product.variants.some((variant) => variant.id === variantId)) return undefined;

  // One clock for SSR and hydration, even if they fall on opposite sides of Beirut midnight.
  return toSeed({ scope: session.scope, data: { product, page, asOf: Date.now() } });
}
