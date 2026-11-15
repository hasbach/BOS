// Digits typed on an Arabic keyboard (research R48). The API accepts ASCII only, so screens turn
// what was typed into ASCII before validating it (lib/money.ts then keeps its ASCII-only rule).

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/**
 * Arabic-Indic (٠-٩) and extended Arabic-Indic (۰-۹) digits become 0-9, the Arabic decimal
 * separator (٫) becomes ".", and the Arabic thousands separator (٬) is removed. Everything else is
 * left as typed, so validation still sees and refuses it.
 */
export function normaliseDigits(input: string): string {
  return input
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - ARABIC_INDIC_ZERO))
    .replace(/[\u06f0-\u06f9]/g, (c) => String(c.charCodeAt(0) - EXTENDED_ARABIC_INDIC_ZERO))
    .replaceAll("\u066b", ".")
    .replaceAll("\u066c", "");
}
