// The product form's state, the request it sends and what a refusal means for it (screens 164 to 175).
// Errors are keyed by the form's own names: "code", "price", "options.<optionKey>.name",
// "variants.<comboKey>.sku" and so on; the server's dotted paths (`variants.2.sku`) are turned
// into these keys through the order the request was built in.

import { isApiError } from "@/lib/api";
import type { OptionInput, Product, ProductInput, SkuConflict, VariantInput } from "@/lib/catalog";
import { normaliseDigits } from "@/lib/digits";
import { errorMessage, fieldErrorMessageKey } from "@/lib/errors";
import { PRICE_RULE, formatMoney, parseMoney } from "@/lib/money";
import type { Currency } from "@/lib/types";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export const MAX_OPTIONS = 2;
export const MAX_VALUES = 20;
export const MAX_VARIANTS = 100;
export const MAX_QUANTITY = 1_000_000;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface ValueDraft {
  key: string;
  id?: string;
  label: string;
  /** An existing value the person removed; kept so it can be put back. */
  removed: boolean;
}

export interface OptionDraft {
  key: string;
  id?: string;
  name: string;
  values: ValueDraft[];
  /** What is typed in the "Add a value" box. */
  adding: string;
}

export type LowMode = "default" | "own" | "none";

export interface VariantDraft {
  id?: string;
  sku: string;
  ownPrice: { price: string; currency: Currency } | null;
  lowMode: LowMode;
  lowLevel: string;
  photoId: string | null;
  /** As typed (create only). */
  opening: string;
  status: "active" | "archived";
  /** Status when the form opened (edit). */
  initialStatus?: "active" | "archived";
  hasHistory: boolean;
  onHand: number;
  /** Option values of an archived variant whose values are no longer offered (shown in Archived variants). */
  labels?: string[];
}

export interface FormState {
  code: string;
  nameEn: string;
  nameAr: string;
  descEn: string;
  descAr: string;
  storeIds: string[];
  options: OptionDraft[];
  price: string;
  currency: Currency;
  samePrice: boolean;
  /** Keyed by combination key (value keys joined with "|"; "" without options). */
  variants: Record<string, VariantDraft>;
  /** Archived variants whose option values are no longer offered, keyed by variant id. */
  orphans: Record<string, VariantDraft>;
}

export type Errors = Record<string, string>;

let sequence = 0;
export const newKey = (prefix: string) => {
  sequence += 1;
  return `${prefix}-${sequence}`;
};

export const emptyVariant = (): VariantDraft => ({
  sku: "",
  ownPrice: null,
  lowMode: "default",
  lowLevel: "",
  photoId: null,
  opening: "",
  status: "active",
  hasHistory: false,
  onHand: 0,
});

export function emptyForm(storeIds: string[], currency: Currency = "USD"): FormState {
  return { code: "", nameEn: "", nameAr: "", descEn: "", descAr: "", storeIds, options: [], price: "", currency, samePrice: true, variants: {}, orphans: {} };
}

/** One row of the variant grid: the values it stands for, in option order. */
export interface Combo {
  key: string;
  values: ValueDraft[];
  /** True when one of its values is being removed (edit only). */
  removing: boolean;
}

/** Every combination of the options' values (removed ones included, marked), in option order. */
export function combos(options: OptionDraft[]): Combo[] {
  let rows: Combo[] = [{ key: "", values: [], removing: false }];
  for (const option of options) {
    const next: Combo[] = [];
    for (const row of rows) {
      for (const value of option.values) {
        next.push({ key: row.key === "" && row.values.length === 0 ? value.key : `${row.key}|${value.key}`, values: [...row.values, value], removing: row.removing || value.removed });
      }
    }
    rows = next;
  }
  return rows;
}

export const comboLabel = (combo: Combo) => combo.values.map((value) => value.label.trim()).join(" · ");

/** The form filled from a saved product (edit, and after `product_changed`). */
export function formFromProduct(product: Product): FormState {
  const options: OptionDraft[] = product.options.map((option) => ({
    key: option.id,
    id: option.id,
    name: option.name,
    values: option.values.map((value) => ({ key: value.id, id: value.id, label: value.label, removed: false })),
    adding: "",
  }));
  const active = product.variants.filter((variant) => variant.status === "active");
  const first = active[0] ?? product.variants[0];
  const price = first ? formatMoney(first.price) : "";
  const currency = first?.currency ?? "USD";
  const variants: Record<string, VariantDraft> = {};
  const orphans: Record<string, VariantDraft> = {};
  for (const variant of product.variants) {
    const keys = variant.option_values.map((label, index) => options[index]?.values.find((value) => value.label === label)?.key);
    const draft: VariantDraft = {
      id: variant.id,
      sku: variant.sku,
      ownPrice: first && (variant.currency !== first.currency || Number(variant.price) !== Number(first.price)) ? { price: formatMoney(variant.price), currency: variant.currency } : null,
      lowMode: variant.low_stock_level === null ? "default" : variant.low_stock_level === 0 ? "none" : "own",
      lowLevel: variant.low_stock_level ? String(variant.low_stock_level) : "",
      photoId: variant.photo_id,
      opening: "",
      status: variant.status,
      initialStatus: variant.status,
      hasHistory: variant.has_history,
      onHand: variant.stock.on_hand,
    };
    if (keys.length === options.length && keys.every((key) => key !== undefined)) variants[keys.join("|")] = draft;
    else orphans[variant.id] = { ...draft, labels: variant.option_values };
  }
  return {
    code: product.code,
    nameEn: product.name_en ?? "",
    nameAr: product.name_ar ?? "",
    descEn: product.description_en ?? "",
    descAr: product.description_ar ?? "",
    storeIds: product.store_ids,
    options,
    price,
    currency,
    samePrice: true,
    variants,
    orphans,
  };
}

/** A whole number from 0 to 1,000,000 typed with any digits, or null. Empty is `empty`. */
export function parseCount(typed: string, empty: number | null): number | null {
  const plain = normaliseDigits(typed).replaceAll(",", "").trim();
  if (plain === "") return empty;
  if (!/^\d+$/.test(plain)) return null;
  const number = Number(plain);
  return number <= MAX_QUANTITY ? number : null;
}

function priceProblem(t: Translate, typed: string, currency: Currency): { value: string } | { error: string } {
  const result = parseMoney(normaliseDigits(typed), PRICE_RULE);
  if (!result.ok) {
    const key = { required: "price", invalid: "priceInvalid", too_many_decimals: "priceDecimals", too_large: "priceLarge", not_positive: "priceInvalid" }[result.problem];
    return { error: t(`catalog.form.fe.${key}`) };
  }
  if (currency === "LBP" && result.value.includes(".") && !/\.0+$/.test(result.value)) return { error: t("catalog.form.fe.priceWhole") };
  return { value: currency === "LBP" ? result.value.replace(/\.0+$/, "") : result.value };
}

/** The grid as it will be saved: rows of offered values whose variant is not archived. */
export function activeRows(state: FormState): Combo[] {
  return combos(state.options).filter((combo) => !combo.removing && (state.variants[combo.key]?.status ?? "active") === "active");
}

export interface Built {
  input: ProductInput;
  /** The key of each sent variant, in request order, to place `variants.N.*` errors. */
  variantKeys: string[];
  errors: Errors;
}

/**
 * Checks what was typed and builds the request. `photoIds` are the uploaded photos in order.
 * `create` adds opening quantities; edit adds each variant's status instead.
 */
export function buildRequest(t: Translate, state: FormState, photoIds: string[], create: boolean): Built {
  const errors: Errors = {};
  const code = state.code.trim();
  if (code === "") errors.code = t("catalog.form.fe.code");
  else if (code.length > 32) errors.code = t("catalog.form.fe.codeLong");
  else if (!CODE.test(code)) errors.code = t("catalog.form.fe.codeInvalid");

  const nameEn = state.nameEn.trim();
  const nameAr = state.nameAr.trim();
  if (nameEn === "" && nameAr === "") errors.name_en = t("catalog.form.fe.name");
  if (nameEn.length > 120) errors.name_en = t("catalog.form.fe.nameLong");
  if (nameAr.length > 120) errors.name_ar = t("catalog.form.fe.nameLong");
  if (state.descEn.trim().length > 2000) errors.description_en = t("catalog.form.fe.descLong");
  if (state.descAr.trim().length > 2000) errors.description_ar = t("catalog.form.fe.descLong");

  const options: OptionInput[] = state.options.map((option) => {
    const name = option.name.trim();
    if (name === "") errors[`options.${option.key}.name`] = t("catalog.form.fe.optionName");
    else if (name.length > 40) errors[`options.${option.key}.name`] = t("catalog.form.fe.optionLong");
    const values = option.values.filter((value) => !value.removed);
    if (values.length === 0) errors[`options.${option.key}.values`] = t("catalog.form.fe.values");
    else if (values.length > MAX_VALUES) errors[`options.${option.key}.values`] = t("catalog.form.fe.tooManyValues");
    return { ...(option.id ? { id: option.id } : {}), name, values: values.map((value) => ({ ...(value.id ? { id: value.id } : {}), label: value.label.trim() })) };
  });

  let shared: string | null = null;
  const single = state.options.length === 0;
  const sharedResult = priceProblem(t, state.price, state.currency);
  if ("value" in sharedResult) shared = sharedResult.value;

  const rows = combos(state.options).filter((combo) => !combo.removing);
  if (rows.length > MAX_VARIANTS) errors.variants = t("catalog.form.fe.tooManyVariants");

  const variants: VariantInput[] = [];
  const variantKeys: string[] = [];
  const skus = new Map<string, string>();
  for (const combo of rows) {
    const draft = state.variants[combo.key] ?? emptyVariant();
    const base = `variants.${combo.key}`;
    const usesShared = draft.ownPrice === null;
    let price: string | null = null;
    let currency: Currency = state.currency;
    if (usesShared) {
      if (!state.samePrice && !single) errors[`${base}.price`] = t("catalog.form.fe.price");
      else if ("error" in sharedResult) errors.price = sharedResult.error;
      else price = shared;
    } else if (draft.ownPrice) {
      currency = draft.ownPrice.currency;
      const own = priceProblem(t, draft.ownPrice.price, currency);
      if ("error" in own) errors[`${base}.price`] = own.error;
      else price = own.value;
    }
    const sku = normaliseDigits(draft.sku).trim();
    if (sku !== "") {
      if (sku.length > 64 || !SKU.test(sku)) errors[`${base}.sku`] = t("catalog.form.fe.skuInvalid");
      else {
        const folded = sku.toLowerCase();
        const other = skus.get(folded);
        if (other !== undefined) {
          errors[`${base}.sku`] = t("catalog.form.fe.skuDuplicate");
          errors[`variants.${other}.sku`] = t("catalog.form.fe.skuDuplicate");
        } else skus.set(folded, combo.key);
      }
    }
    let low: number | null = null;
    if (draft.lowMode === "none") low = 0;
    else if (draft.lowMode === "own") {
      const level = parseCount(draft.lowLevel, null);
      if (level === null || level === 0) errors[`${base}.low_stock_level`] = t("catalog.form.fe.level");
      else low = level;
    }
    const variant: VariantInput = {
      ...(draft.id ? { id: draft.id } : {}),
      option_values: combo.values.map((value) => value.label.trim()),
      sku: sku === "" ? null : sku,
      price: price ?? "",
      currency,
      low_stock_level: low,
      photo_id: draft.photoId && photoIds.includes(draft.photoId) ? draft.photoId : null,
    };
    if (create) {
      const opening = parseCount(draft.opening, 0);
      if (opening === null) errors[`${base}.opening_quantity`] = t("catalog.form.fe.quantity");
      else variant.opening_quantity = opening;
    } else {
      variant.status = draft.status;
    }
    variants.push(variant);
    variantKeys.push(combo.key);
  }
  // Restored variants whose values were archived: the server brings their values back (edit only).
  if (!create) {
    for (const [id, draft] of Object.entries(state.orphans)) {
      if (draft.status !== "active" || !draft.labels) continue;
      variants.push({ id, option_values: draft.labels, sku: draft.sku || null, price: draft.ownPrice?.price ?? shared ?? "", currency: draft.ownPrice?.currency ?? state.currency, low_stock_level: null, photo_id: null, status: "active" });
      variantKeys.push(`orphan:${id}`);
    }
  }

  const input: ProductInput = {
    code,
    name_en: nameEn === "" ? null : nameEn,
    name_ar: nameAr === "" ? null : nameAr,
    description_en: state.descEn.trim() === "" ? null : state.descEn.trim(),
    description_ar: state.descAr.trim() === "" ? null : state.descAr.trim(),
    store_ids: state.storeIds,
    photo_ids: photoIds,
    options,
    variants,
  };
  return { input, variantKeys, errors };
}

/** Text for one server field code at the form's own key. */
function messageFor(t: Translate, key: string, code: string, conflicts: SkuConflict[], sentSku: string | null | undefined): string {
  const fe = (name: string, values?: Record<string, string | number>) => t(`catalog.form.fe.${name}`, values);
  const last = key.split(".").pop() ?? key;
  switch (last) {
    case "code":
      return code === "required" ? fe("code") : code === "too_long" ? fe("codeLong") : code === "in_use" ? fe("codeUsed") : fe("codeInvalid");
    case "name_en":
    case "name_ar":
      return code === "required" ? fe("name") : code === "too_long" ? fe("nameLong") : t(fieldErrorMessageKey(code));
    case "description_en":
    case "description_ar":
      return fe("descLong");
    case "name":
      return code === "required" ? fe("optionName") : code === "too_long" ? fe("optionLong") : t(fieldErrorMessageKey(code));
    case "values":
      return code === "too_many" ? fe("tooManyValues") : code === "duplicate" ? fe("duplicateValue") : code === "too_long" ? fe("valueLong") : fe("values");
    case "sku": {
      if (code === "in_use") {
        const conflict = conflicts.find((entry) => sentSku && entry.sku.toLowerCase() === sentSku.toLowerCase()) ?? (conflicts.length === 1 ? conflicts[0] : undefined);
        return conflict ? fe("skuUsed", { name: conflict.product_name }) : fe("skuUsedPlain");
      }
      return code === "duplicate" ? fe("skuDuplicate") : fe("skuInvalid");
    }
    case "price":
    case "currency":
      return code === "required" ? fe("price") : code === "too_large" ? fe("priceLarge") : code === "not_whole" ? fe("priceWhole") : fe("priceInvalid");
    case "low_stock_level":
      return fe("level");
    case "opening_quantity":
      return fe("quantity");
    case "photo_id":
    case "photo_ids":
      return code === "too_many" ? t("catalog.form.photos.tooMany") : fe("photoGone");
    case "store_ids":
      return fe("stores");
    case "variants":
      return code === "too_many" ? fe("tooManyVariants") : fe("variantsInvalid");
    case "options":
      return t("catalog.form.options.max");
    default:
      return t(fieldErrorMessageKey(code));
  }
}

/** Turns the server's `fields` (dotted, by request position) into the form's keyed errors. */
export function serverFieldErrors(t: Translate, fields: Record<string, string>, state: FormState, built: Built, conflicts: SkuConflict[] = []): Errors {
  const errors: Errors = {};
  const single = state.options.length === 0;
  for (const [path, code] of Object.entries(fields)) {
    const parts = path.split(".");
    let key = path;
    if (parts[0] === "variants" && parts.length >= 3) {
      const rowKey = built.variantKeys[Number(parts[1])];
      const field = parts.slice(2).join(".");
      if (rowKey === undefined) key = "variants";
      else if (field === "price" && single) key = "price";
      else key = `variants.${rowKey}.${field}`;
      const sent = built.input.variants[Number(parts[1])]?.sku;
      errors[key] = messageFor(t, key, code, conflicts, sent);
      continue;
    }
    if (parts[0] === "options" && parts.length >= 3) {
      const option = state.options[Number(parts[1])];
      const field = parts[2] === "values" ? "values" : parts[2] ?? "name";
      key = option ? `options.${option.key}.${field}` : "options";
    }
    if (key === "photo_ids" || key === "photos") key = "photos";
    errors[key] = messageFor(t, key === "photos" ? "photo_ids" : key, code, conflicts, null);
  }
  return errors;
}

export interface Refusal {
  errors: Errors;
  banner: string;
  /** The product as it is now (`product_changed`): the form reloads it. */
  current?: Product;
  gone?: boolean;
  forbidden?: boolean;
  /** No answer at all: the same request may be sent again. */
  connection?: boolean;
}

/** The form's view of a refused or failed save. */
export function saveRefusal(t: Translate, error: unknown, state: FormState, built: Built, current: Product | null, conflicts: SkuConflict[], formatTime: (iso: string) => string): Refusal {
  if (!isApiError(error)) return { errors: {}, banner: errorMessage(t, error) };
  if (error.code === "network_error") return { errors: {}, banner: t("ui.writeFailed"), connection: true };
  const fields = serverFieldErrors(t, error.fields, state, built, conflicts);
  const count = Object.keys(fields).length;
  switch (error.code) {
    case "validation_failed":
      return { errors: fields, banner: count > 0 ? t("catalog.form.fix", { count }) : errorMessage(t, error) };
    case "sku_in_use":
      return { errors: fields, banner: t("catalog.form.banner.skuUsed", { count: Math.max(1, conflicts.length || count) }) };
    case "product_code_in_use":
      return { errors: { ...fields, code: t("catalog.form.fe.codeUsed") }, banner: t("catalog.form.banner.codeUsed") };
    case "product_changed":
      return current ? { errors: {}, banner: t("catalog.form.banner.changed", { time: formatTime(current.updated_at) }), current } : { errors: {}, banner: errorMessage(t, error) };
    case "product_archived":
      return { errors: {}, banner: t("catalog.form.banner.archived") };
    case "options_locked":
      return { errors: {}, banner: t("catalog.form.banner.optionsLocked") };
    case "variant_has_allocations":
      return { errors: {}, banner: t("catalog.form.banner.allocations") };
    case "combination_in_use":
    case "value_in_use":
      return { errors: {}, banner: t("catalog.form.banner.combination") };
    case "not_found":
      return { errors: {}, banner: errorMessage(t, error), gone: true };
    case "forbidden":
      return { errors: {}, banner: errorMessage(t, error), forbidden: true };
    default:
      return { errors: fields, banner: errorMessage(t, error) };
  }
}
