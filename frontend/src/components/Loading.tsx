import { useTranslations } from "next-intl";

import styles from "./States.module.css";

export interface LoadingProps {
  label?: string;
}

export function Loading({ label }: LoadingProps) {
  const t = useTranslations("ui");
  return (
    <div className={styles.state} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <p className={styles.message}>{label ?? t("loading")}</p>
    </div>
  );
}
