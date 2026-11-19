import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import { ApiError } from "@/lib/api";
import {
  ERROR_CODES,
  IMPORT_ERROR_CODES,
  FIELD_ERROR_CODES,
  UNKNOWN_ERROR_KEY,
  errorMessage,
  errorMessageKey,
  fieldErrorMessageKey,
  importErrorMessageKey,
} from "@/lib/errors";

const OPENAPI = resolve(process.cwd(), "../specs/001-platform-foundation/contracts/openapi.yaml");
const OPENAPI_M1 = resolve(process.cwd(), "../specs/002-native-catalog-inventory/contracts/openapi.yaml");

// Pulls the codes out of the backticks in each response description, for example
//   a 409 line whose description is "`last_owner`", or "(`phone: invalid_phone`)" for a field code.
export function codesIn(yaml: string): { errorCodes: Set<string>; fieldCodes: Set<string> } {
  const errorCodes = new Set<string>();
  const fieldCodes = new Set<string>();
  // Only error responses (4xx and 5xx) carry codes, and a note after an em dash ("`validation_failed`
  // — malformed `cursor`") names request properties, not codes.
  const responseLine = /^\s*'[45]\d{2}':\s*\{\s*description:\s*"(.*?)"/;
  for (const line of yaml.split(/\r?\n/)) {
    const match = responseLine.exec(line);
    if (!match?.[1]) continue;
    const codesPart = match[1].split(" — ")[0] ?? "";
    for (const token of codesPart.matchAll(/`([^`]+)`/g)) {
      const text = token[1] ?? "";
      const pair = /^[a-z_]+:\s*([a-z_]+)$/.exec(text);
      if (pair?.[1]) fieldCodes.add(pair[1]);
      else if (/^[a-z][a-z0-9_]*$/.test(text)) errorCodes.add(text);
    }
  }
  return { errorCodes, fieldCodes };
}

const catalogs = { en, ar } as const;

describe("code extraction", () => {
  it("reads error codes and field codes from response lines only", () => {
    const sample = [
      "    - Authentication: opaque session cookie `bos_session` (business users)",
      `        '400': { description: "\`validation_failed\` (\`phone: invalid_phone\`, \`identifier: required\`) or \`wrong_password\`" }`,
      `        '409': { description: "\`last_owner\`" }`,
    ].join("\n");

    const { errorCodes, fieldCodes } = codesIn(sample);

    expect([...errorCodes].sort()).toEqual(["last_owner", "validation_failed", "wrong_password"]);
    expect([...fieldCodes].sort()).toEqual(["invalid_phone", "required"]);
  });
});

// The compose "web" service mounts only ./frontend, so inside the container the specs folder is
// not visible unless it is mounted at /srv/specs. Anywhere else (host, CI checkout) it is found.
const contractVisible = existsSync(OPENAPI);
if (!contractVisible && process.env.CI) {
  throw new Error(`openapi.yaml not found at ${OPENAPI}`);
}

describe.skipIf(!contractVisible)("error codes in openapi.yaml", () => {
  const { errorCodes, fieldCodes } = codesIn(contractVisible ? readFileSync(OPENAPI, "utf8") : "");

  it("finds the codes (guards the parser)", () => {
    expect(errorCodes.size).toBeGreaterThan(20);
    expect(errorCodes).toContain("invalid_credentials");
    expect(errorCodes).toContain("last_owner");
    expect(fieldCodes).toContain("invalid_phone");
  });

  for (const [language, catalog] of Object.entries(catalogs)) {
    it(`has an ${language} translation for every error code`, () => {
      const missing = [...errorCodes].filter((code) => !(code in catalog.errors));
      expect(missing).toEqual([]);
    });

    it(`has an ${language} translation for every field code`, () => {
      const missing = [...fieldCodes].filter((code) => !(code in catalog.fieldErrors));
      expect(missing).toEqual([]);
    });
  }

  it("lists every contract code in ERROR_CODES and FIELD_ERROR_CODES", () => {
    expect([...errorCodes].filter((code) => !(ERROR_CODES as readonly string[]).includes(code))).toEqual([]);
    expect([...fieldCodes].filter((code) => !(FIELD_ERROR_CODES as readonly string[]).includes(code))).toEqual([]);
  });
});

const M1_ERROR_CODES = [
  "validation_failed", "forbidden", "not_found", "product_code_in_use", "sku_in_use", "idempotency_conflict",
  "product_changed", "product_archived", "options_locked", "variant_has_allocations", "combination_in_use",
  "value_in_use", "has_history", "file_too_large", "file_not_image", "stock_changed", "not_enough_stock",
  "try_again", "file_not_csv", "too_many_rows", "missing_columns", "unknown_columns", "import_has_errors",
  "import_conflict", "import_expired",
];
const M1_FIELD_CODES = ["required", "invalid", "too_long", "too_large", "too_many", "duplicate", "not_whole", "in_use"];

describe.skipIf(!existsSync(OPENAPI_M1))("error codes in the M1 openapi.yaml", () => {
  const { errorCodes, fieldCodes } = codesIn(existsSync(OPENAPI_M1) ? readFileSync(OPENAPI_M1, "utf8") : "");

  it("yields exactly the M1 error codes and field codes", () => {
    expect([...errorCodes].sort()).toEqual([...M1_ERROR_CODES].sort());
    expect([...fieldCodes].sort()).toEqual([...M1_FIELD_CODES].sort());
  });

  for (const [language, catalog] of Object.entries(catalogs)) {
    it(`has ${language} text and a mapping for every M1 code`, () => {
      for (const code of errorCodes) {
        expect((catalog.errors as Record<string, string>)[code], code).toBeTruthy();
        expect(ERROR_CODES as readonly string[], code).toContain(code);
      }
      for (const code of fieldCodes) {
        expect((catalog.fieldErrors as Record<string, string>)[code], code).toBeTruthy();
        expect(FIELD_ERROR_CODES as readonly string[], code).toContain(code);
      }
    });
  }
});

describe("import row errors", () => {
  const IMPORT_CODES = [
    "required", "invalid", "too_long", "too_large", "negative", "not_whole", "invalid_currency", "sku_in_use",
    "product_code_in_use", "duplicate_in_file", "unknown_store", "inconsistent_product", "duplicate_combination",
    "missing_option_value", "too_many_options", "too_many_values", "too_many_variants",
  ];

  it("lists every ImportError code of the contract", () => {
    expect([...IMPORT_ERROR_CODES].sort()).toEqual([...IMPORT_CODES].sort());
    if (existsSync(OPENAPI_M1)) {
      const yaml = readFileSync(OPENAPI_M1, "utf8");
      const listed = /ImportError:[\s\S]*?enum: \[([^\]]+)\]/.exec(yaml)?.[1]?.split(",").map((c) => c.trim());
      expect(listed?.sort()).toEqual([...IMPORT_CODES].sort());
    }
  });

  it.each(Object.entries(catalogs))("has non-empty %s text for each", (_language, catalog) => {
    for (const code of IMPORT_CODES) {
      expect((catalog.importErrors as Record<string, string>)[code], code).toBeTruthy();
    }
  });

  it("maps a code to its key and an unknown one to the generic key", () => {
    expect(importErrorMessageKey("sku_in_use")).toBe("importErrors.sku_in_use");
    expect(importErrorMessageKey("brand_new")).toBe(UNKNOWN_ERROR_KEY);
  });
});

describe("error code mapping", () => {
  it.each(Object.entries(catalogs))("has non-empty %s text for every mapped code", (_language, catalog) => {
    for (const code of ERROR_CODES) {
      expect((catalog.errors as Record<string, string>)[code], code).toBeTruthy();
    }
    for (const code of FIELD_ERROR_CODES) {
      expect((catalog.fieldErrors as Record<string, string>)[code], code).toBeTruthy();
    }
    expect(catalog.errors.unknown).toBeTruthy();
  });

  it("covers the codes the web app raises itself and the generic server codes", () => {
    const extra = [
      "csrf_required",
      "internal_error",
      "too_many_requests",
      "network_error",
      "unexpected_response",
      "unauthenticated",
      "forbidden",
      "not_found",
      "validation_failed",
    ];
    for (const code of extra) {
      expect(ERROR_CODES as readonly string[], code).toContain(code);
      for (const catalog of [en, ar]) {
        expect((catalog.errors as Record<string, string>)[code], code).toBeTruthy();
      }
    }
  });

  it("maps a code to its key and unknown codes to the generic key", () => {
    expect(errorMessageKey("last_owner")).toBe("errors.last_owner");
    expect(errorMessageKey("something_new")).toBe(UNKNOWN_ERROR_KEY);
    expect(fieldErrorMessageKey("required")).toBe("fieldErrors.required");
    expect(fieldErrorMessageKey("weird")).toBe(UNKNOWN_ERROR_KEY);
  });

  it("translates a thrown ApiError and falls back for anything else", () => {
    const t = (key: string) => `t:${key}`;
    expect(errorMessage(t, new ApiError({ status: 409, code: "last_owner" }))).toBe("t:errors.last_owner");
    expect(errorMessage(t, new Error("boom"))).toBe(`t:${UNKNOWN_ERROR_KEY}`);
  });
});
