import { useTranslations } from "next-intl";

import styles from "./page.module.css";

export function HomeContent() {
  const t = useTranslations("home");

  return (
    <main className={styles.main}>
      <h1>BOS</h1>
      <p>{t("name")}</p>
      <p>{t("tagline")}</p>
    </main>
  );
}
