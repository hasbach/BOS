import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";

import { BackIcon, LogoutIcon } from "./icons";
import styles from "./AppBar.module.css";

export interface AppBarProps {
  title: string;
  subtitle?: string;
  /** Link target for the back arrow (locale-less path). */
  backHref?: string;
  backLabel?: string;
  /** Dark operator variant with the "Beta staff" badge. */
  ops?: boolean;
  badge?: string;
  onSignOut?: () => void;
  signOutLabel?: string;
  /** One icon link at the end of the bar (for example Edit product); the label names it for assistive technology. */
  action?: AppBarAction;
  /** Several icon links at the end of the bar, in order (for example Low stock list and Import on the Catalog). */
  actions?: AppBarAction[];
}

export interface AppBarAction {
  href: string;
  label: string;
  icon: ReactNode;
}

export function AppBar({ title, subtitle, backHref, backLabel, ops, badge, onSignOut, signOutLabel, action, actions = [] }: AppBarProps) {
  const links = action ? [action, ...actions] : actions;
  return (
    <header className={[styles.bar, ops ? styles.ops : ""].filter(Boolean).join(" ")}>
      {backHref ? (
        <Link href={backHref} className={styles.icon} aria-label={backLabel}>
          <BackIcon className={styles.flip} />
        </Link>
      ) : null}
      <div className={styles.heading}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <span className={styles.sub}>{subtitle}</span> : null}
      </div>
      {badge ? <span className={styles.badge}>{badge}</span> : null}
      {links.map((link) => (
        <Link key={link.href} href={link.href} className={styles.icon} aria-label={link.label}>
          {link.icon}
        </Link>
      ))}
      {onSignOut ? (
        <button type="button" className={styles.icon} onClick={onSignOut} aria-label={signOutLabel}>
          <LogoutIcon className={styles.flip} />
        </button>
      ) : null}
    </header>
  );
}
