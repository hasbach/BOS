// Maps every API error code to a translation key. The server sends stable codes
// (contracts/openapi.yaml); the text lives in messages/{en,ar}.json under "errors".
// tests/errors.test.ts fails if a code in openapi.yaml is missing here or in either language.

import { isApiError, isConnectionError } from "./api";

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
  "combination_in_use",
  "cannot_modify_self",
  "code_invalid",
  "code_not_required",
  "confirmation_required",
  "file_not_csv",
  "file_not_image",
  "file_too_large",
  "has_history",
  "idempotency_conflict",
  "identifier_unavailable",
  "import_conflict",
  "import_expired",
  "import_has_errors",
  "invalid_credentials",
  "invalid_idempotency_key",
  "invitation_closed",
  "last_active_store",
  "last_owner",
  "link_already_used",
  "link_invalid",
  "missing_columns",
  "not_enough_stock",
  "options_locked",
  "owner_has_email",
  "product_archived",
  "product_changed",
  "product_code_in_use",
  "sku_in_use",
  "stock_changed",
  "store_name_in_use",
  "too_many_rows",
  "try_again",
  "unknown_columns",
  "user_inactive",
  "value_in_use",
  "variant_has_allocations",
  "weak_password",
  "whatsapp_number_in_use",
  "wrong_password",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const FIELD_ERROR_CODES = [
  "required",
  "invalid_phone",
  "invalid_email",
  "invalid",
  "too_long",
  "too_large",
  "too_many",
  "duplicate",
  "not_whole",
  "in_use",
] as const;
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

/** Row-level codes of an import preview (ImportError.code in contracts/openapi.yaml); the text is under "importErrors". */
export const IMPORT_ERROR_CODES = [
  "required",
  "invalid",
  "too_long",
  "too_large",
  "negative",
  "not_whole",
  "invalid_currency",
  "sku_in_use",
  "product_code_in_use",
  "duplicate_in_file",
  "unknown_store",
  "inconsistent_product",
  "duplicate_combination",
  "missing_option_value",
  "too_many_options",
  "too_many_values",
  "too_many_variants",
] as const;
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

export const UNKNOWN_ERROR_KEY = "errors.unknown";

const errorCodeSet: ReadonlySet<string> = new Set(ERROR_CODES);
const fieldCodeSet: ReadonlySet<string> = new Set(FIELD_ERROR_CODES);
const importCodeSet: ReadonlySet<string> = new Set(IMPORT_ERROR_CODES);

/** Translation key for an API error code; unknown codes fall back to a generic message. */
export function errorMessageKey(code: string): string {
  return errorCodeSet.has(code) ? `errors.${code}` : UNKNOWN_ERROR_KEY;
}

/** Translation key for a per-field code from the envelope's `fields` map. */
export function fieldErrorMessageKey(code: string): string {
  return fieldCodeSet.has(code) ? `fieldErrors.${code}` : UNKNOWN_ERROR_KEY;
}

/** Translation key for the code of one import row error. */
export function importErrorMessageKey(code: string): string {
  return importCodeSet.has(code) ? `importErrors.${code}` : UNKNOWN_ERROR_KEY;
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

/**
 * Text for a failed write (T083, screen 130). With no answer from the server it says plainly that
 * nothing was saved and that what was typed is still there; any other failure uses its own message.
 */
export function writeFailureMessage(t: Translate, error: unknown): string {
  return isConnectionError(error) ? t("ui.writeFailed") : errorMessage(t, error);
}
