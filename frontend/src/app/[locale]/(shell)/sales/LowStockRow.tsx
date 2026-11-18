"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Card } from "@/components/Card";
import { AlertIcon, ChevronIcon } from "@/components/icons";
import { screenStyles } from "@/components/Screen";
import { Link } from "@/i18n/navigation";
import { CATALOG, productName } from "@/lib/catalog";
import { listLowStock } from "@/lib/stock";
import type { LowStockItem } from "@/lib/stock";
import { useMe } from "@/lib/session";

import styles from "../placeholder.module.css";

const SHOWN = 2;

/**
 * Screen 157: the "Needs attention" row at the top of the owner's and manager's start tab, with the
 * total and the first two names of the Low stock list's first page. It is left out entirely when
 * nothing is low or the list can't load: a shortcut that fails must not get in the way.
 */
export function LowStockRow() {
  const { permissions } = useMe();
  if (!permissions.includes("stock.adjust")) return null;
  return <Row />;
}

function Row() {
  const t = useTranslations("catalog.lowStock.row");
  const locale = useLocale();
  const [low, setLow] = useState<{ total: number; first: LowStockItem[] } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listLowStock({}, controller.signal).then(
      (page) => setLow({ total: typeof page.total === "number" ? page.total : page.items.length, first: page.items.slice(0, SHOWN) }),
      () => undefined,
    );
    return () => controller.abort();
  }, []);

  if (!low || low.total === 0 || low.first.length === 0) return null;

  const names = low.first
    .map((item) => [productName({ name_en: item.product_name_en, name_ar: item.product_name_ar }, locale) || item.sku, item.option_values.join(" · ")].filter(Boolean).join(" "))
    .join(locale === "ar" ? "، " : ", ");
  const rest = low.total - low.first.length;

  return (
    <section aria-label={t("label")} className={styles.attention}>
      <p className={screenStyles.label}>{t("label")}</p>
      <Card style={{ padding: "0 12px" }}>
        <Link href={`${CATALOG}/low-stock`} className={styles.link}>
          <AlertIcon width={22} height={22} aria-hidden="true" />
          <span className={styles.grow}>
            <span className={styles.rowTitle}>{t("count", { count: low.total })}</span>
            <span className={styles.sub}>{rest > 0 ? t("more", { names, count: rest }) : names}</span>
          </span>
          <ChevronIcon className={styles.chevron} width={18} height={18} />
        </Link>
      </Card>
    </section>
  );
}
