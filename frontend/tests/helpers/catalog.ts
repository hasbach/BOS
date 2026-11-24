import type { Product, ProductPage, ProductSummary, Variant } from "@/lib/catalog";
import type { Me } from "@/lib/types";

import type { Call } from "./fetch";
import { mockApi, reply } from "./fetch";
import { AGENT_PERMISSIONS, MANAGER_PERMISSIONS, OWNER_PERMISSIONS, meWith, salesAgent } from "./shell";

export const CATALOG_OWNER = [...OWNER_PERMISSIONS, "catalog.view", "catalog.manage", "stock.adjust"];
export const CATALOG_MANAGER = [...MANAGER_PERMISSIONS, "catalog.view", "catalog.manage", "stock.adjust"];
export const CATALOG_STAFF = [...AGENT_PERMISSIONS, "catalog.view"];

/** The owner, with the catalog permissions M1 grants. */
export const catalogOwner = (over: Partial<Me> = {}): Me => meWith({ permissions: CATALOG_OWNER, ...over });

/** Dana, a sales agent in Store A only. */
export const catalogStaff = (locale: "en" | "ar" = "en"): Me => ({
  ...salesAgent({ locale }),
  permissions: CATALOG_STAFF,
  stores: [{ id: "st-a", name: "Store A", whatsapp_number: null, has_logo: false, status: "active" }],
});

export const summary = (over: Partial<ProductSummary> & Pick<ProductSummary, "id">): ProductSummary => ({
  code: "JN-SLIM",
  name_en: "Slim blue jeans",
  name_ar: "جينز أزرق ضيّق",
  status: "active",
  main_photo_id: "ph-1",
  store_ids: ["st-a"],
  variant_count: 6,
  available_total: 16,
  stock_state: "low",
  prices: [{ currency: "USD", min: "45.00", max: "45.00" }],
  ...over,
});

export const page = (items: ProductSummary[], over: Partial<ProductPage> = {}): ProductPage => ({
  items,
  next_cursor: null,
  counts: { all: 86, in_stock: 85, low: 3, out: 1 },
  ...over,
});

let variantSeq = 0;
export const variant = (over: Partial<Variant> = {}): Variant => {
  variantSeq += 1;
  return {
    id: `v-${variantSeq}`,
    inventory_item_id: `ii-${variantSeq}`,
    sku: `SKU-${variantSeq}`,
    option_values: [],
    price: "45.00",
    currency: "USD",
    low_stock_level: null,
    effective_low_stock_level: 2,
    photo_id: null,
    status: "active",
    has_history: true,
    stock: { on_hand: 3, allocated: 0, available: 3, version: 1 },
    stock_state: "ok",
    ...over,
  };
};

/** Slim blue jeans: sizes 30 and 32 in Blue, one of them low and one reserved, one out. */
export const JEANS: Product = {
  id: "p-jeans",
  code: "JN-SLIM",
  name_en: "Slim blue jeans",
  name_ar: "جينز أزرق ضيّق",
  description_en: "Slim fit stretch denim, mid rise.",
  description_ar: null,
  status: "active",
  version: 4,
  store_ids: ["st-a"],
  photos: [
    { id: "ph-1", width: 1080, height: 1080 },
    { id: "ph-2", width: 1080, height: 1080 },
  ],
  options: [
    { id: "o-size", name: "Size", values: [{ id: "val-30", label: "30" }, { id: "val-32", label: "32" }, { id: "val-34", label: "34" }] },
    { id: "o-col", name: "Color", values: [{ id: "val-blue", label: "Blue" }] },
  ],
  variants: [
    variant({ id: "v-30", sku: "JN-SLIM-30-BLUE", option_values: ["30", "Blue"], stock: { on_hand: 3, allocated: 0, available: 3, version: 1 }, stock_state: "ok" }),
    variant({ id: "v-32", sku: "JN-SLIM-32-BLUE", option_values: ["32", "Blue"], stock: { on_hand: 2, allocated: 1, available: 1, version: 1 }, stock_state: "low" }),
    variant({ id: "v-34", sku: "JN-SLIM-34-BLUE", option_values: ["34", "Blue"], stock: { on_hand: 0, allocated: 0, available: 0, version: 1 }, stock_state: "out" }),
  ],
  has_history: true,
  created_at: "2026-11-10T10:00:00Z",
  updated_at: "2026-11-15T12:20:00Z",
};

export const BUSINESS_SETTINGS = {
  id: "b1",
  name: "Demo Denim House Group",
  edition: "commerce",
  default_currency: "USD",
  usd_lbp_rate: "89500.00",
  default_delivery_fee: "3.00",
  default_delivery_fee_currency: "USD",
  timezone: "Asia/Beirut",
  low_stock_default: 2,
};

/** Answers GET /business with the settings and sends every other call to `handler`. */
export function catalogApi(handler: (call: Call) => Response | Promise<Response>): Call[] {
  return mockApi((call) => {
    if (call.url === "/api/v1/business" && call.method === "GET") return reply(200, BUSINESS_SETTINGS);
    return handler(call);
  });
}

/** The query of a GET /catalog/products call, as an object. */
export function queryOf(call: Call): Record<string, string> {
  return Object.fromEntries(new URL(call.url, "http://x").searchParams.entries());
}

/** The GET /catalog/products calls (the list), in order. */
export const productCalls = (calls: Call[]) => calls.filter((call) => call.method === "GET" && /^\/api\/v1\/catalog\/products(\?|$)/.test(call.url));
