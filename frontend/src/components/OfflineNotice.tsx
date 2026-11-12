"use client";

import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { Banner } from "./Banner";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const getOnline = () => navigator.onLine;
// On the server the connection is unknown: render nothing and let the client decide.
const getServerOnline = () => true;

export interface OfflineNoticeProps {
  /** Shows the notice whatever the connection is (component gallery and tests). */
  forceVisible?: boolean;
}

export function OfflineNotice({ forceVisible = false }: OfflineNoticeProps) {
  const t = useTranslations("ui");
  const online = useSyncExternalStore(subscribe, getOnline, getServerOnline);
  if (online && !forceVisible) return null;

  return (
    <div role="status" aria-live="polite">
      <Banner tone="info" icon="wifioff">
        <span>
          <b>{t("offlineTitle")}</b> {t("offlineText")}
        </span>
      </Banner>
    </div>
  );
}
