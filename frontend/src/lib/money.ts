// Money typed by people and shown to them (research R36). The API takes plain ASCII decimal
// strings only ("89500", "3.50"); people may type thousands separators ("89,500"), and the
// screens show separators with Latin digits in both languages.

export type MoneyProblem = "required" | "invalid" | "too_many_decimals" | "too_large" | "not_positive";

export type MoneyResult = { ok: true; value: string } | { ok: false; problem: MoneyProblem };

export interface MoneyRule {
  /** Largest value allowed. */
  max: number;
  /** True when zero is refused (the exchange rate); false when zero is fine (the delivery fee). */
  positive: boolean;
}

export const RATE_RULE: MoneyRule = { max: 10_000_000, positive: true };
export const FEE_RULE: MoneyRule = { max: 100_000_000, positive: false };

// Digits 0-9 only (callers run the input through normaliseDigits first): a run of digits, or groups of three after one to three digits (89,500). A comma
// anywhere else is refused rather than guessed at, because "3,50" typed as a decimal comma would
// otherwise silently become 350.
const SHAPE = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

/**
 * Turns what was typed into the plain decimal string the API accepts, or says what is wrong.
 * ASCII only: this refuses Arabic-Indic digits and the Arabic comma and decimal mark because the
 * API accepts ASCII only (R48). Callers normalise first (lib/digits.ts normaliseDigits).
 */
export function parseMoney(input: string, rule: MoneyRule): MoneyResult {
  const typed = input.trim();
  if (typed === "") return { ok: false, problem: "required" };
  if (!SHAPE.test(typed)) return { ok: false, problem: "invalid" };
  const plain = typed.replaceAll(",", "");
  const [whole = "", decimals = ""] = plain.split(".");
  if (decimals.length > 2) return { ok: false, problem: "too_many_decimals" };
  const number = Number(plain);
  if (!Number.isFinite(number) || number > rule.max) return { ok: false, problem: "too_large" };
  if (rule.positive && number <= 0) return { ok: false, problem: "not_positive" };
  // Leading zeros are harmless to the API but not worth sending.
  const cleanWhole = whole.replace(/^0+(?=\d)/, "");
  return { ok: true, value: decimals === "" ? cleanWhole : `${cleanWhole}.${decimals}` };
}

/** "89500.00" becomes "89,500.00" with Latin digits; `trimZeros` drops a ".00" ending ("89,500"). */
export function formatMoney(value: string, options: { trimZeros?: boolean } = {}): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const whole = (match[1] ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let decimals = match[2] ?? "";
  if (options.trimZeros) decimals = decimals.replace(/0+$/, "");
  return decimals ? `${whole}.${decimals}` : whole;
}
