// CSV catalog import (specs/002-native-catalog-inventory/contracts/openapi.yaml: /catalog/imports; research R53).
// Upload gives a preview and saves nothing; only confirm saves, all rows or none.

import { API_BASE, api, isApiError } from "./api";
import type { UploadOptions } from "./api";
import type { ImportErrorCode } from "./errors";

export type ImportStatus = "previewed" | "failed" | "committed";

/** One problem in the file: the spreadsheet row (the header is row 1) and the template column (null for the whole row). */
export interface ImportRowError {
  row: number;
  column: string | null;
  code: ImportErrorCode | string;
}

export interface ImportBatch {
  id: string;
  status: ImportStatus;
  file_name: string;
  row_count: number;
  /** What confirming creates (or created). */
  products: number;
  variants: number;
  opening_units: number;
  errors: ImportRowError[];
  expires_at: string;
  committed_at: string | null;
}

/** The server refuses larger files (`file_too_large`); checked first so a big file is not sent for nothing. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** A plain link: the browser downloads the CSV with the session cookie. */
export const IMPORT_TEMPLATE_URL = `${API_BASE}/catalog/imports/template`;

/** Uploads the file and returns its preview (nothing is saved to the catalog). */
export const uploadImport = (file: File, options: Pick<UploadOptions, "onProgress" | "signal"> = {}) =>
  api.upload<ImportBatch>("/catalog/imports", file, { ...options, method: "POST" });

export const getImport = (batchId: string, signal?: AbortSignal) => api.get<ImportBatch>(`/catalog/imports/${batchId}`, { signal });

/** Saves a previewed import; confirming a committed batch again returns it unchanged. */
export const confirmImport = (batchId: string) => api.post<ImportBatch>(`/catalog/imports/${batchId}/confirm`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rows a 409 `import_conflict` lists (its extra member `errors`). */
export function conflictRows(error: unknown): ImportRowError[] {
  if (!isApiError(error) || error.code !== "import_conflict" || !Array.isArray(error.extra.errors)) return [];
  return error.extra.errors.filter(
    (entry): entry is ImportRowError =>
      isRecord(entry) && typeof entry.row === "number" && typeof entry.code === "string" && (entry.column === null || typeof entry.column === "string"),
  );
}

/** The headers a `missing_columns` or `unknown_columns` refusal names (its extra member `columns`). */
export function refusedColumns(error: unknown): string[] {
  if (!isApiError(error) || (error.code !== "missing_columns" && error.code !== "unknown_columns") || !Array.isArray(error.extra.columns)) return [];
  return error.extra.columns.filter((column): column is string => typeof column === "string");
}

/** How many different rows have at least one problem. */
export const rowsWithErrors = (errors: readonly ImportRowError[]) => new Set(errors.map((error) => error.row)).size;
