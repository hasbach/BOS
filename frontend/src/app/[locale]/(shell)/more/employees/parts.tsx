"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { AlertIcon, BanIcon, CheckIcon, ClockIcon, LockIcon, StoreIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { Loading } from "@/components/Loading";
import { Screen, ScreenBody, ScreenFooter, StatusHeader } from "@/components/Screen";
import { SessionEnded } from "@/components/SessionEnded";
import { StoresProvider, useStoreChoices } from "@/components/StoresProvider";
import { isApiError, isSessionEnded } from "@/lib/api";
import { useMe } from "@/lib/session";
import { sortRoles, useStaffList } from "@/lib/staff";
import type { Role, StaffList } from "@/lib/staff";
import type { Seed } from "@/lib/seed";
import type { Store } from "@/lib/stores";

import styles from "./employees.module.css";

export const EMPLOYEES = "/more/employees";

/** What the signed-in user may do on these screens. The server still decides every request. */
export function useStaffAccess() {
  const { permissions } = useMe();
  return {
    view: permissions.includes("staff.view"),
    manage: permissions.includes("staff.manage"),
    manageOwners: permissions.includes("staff.manage_owners"),
  };
}

export function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("") || "?"
  );
}

export function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <div className={`${styles.avatar} ${large ? styles.avatarLarge : ""}`} aria-hidden="true">
      {initials(name)}
    </div>
  );
}

export function RoleChips({ roles }: { roles: Role[] }) {
  const t = useTranslations("staff.role");
  return (
    <div className={styles.pills}>
      {sortRoles(roles).map((role) => (
        <Chip key={role} tone={role === "owner" ? "info" : "neutral"}>
          {t(role)}
        </Chip>
      ))}
    </div>
  );
}

/** "All stores" or the stores' own names, as typed. */
export function StoreChips({ allStores, storeIds }: { allStores: boolean; storeIds: string[] }) {
  const t = useTranslations("staff");
  const stores = useStoreChoices();
  if (allStores) {
    return (
      <Chip>
        <StoreIcon width={14} height={14} /> {t("allStores")}
      </Chip>
    );
  }
  return (
    <>
      {storeIds.map((id) => {
        const store = stores.find((candidate) => candidate.id === id);
        return store ? <Chip key={id}>{store.name}</Chip> : null;
      })}
    </>
  );
}

export function StatusChip({ status }: { status: "active" | "inactive" | "pending" | "expired" }) {
  const t = useTranslations("staff.status");
  // The word carries the status; the icon and colour only reinforce it.
  switch (status) {
    case "active":
      return (
        <Chip tone="ok">
          <CheckIcon width={14} height={14} /> {t("active")}
        </Chip>
      );
    case "inactive":
      return (
        <Chip>
          <BanIcon width={14} height={14} /> {t("inactive")}
        </Chip>
      );
    case "pending":
      return (
        <Chip tone="warn">
          <ClockIcon width={14} height={14} /> {t("pending")}
        </Chip>
      );
    default:
      return (
        <Chip tone="bad">
          <AlertIcon width={14} height={14} /> {t("expired")}
        </Chip>
      );
  }
}

export function Contact({ phone, email }: { phone: string | null; email: string | null }) {
  return (
    <>
      {phone ? (
        <div className={styles.muted}>
          <bdi dir="ltr">{phone}</bdi>
        </div>
      ) : null}
      {email ? (
        <div className={styles.muted}>
          <bdi dir="ltr">{email}</bdi>
        </div>
      ) : null}
    </>
  );
}

export interface CheckItemProps {
  checked: boolean;
  label: string;
  description?: string;
  /** Shown but not changeable (forced or protected); the reason is the description. */
  locked?: boolean;
  dim?: boolean;
  onToggle?: () => void;
}

/** A tick box row, 56px tall for thumbs. The state is a tick mark and aria-checked, never colour alone. */
export function CheckItem({ checked, label, description, locked = false, dim = false, onToggle }: CheckItemProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={locked || dim ? true : undefined}
      className={styles.check}
      onClick={() => {
        if (!locked && !dim) onToggle?.();
      }}
    >
      <span className={`${styles.box} ${checked ? styles.boxOn : ""}`} aria-hidden="true">
        <CheckIcon width={16} height={16} />
      </span>
      <span className={styles.checkText}>
        <span className={styles.name}>{label}</span>
        {description ? <span className={styles.muted}>{description}</span> : null}
      </span>
      {locked ? <LockIcon width={16} height={16} aria-hidden="true" /> : null}
    </button>
  );
}

export function CheckGroup({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.fieldBlock}>
      <span className={styles.fieldLabel}>{label}</span>
      <Card className={error ? styles.invalidBox : ""} style={{ padding: "0 12px" }}>
        <div role="group" aria-label={label}>
          {children}
        </div>
      </Card>
      {error ? (
        <p className={styles.error} role="alert">
          <AlertIcon width={16} height={16} />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p className={styles.muted}>{hint}</p>
      ) : null}
    </div>
  );
}

function StatusScreen({
  icon,
  tone,
  heading,
  text,
  children,
  alert = false,
}: {
  icon: "lock" | "info" | "wifioff";
  tone: "accent" | "warn" | "info";
  heading: string;
  text: string;
  children: ReactNode;
  alert?: boolean;
}) {
  const t = useTranslations("staff");
  const common = useTranslations("common");
  return (
    <Screen>
      <AppBar title={t("title")} backHref="/more" backLabel={common("back")} />
      <ScreenBody>
        <div role={alert ? "alert" : undefined}>
          <StatusHeader tone={tone} icon={icon} title={heading} text={text} />
        </div>
      </ScreenBody>
      <ScreenFooter>{children}</ScreenFooter>
    </Screen>
  );
}

/** Screen 73: reached without staff.view, or the server answered forbidden. */
export function NotAllowedScreen() {
  const t = useTranslations("staff");
  return (
    <StatusScreen icon="lock" tone="info" heading={t("notAllowed.title")} text={t("notAllowed.text")}>
      <LinkButton href="/more">{t("backToMore")}</LinkButton>
    </StatusScreen>
  );
}

/** Screen 72: an employee or invitation that is not in this business (or no longer). */
export function NotFoundScreen() {
  const t = useTranslations("staff");
  return (
    <StatusScreen icon="info" tone="info" heading={t("notFound.title")} text={t("notFound.text")}>
      <LinkButton href={EMPLOYEES}>{t("backToEmployees")}</LinkButton>
    </StatusScreen>
  );
}

export interface StaffContext {
  list: StaffList;
  update: (change: (list: StaffList) => StaffList) => void;
  reload: () => void;
}

interface LoaderProps {
  children: (context: StaffContext) => ReactNode;
  loadingFooter?: ReactNode;
  /** GET /staff as the server already loaded it for this page (the list screen); then not loaded again. */
  initial?: Seed<StaffList>;
  /** GET /stores as the server already loaded it, for the store names. */
  initialStores?: Seed<Store[]>;
}

function Loader({ children, loadingFooter, initial, initialStores }: LoaderProps) {
  const t = useTranslations("staff");
  const ui = useTranslations("ui");
  const common = useTranslations("common");
  const { state, reload, update } = useStaffList(initial);

  if (state.k === "error") {
    if (isSessionEnded(state.error)) return <SessionEnded />;
    if (isApiError(state.error) && state.error.code === "forbidden") return <NotAllowedScreen />;
    return (
      <StatusScreen icon="wifioff" tone="warn" heading={t("loadError.title")} text={t("loadError.text")} alert>
        <Button onClick={reload}>{ui("retry")}</Button>
        <LinkButton href="/more" variant="ghost">
          {t("backToMore")}
        </LinkButton>
      </StatusScreen>
    );
  }
  if (state.k === "loading") {
    return (
      <Screen>
        <AppBar title={t("title")} backHref="/more" backLabel={common("back")} />
        <ScreenBody>
          <Loading label={t("loading")} />
        </ScreenBody>
        {loadingFooter ? <ScreenFooter>{loadingFooter}</ScreenFooter> : null}
      </Screen>
    );
  }
  return <StoresProvider initial={initialStores}>{children({ list: state.value, update, reload })}</StoresProvider>;
}

/**
 * Gate and loader shared by the list and both detail screens. No staff.view, or a forbidden answer,
 * shows the not-allowed screen; a failed load offers retry; the children receive the loaded list.
 */
export function StaffLoader({ children, loadingFooter, initial, initialStores }: LoaderProps) {
  const access = useStaffAccess();
  if (!access.view) return <NotAllowedScreen />;
  return (
    <Loader loadingFooter={loadingFooter} initial={initial} initialStores={initialStores}>
      {children}
    </Loader>
  );
}
