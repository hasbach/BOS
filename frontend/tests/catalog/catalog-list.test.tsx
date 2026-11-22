import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { startTransition, useLayoutEffect } from "react";
import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogList } from "@/app/[locale]/(shell)/more/catalog/CatalogList";
import * as catalogApi from "@/lib/catalog";
import type { ProductPage } from "@/lib/catalog";
import type { CatalogSeedPage } from "@/lib/serverSession";
import { MeContext } from "@/lib/session";

import en from "../../messages/en.json";
import { catalogOwner, catalogStaff, page, productCalls, queryOf, summary } from "../helpers/catalog";
import { apiError, mockApi, networkFailure, reply } from "../helpers/fetch";
import { resetNavigation } from "../helpers/navigation";
import { renderMe } from "../helpers/shell";
import { ar } from "../utils";

vi.mock("@/i18n/navigation", async () => (await import("../helpers/navigation")).navigationMock);

beforeEach(() => resetNavigation("/more/catalog"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const JEANS = summary({ id: "p-jeans" });
const TOTE = summary({
  id: "p-tote",
  code: "BG-TOTE",
  name_en: "Canvas tote bag",
  name_ar: null,
  main_photo_id: null,
  store_ids: ["st-a", "st-b"],
  variant_count: 1,
  available_total: 40,
  stock_state: "ok",
  prices: [{ currency: "LBP", min: "89500000", max: "89500000" }],
});
const WIDE = summary({ id: "p-wide", code: "JN-WIDE", name_en: "Wide-leg black jeans", store_ids: [], variant_count: 4, available_total: 0, stock_state: "out" });

const listed = () => screen.getByRole("list", { name: "Catalog" });
const seededPage = (id: string, page: ProductPage, filters: CatalogSeedPage["filters"] = {}) => ({ id, value: { filters, page } });

function ObserveCommit({ onCommit }: { onCommit?: () => void }) {
  useLayoutEffect(() => { onCommit?.(); }, [onCommit]);
  return null;
}

function renderMountedCatalog(props: ComponentProps<typeof CatalogList>) {
  const catalog = (next: ComponentProps<typeof CatalogList>, onCommit?: () => void, me = catalogOwner()) => (
    <MeContext.Provider value={me}><CatalogList {...next} /><ObserveCommit onCommit={onCommit} /></MeContext.Provider>
  );
  const view = render(catalog(props), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale="en" messages={en}>{children}</NextIntlClientProvider>
    ),
  });
  return (next: ComponentProps<typeof CatalogList>, onCommit?: () => void, me?: ReturnType<typeof catalogOwner>) =>
    view.rerender(catalog(next, onCommit, me));
}

describe("catalog list (screens 132 to 139)", () => {
  it("replaces the mounted first page, counts and cursor with a fresh server seed", async () => {
    const calls = mockApi(() => reply(200, page([WIDE], { counts: null })));
    const update = renderMountedCatalog({ initial: seededPage("before-refresh", page([JEANS], { next_cursor: "old" })) });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Wide-leg black jeans");

    update({ initial: seededPage("after-refresh", page([TOTE], { next_cursor: "fresh", counts: { all: 1, in_stock: 1, low: 0, out: 0 } })) });
    expect(screen.getByText("Canvas tote bag")).toBeInTheDocument();
    expect(screen.queryByText("Slim blue jeans")).not.toBeInTheDocument();
    expect(screen.queryByText("Wide-leg black jeans")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "All1" })).toBeInTheDocument();
    expect(productCalls(calls).map(queryOf)).toEqual([{ cursor: "old" }]);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Wide-leg black jeans")).toBeInTheDocument();
    expect(productCalls(calls).map(queryOf)).toEqual([{ cursor: "old" }, { cursor: "fresh" }]);
  });
  it("adopts no-photo URL changes in both directions using matching server seeds", () => {
    const calls = mockApi(() => reply(200, page([WIDE])));
    const update = renderMountedCatalog({ initial: seededPage("before-url-change", page([JEANS])) });

    update({ initialNoPhoto: true, initial: seededPage("url-no-photo", page([TOTE]), { no_photo: true }) });
    expect(screen.getByRole("button", { name: "No photo" })).toBeInTheDocument();
    expect(screen.getByText("Canvas tote bag")).toBeInTheDocument();
    expect(screen.queryByText("Slim blue jeans")).not.toBeInTheDocument();

    update({ initial: seededPage("url-all-photos", page([JEANS])) });
    expect(screen.getByRole("button", { name: "More filters" })).toBeInTheDocument();
    expect(screen.getByText("Slim blue jeans")).toBeInTheDocument();
    expect(screen.queryByText("Canvas tote bag")).not.toBeInTheDocument();
    expect(productCalls(calls)).toHaveLength(0);
  });

  it.each(["success", "failure"] as const)("invalidates a pending first-page %s at the fresh seed commit", async (outcome) => {
    const stale = Promise.withResolvers<Response>();
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => stale.promise);
    vi.stubGlobal("fetch", fetch);
    const update = renderMountedCatalog({ initial: { id: `first-page-pending-${outcome}`, value: null } });
    expect(screen.getByRole("status")).toHaveTextContent("Loading products…");
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0]?.[1].signal;
    expect(signal?.aborted).toBe(false);

    let abortedAtCommit: boolean | undefined;
    await act(async () => {
      update({ initial: seededPage(`first-page-replaced-${outcome}`, page([TOTE], {
        counts: { all: 1, in_stock: 1, low: 0, out: 0 },
      })) }, () => {
        // Resolve during the new view's layout phase, before passive cleanup can abort it.
        abortedAtCommit = signal?.aborted;
        stale.resolve(outcome === "success" ? reply(200, page([JEANS], { next_cursor: "stale-cursor" })) : apiError(500, "unexpected"));
      });
    });

    expect(abortedAtCommit).toBe(true);
    expect(screen.getByText("Canvas tote bag")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "All1" })).toBeInTheDocument();
    expect(screen.queryByText("Slim blue jeans")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"] as const)("discards a queued first-page %s when the same filters return in a new view", async (outcome) => {
    const deliver = Promise.withResolvers<(response: ProductPage | Error) => void>();
    vi.spyOn(catalogApi, "listProducts").mockReturnValueOnce({
      then(onSuccess, onError) {
        // Give the actual response handler transition priority so sync route changes
        // can commit before React renders the response, even with automatic batching.
        deliver.resolve((response) => startTransition(() => {
          if (response instanceof Error) onError?.(response);
          else onSuccess?.(response);
        }));
        return new Promise(() => {});
      },
    } as Promise<ProductPage>);
    const fresh = Promise.withResolvers<Response>();
    const calls = mockApi((call) => {
      const { cursor, no_photo } = queryOf(call);
      if (cursor || no_photo) return new Promise<Response>(() => {});
      return fresh.promise;
    });
    const update = renderMountedCatalog({});
    const respond = await deliver.promise;

    await act(async () => {
      respond(outcome === "success" ? page([WIDE], { next_cursor: "stale" }) : new Error("stale"));
      flushSync(() => update({ initialNoPhoto: true }));
      expect(productCalls(calls).map(queryOf)).toEqual([{ no_photo: "true" }]);
      flushSync(() => update({}));
      expect(screen.getByRole("status")).toHaveTextContent("Loading products…");
    });

    expect(productCalls(calls).map(queryOf)).toEqual([{ no_photo: "true" }, {}]);
    expect(screen.getByRole("status")).toHaveTextContent("Loading products…");
    expect(screen.queryByText("Wide-leg black jeans")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Stock" })).not.toBeInTheDocument();
    await act(async () => fresh.resolve(reply(200, page([TOTE], {
      next_cursor: "fresh",
      counts: { all: 1, in_stock: 1, low: 0, out: 0 },
    }))));
    expect(screen.getByText("Canvas tote bag")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "All1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(productCalls(calls).map(queryOf).at(-1)).toEqual({ cursor: "fresh" });
  });

  it("keeps active search and stock on refresh and when the no-photo URL changes without a seed", async () => {
    const calls = mockApi(() => reply(200, page([WIDE])));
    const update = renderMountedCatalog({ initial: seededPage("before-filtered-refresh", page([JEANS])) });
    fireEvent.click(screen.getByRole("radio", { name: /Out.*1/ }));
    await screen.findByText("Wide-leg black jeans");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "wide" } });
    await waitFor(() => expect(productCalls(calls).map(queryOf)).toEqual([{ stock: "out" }, { q: "wide", stock: "out" }]));
    await screen.findByText("Wide-leg black jeans");

    update({ initial: seededPage("filtered-refresh", page([TOTE])) });
    expect(screen.queryByText("Canvas tote bag")).not.toBeInTheDocument();
    expect(productCalls(calls).map(queryOf).at(-1)).toEqual({ q: "wide", stock: "out" });
    await screen.findByText("Wide-leg black jeans");

    update({});
    await screen.findByText("Wide-leg black jeans");
    update({ initialNoPhoto: true });
    expect(productCalls(calls).map(queryOf).at(-1)).toEqual({ q: "wide", stock: "out", no_photo: "true" });
    expect(screen.getByRole("searchbox")).toHaveValue("wide");
    expect(screen.getByRole("radio", { name: /Out.*1/ })).toHaveAttribute("aria-checked", "true");
    await screen.findByText("Wide-leg black jeans");
  });

  it("renders the server page without refetching, then paginates and searches on the client", async () => {
    const calls = mockApi((call) => reply(200, call.url.includes("cursor=") ? page([TOTE], { counts: null }) : page([WIDE])));
    renderMe(<CatalogList initial={seededPage("catalog-owner-page", page([JEANS], { next_cursor: "c-2" }))} />, catalogOwner());

    expect(screen.getByText("Slim blue jeans")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /All.*86/ })).toBeInTheDocument();
    expect(productCalls(calls)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Canvas tote bag")).toBeInTheDocument();
    expect(productCalls(calls).map(queryOf)).toEqual([{ cursor: "c-2" }]);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jn-٣٢" } });
    expect(await screen.findByText("Wide-leg black jeans")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(productCalls(calls).map(queryOf)).toEqual([{ cursor: "c-2" }, { q: "jn-32" }, {}]));
  });
  it("fetches fresh data when the router reuses an already displayed seed", async () => {
    const calls = mockApi(() => reply(200, page([TOTE])));
    const initial = seededPage("catalog-back-navigation", page([JEANS]));
    const first = renderMe(<CatalogList initial={initial} />, catalogOwner());
    expect(screen.getByText("Slim blue jeans")).toBeInTheDocument();
    first.unmount();

    renderMe(<CatalogList initial={initial} />, catalogOwner());
    expect(screen.queryByText("Slim blue jeans")).not.toBeInTheDocument();
    expect(await screen.findByText("Canvas tote bag")).toBeInTheDocument();
    expect(productCalls(calls).map(queryOf)).toEqual([{}]);
  });

  it("shows each product with its photo, variant count, price, available total, stores and stock words", async () => {
    mockApi(() => reply(200, page([JEANS, TOTE, WIDE])));
    renderMe(<CatalogList />, catalogOwner());
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(3);

    const jeans = within(rows[0]!);
    expect(jeans.getByRole("link")).toHaveAttribute("href", "/more/catalog/p-jeans");
    expect(jeans.getByText("Slim blue jeans")).toBeInTheDocument();
    expect(jeans.getByText(/6 variants/)).toBeInTheDocument();
    expect(jeans.getByText("$45.00")).toBeInTheDocument();
    expect(jeans.getByText("16 available")).toBeInTheDocument();
    expect(jeans.getByText("Store A")).toBeInTheDocument();
    expect(jeans.getByText("Low")).toBeInTheDocument();
    expect(jeans.getByRole("img")).toHaveAttribute("src", "/api/v1/catalog/photos/ph-1/thumb");

    const tote = within(rows[1]!);
    expect(tote.getByText("LBP 89,500,000")).toBeInTheDocument();
    expect(tote.getByText("No photo")).toBeInTheDocument(); // the chip only owners and managers see
    expect(tote.getByText("Store B")).toBeInTheDocument();

    const wide = within(rows[2]!);
    expect(wide.getByText("Out")).toBeInTheDocument();
    expect(wide.getByText("No store")).toBeInTheDocument();
    expect(listed()).toBeInTheDocument();
  });

  it("shows the product name in the reader's language, or the other one when it is empty", async () => {
    mockApi(() => reply(200, page([JEANS, TOTE])));
    renderMe(<CatalogList />, catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }), "ar");
    expect(await screen.findByText("جينز أزرق ضيّق")).toBeInTheDocument();
    expect(screen.getByText("Canvas tote bag")).toBeInTheDocument();
    expect(screen.getByText("89,500,000 ل.ل.")).toBeInTheDocument();
  });

  it("searches by what was typed, with Arabic-Indic digits turned into 0-9", async () => {
    const calls = mockApi(() => reply(200, page([JEANS])));
    renderMe(<CatalogList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search name, code or SKU" }), { target: { value: "jn-٣٢" } });
    await waitFor(() => expect(productCalls(calls).length).toBe(2));
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ q: "jn-32" });

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(productCalls(calls).length).toBe(3));
    expect(queryOf(productCalls(calls)[2]!)).toEqual({});
  });

  it("offers a stock switch with the counts of the first page, as radios with arrow keys", async () => {
    const calls = mockApi(() => reply(200, page([JEANS])));
    renderMe(<CatalogList />, catalogOwner());
    const group = await screen.findByRole("radiogroup", { name: "Stock" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["All86", "In stock85", "Low3", "Out1"]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1]);

    fireEvent.click(radios[2]!);
    await waitFor(() => expect(productCalls(calls).length).toBe(2));
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ stock: "low" });
    expect(within(screen.getByRole("radiogroup", { name: "Stock" })).getAllByRole("radio")[2]).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(within(screen.getByRole("radiogroup", { name: "Stock" })).getAllByRole("radio")[2]!, { key: "ArrowRight" });
    await waitFor(() => expect(productCalls(calls).length).toBe(3));
    expect(queryOf(productCalls(calls)[2]!)).toEqual({ stock: "out" });
  });

  it("lists only the person's current stores (the fresh me.stores) in the store menu", async () => {
    const calls = mockApi(() => reply(200, page([JEANS])));
    const me = catalogOwner({
      stores: [
        { id: "st-a", name: "Store A", whatsapp_number: null, has_logo: false, status: "active" },
        { id: "st-n", name: "New Store", whatsapp_number: null, has_logo: false, status: "active" },
      ],
    });
    renderMe(<CatalogList />, me);
    await screen.findByText("Slim blue jeans");
    fireEvent.click(screen.getByRole("button", { name: /All stores/ }));
    const dialog = screen.getByRole("dialog", { name: "Store" });
    expect(within(dialog).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["All stores", "Store A", "New Store"]);
    fireEvent.click(within(dialog).getByRole("radio", { name: "New Store" }));
    await waitFor(() => expect(productCalls(calls).length).toBe(2));
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ store_id: "st-n" });
    expect(screen.getByRole("button", { name: /New Store/ })).toBeInTheDocument();
  });

  it("keeps the fetched results when the selected stock radio is clicked again", async () => {
    const calls = mockApi(() => reply(200, page([WIDE])));
    renderMe(<CatalogList initial={seededPage("reselect-stock", page([JEANS]))} />, catalogOwner());
    const out = () => screen.getByRole("radio", { name: /Out.*1/ });
    fireEvent.click(out());
    await screen.findByText("Wide-leg black jeans");

    fireEvent.click(out());
    expect(screen.queryByText("Loading products…")).not.toBeInTheDocument();
    expect(screen.getByText("Wide-leg black jeans")).toBeInTheDocument();
    expect(productCalls(calls).map(queryOf)).toEqual([{ stock: "out" }]);
  });

  it("closes the store sheet without reloading when the selected store is picked again", async () => {
    const calls = mockApi(() => reply(200, page([TOTE])));
    renderMe(<CatalogList initial={seededPage("reselect-store", page([JEANS]))} />, catalogOwner());
    const pickStoreA = () => fireEvent.click(within(screen.getByRole("dialog", { name: "Store" })).getByRole("radio", { name: "Store A" }));
    fireEvent.click(screen.getByRole("button", { name: "All stores" }));
    pickStoreA();
    await screen.findByText("Canvas tote bag");

    fireEvent.click(screen.getByRole("button", { name: "Store A" }));
    pickStoreA();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading products…")).not.toBeInTheDocument();
    expect(screen.getByText("Canvas tote bag")).toBeInTheDocument();
    expect(productCalls(calls).map(queryOf)).toEqual([{ store_id: "st-a" }]);
  });

  it("gives owners and managers archived and no-photo filters in More filters, with Clear", async () => {
    const calls = mockApi(() => reply(200, page([JEANS])));
    renderMe(<CatalogList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    const dialog = screen.getByRole("dialog", { name: "More filters" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archived products" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Only products without a photo/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Show results" }));
    await waitFor(() => expect(productCalls(calls).length).toBe(2));
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ status: "archived", no_photo: "true" });
    expect(screen.getByRole("button", { name: "Archived, no photo" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(productCalls(calls).length).toBe(3));
    expect(queryOf(productCalls(calls)[2]!)).toEqual({});
  });

  it("drops local management filters immediately when catalog.manage is lost", async () => {
    const initial = seededPage("manage-before-revocation", page([JEANS]));
    const stale = Promise.withResolvers<Response>();
    const calls = mockApi((call) => {
      const filters = queryOf(call);
      if (filters.status) return stale.promise;
      return reply(200, filters.cursor ? page([WIDE], { counts: null }) : page([TOTE], { next_cursor: "staff-cursor" }));
    });
    const update = renderMountedCatalog({ initial });
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    const dialog = within(screen.getByRole("dialog", { name: "More filters" }));
    fireEvent.click(dialog.getByRole("radio", { name: "Archived products" }));
    fireEvent.click(dialog.getByRole("checkbox", { name: /Only products without a photo/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Show results" }));
    expect(productCalls(calls).map(queryOf)).toEqual([{ status: "archived", no_photo: "true" }]);

    update({ initial }, undefined, catalogStaff());
    expect(productCalls(calls).map(queryOf)).toEqual([{ status: "archived", no_photo: "true" }, {}]);
    expect(await screen.findByText("Canvas tote bag")).toBeInTheDocument();
    await act(async () => stale.resolve(apiError(403, "forbidden")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(productCalls(calls).map(queryOf).at(-1)).toEqual({ cursor: "staff-cursor" });
    await screen.findByText("Wide-leg black jeans");

    update({ initial });
    expect(screen.getByRole("button", { name: "More filters" })).toBeInTheDocument();
    expect(productCalls(calls)).toHaveLength(3);
  });

  it("closes the management filter sheet in the permission-loss commit even when no filter changed", () => {
    const calls = mockApi(() => reply(200, page([TOTE])));
    const initial = seededPage("manage-open-sheet", page([JEANS]));
    const update = renderMountedCatalog({ initial });
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    expect(screen.getByRole("dialog", { name: "More filters" })).toBeInTheDocument();

    update({ initial }, () => {
      expect(screen.queryByRole("dialog", { name: "More filters" })).not.toBeInTheDocument();
    }, catalogStaff());
    update({ initial });
    expect(screen.queryByRole("dialog", { name: "More filters" })).not.toBeInTheDocument();
    expect(productCalls(calls)).toHaveLength(0);
  });

  it("gives staff no More filters, no store menu for one store, no Add product and no no-photo chip", async () => {
    mockApi(() => reply(200, page([{ ...TOTE, store_ids: ["st-a"] }])));
    renderMe(<CatalogList />, catalogStaff());
    await screen.findByText("Canvas tote bag");
    expect(screen.queryByRole("button", { name: "More filters" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /All stores/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Add product")).not.toBeInTheDocument();
    expect(screen.queryByText("No photo")).not.toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Stock" })).toBeInTheDocument();
  });

  it("loads 20 more with the cursor and keeps the first ones", async () => {
    const second = summary({ id: "p-2", name_en: "Linen shirt" });
    const calls = mockApi((call) => reply(200, call.url.includes("cursor=") ? page([second], { counts: null }) : page([JEANS], { next_cursor: "c-2" })));
    renderMe(<CatalogList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Linen shirt")).toBeInTheDocument();
    expect(screen.getByText("Slim blue jeans")).toBeInTheDocument();
    expect(queryOf(productCalls(calls)[1]!)).toEqual({ cursor: "c-2" });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    // The counts of the first page stay.
    expect(within(screen.getByRole("radiogroup", { name: "Stock" })).getAllByRole("radio")[0]).toHaveTextContent("86");
  });

  it.each(["success", "failure"] as const)("ignores stale Load more %s after the stock filter changes", async (outcome) => {
    const stale = Promise.withResolvers<Response>();
    const fresh = Promise.withResolvers<Response>();
    const calls = mockApi((call) => {
      const { cursor } = queryOf(call);
      if (cursor === "old-cursor") return stale.promise;
      if (cursor === "filtered-cursor") return fresh.promise;
      return reply(200, page([WIDE], { next_cursor: "filtered-cursor" }));
    });
    renderMe(<CatalogList initial={seededPage(`pagination-${outcome}`, page([JEANS], { next_cursor: "old-cursor" }))} />, catalogOwner());
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(screen.getByRole("radio", { name: /Out.*1/ }));
    await screen.findByText("Wide-leg black jeans");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await act(async () => {
      stale.resolve(outcome === "success" ? reply(200, page([TOTE], { next_cursor: "stale-next" })) : apiError(500, "unexpected"));
    });
    expect(screen.queryByText("Canvas tote bag")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Loading more/ })).toBeDisabled();

    await act(async () => fresh.resolve(reply(200, page([TOTE], { counts: null }))));
    expect(screen.getByText("Canvas tote bag")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(productCalls(calls).map(queryOf)).toEqual([
      { cursor: "old-cursor" }, { stock: "out" }, { stock: "out", cursor: "filtered-cursor" },
    ]);
  });

  it("explains an empty catalog to an owner and to staff", async () => {
    mockApi(() => reply(200, page([], { counts: { all: 0, in_stock: 0, low: 0, out: 0 } })));
    renderMe(<CatalogList />, catalogOwner());
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    expect(screen.getByText(/Add your first product/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add product/ })).toHaveAttribute("href", "/more/catalog/new");
    // The empty state's own Import from CSV button (screen 136), besides the app bar's.
    const imports = screen.getAllByRole("link", { name: /Import from CSV/ });
    expect(imports).toHaveLength(2);
    for (const link of imports) expect(link).toHaveAttribute("href", "/more/catalog/import");
  });

  it("opens the Low stock list and CSV import from the app bar for owners and managers (screen 132)", async () => {
    mockApi(() => reply(200, page([JEANS])));
    renderMe(<CatalogList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    expect(screen.getByRole("link", { name: "Low stock list" })).toHaveAttribute("href", "/more/catalog/low-stock");
    expect(screen.getByRole("link", { name: "Import from CSV" })).toHaveAttribute("href", "/more/catalog/import");
  });

  it("gives staff neither app bar link nor the empty-state import (screen 133)", async () => {
    mockApi(() => reply(200, page([], { counts: { all: 0, in_stock: 0, low: 0, out: 0 } })));
    renderMe(<CatalogList />, catalogStaff());
    await screen.findByText(/No products in your stores yet/);
    expect(screen.queryByRole("link", { name: "Low stock list" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Import from CSV/ })).not.toBeInTheDocument();
  });

  it("can open with the no-photo filter on (from the import result)", async () => {
    const calls = mockApi(() => reply(200, page([TOTE])));
    renderMe(<CatalogList initialNoPhoto />, catalogOwner());
    await screen.findByText("Canvas tote bag");
    expect(queryOf(productCalls(calls)[0]!)).toEqual({ no_photo: "true" });
    expect(screen.getByRole("button", { name: "No photo" })).toBeInTheDocument();
  });

  it("tells staff products appear when an owner or manager adds them", async () => {
    mockApi(() => reply(200, page([], { counts: { all: 0, in_stock: 0, low: 0, out: 0 } })));
    renderMe(<CatalogList />, catalogStaff());
    expect(await screen.findByText(/No products in your stores yet/)).toBeInTheDocument();
  });

  it("says nothing matches a search and offers to clear it", async () => {
    mockApi((call) => reply(200, call.url.includes("q=") ? page([], { counts: { all: 0, in_stock: 0, low: 0, out: 0 } }) : page([JEANS])));
    renderMe(<CatalogList />, catalogOwner());
    await screen.findByText("Slim blue jeans");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "linen dress" } });
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    expect(screen.getByText(/contains “linen dress”/)).toBeInTheDocument();
  });

  it("shows the could-not-load state with a retry that loads again", async () => {
    let fail = true;
    mockApi(() => (fail ? networkFailure() : reply(200, page([JEANS]))));
    renderMe(<CatalogList />, catalogOwner());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load the catalog");
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Slim blue jeans")).toBeInTheDocument();
  });

  it("shows the loading state, with Add product waiting for the list", async () => {
    mockApi(() => new Promise<Response>(() => {}));
    renderMe(<CatalogList />, catalogOwner());
    expect(screen.getByRole("status")).toHaveTextContent("Loading products…");
    expect(screen.getByRole("button", { name: /Add product/ })).toBeDisabled();
  });

  it("treats a refused store as the error state rather than showing other stores", async () => {
    mockApi(() => apiError(404, "not_found"));
    renderMe(<CatalogList />, catalogOwner());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load the catalog");
  });

  it("is available in Arabic", async () => {
    mockApi(() => reply(200, page([JEANS])));
    renderMe(<CatalogList />, catalogOwner({ user: { ...catalogOwner().user, locale: "ar" } }), "ar");
    expect(await screen.findByRole("heading", { level: 1, name: ar.catalog.title })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: ar.catalog.stockFilter })).toBeInTheDocument();
    expect(screen.getByText("16 متاح")).toBeInTheDocument();
  });
});
