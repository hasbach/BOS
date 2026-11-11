import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { InboxIcon } from "./icons";
import styles from "./States.module.css";

export interface EmptyProps {
  title?: string;
  description?: string;
  /** Usually a Button that starts the first action. */
  action?: ReactNode;
}

export function Empty({ title, description, action }: EmptyProps) {
  const t = useTranslations("ui");
  return (
    <div className={styles.state}>
      <InboxIcon width={28} height={28} className={styles.icon} />
      <h2 className={styles.title}>{title ?? t("emptyTitle")}</h2>
      {description ? <p className={styles.message}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
