"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import type { ComponentType, SVGProps } from "react";

import { AppBar } from "@/components/AppBar";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { BoxIcon, CartIcon, ChevronIcon, ClockIcon, GearIcon, ListIcon, StoreIcon, TruckIcon, UsersIcon } from "@/components/icons";
import { Loading } from "@/components/Loading";
import { Screen, ScreenBody, screenStyles } from "@/components/Screen";
import { Link, useRouter } from "@/i18n/navigation";
import { useMe } from "@/lib/session";
import { isTabKey, tabPath } from "@/lib/tabs";

import styles from "./placeholder.module.css";

type PlaceholderTab = "sales" | "packing" | "delivery" | "orders";

const ICONS: Record<PlaceholderTab, ComponentType<SVGProps<SVGSVGElement>>> = { sales: CartIcon, packing: BoxIcon, delivery: TruckIcon, orders: ListIcon };

/** Screen 106: the calm "coming soon" state for areas that later milestones fill (FR-029). Not an error. */
export function TabPlaceholder({ tab }: { tab: PlaceholderTab }) {
  const t = useTranslations();
  const router = useRouter();
  const me = useMe();
  const allowed = me.tabs.includes(tab);

  useEffect(() => {
    // A tab that is not one of this person's: go to their own start tab instead of showing it.
    if (!allowed) router.replace(isTabKey(me.start_tab) ? tabPath(me.start_tab) : "/more");
  }, [allowed, me.start_tab, router]);

  if (!allowed) return <Loading />;

  const can = (permission: string) => me.permissions.includes(permission);
  const ready: Array<{ href: string; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }> = [];
  if (can("store.view")) ready.push({ href: "/more/stores", label: t("more.stores"), Icon: StoreIcon });
  if (can("staff.view")) ready.push({ href: "/more/employees", label: t("more.employees"), Icon: UsersIcon });
  if (can("settings.manage")) ready.push({ href: "/more/settings", label: t("more.settings"), Icon: GearIcon });

  const Icon = ICONS[tab];
  return (
    <Screen>
      <AppBar title={t(`tabs.${tab}`)} subtitle={me.business.name} />
      <ScreenBody center>
        <div className={styles.soon}>
          <div className={styles.circle} aria-hidden="true">
            <Icon width={32} height={32} />
          </div>
          <Chip tone="info">
            <ClockIcon width={14} height={14} /> {t("soon.chip")}
          </Chip>
          <p className={styles.big}>{t(`tabs.${tab}`)}</p>
          <p className={styles.text}>{t(`soon.${tab}`)}</p>
          <p className={styles.note}>{t("soon.note")}</p>
        </div>
        {ready.length > 0 ? (
          <section aria-label={t("soon.ready")} className={styles.ready}>
            <p className={screenStyles.label}>{t("soon.ready")}</p>
            <Card style={{ padding: "0 12px" }}>
              <ul className={styles.list}>
                {ready.map((item) => (
                  <li key={item.href} className={styles.item}>
                    <Link href={item.href} className={styles.link}>
                      <item.Icon width={22} height={22} aria-hidden="true" />
                      <span className={styles.name}>{item.label}</span>
                      <ChevronIcon className={styles.chevron} width={18} height={18} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ) : null}
      </ScreenBody>
    </Screen>
  );
}
