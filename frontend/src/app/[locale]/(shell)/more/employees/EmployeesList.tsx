"use client";

import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { ChevronIcon, PlusIcon, UsersIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { Screen, ScreenBody, ScreenFooter, screenStyles } from "@/components/Screen";
import { Link } from "@/i18n/navigation";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/session";
import type { Role, StaffList } from "@/lib/staff";

import styles from "./employees.module.css";
import { Avatar, Contact, EMPLOYEES, RoleChips, StaffLoader, StatusChip, StoreChips, useStaffAccess } from "./parts";

interface RowData {
  key: string;
  href: string;
  name: string;
  you?: boolean;
  phone: string | null;
  email: string | null;
  roles: Role[];
  allStores: boolean;
  storeIds: string[];
  status: "active" | "inactive" | "pending" | "expired";
  note?: string;
}

function PersonRow({ row }: { row: RowData }) {
  const t = useTranslations("staff");
  return (
    <li className={styles.listItem}>
      <Link href={row.href} className={styles.person}>
        <Avatar name={row.name} />
        <span className={styles.personText}>
          <span className={styles.between}>
            <span className={styles.name}>
              {row.name}
              {row.you ? (
                <>
                  {" "}
                  <Chip>{t("you")}</Chip>
                </>
              ) : null}
            </span>
            <StatusChip status={row.status} />
          </span>
          <Contact phone={row.phone} email={row.email} />
          <RoleChips roles={row.roles} />
          <span className={styles.pills}>
            <span className={styles.muted}>{t("stores")}</span>
            <StoreChips allStores={row.allStores} storeIds={row.storeIds} />
          </span>
          {row.note ? <span className={styles.muted}>{row.note}</span> : null}
        </span>
        <ChevronIcon className={styles.chevron} width={18} height={18} />
      </Link>
    </li>
  );
}

function Group({ title, rows }: { title: string; rows: RowData[] }) {
  if (rows.length === 0) return null;
  return (
    <section className={styles.group} aria-label={title}>
      <h2 className={styles.groupLabel}>
        {title} · <span>{rows.length}</span>
      </h2>
      <Card>
        <ul className={styles.list}>
          {rows.map((row) => (
            <PersonRow key={row.key} row={row} />
          ))}
        </ul>
      </Card>
    </section>
  );
}

function InviteButton({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations("staff");
  const content = (
    <>
      <PlusIcon width={18} height={18} /> {t("invite")}
    </>
  );
  return disabled ? <Button disabled>{content}</Button> : <LinkButton href={`${EMPLOYEES}/invite`}>{content}</LinkButton>;
}

/** Screens 49 and 69 to 73: everyone in the business, grouped by status, and the way to invite someone. */
export function EmployeesList() {
  const access = useStaffAccess();
  return <StaffLoader loadingFooter={access.manage ? <InviteButton disabled /> : undefined}>{(ctx) => <Loaded list={ctx.list} />}</StaffLoader>;
}

function Loaded({ list }: { list: StaffList }) {
  const t = useTranslations("staff");
  const common = useTranslations("common");
  const locale = useLocale();
  const me = useMe();
  const access = useStaffAccess();

  const memberRow = (m: (typeof list.members)[number]): RowData => ({
    key: m.user_id,
    href: `${EMPLOYEES}/${m.user_id}`,
    name: m.name,
    you: m.user_id === me.user.id,
    phone: m.phone,
    email: m.email,
    roles: m.roles,
    allStores: m.all_stores,
    storeIds: m.store_ids,
    status: m.status,
  });
  const inviteRow = (i: (typeof list.invitations)[number]): RowData => ({
    key: i.invitation_id,
    href: `${EMPLOYEES}/invitations/${i.invitation_id}`,
    name: i.name,
    phone: i.phone,
    email: i.email,
    roles: i.roles,
    allStores: i.all_stores,
    storeIds: i.store_ids,
    status: i.status,
    note: i.status === "pending" ? t("expires", { date: formatDate(i.expires_at, locale) }) : t("expiredOn", { date: formatDate(i.expires_at, locale) }),
  });

  const active = list.members.filter((m) => m.status === "active").map(memberRow);
  const inactive = list.members.filter((m) => m.status === "inactive").map(memberRow);
  const pending = list.invitations.filter((i) => i.status === "pending").map(inviteRow);
  const expired = list.invitations.filter((i) => i.status === "expired").map(inviteRow);
  const onlyYou = list.members.length <= 1 && list.invitations.length === 0;

  let body: ReactNode;
  if (onlyYou) {
    body = (
      <>
        <Group title={t("groups.active")} rows={active} />
        <Card style={{ display: "grid", placeItems: "center", textAlign: "center", gap: 8, padding: "20px 16px" }}>
          <UsersIcon width={28} height={28} />
          <h2 className={screenStyles.title}>{t("empty.title")}</h2>
          <p className={screenStyles.muted}>{t("empty.text")}</p>
        </Card>
      </>
    );
  } else {
    body = (
      <>
        <Group title={t("groups.active")} rows={active} />
        <Group title={t("groups.inactive")} rows={inactive} />
        <Group title={t("groups.pending")} rows={pending} />
        <Group title={t("groups.expired")} rows={expired} />
      </>
    );
  }

  return (
    <Screen>
      <AppBar title={t("title")} subtitle={me.business.name} backHref="/more" backLabel={common("back")} />
      <ScreenBody>{body}</ScreenBody>
      {access.manage ? (
        <ScreenFooter>
          <InviteButton />
        </ScreenFooter>
      ) : null}
    </Screen>
  );
}
