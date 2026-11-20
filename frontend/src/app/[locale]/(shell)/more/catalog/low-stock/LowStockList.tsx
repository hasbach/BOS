"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { CheckIcon, ChevronIcon, GearIcon, StoreIcon, SyncIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { OfflineNotice } from "@/components/OfflineNotice";
import { Screen, ScreenBody } from "@/components/Screen";
import { SessionEnded } from "@/components/SessionEnded";
import { useMeStores } from "@/components/StoresProvider";
import { Link } from "@/i18n/navigation";
import { isApiError, isSessionEnded } from "@/lib/api";
import { CATALOG, productName } from "@/lib/catalog";
import { listLowStock } from "@/lib/stock";
import type { LowStockItem } from "@/lib/stock";
import { useMe } from "@/lib/session";

import own from "../[productId]/stock.module.css";
import styles from "../catalog.module.css";
import { StoreSheet } from "../CatalogList";
import { CatalogStatus, ProductThumb, StockChip, useBusinessSettings, useCatalogAccess, variantLabel } from "../parts";

type Page = { k: "loading" } | { k: "error"; error: unknown } | { k: "ready"; items: LowStockItem[]; next: string | null; total: number | null };
type More = "idle" | "loading" | "error";

/** Screens 158 to 161: variants at or below their low-stock level, out of stock first (owners and managers: stock.adjust). */
export function LowStockList() {
  const access = useCatalogAccess();
  if (!access.adjust) return <NotAllowed />;
  return <List />;
}

function NotAllowed() {
  const l = useTranslations("catalog.lowStock");
  const c = useTranslations("catalog");
  return (
    <CatalogStatus title={l("title")} heading={l("notAllowed.title")} text={l("notAllowed.text")} tone="info" icon="lock" backHref={CATALOG}>
      <LinkButton href={CATALOG}>{c("backToCatalog")}</LinkButton>
    </CatalogStatus>
  );
}

function Bar() {
  const l = useTranslations("catalog.lowStock");
  const common = useTranslations("common");
  return <AppBar title={l("title")} subtitle={l("subtitle")} backHref={CATALOG} backLabel={common("back")} />;
}

function List() {
  const t = useTranslations();
  const c = useTranslations("catalog");
  const l = useTranslations("catalog.lowStock");
  const stores = useMeStores();
  const { lowDefault } = useBusinessSettings();

  const [storeId, setStoreId] = useState("");
  const [page, setPage] = useState<Page>({ k: "loading" });
  const [more, setMore] = useState<More>("idle");
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState(false);
  const request = useRef<AbortController | null>(null);

  const store = stores.some((candidate) => candidate.id === storeId) ? storeId : "";

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    listLowStock({ store_id: store || undefined }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setPage({ k: "ready", items: result.items, next: result.next_cursor, total: typeof result.total === "number" ? result.total : null });
        setMore("idle");
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setPage({ k: "error", error });
      },
    );
    return () => controller.abort();
  }, [store, attempt]);

  async function loadMore() {
    if (page.k !== "ready" || !page.next || more === "loading") return;
    const signal = request.current?.signal;
    if (!signal || signal.aborted) return;
    setMore("loading");
    try {
      const result = await listLowStock({ store_id: store || undefined, cursor: page.next }, signal);
      if (signal.aborted) return;
      setPage((current) => (current.k === "ready" ? { ...current, items: [...current.items, ...result.items], next: result.next_cursor } : current));
      setMore("idle");
    } catch {
      if (!signal.aborted) setMore("error");
    }
  }

  if (page.k === "error") {
    if (isSessionEnded(page.error)) return <SessionEnded />;
    if (isApiError(page.error) && page.error.code === "forbidden") return <NotAllowed />;
    return (
      <CatalogStatus title={l("title")} heading={l("loadError.title")} text={l("loadError.text")} tone="warn" icon="wifioff" alert backHref={CATALOG}>
        <Button
          onClick={() => {
            setPage({ k: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          <SyncIcon width={16} height={16} /> {t("ui.retry")}
        </Button>
        <LinkButton href={CATALOG} variant="ghost">
          {c("backToCatalog")}
        </LinkButton>
      </CatalogStatus>
    );
  }

  const storeName = stores.find((candidate) => candidate.id === store)?.name;

  return (
    <Screen>
      <Bar />
      <ScreenBody>
        <OfflineNotice />
        {stores.length > 1 ? (
          <div className={styles.pills}>
            <button type="button" className={`${styles.pill} ${store ? styles.pillOn : ""}`} aria-haspopup="dialog" onClick={() => setSheet(true)}>
              <StoreIcon width={16} height={16} />
              {storeName ?? c("allStores")}
              <ChevronIcon width={14} height={14} className={styles.down} />
            </button>
          </div>
        ) : null}

        {page.k === "loading" ? (
          <LoadingRows />
        ) : page.items.length === 0 ? (
          <NothingLow level={lowDefault} />
        ) : (
          <>
            <p className={styles.label}>{c("variantCount", { count: page.total ?? page.items.length })}</p>
            <Card style={{ paddingBlock: 0 }}>
              <ul className={styles.list} aria-label={l("title")}>
                {page.items.map((item) => (
                  <Row key={item.variant_id} item={item} />
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
            <p className={styles.small}>{lowDefault === null ? l("noteNoDefault") : l("note", { level: lowDefault })}</p>
          </>
        )}
      </ScreenBody>

      {sheet ? (
        <StoreSheet
          current={store}
          onClose={() => setSheet(false)}
          onPick={(id) => {
            setSheet(false);
            if (id === store) return;
            request.current?.abort();
            setPage({ k: "loading" });
            setMore("idle");
            setStoreId(id);
          }}
        />
      ) : null}
    </Screen>
  );
}

function Row({ item }: { item: LowStockItem }) {
  const locale = useLocale();
  const c = useTranslations("catalog");
  const l = useTranslations("catalog.lowStock");
  const name = productName({ name_en: item.product_name_en, name_ar: item.product_name_ar }, locale) || item.sku;
  const values = variantLabel(item.option_values);
  return (
    <li className={styles.item}>
      <Link href={`${CATALOG}/${item.product_id}`} className={styles.row}>
        <ProductThumb photoId={item.main_photo_id} name={name} />
        <span className={styles.rowText} style={{ gap: 4 }}>
          <span className={styles.between} style={{ alignItems: "flex-start" }}>
            <span className={styles.name}>{name}</span>
            <StockChip state={item.stock_state} />
          </span>
          <span className={styles.muted}>
            {values ? <>{values} · </> : null}
            <bdi dir="ltr" className={styles.nowrap}>
              {item.sku}
            </bdi>
          </span>
          <span className={own.figures} role="group" aria-label={l("figures")}>
            <span>
              <span className={own.figureLabel}>{c("stock.available")}</span>
              <span className={own.figure}>{item.available}</span>
            </span>
            <span>
              <span className={own.figureLabel}>{c("stock.onHand")}</span>
              <span className={own.figure}>{item.on_hand}</span>
            </span>
            <span>
              <span className={own.figureLabel}>{l("warnAt")}</span>
              <span className={own.figure}>{item.level}</span>
            </span>
          </span>
          {item.allocated > 0 ? <span className={styles.small}>{l("reserved", { count: item.allocated })}</span> : null}
        </span>
        <ChevronIcon className={styles.chevron} width={18} height={18} />
      </Link>
    </li>
  );
}

function NothingLow({ level }: { level: number | null }) {
  const l = useTranslations("catalog.lowStock");
  const { permissions } = useMe();
  return (
    <div className={styles.center}>
      <div className={styles.emptyCircle} aria-hidden="true">
        <CheckIcon width={28} height={28} />
      </div>
      <h2 className={styles.big}>{l("empty.title")}</h2>
      <p className={styles.muted} style={{ maxInlineSize: 280 }}>
        {level === null ? l("empty.textNoDefault") : l("empty.text", { level })}
      </p>
      {permissions.includes("settings.manage") ? (
        <div style={{ inlineSize: "100%", maxInlineSize: 260 }}>
          <LinkButton href="/more/settings" variant="ghost">
            <GearIcon width={16} height={16} /> {l("empty.change")}
          </LinkButton>
        </div>
      ) : null}
    </div>
  );
}

function LoadingRows() {
  const l = useTranslations("catalog.lowStock");
  return (
    <>
      <p className={styles.muted} role="status" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <SyncIcon width={16} height={16} /> {l("loading")}
      </p>
      <Card style={{ paddingBlock: 0 }} aria-hidden="true">
        {[0, 1, 2].map((n) => (
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
