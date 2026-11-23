"use client";

import { useTranslations } from "next-intl";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

import { Banner } from "./Banner";
import styles from "./OfflineNotice.module.css";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const getOnline = () => navigator.onLine;
// On the server the connection is unknown: render the empty region and let the client decide.
const getServerOnline = () => true;

const OfflineNoticeSuppressed = createContext(false);

/** Use around descendants when their frame already renders the connection status. */
export function SuppressOfflineNotices({ children }: { children: ReactNode }) {
  return <OfflineNoticeSuppressed.Provider value={true}>{children}</OfflineNoticeSuppressed.Provider>;
}

export interface OfflineNoticeProps {
  /** Shows the notice whatever the connection is (component gallery and tests). */
  forceVisible?: boolean;
}

export function OfflineNotice(props: OfflineNoticeProps) {
  const suppressed = useContext(OfflineNoticeSuppressed);
  return suppressed ? null : <OfflineStatus {...props} />;
}

function OfflineStatus({ forceVisible = false }: OfflineNoticeProps) {
  const t = useTranslations("ui");
  const online = useSyncExternalStore(subscribe, getOnline, getServerOnline);

  // Keep the live region present before inserting the banner so a disconnect updates it in place.
  return (
    <div className={styles.region} aria-live="polite" aria-atomic="true">
      {!online || forceVisible ? (
        <Banner tone="info" icon="wifioff">
          <span>
            <b>{t("offlineTitle")}</b> {t("offlineText")}
          </span>
        </Banner>
      ) : null}
    </div>
  );
}
