import { beforeEach, describe, expect, it, vi } from "vitest";

const setRequestLocale = vi.fn();

vi.mock("next-intl/server", () => ({
  setRequestLocale: (locale: string) => setRequestLocale(locale),
  getTranslations: async () => (key: string) => key,
  getRequestConfig: (config: unknown) => config,
}));
vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => setRequestLocale.mockClear());

const params = (locale: string) => ({ params: Promise.resolve({ locale }) });
const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/;

const PAGES: Array<[string, () => Promise<{ default: (props: ReturnType<typeof params>) => Promise<unknown> }>]> = [
  ["sign-in", () => import("@/app/[locale]/(auth)/sign-in/page")],
  ["activate", () => import("@/app/[locale]/(auth)/activate/page")],
  ["reset", () => import("@/app/[locale]/(auth)/reset/page")],
  ["home", () => import("@/app/[locale]/(shell)/page")],
  ["operator businesses", () => import("@/app/[locale]/ops/page")],
  ["operator sign-in", () => import("@/app/[locale]/ops/sign-in/page")],
  ["operator set up", () => import("@/app/[locale]/ops/new/page")],
];

describe.each(PAGES)("%s page", (_name, load) => {
  it("calls setRequestLocale with the locale of the address", async () => {
    const { default: Page } = await load();
    await Page(params("ar"));
    expect(setRequestLocale).toHaveBeenCalledWith("ar");
  });

  it("is not found for an unknown locale", async () => {
    const { default: Page } = await load();
    await expect(Page(params("fr"))).rejects.toThrow(NOT_FOUND);
  });
});

describe("shell layout", () => {
  it("calls setRequestLocale and rejects an unknown locale", async () => {
    const { default: Layout } = await import("@/app/[locale]/(shell)/layout");
    await Layout({ children: null, ...params("en") });
    expect(setRequestLocale).toHaveBeenCalledWith("en");
    await expect(Layout({ children: null, ...params("fr") })).rejects.toThrow(NOT_FOUND);
  });
});
