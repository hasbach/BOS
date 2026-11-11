import { useTranslations } from "next-intl";

import { Button } from "./Button";
import { AlertIcon } from "./icons";
import styles from "./States.module.css";

export interface ErrorStateProps {
  title?: string;
  message?: string;
  /** When given, shows a retry button that calls it. */
  onRetry?: () => void;
}

export function ErrorState({ title, message, onRetry }: ErrorStateProps) {
  const t = useTranslations("ui");
  return (
    <div className={styles.state} role="alert">
      <AlertIcon width={28} height={28} className={styles.iconBad} />
      <h2 className={styles.title}>{title ?? t("errorTitle")}</h2>
      <p className={styles.message}>{message ?? t("errorMessage")}</p>
      {onRetry ? (
        <div className={styles.action}>
          <Button variant="ghost" size="small" onClick={onRetry}>
            {t("retry")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
