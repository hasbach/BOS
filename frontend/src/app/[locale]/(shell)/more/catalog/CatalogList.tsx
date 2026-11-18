"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { BoxIcon, CheckIcon, ChevronIcon, CloseIcon, FilterIcon, ImageIcon, PlusIcon, SearchIcon, StoreIcon, SyncIcon } from "@/components/icons";
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
import type { ProductCounts, ProductFilters, ProductSummary } from "@/lib/catalog";
import { normaliseDigits } from "@/lib/digits";
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

/** Search typed with Arabic-Indic digits is searched with 0-9; the API takes at most 100 characters. */
const searchOf = (typed: string) => normaliseDigits(typed).trim().slice(0, 100);

/** Screens 132 to 139: the catalog for everyone with catalog.view, 20 products at a time. */
export function CatalogList() {
  const t = useTranslations();
  const c = useTranslations("catalog");
  const access = useCatalogAccess();
  const stores = useMeStores();
  const me = useMe();

  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [storeId, setStoreId] = useState("");
  const [stock, setStock] = useState<Stock>("all");
  const [extra, setExtra] = useState<Extra>(NO_EXTRA);
  const [page, setPage] = useState<Page>({ k: "loading" });
  const [counts, setCounts] = useState<ProductCounts | null>(null);
  const [more, setMore] = useState<More>("idle");
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState<"store" | "filters" | null>(null);

  // A store the person no longer works in (access changed) is dropped from the filter.
  const store = stores.some((candidate) => candidate.id === storeId) ? storeId : "";

  const filters = (cursor?: string): ProductFilters => ({
    q: query || undefined,
    store_id: store || undefined,
    stock: stock === "all" ? undefined : stock,
    status: extra.archived ? "archived" : undefined,
    no_photo: extra.noPhoto || undefined,
    cursor,
  });

  useEffect(() => {
    const controller = new AbortController();
    const asked: ProductFilters = {
      q: query || undefined,
      store_id: store || undefined,
      stock: stock === "all" ? undefined : stock,
      status: extra.archived ? "archived" : undefined,
      no_photo: extra.noPhoto || undefined,
    };
    listProducts(asked, controller.signal).then(
      (result) => {
        setPage({ k: "ready", items: result.items, next: result.next_cursor });
        if (result.counts) setCounts(result.counts);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setPage({ k: "error", error });
      },
    );
    return () => controller.abort();
  }, [query, store, stock, extra, attempt]);

  // Searching waits until typing pauses, so each key press is not a request.
  useEffect(() => {
    const next = searchOf(typed);
    if (next === query) return;
    const timer = setTimeout(() => {
      setPage({ k: "loading" });
      setMore("idle");
      setQuery(next);
    }, 300);
    return () => clearTimeout(timer);
  }, [typed, query]);

  function change(apply: () => void) {
    setPage({ k: "loading" });
    setMore("idle");
    setSheet(null);
    apply();
  }

  function clearSearch() {
    setTyped("");
    if (query !== "") change(() => setQuery(""));
  }

  async function loadMore() {
    if (page.k !== "ready" || !page.next || more === "loading") return;
    setMore("loading");
    try {
      const result = await listProducts(filters(page.next));
      setPage((current) => (current.k === "ready" ? { k: "ready", items: [...current.items, ...result.items], next: result.next_cursor } : current));
      setMore("idle");
    } catch {
      setMore("error");
    }
  }

  if (page.k === "error") {
    if (isSessionEnded(page.error)) return <SessionEnded />;
    return (
      <CatalogStatus title={c("title")} heading={c("loadError.title")} text={c("loadError.text")} tone="warn" icon="wifioff" alert>
        <Button
          onClick={() => {
            setPage({ k: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          <SyncIcon width={16} height={16} /> {t("ui.retry")}
        </Button>
        <LinkButton href="/more" variant="ghost">
          {c("backToMore")}
        </LinkButton>
      </CatalogStatus>
    );
  }

  const filtered = query !== "" || store !== "" || stock !== "all" || extra.archived || extra.noPhoto;
  const emptyCatalog = page.k === "ready" && page.items.length === 0 && !filtered;
  const extraLabel = extra.archived && extra.noPhoto ? c("activeFilter.both") : extra.archived ? c("activeFilter.archived") : extra.noPhoto ? c("activeFilter.noPhoto") : "";
  const storeName = stores.find((candidate) => candidate.id === store)?.name;

  return (
    <Screen>
      <AppBar title={c("title")} subtitle={me.business.name} backHref="/more" backLabel={t("common.back")} />
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
            <StockSwitch value={stock} counts={counts} onChange={(next) => change(() => setStock(next))} />
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
                      <button type="button" className={styles.pill} onClick={() => change(() => setExtra(NO_EXTRA))}>
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
            onClearFilters={() =>
              change(() => {
                setTyped("");
                setQuery("");
                setStoreId("");
                setStock("all");
                setExtra(NO_EXTRA);
              })
            }
          />
        ) : (
          <>
            <Card style={{ paddingBlock: 0 }}>
              <ul className={styles.list} aria-label={c("title")}>
                {page.items.map((product) => (
                  <Row key={product.id} product={product} />
                ))}
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
          onPick={(id) => change(() => setStoreId(id))}
        />
      ) : null}
      {sheet === "filters" ? <FilterSheet current={extra} onClose={() => setSheet(null)} onApply={(next) => change(() => setExtra(next))} /> : null}
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

function StoreSheet({ current, onClose, onPick }: { current: string; onClose: () => void; onPick: (id: string) => void }) {
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
