"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Card } from "@/components/Card";
import { AlertIcon, ChevronIcon } from "@/components/icons";
import { screenStyles } from "@/components/Screen";
import { Link } from "@/i18n/navigation";
import { CATALOG } from "@/lib/catalog";
import { catalogScreenScope } from "@/lib/catalogScreenSeed";
import type { CatalogScreenSeed } from "@/lib/catalogScreenSeed";
import { lowStockShortcut } from "@/lib/lowStockShortcut";
import type { LowStockShortcut } from "@/lib/lowStockShortcut";
import { useSeed } from "@/lib/seed";
import { useMe } from "@/lib/session";
import { listLowStock } from "@/lib/stock";

import styles from "../placeholder.module.css";

type Props = { seed?: CatalogScreenSeed<LowStockShortcut> };

/**
 * Screen 157: the "Needs attention" row at the top of the owner's and manager's start tab, with the
 * total and the first two names of the Low stock list's first page. It is left out entirely when
 * nothing is low or the list can't load: a shortcut that fails must not get in the way.
 */
export function LowStockRow({ seed }: Props) {
  const me = useMe();
  if (!me.permissions.includes("stock.adjust")) return null;
  const scope = catalogScreenScope(me);
  const current = seed?.value.scope === scope ? seed : undefined;
  return <Row key={JSON.stringify([scope, current?.id])} seed={current} />;
}

function Row({ seed }: Props) {
  const t = useTranslations("catalog.lowStock.row");
  const locale = useLocale();
  const initial = useSeed(seed);
  const [low, setLow] = useState<LowStockShortcut | null>(initial?.data ?? null);

  useEffect(() => {
    if (initial) return;
    const controller = new AbortController();
    void listLowStock({}, controller.signal).then((page) => {
      if (!controller.signal.aborted) setLow(lowStockShortcut(page, locale));
    }).catch(() => undefined); // Optional shortcut: leave it out if its data cannot be loaded.
    return () => controller.abort();
  }, [initial, locale]);

  if (!low || low.total === 0 || low.first.length === 0) return null;

  const names = low.first.join(locale === "ar" ? "، " : ", ");
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
