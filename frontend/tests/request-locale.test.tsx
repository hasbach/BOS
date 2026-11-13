import { beforeEach, describe, expect, it, vi } from "vitest";

import ar from "../messages/ar.json";
import en from "../messages/en.json";

const setRequestLocale = vi.fn();

vi.mock("next-intl/server", () => ({
  setRequestLocale: (locale: string) => setRequestLocale(locale),
  getTranslations: async () => (key: string) => key,
  // The real helper returns the config function unchanged.
  getRequestConfig: (config: unknown) => config,
}));
// The home page's server-side /me needs a request (cookies); here it "could not tell".
vi.mock("@/lib/serverSession", () => ({ getServerMe: async () => ({ k: "unknown" }) }));

beforeEach(() => {
  setRequestLocale.mockClear();
});

describe("message loading by URL locale", () => {
  type Config = (args: { requestLocale: Promise<string | undefined> }) => Promise<{ locale: string; messages: unknown }>;

  async function resolve(locale: string | undefined) {
    const { default: config } = (await import("@/i18n/request")) as unknown as { default: Config };
    return config({ requestLocale: Promise.resolve(locale) });
  }

  it("returns the Arabic messages for ar", async () => {
    const result = await resolve("ar");
    expect(result.locale).toBe("ar");
    expect(result.messages).toEqual(ar);
  });

  it("returns the English messages for en and for an unknown locale", async () => {
    expect((await resolve("en")).messages).toEqual(en);
    expect((await resolve("fr")).messages).toEqual(en);
  });
});

describe("the URL locale reaches the message loader", () => {
  const params = (locale: string) => ({ params: Promise.resolve({ locale }) });

  it("layout calls setRequestLocale with the param", async () => {
    const { default: LocaleLayout } = await import("@/app/[locale]/layout");
    await LocaleLayout({ children: null, ...params("ar") });
    expect(setRequestLocale).toHaveBeenCalledWith("ar");
  });

  it("home page calls setRequestLocale with the param", async () => {
    const { default: HomePage } = await import("@/app/[locale]/(shell)/page");
    await HomePage(params("ar"));
    expect(setRequestLocale).toHaveBeenCalledWith("ar");
  });

  it("dev page calls setRequestLocale with the param", async () => {
    const { default: DevPage } = await import("@/app/[locale]/dev/components/page");
    await DevPage(params("ar"));
    expect(setRequestLocale).toHaveBeenCalledWith("ar");
  });
});
