"use client";

import { useTranslations } from "next-intl";

import { AppBar } from "@/components/AppBar";
import { Card } from "@/components/Card";
import { ChevronIcon, UsersIcon } from "@/components/icons";
import { Screen, ScreenBody, screenStyles } from "@/components/Screen";
import { SignOutButton } from "@/components/SignOutButton";
import { Link } from "@/i18n/navigation";
import { useMe } from "@/lib/session";
import { sortRoles } from "@/lib/staff";

import styles from "./employees/employees.module.css";

/**
 * Screens 18 and 74. Only the entries the user's permissions allow are shown; the server still
 * checks every page behind them. Entries for later stories (Catalog, Reports, Stores, Settings,
 * History, Devices, Language) get their own slot in the lists below when those stories land.
 */
export function MoreMenu() {
  const t = useTranslations();
  const me = useMe();
  const can = (permission: string) => me.permissions.includes(permission);
  const roles = sortRoles(me.user.roles)
    .map((role) => t(`staff.role.${role}`))
    .join(", ");

  const setup: Array<{ key: string; href: string; label: string }> = [];
  // US3 adds Stores (store.view) and Currency and rate (settings.manage); US4 adds Language and
  // Devices; the History screen (audit.view) comes with US7. They are not built yet.
  if (can("staff.view")) setup.push({ key: "employees", href: "/more/employees", label: t("more.employees") });

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
            <p className={screenStyles.muted}>{t("more.profile", { name: me.user.name, roles })}</p>
          </div>
        </Card>
        {setup.length > 0 ? (
          <section className={styles.group} aria-label={t("more.setup")}>
            <h2 className={styles.groupLabel}>{t("more.setup")}</h2>
            <Card>
              <ul className={styles.list}>
                {setup.map((item) => (
                  <li key={item.key} className={styles.listItem}>
                    <Link href={item.href} className={styles.person} style={{ alignItems: "center" }}>
                      <UsersIcon width={22} height={22} aria-hidden="true" />
                      <span className={styles.personText}>
                        <span className={styles.name}>{item.label}</span>
                      </span>
                      <ChevronIcon className={styles.chevron} style={{ marginBlockStart: 0 }} width={18} height={18} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ) : null}
        <SignOutButton />
      </ScreenBody>
    </Screen>
  );
}
