"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { AppBar } from "@/components/AppBar";
import { Chip } from "@/components/Chip";
import { ImageIcon, StoreIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { Screen, ScreenBody, ScreenFooter, StatusHeader } from "@/components/Screen";
import { useMeStores } from "@/components/StoresProvider";
import { api } from "@/lib/api";
import type { Business } from "@/lib/business";
import { CATALOG, photoUrl } from "@/lib/catalog";
import type { ProductSummary, StockState } from "@/lib/catalog";
import { formatAmount } from "@/lib/money";
import { useMe } from "@/lib/session";
import type { Currency } from "@/lib/types";

import styles from "./catalog.module.css";

/** What the signed-in person may do on the catalog screens. The server still decides every request. */
export function useCatalogAccess() {
  const { permissions } = useMe();
  return {
    view: permissions.includes("catalog.view"),
    manage: permissions.includes("catalog.manage"),
    adjust: permissions.includes("stock.adjust"),
  };
}

export interface BusinessSettings {
  /** LBP for 1 USD, or null until loaded (or when it could not be loaded: then nothing approximate is shown). */
  rate: string | null;
  lowDefault: number | null;
}

/**
 * The exchange rate and low-stock default from GET /business, for the "≈" amounts and the
 * "business default" wording. A failure only hides those hints; the screen works without them.
 */
export function useBusinessSettings(): BusinessSettings {
  const [settings, setSettings] = useState<BusinessSettings>({ rate: null, lowDefault: null });
  useEffect(() => {
    const controller = new AbortController();
    api.get<Business>("/business", { signal: controller.signal }).then(
      (business) => setSettings({ rate: business.usd_lbp_rate ?? null, lowDefault: typeof business.low_stock_default === "number" ? business.low_stock_default : null }),
      () => undefined,
    );
    return () => controller.abort();
  }, []);
  return settings;
}

/** Option values as one line: "32 · Blue". */
export const variantLabel = (values: readonly string[]) => values.join(" · ");

/** A price in its own currency; dollars stay left to right inside Arabic text. */
export function Price({ amount, currency }: { amount: string; currency: Currency }) {
  const locale = useLocale();
  const text = formatAmount(amount, currency, locale);
  return locale === "ar" && currency === "LBP" ? <span>{text}</span> : <bdi dir="ltr">{text}</bdi>;
}

/** The list row's prices: each currency on its own, a range when variants differ ("$38.00 – $42.00"). */
export function PriceRange({ prices }: { prices: ProductSummary["prices"] }) {
  const locale = useLocale();
  const parts = prices.map((price) => {
    const min = formatAmount(price.min, price.currency, locale);
    const max = formatAmount(price.max, price.currency, locale);
    return min === max ? min : `${min} – ${max}`;
  });
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return locale === "ar" && prices.every((price) => price.currency === "LBP") ? <span>{text}</span> : <bdi dir="ltr">{text}</bdi>;
}

/** "Low" and "Out" as words; the colour only reinforces them. Nothing for a variant that is fine. */
export function StockChip({ state }: { state: StockState }) {
  const t = useTranslations("catalog.stock");
  if (state === "low") return <Chip tone="warn">{t("low")}</Chip>;
  if (state === "out") return <Chip tone="bad">{t("out")}</Chip>;
  return null;
}

/** The product's stores among the person's own (the fresh GET /me), or "No store". */
export function StoreChips({ storeIds }: { storeIds: readonly string[] }) {
  const t = useTranslations("catalog");
  const stores = useMeStores();
  if (storeIds.length === 0) {
    return (
      <Chip>
        <StoreIcon width={14} height={14} /> {t("noStore")}
      </Chip>
    );
  }
  const named = stores.filter((store) => storeIds.includes(store.id));
  return (
    <>
      {named.map((store) => (
        <Chip key={store.id} tone={stores.indexOf(store) % 2 === 0 ? "storeA" : "storeB"}>
          {store.name}
        </Chip>
      ))}
    </>
  );
}

/** A product photo at the small size, or a dashed "no photo" tile. A photo that can't load shows the tile too. */
export function ProductThumb({ photoId, name }: { photoId: string | null; name: string }) {
  return <Thumb key={photoId ?? "none"} photoId={photoId} name={name} />;
}

function Thumb({ photoId, name }: { photoId: string | null; name: string }) {
  const t = useTranslations("catalog");
  const [failed, setFailed] = useState(false);
  if (photoId && !failed) {
    return (
      <div className={styles.thumb}>
        {/* eslint-disable-next-line @next/next/no-img-element -- served by the API with the session cookie */}
        <img className={styles.image} src={photoUrl(photoId, "thumb")} alt={name} loading="lazy" onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className={`${styles.thumb} ${photoId ? "" : styles.noPhoto}`} role="img" aria-label={photoId ? name : t("noPhoto")}>
      <ImageIcon width={20} height={20} />
    </div>
  );
}

/** A full-screen status with a heading, one sentence and the way out (screens 138, 145). */
export function CatalogStatus({
  title,
  heading,
  text,
  tone,
  icon,
  alert = false,
  backHref = "/more",
  children,
}: {
  title: string;
  heading: string;
  text: string;
  tone: "warn" | "info";
  icon: "wifioff" | "info" | "lock";
  alert?: boolean;
  backHref?: string;
  children: ReactNode;
}) {
  const common = useTranslations("common");
  return (
    <Screen>
      <AppBar title={title} backHref={backHref} backLabel={common("back")} />
      <ScreenBody>
        <div role={alert ? "alert" : undefined}>
          <StatusHeader tone={tone} icon={icon} title={heading} text={text} />
        </div>
      </ScreenBody>
      <ScreenFooter>{children}</ScreenFooter>
    </Screen>
  );
}

/** Screen 145: deleted, archived for staff, outside the person's stores or another business. Same words for all. */
export function ProductNotFound() {
  const t = useTranslations("catalog");
  return (
    <CatalogStatus title={t("title")} heading={t("notFound.title")} text={t("notFound.text")} tone="info" icon="info" backHref={CATALOG}>
      <LinkButton href={CATALOG}>{t("backToCatalog")}</LinkButton>
    </CatalogStatus>
  );
}

/** The product form for someone without catalog.manage (or a forbidden answer). */
export function NotAllowedToEdit({ backHref = CATALOG }: { backHref?: string }) {
  const t = useTranslations("catalog");
  return (
    <CatalogStatus title={t("title")} heading={t("notAllowed.title")} text={t("notAllowed.text")} tone="info" icon="lock" backHref={backHref}>
      <LinkButton href={backHref}>{t("backToCatalog")}</LinkButton>
    </CatalogStatus>
  );
}
