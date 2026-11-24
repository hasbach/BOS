import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { startTransition, useLayoutEffect } from "react";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import LowStockPage from "@/app/[locale]/(shell)/more/catalog/low-stock/page";
import SalesPage from "@/app/[locale]/(shell)/sales/page";
import { MeContext } from "@/lib/session";
import * as stock from "@/lib/stock";
import type { LowStockItem, LowStockPage as StockPage } from "@/lib/stock";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { catalogApi, catalogOwner, catalogStaff, queryOf } from "../helpers/catalog";
import { apiError, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";

const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));
vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const path = "/api/v1/catalog/low-stock";
const owner = catalogOwner();
const arabicOwner = catalogOwner({ user: { ...owner.user, locale: "ar" } });
const jeans: LowStockItem = {
  product_id: "p-jeans", product_name_en: "Blue jeans", product_name_ar: "جينز أزرق",
  variant_id: "v-jeans", sku: "BLUE-SKU", option_values: ["32"], main_photo_id: null,
  on_hand: 0, available: 0, allocated: 0, level: 2, stock_state: "out",
};
const shirt = { ...jeans, variant_id: "v-shirt", product_name_en: "White shirt", product_name_ar: "قميص أبيض", sku: "WHITE-SKU" };
const firstPage = { items: [jeans], next_cursor: "next", total: 21 };

function setup(me = owner, low = () => reply(200, firstPage), token = "valid_session") {
  cookies.mockResolvedValue({ get: (name: string) => ({ value: name === "bos_session" ? token : "not_forwarded" }) });
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    const location = new URL(url);
    if (location.pathname === "/api/v1/me") return reply(200, me);
    if (location.pathname === path) return low();
    return reply(404);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const open = (locale = "en") => LowStockPage({ params: Promise.resolve({ locale }) });

const sales = (locale = "en") => SalesPage({ params: Promise.resolve({ locale }) });
const lowQueries = (calls: ReturnType<typeof catalogApi>) => calls.filter((call) => call.url.startsWith(path)).map(queryOf);
const loading = () => expect(screen.getByText("Loading low stock…")).toHaveAttribute("role", "status");

function ObserveCommit({ onCommit }: { onCommit?: () => void }) {
  useLayoutEffect(() => { onCommit?.(); }, [onCommit]);
  return null;
}

function mountedPage(element: ReactElement, onCommit?: () => void, me = owner) {
  return <NextIntlClientProvider locale="en" messages={en}>
    <MeContext.Provider value={me}>{element}<ObserveCommit onCommit={onCommit} /></MeContext.Provider>
  </NextIntlClientProvider>;
}

beforeEach(() => resetNavigation("/more/catalog/low-stock"));

it("renders the authenticated first page in Arabic HTML without repeating the GET on mount", async () => {
  const serverFetch = setup(arabicOwner);
  const element = await open("ar");
  const html = renderToString(<NextIntlClientProvider locale="ar" messages={ar}><MeContext.Provider value={arabicOwner}>{element}</MeContext.Provider></NextIntlClientProvider>);
  expect(html).toContain("جينز أزرق");
  expect(html).toContain("BLUE-SKU");
  expect(serverFetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/me", path]);
  expect(serverFetch).toHaveBeenCalledWith(expect.stringMatching(/\/catalog\/low-stock$/), expect.objectContaining({
    method: "GET", cache: "no-store", redirect: "manual", headers: { Accept: "application/json", Cookie: "bos_session=valid_session" },
  }));
  const calls = catalogApi(() => reply(200, { items: [], next_cursor: null, total: 0 }));
  renderMe(element, arabicOwner, "ar");
  expect(screen.getByText("جينز أزرق")).toBeInTheDocument();
  expect(calls.filter((call) => call.url.startsWith(path))).toHaveLength(0);
});

it("paginates directly from the seeded cursor and fetches fresh rows for a store change and return", async () => {
  setup();
  const element = await open();
  const calls = catalogApi(() => reply(200, { items: [shirt], next_cursor: null, total: 1 }));
  renderMe(element, owner);
  expect(screen.getByText("21 variants")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("White shirt")).toBeInTheDocument();
  expect(screen.getByText("21 variants")).toBeInTheDocument();
  expect(screen.getByText("Blue jeans")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /All stores/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Store" })).getByRole("radio", { name: "Store B" }));
  await screen.findByText("1 variant");
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Store B/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Store" })).getByRole("radio", { name: "All stores" }));
  await screen.findByText("White shirt");
  expect(calls.filter((call) => call.url.startsWith(path)).map(queryOf)).toEqual([{ cursor: "next" }, { store_id: "st-b" }, {}]);
});

it("keeps the mounted store on refresh and replaces its page while old pagination is pending", async () => {
  setup();
  const before = await open();
  setup(owner, () => reply(200, { ...firstPage, total: 99 }));
  const after = await open();
  const stale = Promise.withResolvers<Response>();
  const fresh = Promise.withResolvers<Response>();
  let storeReads = 0;
  const calls = catalogApi((call) => {
    const { cursor } = queryOf(call);
    if (cursor === "old-store") return stale.promise;
    if (cursor === "fresh-store") return reply(200, { items: [jeans], next_cursor: null });
    return ++storeReads === 1 ? reply(200, { ...firstPage, next_cursor: "old-store", total: 22 }) : fresh.promise;
  });
  const view = render(mountedPage(before));
  fireEvent.click(screen.getByRole("button", { name: "All stores" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Store" })).getByRole("radio", { name: "Store B" }));
  expect(await screen.findByText("22 variants")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  const fetch = vi.mocked(globalThis.fetch);
  const signal = fetch.mock.calls.find(([url]) => String(url).includes("cursor=old-store"))?.[1]?.signal;
  expect(signal?.aborted).toBe(false);

  let abortedAtCommit: boolean | undefined;
  view.rerender(mountedPage(after, () => { abortedAtCommit = signal?.aborted; }));
  expect(screen.getByRole("button", { name: "Store B" })).toBeInTheDocument();
  expect(abortedAtCommit).toBe(true);
  loading();
  expect(screen.queryByText("22 variants")).not.toBeInTheDocument();
  expect(screen.queryByText("99 variants")).not.toBeInTheDocument();
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();

  await act(async () => fresh.resolve(reply(200, { items: [shirt], next_cursor: "fresh-store", total: 23 })));
  await act(async () => stale.resolve(reply(200, { ...firstPage, next_cursor: "stale-store" })));
  expect(screen.getByText("White shirt")).toBeInTheDocument();
  expect(screen.getByText("23 variants")).toBeInTheDocument();
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Blue jeans")).toBeInTheDocument();
  expect(screen.getByText("23 variants")).toBeInTheDocument();
  expect(lowQueries(calls)).toEqual([
    { store_id: "st-b" }, { store_id: "st-b", cursor: "old-store" },
    { store_id: "st-b" }, { store_id: "st-b", cursor: "fresh-store" },
  ]);
});

const withStoreC = { ...owner, stores: [...owner.stores, { ...owner.stores[0]!, id: "st-c", name: "Store C" }] };

function selectStoreB() {
  fireEvent.click(screen.getByRole("button", { name: "All stores" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Store" })).getByRole("radio", { name: "Store B" }));
}

it.each([
  { change: "added with a fresh route seed", beforeMe: owner, afterMe: withStoreC, refreshSeed: true },
  { change: "removed with no route seed change", beforeMe: withStoreC, afterMe: owner, refreshSeed: false },
])("keeps Store B selected when an unrelated session store is $change", async ({ beforeMe, afterMe, refreshSeed }) => {
  setup(beforeMe);
  const before = await open();
  let after = before;
  if (refreshSeed) {
    setup(afterMe, () => reply(200, { ...firstPage, total: 99 }));
    after = await open();
  }
  const stale = Promise.withResolvers<Response>();
  const fresh = Promise.withResolvers<Response>();
  let reads = 0;
  const calls = catalogApi((call) => {
    if (queryOf(call).cursor === "next") return stale.promise;
    return ++reads === 1 ? reply(200, firstPage) : fresh.promise;
  });
  const view = render(mountedPage(before, undefined, beforeMe));
  selectStoreB();
  expect(await screen.findByText("21 variants")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  const signal = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url).includes("cursor=next"))?.[1]?.signal;
  expect(signal?.aborted).toBe(false);

  let abortedAtCommit: boolean | undefined;
  view.rerender(mountedPage(after, () => { abortedAtCommit = signal?.aborted; }, afterMe));
  expect(screen.getByRole("button", { name: "Store B" })).toBeInTheDocument();
  expect(abortedAtCommit).toBe(true);
  loading();
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  expect(screen.queryByText("99 variants")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  expect(lowQueries(calls)).toEqual([{ store_id: "st-b" }, { store_id: "st-b", cursor: "next" }, { store_id: "st-b" }]);

  await act(async () => fresh.resolve(reply(200, { items: [shirt], next_cursor: null, total: 1 })));
  await act(async () => stale.resolve(reply(200, firstPage)));
  expect(screen.getByText("White shirt")).toBeInTheDocument();
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
});

it("can return to All stores when the selected store is the only one left", async () => {
  setup();
  const element = await open();
  const onlyStoreB = { ...owner, stores: owner.stores.filter(({ id }) => id === "st-b") };
  const calls = catalogApi((call) => reply(200, queryOf(call).store_id ? firstPage : { items: [shirt], next_cursor: null }));
  const view = render(mountedPage(element));
  selectStoreB();
  await screen.findByText("Blue jeans");

  view.rerender(mountedPage(element, undefined, onlyStoreB));
  fireEvent.click(screen.getByRole("button", { name: "Store B" }));
  const dialog = within(screen.getByRole("dialog", { name: "Store" }));
  expect(dialog.getByRole("radio", { name: "Store B", checked: true })).toBeInTheDocument();
  fireEvent.click(dialog.getByRole("radio", { name: "All stores" }));

  expect(await screen.findByText("White shirt")).toBeInTheDocument();
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "All stores" })).not.toBeInTheDocument();
  expect(lowQueries(calls)).toEqual([{ store_id: "st-b" }, { store_id: "st-b" }, {}]);
});

it("drops an unavailable selection and does not restore it when the store returns", async () => {
  setup(withStoreC);
  const element = await open();
  const withoutStoreB = { ...withStoreC, stores: withStoreC.stores.filter(({ id }) => id !== "st-b") };
  const calls = catalogApi((call) => reply(200, queryOf(call).store_id ? firstPage : { items: [shirt], next_cursor: null }));
  const view = render(mountedPage(element, undefined, withStoreC));
  selectStoreB();
  expect(await screen.findByText("21 variants")).toBeInTheDocument();

  view.rerender(mountedPage(element, undefined, withoutStoreB));
  expect(screen.getByRole("button", { name: "All stores" })).toBeInTheDocument();
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  await screen.findByText("White shirt");

  view.rerender(mountedPage(element, undefined, withStoreC));
  expect(screen.getByRole("button", { name: "All stores" })).toBeInTheDocument();
  await screen.findByText("White shirt");
  expect(lowQueries(calls)).toEqual([{ store_id: "st-b" }, {}, {}]);
});

it.each([
  { change: "tenant", nextMe: { ...owner, business: { ...owner.business, id: "other-business" } } },
  { change: "identity", nextMe: { ...owner, user: { ...owner.user, id: "other-user" } } },
])("discards the selected store and its rows on a mounted $change change", async ({ nextMe }) => {
  setup();
  const element = await open();
  const fresh = Promise.withResolvers<Response>();
  let reads = 0;
  const calls = catalogApi(() => ++reads === 1 ? reply(200, firstPage) : fresh.promise);
  const view = render(mountedPage(element));
  selectStoreB();
  expect(await screen.findByText("21 variants")).toBeInTheDocument();

  view.rerender(mountedPage(element, undefined, nextMe));
  expect(screen.getByRole("button", { name: "All stores" })).toBeInTheDocument();
  loading();
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  expect(screen.queryByText("21 variants")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  expect(lowQueries(calls)).toEqual([{ store_id: "st-b" }, {}]);

  await act(async () => fresh.resolve(reply(200, { items: [shirt], next_cursor: null })));
  expect(screen.getByText("White shirt")).toBeInTheDocument();
});

it("invalidates an in-flight first page at a mismatched seed commit and retries the fallback", async () => {
  setup(owner, () => reply(500));
  const before = await open();
  setup({ ...owner, all_stores: false, stores: owner.stores.slice(1) });
  const mismatch = await open();
  const stale = Promise.withResolvers<Response>();
  let reads = 0;
  const calls = catalogApi(() => {
    if (++reads === 1) return stale.promise;
    if (reads === 2) return reply(500);
    return reply(200, { items: [shirt], next_cursor: null, total: 3 });
  });
  const view = render(mountedPage(before));
  loading();
  const fetch = vi.mocked(globalThis.fetch);
  const signal = fetch.mock.calls.find(([url]) => String(url).startsWith(path))?.[1]?.signal;
  expect(signal?.aborted).toBe(false);

  let abortedAtCommit: boolean | undefined;
  view.rerender(mountedPage(mismatch, () => {
    abortedAtCommit = signal?.aborted;
    stale.resolve(reply(200, firstPage));
  }));
  expect(abortedAtCommit).toBe(true);
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load low stock");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("White shirt")).toBeInTheDocument();
  expect(screen.getByText("3 variants")).toBeInTheDocument();
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  expect(lowQueries(calls)).toEqual([{}, {}, {}]);
});

it.each(["first page", "pagination"] as const)("rejects a queued %s result after a newer view commits", async (source) => {
  const paginating = source === "pagination";
  const freshPage = { items: [shirt], next_cursor: null, total: 3 };
  setup(owner, () => paginating ? reply(200, firstPage) : reply(500));
  const before = await open();
  setup(owner, () => paginating ? reply(200, freshPage) : reply(500));
  const after = await open();
  const deliver = Promise.withResolvers<(result: StockPage) => void>();
  const request = vi.spyOn(stock, "listLowStock").mockReturnValueOnce({
    then(onSuccess) {
      // Queue the real response handler below the priority of the refresh commit.
      deliver.resolve((result) => startTransition(() => { onSuccess?.(result); }));
      return new Promise(() => {});
    },
  } as Promise<StockPage>);
  const fresh = Promise.withResolvers<Response>();
  const calls = catalogApi(() => fresh.promise);
  const view = render(mountedPage(before));
  if (paginating) fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  const respond = await deliver.promise;
  const signal = request.mock.calls[0]?.[1];

  await act(async () => {
    expect(signal?.aborted).toBe(false);
    respond({ items: [jeans], next_cursor: "stale", total: 99 });
    flushSync(() => view.rerender(mountedPage(after)));
    if (paginating) expect(screen.getByText("White shirt")).toBeInTheDocument();
    else loading();
  });
  expect(screen.queryByText("99 variants")).not.toBeInTheDocument();
  expect(screen.queryByText("21 variants")).not.toBeInTheDocument();
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  if (!paginating) {
    loading();
    await act(async () => fresh.resolve(reply(200, freshPage)));
  }
  expect(screen.getByText("White shirt")).toBeInTheDocument();
  expect(screen.getByText("3 variants")).toBeInTheDocument();
  expect(lowQueries(calls)).toEqual(paginating ? [] : [{}]);
});

it("does not load or expose low stock to a session without stock.adjust on either route", async () => {
  const fetch = setup(catalogStaff());
  await open();
  await sales();
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/me", "/api/v1/me"]);
});

it("does not reuse an earlier session's low-stock result on a separate request", async () => {
  setup();
  await open();
  const otherOwner = { ...owner, business: { ...owner.business, id: "other-business" } };
  const fetch = setup(otherOwner, () => reply(200, { items: [shirt], next_cursor: null, total: 1 }), "different_session");
  const element = await open();
  expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/catalog\/low-stock$/), expect.objectContaining({
    cache: "no-store", headers: { Accept: "application/json", Cookie: "bos_session=different_session" },
  }));
  catalogApi(() => reply(500));
  renderMe(element, otherOwner);
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  expect(screen.getByText("White shirt")).toBeInTheDocument();
});

it("retries via the existing client path when a server response is unusable", async () => {
  setup(owner, () => reply(200, { ...firstPage, items: [{ ...jeans, option_values: null }] }));
  const element = await open();
  let refused = true;
  const calls = catalogApi(() => refused ? apiError(500, "internal_error") : reply(200, firstPage));
  renderMe(element, owner);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load low stock");
  refused = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Blue jeans")).toBeInTheDocument();
  expect(calls.filter((call) => call.url.startsWith(path))).toHaveLength(2);
});

it("ignores an otherwise valid list seed when the mounted store scope differs", async () => {
  setup();
  const element = await open();
  const restricted = { ...owner, all_stores: false, stores: owner.stores.slice(1) };
  const calls = catalogApi(() => reply(200, { items: [shirt], next_cursor: null, total: 1 }));
  renderMe(element, restricted);
  expect(screen.queryByText("Blue jeans")).not.toBeInTheDocument();
  expect(await screen.findByText("White shirt")).toBeInTheDocument();
  expect(calls.filter((call) => call.url.startsWith(path)).map(queryOf)).toEqual([{}]);
});

it("renders the localized Sales shortcut on the server and sends only count and the first two labels", async () => {
  const fetch = setup(arabicOwner, () => reply(200, { items: [jeans, shirt, { ...jeans, product_name_ar: "Hidden third item" }], next_cursor: "next", total: 5 }));
  const element = await sales("ar");
  const html = renderToString(<NextIntlClientProvider locale="ar" messages={ar}><MeContext.Provider value={arabicOwner}>{element}</MeContext.Provider></NextIntlClientProvider>);
  expect(html).toContain("جينز أزرق");
  expect(html).toContain("قميص أبيض");
  expect(element.props.top.props.seed.value.data).toEqual({ total: 5, first: ["جينز أزرق 32", "قميص أبيض 32"] });
  expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/catalog\/low-stock$/), expect.objectContaining({ cache: "no-store" }));
  const calls = catalogApi(() => reply(200, firstPage));
  renderMe(element, arabicOwner, "ar");
  expect(screen.getByRole("link", { name: /5 متغيّرات مخزونها منخفض أو نافد/ })).toHaveTextContent("جينز أزرق 32، قميص أبيض 32");
  expect(calls).toHaveLength(0);
});

it("does not fetch a shortcut for a session that cannot open the Sales tab", async () => {
  const fetch = setup({ ...owner, tabs: ["more"] });
  await sales();
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/me"]);
});

it("does not retry a successful empty shortcut from the browser", async () => {
  setup(owner, () => reply(200, { items: [], next_cursor: null, total: 0 }));
  const element = await sales();
  const calls = catalogApi(() => reply(200, firstPage));
  renderMe(element, owner);
  expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
  expect(screen.getByText("Coming soon")).toBeInTheDocument();
  expect(calls).toHaveLength(0);
});

it("silently falls back to the browser shortcut after an unsuccessful server read", async () => {
  const serverFetch = setup(owner, () => apiError(500, "internal_error"));
  const element = await sales();
  expect(serverFetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/me", path]);
  const calls = catalogApi(() => reply(200, firstPage));
  renderMe(element, owner);
  expect(await screen.findByRole("link", { name: /21 variants low or out of stock/ })).toHaveTextContent("Blue jeans 32");
  expect(calls.filter((call) => call.url.startsWith(path)).map(queryOf)).toEqual([{}]);
});
