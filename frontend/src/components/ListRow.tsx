import type { ReactNode } from "react";

import { ChevronIcon } from "./icons";
import styles from "./ListRow.module.css";

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Thumbnail, avatar or icon at the start of the row. */
  leading?: ReactNode;
  /** Chip, amount or similar at the end of the row. */
  trailing?: ReactNode;
  /** Shows a chevron that points the reading direction (flips in right-to-left). */
  chevron?: boolean;
  /** Makes the whole row a link. */
  href?: string;
  /** Makes the whole row a button. */
  onClick?: () => void;
  /** Use "li" when the rows sit inside a ul or ol. */
  as?: "div" | "li";
}

export function ListRow({ title, subtitle, leading, trailing, chevron, href, onClick, as: Tag = "div" }: ListRowProps) {
  const content = (
    <>
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </span>
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
      {chevron ? <ChevronIcon className={styles.chevron} width={18} height={18} /> : null}
    </>
  );

  return (
    <Tag className={styles.row}>
      {href ? (
        <a className={`${styles.inner} ${styles.interactive}`} href={href}>
          {content}
        </a>
      ) : onClick ? (
        <button type="button" className={`${styles.inner} ${styles.interactive}`} onClick={onClick}>
          {content}
        </button>
      ) : (
        <div className={styles.inner}>{content}</div>
      )}
    </Tag>
  );
}
