import { isApiError } from "@/lib/api";
import { errorMessage, fieldErrorMessageKey } from "@/lib/errors";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface FormErrors {
  name?: string;
  wa?: string;
  logo?: string;
}

export interface Outcome {
  fields: FormErrors;
  /** The message at the top of the form, when there is one. */
  banner: string;
  /** The request found the store gone: show the not-found screen. */
  gone?: boolean;
  /** The server said this person may not change stores: show the not-allowed screen. */
  forbidden?: boolean;
}

/**
 * What a failed create, edit, deactivate or reactivate request means for the form: messages next
 * to the fields (screens 80, 81), the last-active-store message (screen 89) or a plain banner.
 */
export function storeOutcome(t: Translate, error: unknown): Outcome {
  if (!isApiError(error)) return { fields: {}, banner: errorMessage(t, error) };
  switch (error.code) {
    case "validation_failed": {
      const fields: FormErrors = {};
      for (const [field, code] of Object.entries(error.fields)) {
        if (field === "name") fields.name = t(code === "required" ? "stores.fe.name" : code === "too_long" ? "stores.fe.nameTooLong" : fieldErrorMessageKey(code));
        else if (field === "whatsapp_number") fields.wa = t(code === "invalid_phone" ? "stores.fe.phone" : fieldErrorMessageKey(code));
      }
      const count = Object.keys(fields).length;
      return { fields, banner: count > 0 ? t("stores.form.fix", { count }) : errorMessage(t, error) };
    }
    case "store_name_in_use":
      return { fields: { name: t("stores.fe.nameUsed") }, banner: t("stores.form.notSaved") };
    case "whatsapp_number_in_use":
      return { fields: { wa: t("stores.fe.waUsed") }, banner: t("stores.form.notSaved") };
    case "last_active_store":
      return { fields: {}, banner: t("stores.deactivate.lastActive") };
    case "not_found":
      return { fields: {}, banner: errorMessage(t, error), gone: true };
    case "forbidden":
      return { fields: {}, banner: errorMessage(t, error), forbidden: true };
    default:
      return { fields: {}, banner: errorMessage(t, error) };
  }
}

/** The message next to the logo for a refused or failed upload (screens 82, 85, 86). */
export function logoErrorText(t: Translate, error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "file_too_large") return t("stores.fe.big");
    if (error.code === "file_not_image" || (error.code === "validation_failed" && error.fields.file)) return t("stores.fe.img");
  }
  return errorMessage(t, error);
}
