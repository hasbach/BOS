import { describe, expect, it } from "vitest";

import { normaliseDigits } from "@/lib/digits";
import { FEE_RULE, RATE_RULE, parseMoney } from "@/lib/money";

describe("normaliseDigits (R48)", () => {
  it("turns Arabic-Indic digits into ASCII", () => {
    expect(normaliseDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("turns extended Arabic-Indic (Persian) digits into ASCII", () => {
    expect(normaliseDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });

  it("turns the Arabic decimal separator into a dot", () => {
    expect(normaliseDigits("٢٫٥")).toBe("2.5");
  });

  it("removes the Arabic thousands separator", () => {
    expect(normaliseDigits("٨٩٬٥٠٠")).toBe("89500");
  });

  it("leaves other characters untouched", () => {
    expect(normaliseDigits("abc 1,234.50 -x")).toBe("abc 1,234.50 -x");
    expect(normaliseDigits("")).toBe("");
  });

  it("handles mixed input", () => {
    expect(normaliseDigits("٨٩,500.٢٥")).toBe("89,500.25");
    expect(normaliseDigits("1٬۲٫٣x")).toBe("12.3x");
  });

  it("feeds parseMoney, which itself stays ASCII-only", () => {
    expect(parseMoney(normaliseDigits("٨٩٬٥٠٠"), RATE_RULE)).toEqual({ ok: true, value: "89500" });
    expect(parseMoney(normaliseDigits("٢٫٥"), FEE_RULE)).toEqual({ ok: true, value: "2.5" });
    expect(parseMoney("٨٩٥٠٠", RATE_RULE)).toEqual({ ok: false, problem: "invalid" });
  });
});
