import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  archiveProduct,
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  mainPhotoOf,
  photoUrl,
  restoreProduct,
  updateProduct,
  uploadPhoto,
} from "@/lib/catalog";
import type { ProductInput } from "@/lib/catalog";

import { imageFile, installFakeXhr, lastUpload } from "../helpers/stores";

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
afterEach(() => vi.unstubAllGlobals());

const INPUT: ProductInput = { code: "JN-TEST", name_en: "Jeans", variants: [{ option_values: [], price: "30", currency: "USD" }] };

describe("catalog API calls", () => {
  it("lists products with only the filters that were set", async () => {
    fetchMock.mockImplementation(async () => json({ items: [], next_cursor: null, counts: null }));
    await listProducts({ q: "jeans", stock: "low", status: "archived", cursor: "abc" });
    const { url, init } = lastCall();
    expect(init.method).toBe("GET");
    const params = new URL(url, "http://x").searchParams;
    expect(url.startsWith("/api/v1/catalog/products?")).toBe(true);
    expect(Object.fromEntries(params)).toEqual({ q: "jeans", stock: "low", status: "archived", cursor: "abc" });

    await listProducts({});
    expect(lastCall().url).toBe("/api/v1/catalog/products");
  });

  it("sends store_id and no_photo as given", async () => {
    fetchMock.mockImplementation(async () => json({ items: [], next_cursor: null, counts: null }));
    await listProducts({ store_id: "st-1", no_photo: true });
    expect(Object.fromEntries(new URL(lastCall().url, "http://x").searchParams)).toEqual({ store_id: "st-1", no_photo: "true" });
  });

  it("reads one product", async () => {
    fetchMock.mockImplementation(async () => json({ id: "p1" }));
    await expect(getProduct("p1")).resolves.toEqual({ id: "p1" });
    expect(lastCall().url).toBe("/api/v1/catalog/products/p1");
  });

  it("creates with the idempotency key and the CSRF header", async () => {
    fetchMock.mockImplementation(async () => json({ id: "p1" }, 201));
    await createProduct(INPUT, "key-1");
    const { url, init, headers } = lastCall();
    expect(url).toBe("/api/v1/catalog/products");
    expect(init.method).toBe("POST");
    expect(headers.get("Idempotency-Key")).toBe("key-1");
    expect(headers.get("X-BOS-CSRF")).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual(INPUT);
  });

  it("updates with the version it was loaded at", async () => {
    fetchMock.mockImplementation(async () => json({ id: "p1" }));
    await updateProduct("p1", { ...INPUT, version: 3 });
    const { url, init } = lastCall();
    expect(url).toBe("/api/v1/catalog/products/p1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body)).version).toBe(3);
  });

  it("archives and restores by version, and deletes with the version in the query", async () => {
    fetchMock.mockImplementation(async () => json({ id: "p1" }));
    await archiveProduct("p1", 4);
    expect(lastCall().url).toBe("/api/v1/catalog/products/p1/archive");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ version: 4 });
    await restoreProduct("p1", 5);
    expect(lastCall().url).toBe("/api/v1/catalog/products/p1/restore");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ version: 5 });

    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(deleteProduct("p1", 6)).resolves.toBeUndefined();
    expect(lastCall().url).toBe("/api/v1/catalog/products/p1?version=6");
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("surfaces product_changed with the current product", async () => {
    fetchMock.mockImplementation(async () => json({ error: { code: "product_changed", message: "x", fields: {}, current: { id: "p1", version: 9 } } }, 409));
    await expect(updateProduct("p1", { ...INPUT, version: 3 })).rejects.toMatchObject({ status: 409, code: "product_changed" });
  });
});

describe("photos", () => {
  beforeEach(installFakeXhr);

  it("uploads by POST to /catalog/photos as field `file` and reports progress", async () => {
    const seen: number[] = [];
    const pending = uploadPhoto(imageFile("shirt.png"), { onProgress: (p) => seen.push(p) });
    const xhr = lastUpload();
    expect(xhr).toMatchObject({ method: "POST", url: "/api/v1/catalog/photos" });
    expect((xhr.form?.get("file") as File).name).toBe("shirt.png");
    xhr.progress(1, 2);
    xhr.respond(201, { id: "ph1", width: 1080, height: 720 });
    await expect(pending).resolves.toEqual({ id: "ph1", width: 1080, height: 720 });
    expect(seen).toEqual([50]);
  });

  it("builds image URLs for the two sizes", () => {
    expect(photoUrl("ph1", "thumb")).toBe("/api/v1/catalog/photos/ph1/thumb");
    expect(photoUrl("ph1", "large")).toBe("/api/v1/catalog/photos/ph1/large");
  });

  it("the main photo is the first one", () => {
    expect(mainPhotoOf({ photos: [{ id: "a", width: 1, height: 1 }, { id: "b", width: 1, height: 1 }] })).toBe("a");
    expect(mainPhotoOf({ photos: [] })).toBeNull();
  });
});

describe("productName", () => {
  it("prefers the reader's language and falls back to the other", async () => {
    const { productName } = await import("@/lib/catalog");
    expect(productName({ name_en: "Jeans", name_ar: "جينز" }, "ar")).toBe("جينز");
    expect(productName({ name_en: "Jeans", name_ar: null }, "ar")).toBe("Jeans");
    expect(productName({ name_en: null, name_ar: "جينز" }, "en")).toBe("جينز");
    expect(productName({ name_en: " ", name_ar: null }, "en")).toBe("");
  });
});
