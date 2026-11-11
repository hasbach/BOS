import type { ReactNode } from "react";

import { AlertIcon, CheckIcon, InfoIcon, LockIcon, WifiOffIcon } from "./icons";
import styles from "./Banner.module.css";

export type BannerTone = "info" | "warn" | "bad" | "ok";
export type BannerIcon = "info" | "alert" | "check" | "lock" | "wifioff";

const ICONS = { info: InfoIcon, alert: AlertIcon, check: CheckIcon, lock: LockIcon, wifioff: WifiOffIcon };

export interface BannerProps {
  tone?: BannerTone;
  icon?: BannerIcon;
  /** Large bordered variant for a warning the person must not miss. */
  strong?: boolean;
  /** Announced at once by assistive technology (errors, results). */
  alert?: boolean;
  children: ReactNode;
}

// A notice with an icon and words; the meaning never rests on colour alone.
export function Banner({ tone = "info", icon = "info", strong = false, alert = false, children }: BannerProps) {
  const Icon = ICONS[icon];
  return (
    <div
      className={[styles.banner, styles[tone], strong ? styles.strong : ""].filter(Boolean).join(" ")}
      role={alert ? "alert" : undefined}
    >
      <Icon width={strong ? 20 : 16} height={strong ? 20 : 16} />
      <div className={styles.text}>{children}</div>
    </div>
  );
}
