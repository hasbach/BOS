import { fireEvent, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import StockHistoryPage from "@/app/[locale]/(shell)/more/catalog/[productId]/variants/[variantId]/history/page";
import { MeContext } from "@/lib/session";
import type { Movement } from "@/lib/stock";

import ar from "../../messages/ar.json";
import { JEANS, catalogOwner, catalogStaff } from "../helpers/catalog";
import { apiError, reply } from "../helpers/fetch";
import { renderMe } from "../helpers/shell";

const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));
vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const owner = catalogOwner();
const arabicOwner = catalogOwner({ user: { ...owner.user, locale: "ar" } });
const productPath = "/api/v1/catalog/products/p-jeans";
const movementPath = "/api/v1/catalog/variants/v-32/movements";
const opening: Movement = {
  id: "opening", reason: "opening", actor_type: "user", actor_name: "Demo Owner", note: null,
  source: "product_form", quantity: 2, counted_quantity: null, on_hand_after: 2, at: "2026-11-10T07:30:00Z",
};
const firstPage = { items: [opening], next_cursor: "next" };

function setup(me = owner, products: () => Response | Promise<Response> = () => reply(200, JEANS), movements: () => Response | Promise<Response> = () => reply(200, firstPage)) {
  cookies.mockResolvedValue({ get: (name: string) => name === "bos_session" ? { value: "valid_session" } : undefined });
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/me") return reply(200, me);
    if (path === productPath) return products();
    if (path === movementPath) return movements();
    return reply(404);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function open(locale = "en", variantId = "v-32") {
  return StockHistoryPage({ params: Promise.resolve({ locale, productId: JEANS.id, variantId }) });
}

describe("server-first stock history", () => {
  it("starts both authenticated reads before either response and renders the movement in Arabic HTML", async () => {
    let releaseProduct!: (response: Response) => void;
    let releaseMovements!: (response: Response) => void;
    const fetch = setup(arabicOwner, () => new Promise((resolve) => { releaseProduct = resolve; }), () => new Promise((resolve) => { releaseMovements = resolve; }));
    const element = open("ar");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/me", productPath, movementPath]);
    for (const path of [productPath, movementPath]) {
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining(path), expect.objectContaining({
        cache: "no-store", redirect: "manual", method: "GET", headers: { Accept: "application/json", Cookie: "bos_session=valid_session" },
      }));
    }
    releaseProduct(reply(200, JEANS));
    releaseMovements(reply(200, firstPage));
    const html = renderToString(<NextIntlClientProvider locale="ar" messages={ar}><MeContext.Provider value={arabicOwner}>{await element}</MeContext.Provider></NextIntlClientProvider>);
    expect(html).toContain(ar.catalog.reasons.opening);
    expect(html).toContain("JN-SLIM-32-BLUE");
  });

  it("loads only the next cursor from the browser when the first page is seeded", async () => {
    setup();
    const element = await open();
    const next = { ...opening, id: "received", reason: "received" };
    const clientFetch = vi.fn(async (url: string) => url === productPath ? reply(200, JEANS) : reply(200, { items: [next], next_cursor: null }));
    vi.stubGlobal("fetch", clientFetch);
    renderMe(element, owner);
    expect(screen.getByText("Opening stock")).toBeInTheDocument();
    expect(clientFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Received")).toBeInTheDocument();
    expect(clientFetch).toHaveBeenCalledExactlyOnceWith(`${movementPath}?cursor=next`, expect.anything());
  });

  it.each([
    ["missing stock permission", catalogStaff()],
    ["missing catalog permission", catalogOwner({ permissions: ["stock.adjust"] })],
    ["language mismatch", arabicOwner],
  ])("does not ask for history data with %s", async (_name, me) => {
    const fetch = setup(me);
    await open();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\/me$/), expect.anything());
  });

  it.each([
    ["forbidden", () => apiError(403, "forbidden"), "You can’t open stock history"],
    ["not found", () => apiError(404, "not_found"), "Not found"],
    ["session ended", () => apiError(401, "unauthenticated"), "Your session has ended"],
  ])("delegates a %s response to the browser error path", async (_name, refusal, message) => {
    setup(owner, undefined, refusal);
    const element = await open();
    const clientFetch = vi.fn(async (url: string) => url === productPath ? reply(200, JEANS) : refusal());
    vi.stubGlobal("fetch", clientFetch);
    renderMe(element, owner);
    expect(await screen.findByText(message, { exact: false })).toBeInTheDocument();
    expect(clientFetch.mock.calls.map(([url]) => url)).toEqual([productPath, movementPath]);
  });

  it("does not seed movements for a variant outside the product", async () => {
    const otherProduct = { ...JEANS, variants: JEANS.variants.filter((variant) => variant.id !== "v-32") };
    setup(owner, () => reply(200, otherProduct));
    const element = await open();
    const clientFetch = vi.fn((url: string) => url === productPath ? reply(200, otherProduct) : reply(200, firstPage));
    vi.stubGlobal("fetch", clientFetch);
    renderMe(element, owner);
    expect(screen.queryByText("Opening stock")).not.toBeInTheDocument();
    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(clientFetch.mock.calls.map(([url]) => url)).toEqual([productPath, movementPath]);
  });

  it("keeps the seeded date group stable across Beirut midnight until the next read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T21:59:59Z"));
    setup();
    const element = await open();
    vi.setSystemTime(new Date("2026-11-10T22:00:01Z"));
    vi.stubGlobal("fetch", vi.fn(() => reply(200, { items: [], next_cursor: null })));
    renderMe(element, owner);
    expect(screen.getByRole("region", { name: /^Today/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("region", { name: /^Yesterday/ })).toBeInTheDocument();
  });
});
