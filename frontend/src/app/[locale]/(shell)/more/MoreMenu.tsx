"use client";

import { useLocale, useTranslations } from "next-intl";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { AppBar } from "@/components/AppBar";
import { Card } from "@/components/Card";
import { ChevronIcon, ClockIcon, GearIcon, GlobeIcon, PhoneIcon, StoreIcon, UserIcon, UsersIcon } from "@/components/icons";
import { Screen, ScreenBody, screenStyles } from "@/components/Screen";
import { SignOutButton } from "@/components/SignOutButton";
import { Link } from "@/i18n/navigation";
import { useMe } from "@/lib/session";
import { sortRoles } from "@/lib/staff";
import { formatWhatsapp } from "@/lib/stores";

import styles from "./employees/employees.module.css";

interface Item {
  key: string;
  href: string;
  label: string;
  hint?: ReactNode;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

function Group({ title, items }: { title: string; items: Item[] }) {
  if (items.length === 0) return null;
  return (
    <section className={styles.group} aria-label={title}>
      <h2 className={styles.groupLabel}>{title}</h2>
      <Card>
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.key} className={styles.listItem}>
              <Link href={item.href} className={styles.person} style={{ alignItems: "center" }}>
                <item.Icon width={22} height={22} aria-hidden="true" />
                <span className={styles.personText}>
                  <span className={styles.name}>{item.label}</span>
                  {item.hint ? <span className={styles.muted}>{item.hint}</span> : null}
                </span>
                <ChevronIcon className={styles.chevron} style={{ marginBlockStart: 0 }} width={18} height={18} />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/**
 * Screens 107 and 108. Only the entries the person's permissions allow are shown; the server still
 * checks every page behind them. Profile, Devices and Language are for everyone.
 */
export function MoreMenu() {
  const t = useTranslations();
  const locale = useLocale();
  const me = useMe();
  const can = (permission: string) => me.permissions.includes(permission);
  const roles = sortRoles(me.user.roles)
    .map((role) => t(`staff.role.${role}`))
    .join(", ");

  const business: Item[] = [];
  if (can("store.view")) business.push({ key: "stores", href: "/more/stores", label: t("more.stores"), hint: t("more.storeCount", { count: me.stores.length }), Icon: StoreIcon });
  if (can("staff.view")) business.push({ key: "employees", href: "/more/employees", label: t("more.employees"), Icon: UsersIcon });
  if (can("settings.manage")) business.push({ key: "settings", href: "/more/settings", label: t("more.settings"), Icon: GearIcon });
  if (can("audit.view")) business.push({ key: "history", href: "/more/history", label: t("more.history"), hint: t("more.historyHint"), Icon: ClockIcon });

  const account: Item[] = [
    {
      key: "profile",
      href: "/more/profile",
      label: t("more.profileLink"),
      hint: (
        <>
          {me.user.name}
          {me.user.phone ? (
            <>
              {" · "}
              <bdi dir="ltr">{formatWhatsapp(me.user.phone)}</bdi>
            </>
          ) : null}
        </>
      ),
      Icon: UserIcon,
    },
    { key: "devices", href: "/more/devices", label: t("more.devices"), Icon: PhoneIcon },
    { key: "language", href: "/more/language", label: t("more.language"), hint: locale === "ar" ? "العربية" : "English", Icon: GlobeIcon },
  ];

  return (
    <Screen>
      <AppBar title={t("more.title")} />
      <ScreenBody>
        <Card style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className={screenStyles.logo} style={{ inlineSize: 48, blockSize: 48, borderRadius: 12, fontSize: 15 }} aria-hidden="true">
            BOS
          </div>
          <div>
            <p className={screenStyles.title}>{me.business.name}</p>
            <p className={screenStyles.muted}>{t("more.signedIn", { name: me.user.name, roles })}</p>
          </div>
        </Card>
        <Group title={t("more.business")} items={business} />
        <Group title={t("more.account")} items={account} />
        <SignOutButton />
      </ScreenBody>
    </Screen>
  );
}
