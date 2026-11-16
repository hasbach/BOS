import { describe, expect, it } from "vitest";

import { FEE_RULE, RATE_RULE, approximate, formatMoney, parseMoney } from "@/lib/money";

describe("parseMoney", () => {
  it("strips typed thousands separators and sends a plain decimal string", () => {
    expect(parseMoney("89,500", RATE_RULE)).toEqual({ ok: true, value: "89500" });
    expect(parseMoney("1,234,567.5", RATE_RULE)).toEqual({ ok: true, value: "1234567.5" });
    expect(parseMoney(" 3.50 ", FEE_RULE)).toEqual({ ok: true, value: "3.50" });
    expect(parseMoney("0003", FEE_RULE)).toEqual({ ok: true, value: "3" });
  });

  it("refuses more than 2 decimals instead of rounding", () => {
    expect(parseMoney("3.555", FEE_RULE)).toEqual({ ok: false, problem: "too_many_decimals" });
    expect(parseMoney("89500.001", RATE_RULE)).toEqual({ ok: false, problem: "too_many_decimals" });
  });

  it("refuses a comma that is not a thousands separator rather than guessing (3,50 is not 350)", () => {
    expect(parseMoney("3,50", FEE_RULE)).toEqual({ ok: false, problem: "invalid" });
    expect(parseMoney("1,2345", FEE_RULE)).toEqual({ ok: false, problem: "invalid" });
    expect(parseMoney(",500", FEE_RULE)).toEqual({ ok: false, problem: "invalid" });
  });

  it("refuses Arabic-Indic digits and the Arabic separators (it does not convert them)", () => {
    expect(parseMoney("٨٩٥٠٠", RATE_RULE)).toEqual({ ok: false, problem: "invalid" });
    expect(parseMoney("3٫50", FEE_RULE)).toEqual({ ok: false, problem: "invalid" });
    expect(parseMoney("89٬500", RATE_RULE)).toEqual({ ok: false, problem: "invalid" });
  });

  it("refuses letters, exponents, signs and empty input", () => {
    for (const bad of ["abc", "1e3", "-5", "+5", "5.", ".5", "1 000"]) {
      expect(parseMoney(bad, FEE_RULE), bad).toEqual({ ok: false, problem: "invalid" });
    }
    expect(parseMoney("   ", FEE_RULE)).toEqual({ ok: false, problem: "required" });
  });

  it("applies the limits: rate above 0 and at most 10,000,000; fee 0 or more and at most 100,000,000", () => {
    expect(parseMoney("0", RATE_RULE)).toEqual({ ok: false, problem: "not_positive" });
    expect(parseMoney("0.00", RATE_RULE)).toEqual({ ok: false, problem: "not_positive" });
    expect(parseMoney("10,000,000", RATE_RULE)).toEqual({ ok: true, value: "10000000" });
    expect(parseMoney("10,000,000.01", RATE_RULE)).toEqual({ ok: false, problem: "too_large" });
    expect(parseMoney("0", FEE_RULE)).toEqual({ ok: true, value: "0" });
    expect(parseMoney("100,000,000", FEE_RULE)).toEqual({ ok: true, value: "100000000" });
    expect(parseMoney("100000001", FEE_RULE)).toEqual({ ok: false, problem: "too_large" });
  });
});

describe("formatMoney", () => {
  it("shows separators with Latin digits", () => {
    expect(formatMoney("89500.00")).toBe("89,500.00");
    expect(formatMoney("89500.00", { trimZeros: true })).toBe("89,500");
    expect(formatMoney("1234567.50", { trimZeros: true })).toBe("1,234,567.5");
    expect(formatMoney("3.00")).toBe("3.00");
    expect(formatMoney("0")).toBe("0");
  });

  it("returns something it cannot read as it was", () => {
    expect(formatMoney("n/a")).toBe("n/a");
  });
});

describe("approximate", () => {
  it("turns USD into whole pounds at the rate, rounding half up", () => {
    expect(approximate("12.50", "USD", "89500")).toEqual({ currency: "LBP", amount: "1118750" });
    expect(approximate("0.01", "USD", "89500")).toEqual({ currency: "LBP", amount: "895" });
    expect(approximate("1", "USD", "89500.50")).toEqual({ currency: "LBP", amount: "89501" });
    expect(approximate("0", "USD", "89500")).toEqual({ currency: "LBP", amount: "0" });
  });

  it("turns LBP into dollars rounded to cents, always with two decimals", () => {
    expect(approximate("895000", "LBP", "89500")).toEqual({ currency: "USD", amount: "10.00" });
    expect(approximate("100000", "LBP", "89500")).toEqual({ currency: "USD", amount: "1.12" });
    expect(approximate("447", "LBP", "89500")).toEqual({ currency: "USD", amount: "0.00" });
    expect(approximate("448", "LBP", "89500")).toEqual({ currency: "USD", amount: "0.01" });
    expect(approximate("0", "LBP", "89500")).toEqual({ currency: "USD", amount: "0.00" });
  });

  it("is exact for the largest price (no floating point)", () => {
    expect(approximate("99999999999.99", "USD", "10000000")).toEqual({ currency: "LBP", amount: "999999999999900000" });
  });

  it("gives nothing when the price or rate is not a usable decimal", () => {
    expect(approximate("abc", "USD", "89500")).toBeNull();
    expect(approximate("10", "USD", "0")).toBeNull();
    expect(approximate("10", "LBP", "0.00")).toBeNull();
    expect(approximate("10", "USD", "")).toBeNull();
    expect(approximate("-5", "USD", "89500")).toBeNull();
  });
});
