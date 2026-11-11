"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Empty } from "@/components/Empty";
import { ErrorState } from "@/components/ErrorState";
import { Field } from "@/components/Field";
import { ListRow } from "@/components/ListRow";
import { Loading } from "@/components/Loading";
import { OfflineNotice } from "@/components/OfflineNotice";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Sheet } from "@/components/Sheet";
import { Link } from "@/i18n/navigation";

import styles from "./gallery.module.css";

type Theme = "auto" | "light" | "dark";
type Currency = "usd" | "lbp" | "both";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{title}</h2>
      <div className={styles.stack}>{children}</div>
    </section>
  );
}

export function Gallery() {
  const t = useTranslations("dev");
  const locale = useLocale();
  const [theme, setTheme] = useState<Theme>("auto");
  const [currency, setCurrency] = useState<Currency>("usd");
  const [sheetOpen, setSheetOpen] = useState(false);

  function chooseTheme(next: Theme) {
    setTheme(next);
    if (next === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t("title")}</h1>

      <div className={styles.toolbar}>
        <SegmentedControl<Theme>
          label={t("theme")}
          value={theme}
          onChange={chooseTheme}
          options={[
            { value: "auto", label: t("themeAuto") },
            { value: "light", label: t("themeLight") },
            { value: "dark", label: t("themeDark") },
          ]}
        />
        <p className={styles.langs}>
          {t("language")}:{" "}
          <Link href="/dev/components" locale="en" aria-current={locale === "en" ? "true" : undefined}>
            English
          </Link>{" "}
          <Link href="/dev/components" locale="ar" aria-current={locale === "ar" ? "true" : undefined}>
            العربية
          </Link>
        </p>
      </div>

      <Section title={t("buttons")}>
        <Button>{t("primary")}</Button>
        <Button variant="ink">{t("ink")}</Button>
        <Button variant="ghost">{t("ghost")}</Button>
        <Button variant="danger">{t("danger")}</Button>
        <Button disabled>{t("disabled")}</Button>
        <Button loading>{t("saving")}</Button>
        <div className={styles.row}>
          <Button size="small">{t("small")}</Button>
          <Button size="small" variant="ghost">
            {t("small")}
          </Button>
          <Button size="small" variant="danger">
            {t("small")}
          </Button>
          <Button size="small" loading>
            {t("saving")}
          </Button>
        </div>
      </Section>

      <Section title={t("fields")}>
        <Field label={t("fieldLabel")} helper={t("fieldHelper")} placeholder="Beta Store" />
        <Field label={t("fieldLabel")} defaultValue="Beta Store" error={t("fieldError")} />
        <Field label={t("fieldNotes")} multiline />
        <Field label={t("fieldLabel")} disabled defaultValue="Beta Store" />
      </Section>

      <Section title={t("chips")}>
        <div className={styles.row}>
          <Chip>{t("chipNeutral")}</Chip>
          <Chip tone="ok">{t("chipOk")}</Chip>
          <Chip tone="warn">{t("chipWarn")}</Chip>
          <Chip tone="bad">{t("chipBad")}</Chip>
          <Chip tone="info">{t("chipInfo")}</Chip>
          <Chip tone="storeA">{t("chipStoreA")}</Chip>
          <Chip tone="storeB">{t("chipStoreB")}</Chip>
        </div>
      </Section>

      <Section title={t("cards")}>
        <Card>{t("cardBody")}</Card>
        <Card>
          <ListRow
            title={t("rowTitle")}
            subtitle={t("rowSubtitle")}
            leading={<Chip tone="storeA">A</Chip>}
            trailing={<Chip tone="ok">{t("chipOk")}</Chip>}
            chevron
            onClick={() => undefined}
          />
          <ListRow
            title={t("rowTitle")}
            subtitle={t("rowSubtitle")}
            trailing={<span>{t("rowTrailing")}</span>}
          />
        </Card>
      </Section>

      <Section title={t("segmented")}>
        <SegmentedControl<Currency>
          label={t("segLabel")}
          value={currency}
          onChange={setCurrency}
          options={[
            { value: "usd", label: t("segUsd") },
            { value: "lbp", label: t("segLbp") },
            { value: "both", label: t("segBoth") },
          ]}
        />
      </Section>

      <Section title={t("sheet")}>
        <Button variant="ghost" onClick={() => setSheetOpen(true)}>
          {t("openSheet")}
        </Button>
        <Sheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title={t("sheetTitle")}
          footer={<Button onClick={() => setSheetOpen(false)}>{t("primary")}</Button>}
        >
          <p>{t("sheetBody")}</p>
        </Sheet>
      </Section>

      <Section title={t("states")}>
        <Card>
          <Loading />
        </Card>
        <Card>
          <Empty description={t("emptyDescription")} action={<Button size="small">{t("emptyAction")}</Button>} />
        </Card>
        <Card>
          <ErrorState message={t("errorBody")} onRetry={() => undefined} />
        </Card>
      </Section>

      <Section title={t("offline")}>
        <OfflineNotice forceVisible />
      </Section>
    </main>
  );
}
