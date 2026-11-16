// Catalog API calls and types (specs/002-native-catalog-inventory/contracts/openapi.yaml: /catalog/products, /catalog/photos).

import { api } from "./api";
import type { UploadOptions } from "./api";
import type { Currency } from "./types";

export type StockState = "ok" | "low" | "out";
export type ProductStatus = "active" | "archived";
export type PhotoSize = "thumb" | "large";

export interface StockNumbers {
  on_hand: number;
  /** Shown to people as "Reserved". */
  allocated: number;
  available: number;
  /** Balance version, for stock adjustments. */
  version: number;
}

export interface Photo {
  id: string;
  width: number;
  height: number;
}

export interface Variant {
  id: string;
  inventory_item_id: string;
  sku: string;
  option_values: string[];
  price: string;
  currency: Currency;
  low_stock_level: number | null;
  effective_low_stock_level: number;
  photo_id: string | null;
  status: ProductStatus;
  has_history: boolean;
  stock: StockNumbers;
  stock_state: StockState;
}

export interface ProductOption {
  id: string;
  name: string;
  values: Array<{ id: string; label: string }>;
}

export interface Product {
  id: string;
  code: string;
  name_en: string | null;
  name_ar: string | null;
  description_en: string | null;
  description_ar: string | null;
  status: ProductStatus;
  version: number;
  store_ids: string[];
  photos: Photo[];
  options: ProductOption[];
  variants: Variant[];
  has_history: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductSummary {
  id: string;
  code: string;
  name_en: string | null;
  name_ar: string | null;
  status: ProductStatus;
  main_photo_id: string | null;
  store_ids: string[];
  variant_count: number;
  available_total: number;
  stock_state: StockState;
  prices: Array<{ currency: Currency; min: string; max: string }>;
}

export interface ProductCounts {
  all: number;
  in_stock: number;
  low: number;
  out: number;
}

export interface ProductPage {
  items: ProductSummary[];
  next_cursor: string | null;
  /** First page only. */
  counts: ProductCounts | null;
}

export interface ProductFilters {
  q?: string;
  store_id?: string;
  stock?: "in_stock" | "low" | "out";
  status?: ProductStatus;
  no_photo?: boolean;
  cursor?: string;
}

export interface OptionInput {
  id?: string;
  name: string;
  values: Array<{ id?: string; label: string }>;
}

export interface VariantInput {
  id?: string;
  option_values: string[];
  sku?: string | null;
  price: string;
  currency: Currency;
  low_stock_level?: number | null;
  photo_id?: string | null;
  /** Create only. */
  opening_quantity?: number;
  /** Update only. */
  status?: ProductStatus;
}

export interface ProductInput {
  code: string;
  name_en?: string | null;
  name_ar?: string | null;
  description_en?: string | null;
  description_ar?: string | null;
  store_ids?: string[];
  photo_ids?: string[];
  options?: OptionInput[];
  variants: VariantInput[];
}

export type ProductUpdate = ProductInput & { version: number };

/** One conflicting SKU in a 409 `sku_in_use`. */
export interface SkuConflict {
  sku: string;
  product_id: string;
  product_name: string;
}

export const listProducts = (filters: ProductFilters = {}, signal?: AbortSignal) =>
  api.get<ProductPage>("/catalog/products", { query: { ...filters }, signal });

export const getProduct = (id: string, signal?: AbortSignal) => api.get<Product>(`/catalog/products/${id}`, { signal });

/** `idempotencyKey` stays the same for every retry of one save. */
export const createProduct = (input: ProductInput, idempotencyKey: string) =>
  api.post<Product>("/catalog/products", input, { idempotencyKey });

export const updateProduct = (id: string, input: ProductUpdate) => api.put<Product>(`/catalog/products/${id}`, input);

export const archiveProduct = (id: string, version: number) => api.post<Product>(`/catalog/products/${id}/archive`, { version });

export const restoreProduct = (id: string, version: number) => api.post<Product>(`/catalog/products/${id}/restore`, { version });

export const deleteProduct = (id: string, version: number) => api.delete(`/catalog/products/${id}`, { query: { version } });

/** Stages a photo; it belongs to no product until a save lists it in `photo_ids`. */
export const uploadPhoto = (file: Blob, options: Pick<UploadOptions, "onProgress" | "signal"> = {}) =>
  api.upload<Photo>("/catalog/photos", file, { ...options, method: "POST" });

export const photoUrl = (photoId: string, size: PhotoSize) => `/api/v1/catalog/photos/${photoId}/${size}`;

/** The first photo is the main one. */
export const mainPhotoOf = (product: Pick<Product, "photos">): string | null => product.photos[0]?.id ?? null;

/** The product's name in the reader's language, falling back to the other one. */
export function productName(product: Pick<Product, "name_en" | "name_ar">, locale: string): string {
  const [first, second] = locale === "ar" ? [product.name_ar, product.name_en] : [product.name_en, product.name_ar];
  return first?.trim() || second?.trim() || "";
}
