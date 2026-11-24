import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProductPage from "@/app/[locale]/(shell)/more/catalog/[productId]/page";
import { MeContext } from "@/lib/session";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { BUSINESS_SETTINGS, JEANS, catalogOwner, catalogStaff } from "../helpers/catalog";
import { apiError, reply } from "../helpers/fetch";
import { renderMe } from "../helpers/shell";

const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));
vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

afterEach(() => vi.unstubAllGlobals());

const owner = catalogOwner();
const arabicOwner = catalogOwner({ user: { ...owner.user, locale: "ar" } });
const productPath = "/api/v1/catalog/products/p-jeans";

function setup(me = owner, productReply = () => reply(200, JEANS), token = "valid_session") {
  cookies.mockResolvedValue({ get: (name: string) => name === "bos_session" && token ? { value: token } : undefined });
  const fetch = vi.fn(async (url: string) => url.endsWith("/me") ? reply(200, me) : productReply());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function open(locale = "en", saved?: string) {
  return ProductPage({ params: Promise.resolve({ locale, productId: JEANS.id }), searchParams: Promise.resolve({ saved }) });
}

describe("server-first product detail", () => {
  it("puts the variant SKU and Arabic name in the initial HTML", async () => {
    const serverFetch = setup(arabicOwner);
    const element = await open("ar");
    expect(serverFetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/me", productPath]);
    expect(serverFetch).toHaveBeenLastCalledWith(expect.stringContaining(productPath), expect.objectContaining({
      cache: "no-store", redirect: "manual", method: "GET", headers: { Accept: "application/json", Cookie: "bos_session=valid_session" },
    }));
    const html = renderToString(<NextIntlClientProvider locale="ar" messages={ar}><MeContext.Provider value={arabicOwner}>{element}</MeContext.Provider></NextIntlClientProvider>);
    expect(html).toContain(JEANS.name_ar);
    expect(html).toContain("JN-SLIM-32-BLUE");
  });

  it("mounts the seed with the saved notice without another product GET", async () => {
    setup();
    const element = await open("en", "created");
    const clientFetch = vi.fn(async () => reply(200, BUSINESS_SETTINGS));
    vi.stubGlobal("fetch", clientFetch);
    renderMe(element, owner);
    expect(screen.getByText("Saved. 3 variants and 5 units of opening stock.")).toBeInTheDocument();
    await screen.findByText(/approximate, at/);
    expect(clientFetch).toHaveBeenCalledExactlyOnceWith("/api/v1/business", expect.anything());
  });

  it.each([
    ["no session", owner, "", 0],
    ["wrong language", arabicOwner, "valid_session", 1],
    ["missing permission", catalogOwner({ permissions: [] }), "valid_session", 1],
    ["unusable store scope", catalogOwner({ stores: [{ ...owner.stores[0]!, id: "" }] }), "valid_session", 1],
  ])("does not ask for product data with %s", async (_name, me, token, count) => {
    const fetch = setup(me, undefined, token);
    await open();
    expect(fetch).toHaveBeenCalledTimes(count);
    if (count) expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/me$/), expect.anything());
  });

  it("does not show a seed from a different catalog scope", async () => {
    setup();
    const element = await open();
    const fetch = vi.fn(() => apiError(404, "not_found"));
    vi.stubGlobal("fetch", fetch);
    renderMe(element, catalogStaff());
    expect(screen.queryByText("JN-SLIM-32-BLUE")).not.toBeInTheDocument();
    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(productPath, expect.anything());
  });

  it("discards malformed product data and runs the original browser fallback again on refresh", async () => {
    setup(owner, () => reply(200, { ...JEANS, variants: null }));
    const first = await open();
    const refreshed = await open();
    const refreshedName = "Fresh product after browser fallback";
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url: string) => url === productPath
      ? reply(200, ++reads === 1 ? JEANS : { ...JEANS, name_en: refreshedName })
      : reply(200, BUSINESS_SETTINGS)));
    const wrap = (element: Awaited<ReturnType<typeof open>>) => (
      <NextIntlClientProvider locale="en" messages={en}><MeContext.Provider value={owner}>{element}</MeContext.Provider></NextIntlClientProvider>
    );
    const { rerender } = render(wrap(first));
    await screen.findByRole("heading", { name: JEANS.name_en! });
    rerender(wrap(refreshed));
    expect(screen.queryByRole("heading", { name: JEANS.name_en! })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: refreshedName })).toBeInTheDocument();
    expect(reads).toBe(2);
  });
});
