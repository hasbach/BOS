import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, api, apiRequest } from "@/lib/api";

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function lastCall() {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  const [url, init] = call;
  return { url: String(url), init: init ?? {}, headers: new Headers(init?.headers) };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected the request to fail");
}

describe("api client requests", () => {
  it("calls the same-origin /api/v1 with cookies and no CSRF header on GET", async () => {
    fetchMock.mockResolvedValue(json({ status: "ok" }));

    const result = await api.get<{ status: string }>("/health");

    expect(result).toEqual({ status: "ok" });
    const { url, init, headers } = lastCall();
    expect(url).toBe("/api/v1/health");
    expect(init.credentials).toBe("same-origin");
    expect(headers.get("X-BOS-CSRF")).toBeNull();
  });

  it.each(["post", "put", "patch"] as const)("sends X-BOS-CSRF and JSON on %s", async (method) => {
    fetchMock.mockResolvedValue(json({ id: 1 }));

    await api[method]("/stores", { name: "A" });

    const { init, headers } = lastCall();
    expect(init.method).toBe(method.toUpperCase());
    expect(headers.get("X-BOS-CSRF")).toBe("1");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "A" }));
  });

  it("sends X-BOS-CSRF on DELETE", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api.delete("/stores/1");

    expect(lastCall().headers.get("X-BOS-CSRF")).toBe("1");
  });

  it("adds the Idempotency-Key header when given", async () => {
    fetchMock.mockResolvedValue(json({}));

    await api.post("/staff/invitations", {}, { idempotencyKey: "abc-123" });

    expect(lastCall().headers.get("Idempotency-Key")).toBe("abc-123");
  });

  it("omits the Idempotency-Key header when not given", async () => {
    fetchMock.mockResolvedValue(json({}));

    await api.post("/staff/invitations", {});

    expect(lastCall().headers.has("Idempotency-Key")).toBe(false);
  });

  it("builds a query string and skips undefined values", async () => {
    fetchMock.mockResolvedValue(json([]));

    await api.get("/audit", { query: { page: 2, q: "a b", skip: undefined } });

    expect(lastCall().url).toBe("/api/v1/audit?page=2&q=a+b");
  });

  it("returns undefined for 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(api.post("/auth/sign-out")).resolves.toBeUndefined();
  });
});

describe("api client failures", () => {
  it("throws ApiError with status, code and fields from the envelope", async () => {
    fetchMock.mockResolvedValue(
      json({ error: { code: "validation_failed", message: "bad", fields: { phone: "invalid_phone", n: 3 } } }, 400),
    );

    const error = await failure(api.post("/me/phone", {}));

    expect(error.status).toBe(400);
    expect(error.code).toBe("validation_failed");
    expect(error.fields).toEqual({ phone: "invalid_phone" });
    expect(error.message).toBe("bad");
  });

  it("gives an empty fields map when the envelope has none", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "forbidden", message: "no" } }, 403));

    expect((await failure(api.get("/x"))).fields).toEqual({});
  });

  it("turns a rejected fetch into network_error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await failure(api.get("/health"));

    expect(error.code).toBe("network_error");
    expect(error.status).toBe(0);
  });

  it("turns a non-JSON error body into unexpected_response", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 }));

    const error = await failure(api.get("/health"));

    expect(error.code).toBe("unexpected_response");
    expect(error.status).toBe(502);
  });

  it("turns JSON without the error envelope into unexpected_response", async () => {
    fetchMock.mockResolvedValue(json({ detail: "nope" }, 500));

    expect((await failure(api.get("/health"))).code).toBe("unexpected_response");
  });

  it("does not report success for a 2xx whose body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>proxy page</html>", { status: 200 }));

    const error = await failure(api.get("/health"));

    expect(error.code).toBe("unexpected_response");
    expect(error.status).toBe(200);
  });

  it.each([400, 401, 404, 409, 500])("never resolves for status %i", async (status) => {
    fetchMock.mockResolvedValue(json({ error: { code: "not_found", message: "" } }, status));

    await expect(apiRequest("/x")).rejects.toBeInstanceOf(ApiError);
  });

  it("lets an aborted request surface as an abort, not a network error", async () => {
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(api.get("/x")).rejects.toMatchObject({ name: "AbortError" });
  });
});
