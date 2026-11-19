// Typed fetch wrapper for the same-origin BOS API (/api/v1).
// Success means the server answered 2xx and nothing else: a network failure, a non-2xx status
// or an unreadable response always throws ApiError, so callers never show success by accident.
//
// Every refused answer (401/403) is also reported to the listeners registered with onApiRefusal, so the
// guards can react centrally (SC-005): a session that has ended goes to sign-in from whichever screen
// asked, and a permission refusal makes the business guard ask GET /me again. Screens still get the error.

import { SIGN_IN_CODES } from "./identity";

export const API_BASE = "/api/v1";

export type FieldErrors = Record<string, string>;

/** Someone who would lose their only store (409 confirmation_required carries a list of these). */
export interface AffectedPerson {
  kind: "employee" | "invitation";
  id: string;
  name: string;
  roles: string[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldErrors;
  readonly affected: AffectedPerson[];
  /** The other members of the error object that an operation names (M1: `current`, `conflicts`, `balance`), unchecked. */
  readonly extra: Record<string, unknown>;

  constructor(init: { status: number; code: string; message?: string; fields?: FieldErrors; affected?: AffectedPerson[]; extra?: Record<string, unknown> }) {
    super(init.message ?? init.code);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields ?? {};
    this.affected = init.affected ?? [];
    this.extra = init.extra ?? {};
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** True when the request got no answer at all (offline, server unreachable): nothing was saved. */
export function isConnectionError(value: unknown): boolean {
  return value instanceof ApiError && value.code === "network_error";
}

/**
 * True when the answer means the business session is over (signed out elsewhere, deactivated, business
 * suspended or not active): the person must sign in again. Never true for a request with no answer.
 */
export function isSessionEnded(value: unknown): boolean {
  return value instanceof ApiError && (value.status === 401 || value.status === 403) && SIGN_IN_CODES.has(value.code);
}

/** A refused answer (401 or 403) to a request, with the API path that was asked (no query string). */
export interface ApiRefusal {
  path: string;
  error: ApiError;
}

type RefusalListener = (refusal: ApiRefusal) => void;

const refusalListeners = new Set<RefusalListener>();

/** Calls `listener` for every 401/403 answer from any request; returns the function that stops it. */
export function onApiRefusal(listener: RefusalListener): () => void {
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}

function normalisePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** Tells the listeners about a refused answer before it is thrown to the caller. */
function refused(path: string, error: ApiError): ApiError {
  if (error.status === 401 || error.status === 403) {
    const refusal = { path: normalisePath(path), error };
    for (const listener of [...refusalListeners]) {
      try {
        listener(refusal);
      } catch {
        // A listener's own failure must not change what the caller gets.
      }
    }
  }
  return error;
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Serialised as JSON. */
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** Sent as the Idempotency-Key header on endpoints that accept it. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_BASE}${normalisePath(path)}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnvelope(text: string, status: number): ApiError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new ApiError({ status, code: "unexpected_response" });
  }
  const error = isRecord(parsed) ? parsed.error : undefined;
  if (!isRecord(error) || typeof error.code !== "string" || error.code === "") {
    return new ApiError({ status, code: "unexpected_response" });
  }
  const fields: FieldErrors = {};
  if (isRecord(error.fields)) {
    for (const [name, code] of Object.entries(error.fields)) {
      if (typeof code === "string") fields[name] = code;
    }
  }
  const affected: AffectedPerson[] = [];
  if (Array.isArray(error.affected)) {
    for (const entry of error.affected) {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") continue;
      affected.push({
        kind: entry.kind === "invitation" ? "invitation" : "employee",
        id: entry.id,
        name: entry.name,
        roles: Array.isArray(entry.roles) ? entry.roles.filter((role): role is string => typeof role === "string") : [],
      });
    }
  }
  const extra: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(error)) {
    if (!["code", "message", "fields", "affected"].includes(name)) extra[name] = value;
  }
  return new ApiError({
    status,
    code: error.code,
    message: typeof error.message === "string" ? error.message : undefined,
    fields,
    affected,
    extra,
  });
}

/** The body of a 2xx answer; one that cannot be read is not a confirmed success. */
function readSuccess<T>(status: number, text: string): T {
  if (status === 204 || status === 205 || text.trim() === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({ status, code: "unexpected_response" });
  }
}

export async function apiRequest<T = void>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (MUTATING.has(method)) headers["X-BOS-CSRF"] = "1";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (error) {
    // A cancelled request is the caller's own doing, not a failure to report.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError({ status: 0, code: "network_error" });
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError({ status: response.status, code: "network_error" });
  }

  if (!response.ok) throw refused(path, readEnvelope(text, response.status));

  return readSuccess<T>(response.status, text);
}

export interface UploadOptions {
  method?: "PUT" | "POST";
  /** Name of the multipart field; the logo endpoint reads `file`. */
  field?: string;
  /** Called with 0 to 100 while the file is sent. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * Sends one file as multipart/form-data. fetch cannot report upload progress, so this uses
 * XMLHttpRequest; the rules are the same as apiRequest: only a 2xx with a readable body is success,
 * and the CSRF header is always sent. The browser sets the multipart Content-Type itself.
 */
export function apiUpload<T = void>(path: string, file: Blob, options: UploadOptions = {}): Promise<T> {
  const method = options.method ?? "PUT";
  return new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(method, buildUrl(path));
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-BOS-CSRF", "1");
    xhr.responseType = "text";

    const onAbort = () => xhr.abort();
    options.signal?.addEventListener("abort", onAbort);
    const done = () => options.signal?.removeEventListener("abort", onAbort);

    const report = options.onProgress;
    if (report) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) report(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      };
    }
    xhr.onerror = () => {
      done();
      reject(new ApiError({ status: 0, code: "network_error" }));
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      done();
      reject(new DOMException("Aborted", "AbortError"));
    };
    xhr.onload = () => {
      done();
      const text = typeof xhr.response === "string" ? xhr.response : "";
      try {
        if (xhr.status < 200 || xhr.status >= 300) throw refused(path, readEnvelope(text, xhr.status));
        resolve(readSuccess<T>(xhr.status, text));
      } catch (error) {
        reject(error);
      }
    };

    const form = new FormData();
    form.append(options.field ?? "file", file, file instanceof File ? file.name : "logo");
    xhr.send(form);
  });
}

type BodyOptions = Omit<RequestOptions, "method" | "body">;

export const api = {
  get: <T>(path: string, options?: BodyOptions) => apiRequest<T>(path, { ...options, method: "GET" }),
  post: <T = void>(path: string, body?: unknown, options?: BodyOptions) =>
    apiRequest<T>(path, { ...options, method: "POST", body }),
  put: <T = void>(path: string, body?: unknown, options?: BodyOptions) =>
    apiRequest<T>(path, { ...options, method: "PUT", body }),
  patch: <T = void>(path: string, body?: unknown, options?: BodyOptions) =>
    apiRequest<T>(path, { ...options, method: "PATCH", body }),
  delete: <T = void>(path: string, options?: BodyOptions) =>
    apiRequest<T>(path, { ...options, method: "DELETE" }),
  upload: apiUpload,
};
