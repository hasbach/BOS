"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { ReactNode } from "react";

import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { BanIcon, CheckIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { Loading } from "@/components/Loading";
import { Screen, ScreenBody, ScreenFooter, StatusHeader } from "@/components/Screen";
import { isApiError } from "@/lib/api";
import { useMe } from "@/lib/session";
import { STORES, logoUrl, storeInitials, useStoresList } from "@/lib/stores";
import type { Store } from "@/lib/stores";

import styles from "./stores.module.css";

/** What the signed-in user may do on these screens. The server still decides every request. */
export function useStoreAccess() {
  const { permissions } = useMe();
  return { view: permissions.includes("store.view"), manage: permissions.includes("store.manage") };
}

/** The store's logo, or its initials when it has none or the image cannot be read (404). */
export function StoreLogo({ store, version = 0, large = false }: { store: Pick<Store, "id" | "name" | "has_logo">; version?: number; large?: boolean }) {
  // A new key resets the "image failed" state when the logo or its version changes.
  return <Thumb key={`${store.id}-${store.has_logo}-${version}`} store={store} version={version} large={large} />;
}

function Thumb({ store, version, large }: { store: Pick<Store, "id" | "name" | "has_logo">; version: number; large: boolean }) {
  const t = useTranslations("stores");
  const [failed, setFailed] = useState(false);
  const classes = [styles.thumb, large ? styles.thumbLarge : ""].filter(Boolean).join(" ");
  if (store.has_logo && !failed) {
    return (
      <div className={classes}>
        {/* eslint-disable-next-line @next/next/no-img-element -- served by the API with the session cookie; not an optimisable static image */}
        <img className={styles.image} src={logoUrl(store.id, version)} alt={t("logoOf", { name: store.name })} onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className={classes} aria-hidden="true">
      {storeInitials(store.name)}
    </div>
  );
}

export function StatusChip({ status }: { status: Store["status"] }) {
  const t = useTranslations("stores.status");
  // The word carries the status; the icon and colour only reinforce it.
  return status === "active" ? (
    <Chip tone="ok">
      <CheckIcon width={14} height={14} /> {t("active")}
    </Chip>
  ) : (
    <Chip>
      <BanIcon width={14} height={14} /> {t("inactive")}
    </Chip>
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
  const t = useTranslations("stores");
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

/** Screen 98: reached without store.manage, or the server answered forbidden. */
export function NotAllowedScreen() {
  const t = useTranslations("stores");
  return (
    <StatusScreen icon="lock" tone="info" heading={t("notAllowed.title")} text={t("notAllowed.text")}>
      <LinkButton href={STORES}>{t("backToStores")}</LinkButton>
    </StatusScreen>
  );
}

/** Screen 102: a store that is not in this business (or no longer, or not one of the user's). */
export function NotFoundScreen() {
  const t = useTranslations("stores");
  return (
    <StatusScreen icon="info" tone="info" heading={t("notFound.title")} text={t("notFound.text")}>
      <LinkButton href={STORES}>{t("backToStores")}</LinkButton>
    </StatusScreen>
  );
}

export interface StoresContext {
  stores: Store[];
}

/**
 * Loads GET /stores for the list and the edit screens. No store.view, or a forbidden answer, is
 * not allowed; a failed load offers retry (screen 101); the children get the loaded stores.
 */
export function StoresLoader({ children, loadingFooter }: { children: (context: StoresContext) => ReactNode; loadingFooter?: ReactNode }) {
  const access = useStoreAccess();
  if (!access.view) return <NotAllowedScreen />;
  return <Loader loadingFooter={loadingFooter}>{children}</Loader>;
}

function Loader({ children, loadingFooter }: { children: (context: StoresContext) => ReactNode; loadingFooter?: ReactNode }) {
  const t = useTranslations("stores");
  const ui = useTranslations("ui");
  const common = useTranslations("common");
  const { state, reload } = useStoresList();

  if (state.k === "error") {
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
  return <>{children({ stores: state.value })}</>;
}
