"use client";

import { useLocale, useTranslations } from "next-intl";
import { startTransition, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import type { AppBarAction } from "@/components/AppBar";
import { AlertIcon, BoxIcon, CheckIcon, ChevronIcon, CloseIcon, FilterIcon, ImageIcon, PlusIcon, SearchIcon, StoreIcon, SyncIcon, UploadIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { OfflineNotice } from "@/components/OfflineNotice";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { SessionEnded } from "@/components/SessionEnded";
import { Sheet } from "@/components/Sheet";
import { useMeStores } from "@/components/StoresProvider";
import { useRovingRadio } from "@/components/useRovingRadio";
import { Link } from "@/i18n/navigation";
import { isSessionEnded } from "@/lib/api";
import { CATALOG, listProducts, productName } from "@/lib/catalog";
import type { ProductCounts, ProductFilters, ProductPage, ProductSummary } from "@/lib/catalog";
import { normaliseDigits } from "@/lib/digits";
import type { Seed } from "@/lib/seed";
import type { CatalogSeedPage } from "@/lib/serverSession";
import { useMe } from "@/lib/session";

import styles from "./catalog.module.css";
import { CatalogStatus, PriceRange, ProductThumb, StockChip, StoreChips, useCatalogAccess } from "./parts";

type Stock = "all" | "in_stock" | "low" | "out";
const STOCKS: readonly Stock[] = ["all", "in_stock", "low", "out"];
const STOCK_KEY: Record<Stock, string> = { all: "all", in_stock: "inStock", low: "low", out: "out" };
const COUNT_KEY: Record<Stock, keyof ProductCounts> = { all: "all", in_stock: "in_stock", low: "low", out: "out" };

interface Extra {
  archived: boolean;
  noPhoto: boolean;
}
const NO_EXTRA: Extra = { archived: false, noPhoto: false };

type Page = { k: "loading" } | { k: "error"; error: unknown } | { k: "ready"; items: ProductSummary[]; next: string | null };
type More = "idle" | "loading" | "error";
type CatalogView = { seedId: string | undefined; routeNoPhoto: boolean; initialPage: ProductPage | undefined; filters: ProductFilters };
type CatalogResponse = { view: CatalogView; page: Page; counts: ProductCounts | null; more: More };

// As with useSeed, a cached server payload shouldn't be replayed on back navigation.
const seenCatalogSeeds = new Set<string>();
function initialResponse(view: CatalogView): CatalogResponse {
  const seed = view.initialPage;
  return {
    view,
    page: seed ? { k: "ready", items: seed.items, next: seed.next_cursor } : { k: "loading" },
    counts: seed?.counts ?? null,
    more: "idle",
  };
}

function sameFilters(a: ProductFilters, b: ProductFilters) {
  return a.q === b.q && a.store_id === b.store_id && a.stock === b.stock && a.status === b.status && a.no_photo === b.no_photo;
}

/** Search typed with Arabic-Indic digits is searched with 0-9; the API takes at most 100 characters. */
const searchOf = (typed: string) => normaliseDigits(typed).trim().slice(0, 100);

/**
 * Screens 132 to 139: the catalog for everyone with catalog.view, 20 products at a time.
 * `initialNoPhoto` opens it with the no-photo filter on (the import result's Add photos; catalog.manage only).
 */
export function CatalogList({ initialNoPhoto = false, initial: seed }: { initialNoPhoto?: boolean; initial?: Seed<CatalogSeedPage | null> } = {}) {
  const t = useTranslations();
  const c = useTranslations("catalog");
  const access = useCatalogAccess();
  const stores = useMeStores();
  const me = useMe();
  const routeNoPhoto = initialNoPhoto && access.manage;
  const seedId = seed?.id;
  const initial = seed && !seenCatalogSeeds.has(seed.id) ? seed.value ?? undefined : undefined;
  const routeFilters = { no_photo: routeNoPhoto || undefined };
  const initialPage = initial && sameFilters(initial.filters, routeFilters) ? initial.page : undefined;
  const hasSeed = seed?.value != null;
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [storeId, setStoreId] = useState("");
  const [stock, setStock] = useState<Stock>("all");
  const [extra, setExtra] = useState<Extra>(() => (routeNoPhoto ? { archived: false, noPhoto: true } : NO_EXTRA));
  const firstRequest = useRef<AbortController | null>(null);
  const moreRequest = useRef<AbortController | null>(null);
  const [sheet, setSheet] = useState<"store" | "filters" | null>(null);

  // A store the person no longer works in (access changed) is dropped from the filter.
  const store = stores.some((candidate) => candidate.id === storeId) ? storeId : "";

  const [previousView, setView] = useState<CatalogView>(() => ({ seedId, routeNoPhoto, initialPage, filters: routeFilters }));
  const [response, setResponse] = useState(() => initialResponse(previousView));
  const [lastCounts, setLastCounts] = useState<{ value: ProductCounts; restricted: boolean } | null>(() =>
    initialPage?.counts ? { value: initialPage.counts, restricted: routeNoPhoto } : null,
  );
  // URL navigation updates no-photo, but a refresh with the same URL keeps local overrides.
  const urlChanged = previousView.routeNoPhoto !== routeNoPhoto;
  const effectiveExtra = access.manage ? { archived: extra.archived, noPhoto: urlChanged ? routeNoPhoto : extra.noPhoto } : NO_EXTRA;
  const filters: ProductFilters = {
    q: query || undefined,
    store_id: store || undefined,
    stock: stock === "all" ? undefined : stock,
    status: effectiveExtra.archived ? "archived" : undefined,
    no_photo: effectiveExtra.noPhoto || undefined,
  };
  const routeChanged = urlChanged || previousView.seedId !== seedId;

  // Object identity distinguishes successive views even when their filters match (A → B → A).
  let view = previousView;
  if (routeChanged || !sameFilters(previousView.filters, filters)) {
    const matchingSeed = routeChanged && initial && sameFilters(filters, initial.filters) ? initial.page : undefined;
    view = { seedId, routeNoPhoto, filters, initialPage: matchingSeed };
    setView(view);
  }
  if (extra.archived !== effectiveExtra.archived || extra.noPhoto !== effectiveExtra.noPhoto) setExtra(effectiveExtra);
  if ((urlChanged && sheet !== null) || (!access.manage && sheet === "filters")) setSheet(null);

  // Abort ignores callbacks that run late; ownership also ignores updates queued before abort
  // that React may replay after the new view commits. Keep only counts accepted by a view.
  const current = response.view === view ? response : initialResponse(view);
  const { page, more } = current;
  const previousCounts = !access.manage && lastCounts?.restricted ? null : lastCounts;
  const counts = current.counts ?? previousCounts?.value ?? null;
  if (current.counts && current.counts !== previousCounts?.value) {
    setLastCounts({ value: current.counts, restricted: effectiveExtra.archived || effectiveExtra.noPhoto });
  } else if (previousCounts !== lastCounts) {
    setLastCounts(previousCounts);
  }

  useEffect(() => {
    if (hasSeed && seedId !== undefined) seenCatalogSeeds.add(seedId);
  }, [hasSeed, seedId]);

  // Invalidate both requests when the view commits, before passive effects run.
  useLayoutEffect(() => () => {
    firstRequest.current?.abort();
    firstRequest.current = null;
    moreRequest.current?.abort();
    moreRequest.current = null;
  }, [view]);

  // A layout effect sends the request in the same task as the commit. A passive effect would wait
  // until the loading rows were painted, which costs a throttled phone ~60-90 ms per search (T107).
  useLayoutEffect(() => {
    if (view.initialPage) return;
    const controller = new AbortController();
    firstRequest.current = controller;
    listProducts(view.filters, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setResponse({
          view, page: { k: "ready", items: result.items, next: result.next_cursor },
          counts: result.counts, more: "idle",
        });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setResponse({ view, page: { k: "error", error }, counts: null, more: "idle" });
      },
    );
    return () => {
      controller.abort();
      if (firstRequest.current === controller) firstRequest.current = null;
    };
  }, [view]);

  // Searching waits until typing pauses, so each key press is not a request.
  useEffect(() => {
    const next = searchOf(typed);
    if (next === query) return;
    const timer = setTimeout(() => setQuery(next), 300);
    return () => clearTimeout(timer);
  }, [typed, query]);

  function clearSearch() {
    setTyped("");
    setQuery("");
  }

  async function loadMore() {
    if (page.k !== "ready" || !page.next || moreRequest.current) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    function updateMore(more: More, result?: ProductPage) {
      setResponse((previous) => {
        const owned = previous.view === view ? previous : initialResponse(view);
        if (owned.page.k !== "ready") return previous;
        return {
          ...owned, more,
          page: result ? { k: "ready", items: [...owned.page.items, ...result.items], next: result.next_cursor } : owned.page,
        };
      });
    }
    updateMore("loading");
    try {
      const result = await listProducts({ ...view.filters, cursor: page.next }, controller.signal);
      if (!controller.signal.aborted) updateMore("idle", result);
    } catch {
      if (!controller.signal.aborted) updateMore("error");
    } finally {
      if (moreRequest.current === controller) moreRequest.current = null;
    }
  }

  if (page.k === "error") {
    if (isSessionEnded(page.error)) return <SessionEnded />;
    return (
      <CatalogStatus title={c("title")} heading={c("loadError.title")} text={c("loadError.text")} tone="warn" icon="wifioff" alert>
        <Button onClick={() => setView({ ...view, initialPage: undefined })}>
          <SyncIcon width={16} height={16} /> {t("ui.retry")}
        </Button>
        <LinkButton href="/more" variant="ghost">
          {c("backToMore")}
        </LinkButton>
      </CatalogStatus>
    );
  }

  const { archived, noPhoto } = effectiveExtra;
  const filtered = query !== "" || store !== "" || stock !== "all" || archived || noPhoto;
  const emptyCatalog = page.k === "ready" && page.items.length === 0 && !filtered;
  const extraLabel = archived && noPhoto ? c("activeFilter.both") : archived ? c("activeFilter.archived") : noPhoto ? c("activeFilter.noPhoto") : "";
  const storeName = stores.find((candidate) => candidate.id === store)?.name;
  // Screen 132: the Low stock list (stock.adjust) and CSV import (catalog.manage) for owners and managers.
  const barLinks: AppBarAction[] = [];
  if (access.adjust) barLinks.push({ href: `${CATALOG}/low-stock`, label: c("lowStockList"), icon: <AlertIcon width={22} height={22} /> });
  if (access.manage) barLinks.push({ href: `${CATALOG}/import`, label: c("importCsv"), icon: <UploadIcon width={22} height={22} /> });

  return (
    <Screen>
      <AppBar title={c("title")} subtitle={me.business.name} backHref="/more" backLabel={t("common.back")} actions={barLinks} />
      <ScreenBody>
        <OfflineNotice />
        <div className={styles.search}>
          <SearchIcon width={20} height={20} />
          <input
            className={styles.searchInput}
            type="search"
            value={typed}
            placeholder={c("search")}
            aria-label={c("search")}
            maxLength={100}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
          {typed !== "" ? (
            <button type="button" className={styles.iconButton} aria-label={c("clearSearch")} onClick={clearSearch}>
              <CloseIcon width={16} height={16} />
            </button>
          ) : null}
        </div>

        {/* The switch and menus appear with the first page's counts (screen 135 has none) and stay while a filter loads. */}
        {counts === null || emptyCatalog ? null : (
          <>
            <StockSwitch value={stock} counts={counts} onChange={setStock} />
            {stores.length > 1 || access.manage ? (
              <div className={styles.pills}>
                {stores.length > 1 ? (
                  <button type="button" className={`${styles.pill} ${store ? styles.pillOn : ""}`} aria-haspopup="dialog" onClick={() => setSheet("store")}>
                    <StoreIcon width={16} height={16} />
                    {storeName ?? c("allStores")}
                    <ChevronIcon width={14} height={14} className={styles.down} />
                  </button>
                ) : null}
                {access.manage ? (
                  <>
                    <button type="button" className={`${styles.pill} ${extraLabel ? styles.pillOn : ""}`} aria-haspopup="dialog" onClick={() => setSheet("filters")}>
                      <FilterIcon width={16} height={16} />
                      {extraLabel || c("moreFilters")}
                    </button>
                    {extraLabel ? (
                      <button type="button" className={styles.pill} onClick={() => setExtra(NO_EXTRA)}>
                        <CloseIcon width={16} height={16} />
                        {c("clearFilters")}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        {page.k === "loading" ? (
          <LoadingRows />
        ) : page.items.length === 0 ? (
          <Nothing
            emptyCatalog={emptyCatalog}
            query={query}
            onClearSearch={clearSearch}
            onClearFilters={() => {
              clearSearch();
              setStoreId("");
              setStock("all");
              setExtra(NO_EXTRA);
            }}
          />
        ) : (
          <>
            <Card style={{ paddingBlock: 0 }}>
              <ul className={styles.list} aria-label={c("title")}>
                <Rows items={page.items} staged={!view.initialPage} />
              </ul>
            </Card>
            {more === "error" ? (
              <Banner tone="bad" icon="alert" alert>
                {c("moreError")}
              </Banner>
            ) : null}
            {page.next ? (
              <Button variant="ghost" loading={more === "loading"} onClick={() => void loadMore()}>
                {more === "loading" ? c("loadingMore") : c("loadMore")}
              </Button>
            ) : null}
          </>
        )}
      </ScreenBody>
      {access.manage ? (
        <ScreenFooter>
          {page.k === "loading" ? (
            <Button disabled>
              <PlusIcon width={18} height={18} /> {c("add")}
            </Button>
          ) : (
            <LinkButton href={`${CATALOG}/new`}>
              <PlusIcon width={18} height={18} /> {c("add")}
            </LinkButton>
          )}
        </ScreenFooter>
      ) : null}

      {sheet === "store" ? (
        <StoreSheet
          current={store}
          onClose={() => setSheet(null)}
          onPick={(id) => {
            setStoreId(id);
            setSheet(null);
          }}
        />
      ) : null}
      {access.manage && sheet === "filters" ? (
        <FilterSheet
          current={effectiveExtra}
          onClose={() => setSheet(null)}
          onApply={(next) => {
            setExtra(next);
            setSheet(null);
          }}
        />
      ) : null}
    </Screen>
  );
}

function StockSwitch({ value, counts, onChange }: { value: Stock; counts: ProductCounts | null; onChange: (value: Stock) => void }) {
  const c = useTranslations("catalog");
  const item = useRovingRadio(STOCKS, value, onChange);
  return (
    <div className={styles.seg} role="radiogroup" aria-label={c("stockFilter")}>
      {STOCKS.map((option) => {
        const on = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={on}
            className={`${styles.segOption} ${on ? styles.segOn : ""}`}
            {...item(option)}
            onClick={() => onChange(option)}
          >
            <span>{c(`filters.${STOCK_KEY[option]}`)}</span>
            {counts ? <span>{counts[COUNT_KEY[option]]}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Rows that fill a phone screen: a row is about 120 px tall and the list starts about 265 px
 * down, so 360 × 740 shows four and a 430 × 932 phone between five and six.
 */
export const FIRST_ROWS = 6;

/**
 * A page that arrived after the list was mounted (a search, filter or retry) shows its first
 * FIRST_ROWS rows in the commit that replaces the loading rows, and the rest in a transition
 * right after. Building all 20 rows before the first paint delayed the matches on a throttled
 * phone (T107: 4× CPU). Same rows in the same order once complete; a server-rendered page shows
 * all its rows at once, as hydration needs.
 */
function Rows({ items, staged }: { items: ProductSummary[]; staged: boolean }) {
  const [complete, setComplete] = useState(!staged);
  useEffect(() => {
    if (!complete) startTransition(() => setComplete(true));
  }, [complete]);
  return (complete ? items : items.slice(0, FIRST_ROWS)).map((product) => <Row key={product.id} product={product} />);
}

function Row({ product }: { product: ProductSummary }) {
  const c = useTranslations("catalog");
  const locale = useLocale();
  const access = useCatalogAccess();
  const name = productName(product, locale) || product.code;
  return (
    <li className={styles.item}>
      <Link href={`${CATALOG}/${product.id}`} className={styles.row}>
        <ProductThumb photoId={product.main_photo_id} name={name} />
        <span className={styles.rowText}>
          <span className={styles.name}>{name}</span>
          <span className={styles.muted}>
            {c("variantCount", { count: product.variant_count })} · <PriceRange prices={product.prices} />
          </span>
          <span className={styles.muted}>{c("availableCount", { count: product.available_total })}</span>
          <span className={styles.chips}>
            <StoreChips storeIds={product.store_ids} />
            <StockChip state={product.stock_state} />
            {access.manage && !product.main_photo_id ? (
              <Chip>
                <ImageIcon width={14} height={14} /> {c("noPhoto")}
              </Chip>
            ) : null}
            {product.status === "archived" ? (
              <Chip>
                <BoxIcon width={14} height={14} /> {c("archived")}
              </Chip>
            ) : null}
          </span>
        </span>
        <ChevronIcon className={styles.chevron} width={18} height={18} />
      </Link>
    </li>
  );
}

function LoadingRows() {
  const c = useTranslations("catalog");
  return (
    <>
      <p className={styles.muted} role="status" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <SyncIcon width={16} height={16} /> {c("loading")}
      </p>
      <Card style={{ paddingBlock: 0 }} aria-hidden="true">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className={styles.row}>
            <div className={styles.skeleton} style={{ inlineSize: 52, blockSize: 52, borderRadius: 10, flex: "none" }} />
            <div className={styles.rowText} style={{ gap: 8 }}>
              <div className={styles.skeleton} style={{ blockSize: 14, inlineSize: "45%" }} />
              <div className={styles.skeleton} style={{ blockSize: 12, inlineSize: "65%" }} />
              <div className={styles.skeleton} style={{ blockSize: 12, inlineSize: "30%" }} />
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}

function Nothing({ emptyCatalog, query, onClearSearch, onClearFilters }: { emptyCatalog: boolean; query: string; onClearSearch: () => void; onClearFilters: () => void }) {
  const c = useTranslations("catalog");
  const access = useCatalogAccess();
  if (emptyCatalog) {
    return (
      <div className={styles.center}>
        <div className={styles.emptyCircle} aria-hidden="true">
          <BoxIcon width={28} height={28} />
        </div>
        <h2 className={styles.big}>{c("empty.title")}</h2>
        <p className={styles.muted} style={{ maxInlineSize: 280 }}>
          {access.manage ? c("empty.manage") : c("empty.staff")}
        </p>
        {access.manage ? (
          <div style={{ inlineSize: "100%", maxInlineSize: 260 }}>
            <LinkButton href={`${CATALOG}/import`} variant="ghost">
              <UploadIcon width={16} height={16} /> {c("importCsv")}
            </LinkButton>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className={styles.center}>
      <div className={styles.emptyCircle} aria-hidden="true">
        <SearchIcon width={28} height={28} />
      </div>
      <h2 className={styles.big}>{c("noMatch.title")}</h2>
      <p className={styles.muted} style={{ maxInlineSize: 280 }}>
        {query ? c("noMatch.text", { q: query }) : c("noMatch.filtered")}
      </p>
      <Button variant="ghost" size="small" onClick={query ? onClearSearch : onClearFilters}>
        <CloseIcon width={16} height={16} /> {query ? c("clearSearch") : c("clearFilters")}
      </Button>
    </div>
  );
}

/** The store menu's sheet (also used by the Low stock list): "All stores" and the person's own stores. */
export function StoreSheet({ current, onClose, onPick }: { current: string; onClose: () => void; onPick: (id: string) => void }) {
  const c = useTranslations("catalog");
  const stores = useMeStores();
  const values = ["", ...stores.map((store) => store.id)];
  const [draft, setDraft] = useState(current);
  const item = useRovingRadio(values, draft, setDraft);
  return (
    <Sheet open onClose={onClose} title={c("storeMenu")}>
      <div role="radiogroup" aria-label={c("storeMenu")}>
        {values.map((id) => {
          const on = draft === id;
          const label = id === "" ? c("allStores") : stores.find((store) => store.id === id)?.name;
          return (
            <button key={id || "all"} type="button" role="radio" aria-checked={on} className={styles.choice} {...item(id)} onClick={() => onPick(id)}>
              <span className={`${styles.box} ${styles.radio} ${on ? styles.boxOn : ""}`} aria-hidden="true">
                <CheckIcon width={14} height={14} />
              </span>
              <span className={styles.grow}>{label}</span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

const SHOW = ["active", "archived"] as const;

function FilterSheet({ current, onClose, onApply }: { current: Extra; onClose: () => void; onApply: (extra: Extra) => void }) {
  const c = useTranslations("catalog");
  const [draft, setDraft] = useState(current);
  const show = draft.archived ? "archived" : "active";
  const item = useRovingRadio(SHOW, show, (value) => setDraft((d) => ({ ...d, archived: value === "archived" })));
  return (
    <Sheet
      open
      onClose={onClose}
      title={c("moreFilters")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onApply(NO_EXTRA)}>
            {c("filterSheet.clear")}
          </Button>
          <Button onClick={() => onApply(draft)}>{c("filterSheet.apply")}</Button>
        </>
      }
    >
      <div className={styles.stack}>
        <div>
          <p className={styles.label} style={{ marginBlockEnd: 6 }}>
            {c("filterSheet.show")}
          </p>
          <div className={styles.pills} role="radiogroup" aria-label={c("filterSheet.show")}>
            {SHOW.map((value) => {
              const on = show === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`${styles.pill} ${on ? styles.pillOn : ""}`}
                  {...item(value)}
                  onClick={() => setDraft((d) => ({ ...d, archived: value === "archived" }))}
                >
                  {on ? <CheckIcon width={14} height={14} /> : null}
                  {c(`filterSheet.${value}`)}
                </button>
              );
            })}
          </div>
        </div>
        <Card style={{ paddingBlock: 0 }}>
          <button type="button" role="checkbox" aria-checked={draft.noPhoto} className={styles.choice} onClick={() => setDraft((d) => ({ ...d, noPhoto: !d.noPhoto }))}>
            <span className={`${styles.box} ${draft.noPhoto ? styles.boxOn : ""}`} aria-hidden="true">
              <CheckIcon width={14} height={14} />
            </span>
            <span className={styles.grow}>
              <span className={styles.name}>{c("filterSheet.noPhoto")}</span>
              <br />
              <span className={styles.muted}>{c("filterSheet.noPhotoHint")}</span>
            </span>
          </button>
        </Card>
        <p className={styles.small}>{c("filterSheet.archivedNote")}</p>
      </div>
    </Sheet>
  );
}
