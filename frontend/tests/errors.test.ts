import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import { ApiError } from "@/lib/api";
import {
  ERROR_CODES,
  FIELD_ERROR_CODES,
  UNKNOWN_ERROR_KEY,
  errorMessage,
  errorMessageKey,
  fieldErrorMessageKey,
} from "@/lib/errors";

const OPENAPI = resolve(process.cwd(), "../specs/001-platform-foundation/contracts/openapi.yaml");

// Pulls the codes out of the backticks in each response description, for example
//   a 409 line whose description is "`last_owner`", or "(`phone: invalid_phone`)" for a field code.
export function codesIn(yaml: string): { errorCodes: Set<string>; fieldCodes: Set<string> } {
  const errorCodes = new Set<string>();
  const fieldCodes = new Set<string>();
  const responseLine = /^\s*'\d{3}':\s*\{\s*description:\s*"(.*)"/;
  for (const line of yaml.split(/\r?\n/)) {
    const match = responseLine.exec(line);
    if (!match?.[1]) continue;
    for (const token of match[1].matchAll(/`([^`]+)`/g)) {
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
