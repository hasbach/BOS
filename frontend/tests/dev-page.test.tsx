import { afterEach, describe, expect, it, vi } from "vitest";

import ComponentsPage from "@/app/[locale]/dev/components/page";

vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));

const params = (locale: string) => ({ params: Promise.resolve({ locale }) });

describe("dev components page", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is not found in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(ComponentsPage(params("en"))).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it("is not found for an unknown locale", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(ComponentsPage(params("fr"))).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it("renders outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(ComponentsPage(params("ar"))).resolves.toBeTruthy();
  });
});
