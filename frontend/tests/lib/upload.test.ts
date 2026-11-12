import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiUpload } from "@/lib/api";

import { FakeXhr, imageFile, installFakeXhr, lastUpload } from "../helpers/stores";

beforeEach(installFakeXhr);
afterEach(() => vi.unstubAllGlobals());

describe("apiUpload", () => {
  it("sends the file as multipart field `file` with the CSRF header, with the cookie, and reports progress", async () => {
    const seen: number[] = [];
    const pending = apiUpload("/stores/st-b/logo", imageFile("logo.png"), { onProgress: (p) => seen.push(p) });
    const xhr = lastUpload();
    expect(xhr).toMatchObject({ method: "PUT", url: "/api/v1/stores/st-b/logo", withCredentials: true });
    expect(xhr.headers["X-BOS-CSRF"]).toBe("1");
    expect(xhr.headers["Content-Type"]).toBeUndefined(); // the browser adds the multipart boundary
    expect((xhr.form?.get("file") as File).name).toBe("logo.png");

    xhr.progress(5, 10);
    xhr.progress(10, 10);
    xhr.respond(200, { id: "st-b", has_logo: true });
    await expect(pending).resolves.toEqual({ id: "st-b", has_logo: true });
    expect(seen).toEqual([50, 100]);
  });

  it("rejects with the server's error code and fields on a refusal", async () => {
    const pending = apiUpload("/stores/st-b/logo", imageFile());
    lastUpload().respond(400, { error: { code: "file_too_large", message: "x" } });
    await expect(pending).rejects.toMatchObject({ status: 400, code: "file_too_large" });
  });

  it("is a network error when the request fails, and an unreadable 2xx is not a success", async () => {
    const lost = apiUpload("/stores/st-b/logo", imageFile());
    lastUpload().fail();
    await expect(lost).rejects.toMatchObject({ code: "network_error" });

    const odd = apiUpload("/stores/st-b/logo", imageFile());
    const xhr = lastUpload();
    xhr.status = 200;
    xhr.response = "<html>";
    xhr.onload?.();
    await expect(odd).rejects.toBeInstanceOf(ApiError);
    await expect(odd).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("aborts when the signal fires", async () => {
    const controller = new AbortController();
    const pending = apiUpload("/stores/st-b/logo", imageFile(), { signal: controller.signal });
    controller.abort();
    expect(FakeXhr.instances[0]?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
