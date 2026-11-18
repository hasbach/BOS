// Stock adjustments and stock history (specs/002-native-catalog-inventory/contracts/openapi.yaml:
// /catalog/variants/{variantId}/adjustments and /movements; research R41, R43, R44).

import { api, isApiError } from "./api";
import type { StockNumbers, StockState } from "./catalog";
import { newIdempotencyKey } from "./staff";

/** What the adjust-stock sheet records: the sign comes from the mode, never from a typed minus. */
export type AdjustMode = "add" | "remove" | "count";
export type AdjustReason = "opening" | "received" | "found" | "damaged" | "lost" | "count_correction" | "other";
export type MovementReason = AdjustReason | "allocation_consumed";
export type MovementSource = "manual" | "product_form" | "import" | "allocation";

export interface AdjustmentInput {
  reason: AdjustReason;
  /** Every reason except count_correction: 1 to 1,000,000. */
  quantity?: number;
  /** count_correction only: 0 to 1,000,000. */
  counted_quantity?: number;
  /** other only: sets the sign. */
  direction?: "in" | "out";
  note?: string;
  balance_version: number;
}

export interface Movement {
  id: string;
  at: string;
  reason: MovementReason;
  /** Signed. */
  quantity: number;
  counted_quantity: number | null;
  on_hand_after: number;
  actor_type: "user" | "system";
  /** The user's current name; null for system. */
  actor_name: string | null;
  note: string | null;
  source: MovementSource;
}

export interface AdjustmentResult {
  movement: Movement;
  balance: StockNumbers;
}

export interface MovementPage {
  items: Movement[];
  next_cursor: string | null;
}

export const MAX_QUANTITY = 1_000_000;
export const NOTE_MAX = 500;

/** The reasons each mode offers (R41); Set count has one reason of its own. */
export const REASONS_BY_MODE: Record<"add" | "remove", readonly AdjustReason[]> = {
  add: ["received", "found", "opening", "other"],
  remove: ["damaged", "lost", "other"],
};

/** One key per opened sheet, reused for every retry of its save (R44). */
export const newAdjustmentKey = newIdempotencyKey;

/** `idempotencyKey` stays the same for every retry of one sheet's save. */
export const adjustStock = (variantId: string, input: AdjustmentInput, idempotencyKey: string) =>
  api.post<AdjustmentResult>(`/catalog/variants/${variantId}/adjustments`, input, { idempotencyKey });

/** Newest first, 50 per page. */
export const listMovements = (variantId: string, cursor?: string, signal?: AbortSignal) =>
  api.get<MovementPage>(`/catalog/variants/${variantId}/movements`, { query: { cursor }, signal });

/** The request body for what the sheet shows. `amount` is the quantity, or the number counted for Set count. */
export function buildAdjustment(mode: AdjustMode, reason: AdjustReason | null, amount: number, note: string, balanceVersion: number): AdjustmentInput {
  const text = note.trim();
  if (mode === "count") {
    return { reason: "count_correction", counted_quantity: amount, ...(text ? { note: text } : {}), balance_version: balanceVersion };
  }
  const chosen = reason ?? (mode === "add" ? "received" : "damaged");
  return {
    reason: chosen,
    quantity: amount,
    ...(chosen === "other" ? { direction: mode === "add" ? ("in" as const) : ("out" as const) } : {}),
    ...(text ? { note: text } : {}),
    balance_version: balanceVersion,
  };
}

/** The signed change a mode and amount would make to on hand. */
export function changeOf(mode: AdjustMode, amount: number, numbers: StockNumbers): number {
  if (mode === "count") return amount - numbers.on_hand;
  return mode === "add" ? amount : -amount;
}

/** On hand and available after the change, as the server would compute them. */
export function preview(mode: AdjustMode, amount: number, numbers: StockNumbers): { change: number; onHand: number; available: number } {
  const change = changeOf(mode, amount, numbers);
  const onHand = numbers.on_hand + change;
  return { change, onHand, available: Math.max(0, onHand - numbers.allocated) };
}

/**
 * Why the server would refuse this change for the numbers, or null. On hand may not go below what is
 * reserved (so never below zero) nor above 1,000,000. The server still decides.
 */
export function stockProblem(mode: AdjustMode, amount: number, numbers: StockNumbers): "not_enough_stock" | "too_large" | null {
  const { onHand } = preview(mode, amount, numbers);
  if (onHand < numbers.allocated || onHand < 0) return "not_enough_stock";
  if (onHand > MAX_QUANTITY) return "too_large";
  return null;
}

/** "Low" and "Out" for numbers (contracts StockState): out at 0 available; low at 0 < available ≤ level. */
export function stockStateOf(numbers: StockNumbers, level: number): StockState {
  if (numbers.available <= 0) return "out";
  if (level > 0 && numbers.available <= level) return "low";
  return "ok";
}

function isNumbers(value: unknown): value is StockNumbers {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return ["on_hand", "allocated", "available", "version"].every((key) => typeof record[key] === "number");
}

/** The current numbers a 409 `stock_changed` or `not_enough_stock` carries (its extra member `balance`), or null. */
export function currentBalance(error: unknown): StockNumbers | null {
  if (!isApiError(error) || (error.code !== "stock_changed" && error.code !== "not_enough_stock")) return null;
  return isNumbers(error.extra.balance) ? error.extra.balance : null;
}
