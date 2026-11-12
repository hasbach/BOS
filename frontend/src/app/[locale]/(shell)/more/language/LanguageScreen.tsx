"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Screen, ScreenBody, screenStyles } from "@/components/Screen";
import { usePathname } from "@/i18n/navigation";
import { dirFor } from "@/i18n/routing";
import { api } from "@/lib/api";
import { hardNavigate } from "@/lib/navigate";
import type { Locale, Me } from "@/lib/types";

import styles from "./language.module.css";

type Status = "idle" | "saving" | "failed";

const OPTIONS: Array<{ value: Locale; name: string; lang: string }> = [
  { value: "ar", name: "العربية", lang: "ar" },
  { value: "en", name: "English", lang: "en" },
];

function setPageLanguage(locale: string) {
  document.documentElement.lang = locale;
  document.documentElement.dir = dirFor(locale);
}

/**
 * Screen 119. Tapping a language flips the layout at once, then saves it to the account
 * (PATCH /me, locale) and only after the server answers moves the address to the new language,
 * so BOS opens in it on every device. If the save fails the layout goes back, the message says
 * nothing was saved, and Try again repeats it.
 */
export function LanguageScreen() {
  const t = useTranslations("language");
  const common = useTranslations("common");
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const [chosen, setChosen] = useState<Locale | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  async function choose(next: Locale) {
    if (status === "saving" || (next === locale && status !== "failed")) return;
    setChosen(next);
    setStatus("saving");
    // The layout answers the tap straight away; saving is confirmed separately.
    setPageLanguage(next);
    try {
      await api.patch<Me>("/me", { locale: next });
      hardNavigate(`/${next}${pathname === "/" ? "" : pathname}`);
    } catch {
      setPageLanguage(locale);
      setStatus("failed");
    }
  }

  const selected = chosen ?? locale;
  const saving = status === "saving";

  return (
    <Screen>
      <AppBar title={t("title")} backHref="/more" backLabel={common("back")} />
      <ScreenBody>
        <Card style={{ padding: "0 12px" }}>
          <div role="radiogroup" aria-label={t("title")}>
            {OPTIONS.map((option) => {
              const on = selected === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={saving}
                  className={styles.option}
                  onClick={() => void choose(option.value)}
                >
                  <span className={`${styles.radio} ${on ? styles.radioOn : ""}`} aria-hidden="true" />
                  <span className={styles.text}>
                    <span className={screenStyles.title} lang={option.lang}>
                      {option.name}
                    </span>
                    <span className={styles.note}>{option.value === "ar" ? t("arabicNote") : t("englishNote")}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
        {status === "failed" ? (
          <>
            <Banner tone="bad" icon="alert" alert>
              {t("failed")}
            </Banner>
            <Button onClick={() => chosen && void choose(chosen)}>{t("retry")}</Button>
          </>
        ) : (
          <Banner tone="info" icon="info">
            {saving ? t("saving") : t("info")}
          </Banner>
        )}
        <p className={screenStyles.hint}>{t("hint")}</p>
      </ScreenBody>
    </Screen>
  );
}
