// Typed fetch wrapper for the same-origin BOS API (/api/v1).
// Success means the server answered 2xx and nothing else: a network failure, a non-2xx status
// or an unreadable response always throws ApiError, so callers never show success by accident.

export const API_BASE = "/api/v1";

export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldErrors;

  constructor(init: { status: number; code: string; message?: string; fields?: FieldErrors }) {
    super(init.message ?? init.code);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields ?? {};
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
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
  const url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
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
  return new ApiError({
    status,
    code: error.code,
    message: typeof error.message === "string" ? error.message : undefined,
    fields,
  });
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

  if (!response.ok) throw readEnvelope(text, response.status);

  if (response.status === 204 || response.status === 205 || text.trim() === "") {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 2xx whose body we cannot read is not a confirmed success.
    throw new ApiError({ status: response.status, code: "unexpected_response" });
  }
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
};
