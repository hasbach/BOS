// Maps every API error code to a translation key. The server sends stable codes
// (contracts/openapi.yaml); the text lives in messages/{en,ar}.json under "errors".
// tests/errors.test.ts fails if a code in openapi.yaml is missing here or in either language.

import { isApiError } from "./api";

export const ERROR_CODES = [
  // Raised by the web app itself
  "network_error",
  "unexpected_response",
  // Generic server codes
  "unauthenticated",
  "forbidden",
  "not_found",
  "csrf_required",
  "internal_error",
  "validation_failed",
  "too_many_requests",
  // From openapi.yaml
  "already_member",
  "business_pending",
  "business_suspended",
  "cannot_modify_self",
  "confirmation_required",
  "file_not_image",
  "file_too_large",
  "idempotency_conflict",
  "identifier_unavailable",
  "invalid_credentials",
  "invitation_closed",
  "last_active_store",
  "last_owner",
  "link_already_used",
  "link_invalid",
  "owner_has_email",
  "store_name_in_use",
  "weak_password",
  "whatsapp_number_in_use",
  "wrong_password",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const FIELD_ERROR_CODES = ["required", "invalid_phone"] as const;
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

export const UNKNOWN_ERROR_KEY = "errors.unknown";

const errorCodeSet: ReadonlySet<string> = new Set(ERROR_CODES);
const fieldCodeSet: ReadonlySet<string> = new Set(FIELD_ERROR_CODES);

/** Translation key for an API error code; unknown codes fall back to a generic message. */
export function errorMessageKey(code: string): string {
  return errorCodeSet.has(code) ? `errors.${code}` : UNKNOWN_ERROR_KEY;
}

/** Translation key for a per-field code from the envelope's `fields` map. */
export function fieldErrorMessageKey(code: string): string {
  return fieldCodeSet.has(code) ? `fieldErrors.${code}` : UNKNOWN_ERROR_KEY;
}

type Translate = (key: string) => string;

/**
 * User-facing text for any thrown value. Pass the translator for the root namespace, for example
 * `const t = useTranslations(); errorMessage(t, error)`.
 */
export function errorMessage(t: Translate, error: unknown): string {
  return t(isApiError(error) ? errorMessageKey(error.code) : UNKNOWN_ERROR_KEY);
}

/** User-facing text for each entry of an ApiError's `fields` map. */
export function fieldErrorMessages(t: Translate, fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).map(([name, code]) => [name, t(fieldErrorMessageKey(code))]));
}
