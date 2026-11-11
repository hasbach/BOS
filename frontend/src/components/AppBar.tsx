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
}

export function AppBar({ title, subtitle, backHref, backLabel, ops, badge, onSignOut, signOutLabel }: AppBarProps) {
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
      {onSignOut ? (
        <button type="button" className={styles.icon} onClick={onSignOut} aria-label={signOutLabel}>
          <LogoutIcon className={styles.flip} />
        </button>
      ) : null}
    </header>
  );
}
