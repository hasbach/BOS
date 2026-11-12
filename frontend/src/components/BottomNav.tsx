"use client";

import { useTranslations } from "next-intl";
import type { ComponentType, SVGProps } from "react";

import { Link, usePathname } from "@/i18n/navigation";
import { useMe } from "@/lib/session";
import { activeTab, tabPath, visibleTabs } from "@/lib/tabs";
import type { TabKey } from "@/lib/tabs";

import { BoxIcon, CartIcon, ListIcon, MenuIcon, TruckIcon } from "./icons";
import styles from "./BottomNav.module.css";

const ICONS: Record<TabKey, ComponentType<SVGProps<SVGSVGElement>>> = {
  sales: CartIcon,
  packing: BoxIcon,
  delivery: TruckIcon,
  orders: ListIcon,
  more: MenuIcon,
};

/**
 * The bottom tab bar (screens 103 to 105). The tabs come from GET /me. The active tab is shown by a
 * filled plate behind a heavier icon and a bold label, and announced with aria-current: never by
 * colour alone.
 */
export function BottomNav() {
  const t = useTranslations("tabs");
  const me = useMe();
  const pathname = usePathname();
  const tabs = visibleTabs(me.tabs);
  const current = activeTab(pathname);

  return (
    <nav className={styles.nav} aria-label={t("aria")}>
      <div className={styles.inner} style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
        {tabs.map((key) => {
          const Icon = ICONS[key];
          const on = key === current;
          return (
            <Link key={key} href={tabPath(key)} className={`${styles.tab} ${on ? styles.on : ""}`} aria-current={on ? "page" : undefined}>
              <span className={styles.plate} data-plate={on ? "on" : "off"}>
                <Icon width={22} height={22} />
              </span>
              <span className={styles.label}>{t(key)}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
