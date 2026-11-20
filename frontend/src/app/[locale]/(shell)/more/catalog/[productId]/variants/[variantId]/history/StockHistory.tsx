"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type { ComponentType, SVGProps } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { BoxIcon, CheckIcon, ClockIcon, EditIcon, MinusIcon, PlusIcon, SyncIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { Loading } from "@/components/Loading";
import { OfflineNotice } from "@/components/OfflineNotice";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { SessionEnded } from "@/components/SessionEnded";
import { isApiError, isSessionEnded } from "@/lib/api";
import { eventName } from "@/lib/audit";
import { CATALOG, getProduct, productName } from "@/lib/catalog";
import type { Product, StockNumbers, Variant } from "@/lib/catalog";
import { listMovements, stockStateOf } from "@/lib/stock";
import type { AdjustmentResult, Movement, MovementReason } from "@/lib/stock";
import { beirutDayKey, daysAgo, formatBeirutDate, formatClock, formatWeekdayDate } from "@/lib/time";

import styles from "../../../../catalog.module.css";
import { CatalogStatus, ProductNotFound, useCatalogAccess, variantLabel } from "../../../../parts";
import { AdjustStockSheet, StockFigures, signed } from "../../../AdjustStockSheet";
import own from "../../../stock.module.css";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const REASON_ICONS: Record<MovementReason, Icon> = {
  opening: PlusIcon,
  received: PlusIcon,
  found: PlusIcon,
  damaged: MinusIcon,
  lost: MinusIcon,
  count_correction: CheckIcon,
  other: EditIcon,
  allocation_consumed: BoxIcon,
};

type Load =
  | { k: "loading" }
  | { k: "forbidden" }
  | { k: "gone" }
  | { k: "ended" }
  | { k: "error" }
  | { k: "ready"; product: Product; movements: Movement[]; next: string | null };
type More = "idle" | "loading" | "error";

/** Design 156: what a sales, packing or dispatch user gets from an old link. */
function NotAllowed() {
  const h = useTranslations("catalog.history");
  const c = useTranslations("catalog");
  return (
    <CatalogStatus title={h("title")} heading={h("notAllowed.title")} text={h("notAllowed.text")} tone="info" icon="lock" backHref={CATALOG}>
      <LinkButton href={CATALOG}>{c("backToCatalog")}</LinkButton>
    </CatalogStatus>
  );
}

/** Designs 153 to 156: one variant's stock movements, newest first, 50 at a time (stock.adjust holders). */
export function StockHistory({ productId, variantId }: { productId: string; variantId: string }) {
  const access = useCatalogAccess();
  if (!access.adjust) return <NotAllowed />;
  return <History productId={productId} variantId={variantId} />;
}

function History({ productId, variantId }: { productId: string; variantId: string }) {
  const t = useTranslations();
  const h = useTranslations("catalog.history");
  const c = useTranslations("catalog");
  const locale = useLocale();
  const [load, setLoad] = useState<Load>({ k: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<More>("idle");
  const [adjusting, setAdjusting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getProduct(productId, controller.signal), listMovements(variantId, undefined, controller.signal)]).then(
      ([product, page]) => {
        const found = product.variants.some((variant) => variant.id === variantId);
        setLoad(found ? { k: "ready", product, movements: page.items, next: page.next_cursor } : { k: "gone" });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (isSessionEnded(error)) setLoad({ k: "ended" });
        else if (isApiError(error) && error.code === "forbidden") setLoad({ k: "forbidden" });
        else if (isApiError(error) && error.code === "not_found") setLoad({ k: "gone" });
        else setLoad({ k: "error" });
      },
    );
    return () => controller.abort();
  }, [productId, variantId, attempt]);

  if (load.k === "ended") return <SessionEnded />;
  if (load.k === "forbidden") return <NotAllowed />;
  if (load.k === "gone") return <ProductNotFound />;
  if (load.k === "error") {
    return (
      <CatalogStatus title={h("title")} heading={h("loadError.title")} text={h("loadError.text")} tone="warn" icon="wifioff" alert backHref={`${CATALOG}/${productId}`}>
        <Button
          onClick={() => {
            setLoad({ k: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          <SyncIcon width={16} height={16} /> {t("ui.retry")}
        </Button>
      </CatalogStatus>
    );
  }
  if (load.k === "loading") {
    return (
      <Screen>
        <AppBar title={h("title")} backHref={`${CATALOG}/${productId}`} backLabel={t("common.back")} />
        <ScreenBody>
          <Loading label={h("loading")} />
        </ScreenBody>
      </Screen>
    );
  }

  const { product, movements, next } = load;
  const variant = product.variants.find((v) => v.id === variantId) as Variant;
  const single = product.options.length === 0;
  const label = single ? c("detail.onlyVariant") : variantLabel(variant.option_values);
  const productArchived = product.status === "archived";

  async function loadMore() {
    if (load.k !== "ready" || !load.next || more === "loading") return;
    setMore("loading");
    try {
      const page = await listMovements(variantId, load.next);
      setLoad((current) => (current.k === "ready" ? { ...current, movements: [...current.movements, ...page.items], next: page.next_cursor } : current));
      setMore("idle");
    } catch {
      setMore("error");
    }
  }

  function setBalance(balance: StockNumbers, movement?: Movement) {
    setLoad((current) =>
      current.k === "ready"
        ? {
            ...current,
            product: {
              ...current.product,
              variants: current.product.variants.map((v) => (v.id === variantId ? { ...v, stock: balance, stock_state: stockStateOf(balance, v.effective_low_stock_level) } : v)),
            },
            movements: movement ? [movement, ...current.movements.filter((m) => m.id !== movement.id)] : current.movements,
          }
        : current,
    );
  }

  function adjusted(_: string, result: AdjustmentResult) {
    setBalance(result.balance, result.movement);
    setSaved(c("adjust.saved", { variant: label, onHand: result.balance.on_hand, available: result.balance.available }));
    setAdjusting(false);
  }

  return (
    <Screen>
      <AppBar title={h("title")} subtitle={productName(product, locale) || product.code} backHref={`${CATALOG}/${productId}`} backLabel={t("common.back")} />
      <ScreenBody>
        <OfflineNotice />
        {saved ? (
          <Banner tone="ok" icon="check" alert>
            {saved}
          </Banner>
        ) : null}
        <Card>
          <div className={styles.name}>{label}</div>
          <bdi dir="ltr" className={styles.muted}>
            {variant.sku}
          </bdi>
          <div style={{ marginBlockStart: 8 }}>
            <StockFigures numbers={variant.stock} label={c("adjust.numbers")} />
          </div>
        </Card>

        {movements.length === 0 ? (
          <div className={styles.center}>
            <div className={styles.emptyCircle} aria-hidden="true">
              <ClockIcon width={28} height={28} />
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700 }}>{h("empty.title")}</h2>
            <p style={{ fontSize: 14, color: "var(--fg-2)", maxInlineSize: 280 }}>{h("empty.text")}</p>
          </div>
        ) : (
          <>
            <p className={styles.small}>{t("history.note")}</p>
            <Days movements={movements} locale={locale} />
            {more === "loading" ? (
              <Card style={{ padding: 0 }} aria-busy="true">
                <ul className={own.list}>
                  {[0, 1].map((n) => (
                    <li key={n} className={own.move} aria-hidden="true">
                      <div className={`${styles.skeleton} ${own.icon}`} />
                      <div className={own.text} style={{ gap: 8 }}>
                        <div className={styles.skeleton} style={{ blockSize: 14, inlineSize: "50%" }} />
                        <div className={styles.skeleton} style={{ blockSize: 12, inlineSize: "75%" }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            {more === "error" ? (
              <Banner tone="bad" icon="alert" alert>
                {t("history.moreError")}
              </Banner>
            ) : null}
            {next ? (
              <Button variant="ghost" loading={more === "loading"} onClick={() => void loadMore()}>
                {more === "loading" ? (
                  <>
                    <SyncIcon width={16} height={16} /> {t("history.loadingMore")}
                  </>
                ) : (
                  t("history.loadMore")
                )}
              </Button>
            ) : (
              <p className={styles.small} style={{ textAlign: "center" }}>
                {h("end")}
              </p>
            )}
          </>
        )}
      </ScreenBody>
      {!productArchived ? (
        <ScreenFooter>
          <Button variant="ink" onClick={() => setAdjusting(true)}>
            {c("detail.adjust")}
          </Button>
        </ScreenFooter>
      ) : null}

      <AdjustStockSheet
        open={adjusting}
        variants={[variant]}
        variantId={variantId}
        single={single}
        onClose={() => setAdjusting(false)}
        onSaved={adjusted}
        onBalance={(_, balance) => setBalance(balance)}
      />
    </Screen>
  );
}

function Days({ movements, locale }: { movements: Movement[]; locale: string }) {
  const t = useTranslations();
  const now = new Date();

  const days = useMemo(() => {
    const groups: Array<{ key: string; at: string; items: Movement[] }> = [];
    for (const movement of movements) {
      const key = beirutDayKey(movement.at);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(movement);
      else groups.push({ key, at: movement.at, items: [movement] });
    }
    return groups;
  }, [movements]);

  function heading(at: string): string {
    const ago = daysAgo(at, now);
    if (ago >= 180) return formatBeirutDate(at, locale);
    const date = formatWeekdayDate(at, locale);
    if (ago <= 0) return t("history.today", { date });
    if (ago === 1) return t("history.yesterday", { date });
    return date;
  }

  return (
    <>
      {days.map((day) => {
        const title = heading(day.at);
        return (
          <section key={day.key} className={own.group} aria-label={title}>
            <h2 className={styles.label}>{title}</h2>
            <Card style={{ padding: 0 }}>
              <ul className={own.list}>
                {day.items.map((movement) => (
                  <Row key={movement.id} movement={movement} locale={locale} />
                ))}
              </ul>
            </Card>
          </section>
        );
      })}
    </>
  );
}

/** One movement: reason, signed change, what was counted, where opening stock came from, the note, then on hand after · who · time. */
function Row({ movement, locale }: { movement: Movement; locale: string }) {
  const t = useTranslations();
  const c = useTranslations("catalog");
  const h = useTranslations("catalog.history");
  const Icon = REASON_ICONS[movement.reason] ?? EditIcon;
  const who = movement.actor_type === "system" || !movement.actor_name ? t("history.actor.system") : movement.actor_name;
  // Reserve/release only change availability and appear in audit history. Consumption changes on hand.
  const source = movement.source === "allocation"
    ? eventName("stock.consumed", t)
    : movement.reason === "opening" ? h(`source.${movement.source}`) : null;

  return (
    <li className={own.move}>
      <div className={own.icon} aria-hidden="true">
        <Icon width={16} height={16} />
      </div>
      <div className={own.text}>
        <div className={styles.between}>
          <span className={styles.name}>{c(`reasons.${movement.reason}`)}</span>
          <bdi dir="ltr" className={own.change}>
            {signed(movement.quantity)}
          </bdi>
        </div>
        {movement.counted_quantity !== null ? <span className={styles.muted}>{h("counted", { n: movement.counted_quantity })}</span> : null}
        {source ? <span className={styles.muted}>{source}</span> : null}
        {movement.note ? <span className={styles.muted}>{h("noteLine", { note: movement.note })}</span> : null}
        <span className={styles.small}>
          {h("onHandAfter")} <b>{movement.on_hand_after}</b>
          {" · "}
          {t("history.by", { who })}
          {" · "}
          <bdi dir="ltr">{formatClock(movement.at, locale)}</bdi>
        </span>
      </div>
    </li>
  );
}
