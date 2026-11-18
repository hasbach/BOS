"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { UIEvent } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import type { BannerIcon, BannerTone } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { BoxIcon, CloseIcon, EditIcon, ImageIcon, SyncIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { OfflineNotice } from "@/components/OfflineNotice";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { SessionEnded } from "@/components/SessionEnded";
import { Sheet } from "@/components/Sheet";
import { useRouter } from "@/i18n/navigation";
import { isApiError, isSessionEnded } from "@/lib/api";
import { CATALOG, archiveProduct, changedProduct, deleteProduct, getProduct, photoUrl, productName, restoreProduct } from "@/lib/catalog";
import type { Product, Variant } from "@/lib/catalog";
import { writeFailureMessage } from "@/lib/errors";
import { formatApproximate, formatMoney } from "@/lib/money";

import styles from "../catalog.module.css";
import { CatalogStatus, NotAllowedToEdit, Price, PriceRange, ProductNotFound, StockChip, StoreChips, useBusinessSettings, useCatalogAccess, variantLabel } from "../parts";

type Load = { k: "loading" } | { k: "error"; error: unknown } | { k: "gone" } | { k: "ready"; product: Product };

interface Notice {
  tone: BannerTone;
  icon: BannerIcon;
  text: string;
}

/** What the product form just saved, shown once on arrival (screen 173). */
export type Saved = "created" | "updated";

/** Screens 140 to 145: one product with its variants and stock numbers. */
export function ProductDetail({ productId, saved }: { productId: string; saved?: Saved }) {
  const c = useTranslations("catalog");
  const t = useTranslations();
  const [load, setLoad] = useState<Load>({ k: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getProduct(productId, controller.signal).then(
      (product) => setLoad({ k: "ready", product }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(isApiError(error) && error.code === "not_found" ? { k: "gone" } : { k: "error", error });
      },
    );
    return () => controller.abort();
  }, [productId, attempt]);

  if (load.k === "gone") return <ProductNotFound />;
  if (load.k === "error") {
    if (isSessionEnded(load.error)) return <SessionEnded />;
    if (isApiError(load.error) && load.error.code === "forbidden") return <NotAllowedToEdit />;
    return (
      <CatalogStatus title={c("title")} heading={c("productLoadError.title")} text={c("productLoadError.text")} tone="warn" icon="wifioff" alert backHref={CATALOG}>
        <Button
          onClick={() => {
            setLoad({ k: "loading" });
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
  if (load.k === "loading") {
    return (
      <Screen>
        <AppBar title={c("title")} backHref={CATALOG} backLabel={t("common.back")} />
        <ScreenBody>
          <p className={styles.muted} role="status" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <SyncIcon width={16} height={16} /> {t("ui.loading")}
          </p>
          <div className={styles.skeleton} style={{ blockSize: 200 }} aria-hidden="true" />
          <div className={styles.skeleton} style={{ blockSize: 24, inlineSize: "40%" }} aria-hidden="true" />
          <div className={styles.skeleton} style={{ blockSize: 160 }} aria-hidden="true" />
        </ScreenBody>
      </Screen>
    );
  }
  return <Loaded key={load.product.id} initial={load.product} saved={saved} />;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

function savedNotice(t: Translate, product: Product, saved?: Saved): Notice | null {
  if (!saved) return null;
  if (saved === "updated") return { tone: "ok", icon: "check", text: t("detail.saved") };
  const active = product.variants.filter((variant) => variant.status === "active");
  const units = active.reduce((sum, variant) => sum + variant.stock.on_hand, 0);
  return { tone: "ok", icon: "check", text: t("detail.savedCreated", { variants: active.length, units }) };
}

type Busy = "archive" | "restore" | "delete" | null;

function Loaded({ initial, saved }: { initial: Product; saved?: Saved }) {
  const t = useTranslations();
  const c = useTranslations("catalog");
  const locale = useLocale();
  const router = useRouter();
  const access = useCatalogAccess();
  const settings = useBusinessSettings();

  const [product, setProduct] = useState(initial);
  const [notice, setNotice] = useState<Notice | null>(() => savedNotice(c, initial, saved));
  const [sheet, setSheet] = useState<"archive" | "delete" | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [gone, setGone] = useState(false);

  if (gone) return <ProductNotFound />;

  const name = productName(product, locale) || product.code;
  const archived = product.status === "archived";
  const editable = access.manage && !archived;
  const active = product.variants.filter((variant) => variant.status === "active");
  const archivedVariants = access.manage ? product.variants.filter((variant) => variant.status === "archived") : [];
  const description = (locale === "ar" ? product.description_ar || product.description_en : product.description_en || product.description_ar)?.trim();

  /** What a refused or failed action means: the product changed (show it), it is gone, or a message. */
  function failed(error: unknown, inSheet: boolean) {
    const current = changedProduct(error);
    if (current) {
      setProduct(current);
      setSheet(null);
      setSheetError(null);
      setNotice({ tone: "bad", icon: "alert", text: c("detail.changed") });
      return;
    }
    if (isApiError(error) && error.code === "not_found") {
      setGone(true);
      return;
    }
    let text = writeFailureMessage(t, error);
    if (isApiError(error) && error.code === "variant_has_allocations") text = c("detail.hasAllocations");
    if (isApiError(error) && error.code === "has_history") {
      text = c("detail.hasHistory");
      setProduct((p) => ({ ...p, has_history: true }));
    }
    if (inSheet) setSheetError(text);
    else setNotice({ tone: "bad", icon: "alert", text });
  }

  async function archive() {
    setBusy("archive");
    setSheetError(null);
    try {
      const updated = await archiveProduct(product.id, product.version);
      setProduct(updated);
      setNotice(null);
      setSheet(null);
    } catch (error) {
      failed(error, true);
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy("restore");
    setNotice(null);
    try {
      const updated = await restoreProduct(product.id, product.version);
      setProduct(updated);
      setNotice({ tone: "ok", icon: "check", text: c("detail.restored") });
    } catch (error) {
      failed(error, false);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    setSheetError(null);
    try {
      await deleteProduct(product.id, product.version);
      router.replace(CATALOG);
    } catch (error) {
      failed(error, true);
      setBusy(null);
    }
  }

  function openSheet(kind: "archive" | "delete") {
    setSheetError(null);
    setSheet(kind);
  }

  return (
    <Screen>
      <AppBar
        title={name}
        subtitle={archived ? c("archived") : undefined}
        backHref={CATALOG}
        backLabel={t("common.back")}
        action={editable ? { href: `${CATALOG}/${product.id}/edit`, label: c("detail.edit"), icon: <EditIcon /> } : undefined}
      />
      <ScreenBody>
        <OfflineNotice />
        {notice ? (
          <Banner tone={notice.tone} icon={notice.icon} alert>
            {notice.text}
          </Banner>
        ) : null}
        {archived ? (
          <Banner tone="warn" icon="alert">
            {c("detail.archivedBanner")}
          </Banner>
        ) : null}

        <Gallery product={product} />

        <div>
          <ProductPrice variants={active.length > 0 ? active : product.variants} rate={settings.rate} />
          <div className={styles.chips} style={{ marginBlockStart: 6 }}>
            <StoreChips storeIds={product.store_ids} />
            <Chip>
              <bdi dir="ltr">{product.code}</bdi>
            </Chip>
          </div>
        </div>

        <Card>
          <div className={styles.between} style={{ marginBlockEnd: 4 }}>
            <span className={styles.label}>
              {c("detail.variants")} · {active.length}
            </span>
            <span className={styles.small}>{c("detail.availableRule")}</span>
          </div>
          <VariantTable variants={active} single={product.options.length === 0} sharedPrice={sharedPrice(active)} />
        </Card>

        {archivedVariants.length > 0 ? (
          <Card>
            <span className={styles.label}>
              {c("detail.archivedVariants")} · {archivedVariants.length}
            </span>
            <VariantTable variants={archivedVariants} single={product.options.length === 0} sharedPrice={sharedPrice(active)} />
          </Card>
        ) : null}

        {description ? (
          <Card>
            <span className={styles.label}>{c("detail.description")}</span>
            <p className={styles.muted} style={{ marginBlockStart: 4, whiteSpace: "pre-line" }}>
              {description}
            </p>
          </Card>
        ) : null}

        {access.manage ? (
          <Card className={styles.stack}>
            <span className={styles.label}>{c("detail.statusTitle")}</span>
            {archived ? (
              <>
                <p className={styles.muted}>{c("detail.restoreText")}</p>
                <Button loading={busy === "restore"} onClick={() => void restore()}>
                  <SyncIcon width={16} height={16} /> {c("detail.restore")}
                </Button>
              </>
            ) : (
              <>
                <p className={styles.muted}>{c("detail.archiveText")}</p>
                <Button variant="ghost" onClick={() => openSheet("archive")}>
                  <BoxIcon width={16} height={16} /> {c("detail.archive")}
                </Button>
              </>
            )}
            {!product.has_history ? (
              <div className={styles.stack} style={{ borderBlockStart: "1px solid var(--border)", paddingBlockStart: 10 }}>
                <p className={styles.muted}>{c("detail.deleteText")}</p>
                <Button variant="danger" onClick={() => openSheet("delete")}>
                  <CloseIcon width={16} height={16} /> {c("detail.delete")}
                </Button>
              </div>
            ) : null}
          </Card>
        ) : null}
      </ScreenBody>
      {editable ? (
        <ScreenFooter>
          <LinkButton href={`${CATALOG}/${product.id}/edit`} variant="ghost">
            <EditIcon width={16} height={16} /> {c("detail.edit")}
          </LinkButton>
        </ScreenFooter>
      ) : null}

      <Sheet
        open={sheet === "archive"}
        onClose={() => setSheet(null)}
        title={c("detail.archiveTitle", { name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheet(null)}>
              {c("detail.cancel")}
            </Button>
            <Button variant="danger" loading={busy === "archive"} onClick={() => void archive()}>
              <BoxIcon width={16} height={16} /> {c("detail.archiveConfirm")}
            </Button>
          </>
        }
      >
        <div className={styles.stack}>
          <p>{c("detail.archiveSheet")}</p>
          {sheetError ? (
            <Banner tone="bad" icon="alert" alert>
              {sheetError}
            </Banner>
          ) : null}
        </div>
      </Sheet>

      <Sheet
        open={sheet === "delete"}
        onClose={() => setSheet(null)}
        title={c("detail.deleteTitle", { name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheet(null)}>
              {c("detail.cancel")}
            </Button>
            {product.has_history ? (
              <Button variant="danger" loading={busy === "archive"} onClick={() => void archive()}>
                <BoxIcon width={16} height={16} /> {c("detail.archiveConfirm")}
              </Button>
            ) : (
              <Button variant="danger" loading={busy === "delete"} onClick={() => void remove()}>
                <CloseIcon width={16} height={16} /> {c("detail.deleteConfirm")}
              </Button>
            )}
          </>
        }
      >
        <div className={styles.stack}>
          <p>{c("detail.deleteSheet")}</p>
          {sheetError ? (
            <Banner tone="bad" icon="alert" alert>
              {sheetError}
            </Banner>
          ) : null}
        </div>
      </Sheet>
    </Screen>
  );
}

/** The price every given variant shares, or null when they differ. */
function sharedPrice(variants: Variant[]): { price: string; currency: Variant["currency"] } | null {
  const first = variants[0];
  if (!first) return null;
  const same = variants.every((variant) => variant.currency === first.currency && Number(variant.price) === Number(first.price));
  return same ? { price: first.price, currency: first.currency } : null;
}

function ProductPrice({ variants, rate }: { variants: Variant[]; rate: string | null }) {
  const c = useTranslations("catalog");
  const locale = useLocale();
  const shared = sharedPrice(variants);
  if (shared) {
    const approx = rate ? formatApproximate(shared.price, shared.currency, rate, locale) : null;
    return (
      <>
        <div className={styles.big}>
          <Price amount={shared.price} currency={shared.currency} />
        </div>
        {approx && rate ? <p className={styles.muted}>{c("detail.approx", { amount: approx, rate: formatMoney(rate, { trimZeros: true }) })}</p> : null}
      </>
    );
  }
  const byCurrency = (["USD", "LBP"] as const)
    .map((currency) => {
      const prices = variants.filter((variant) => variant.currency === currency).map((variant) => variant.price);
      if (prices.length === 0) return null;
      const sorted = [...prices].sort((a, b) => Number(a) - Number(b));
      return { currency, min: sorted[0] ?? "0", max: sorted[sorted.length - 1] ?? "0" };
    })
    .filter((entry) => entry !== null);
  return (
    <div className={styles.big}>
      <PriceRange prices={byCurrency} />
    </div>
  );
}

function VariantTable({ variants, single, sharedPrice: shared }: { variants: Variant[]; single: boolean; sharedPrice: { price: string; currency: Variant["currency"] } | null }) {
  const c = useTranslations("catalog");
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">{c("detail.variant")}</th>
          <th scope="col" className={styles.num}>
            {c("stock.onHand")}
          </th>
          <th scope="col" className={styles.num}>
            {c("stock.reserved")}
          </th>
          <th scope="col" className={styles.num}>
            {c("stock.available")}
          </th>
        </tr>
      </thead>
      <tbody>
        {variants.map((variant) => {
          const ownPrice = shared === null || variant.currency !== shared.currency || Number(variant.price) !== Number(shared.price);
          return [
            <tr key={variant.id}>
              <td>
                <span className={styles.name}>{single ? c("detail.onlyVariant") : variantLabel(variant.option_values)}</span>{" "}
                {variant.status === "archived" ? <Chip>{c("detail.archivedVariant")}</Chip> : <StockChip state={variant.stock_state} />}
              </td>
              <td className={styles.num}>{variant.stock.on_hand}</td>
              <td className={styles.num}>{variant.stock.allocated}</td>
              <td className={styles.num}>
                <b>{variant.stock.available}</b>
              </td>
            </tr>,
            <tr key={`${variant.id}-sku`} className={styles.sub}>
              <td colSpan={4}>
                <bdi dir="ltr" className={styles.nowrap}>
                  {variant.sku}
                </bdi>
                {ownPrice ? (
                  <>
                    {" · "}
                    <Price amount={variant.price} currency={variant.currency} />
                  </>
                ) : null}
              </td>
            </tr>,
          ];
        })}
      </tbody>
    </table>
  );
}

/** The photos at the large size, one at a time with a swipe; "1 / 3" says where you are. */
function Gallery({ product }: { product: Product }) {
  const c = useTranslations("catalog");
  const [index, setIndex] = useState(0);
  const count = product.photos.length;
  if (count === 0) {
    return (
      <div className={styles.noPhotoLarge}>
        <ImageIcon width={28} height={28} />
        <span className={styles.muted}>{c("detail.noPhoto")}</span>
      </div>
    );
  }
  function onScroll(event: UIEvent<HTMLDivElement>) {
    const strip = event.currentTarget;
    if (strip.clientWidth > 0) setIndex(Math.min(count - 1, Math.round(Math.abs(strip.scrollLeft) / strip.clientWidth)));
  }
  return (
    <div className={styles.galleryWrap}>
      <div className={styles.gallery} onScroll={onScroll} tabIndex={count > 1 ? 0 : undefined}>
        {product.photos.map((photo, n) => (
          <div key={photo.id} className={styles.slide}>
            {/* eslint-disable-next-line @next/next/no-img-element -- served by the API with the session cookie */}
            <img src={photoUrl(photo.id, "large")} alt={c("detail.photoOf", { n: n + 1, count })} loading={n === 0 ? "eager" : "lazy"} />
          </div>
        ))}
      </div>
      <span className={styles.galleryCount}>
        <Chip>
          <bdi dir="ltr">
            {index + 1} / {count}
          </bdi>
        </Chip>
      </span>
    </div>
  );
}
