import type { ReactNode } from "react";

import { CheckIcon, ClockIcon, InfoIcon, LockIcon, SendIcon, WifiOffIcon } from "./icons";
import styles from "./Screen.module.css";

/** Phone-width page column shared by every signed-out and operator screen. */
export function Screen({ children }: { children: ReactNode }) {
  return <div className={styles.screen}>{children}</div>;
}

export function ScreenBody({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return <div className={[styles.body, center ? styles.center : ""].filter(Boolean).join(" ")}>{children}</div>;
}

export function ScreenFooter({ children }: { children: ReactNode }) {
  return <div className={styles.footer}>{children}</div>;
}

export function BrandHeader({ name, tagline }: { name: string; tagline?: string }) {
  return (
    <div className={styles.brand}>
      <div className={styles.logo} aria-hidden="true">
        BOS
      </div>
      <div>
        <h1 className={styles.brandName}>{name}</h1>
        {tagline ? <p className={styles.muted}>{tagline}</p> : null}
      </div>
    </div>
  );
}

const STATUS_ICONS = { clock: ClockIcon, check: CheckIcon, info: InfoIcon, send: SendIcon, lock: LockIcon, wifioff: WifiOffIcon };

export interface StatusHeaderProps {
  tone: "accent" | "warn" | "info";
  icon: keyof typeof STATUS_ICONS;
  title: string;
  text: string;
}

/** Big round icon, a heading and one sentence: the top of the status screens (30, 31, 32, 43, 44). */
export function StatusHeader({ tone, icon, title, text }: StatusHeaderProps) {
  const Icon = STATUS_ICONS[icon];
  return (
    <div className={styles.status}>
      <div className={`${styles.statusIcon} ${styles[tone]}`}>
        <Icon width={28} height={28} />
      </div>
      <h1 className={styles.statusTitle}>{title}</h1>
      <p className={styles.statusText}>{text}</p>
    </div>
  );
}

export { styles as screenStyles };
