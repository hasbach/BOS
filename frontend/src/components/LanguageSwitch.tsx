"use client";

import { useLocale, useTranslations } from "next-intl";

import { usePathname } from "@/i18n/navigation";
import { hardNavigate } from "@/lib/navigate";

import { SegmentedControl } from "./SegmentedControl";

export interface LanguageSwitchProps {
  /** Fragment (with its leading #) to carry to the new page, for example a one-time link token. */
  hash?: string;
}

// Switches the page language on the spot. It reloads the page in the other language, because the
// whole page (direction, fonts, text) changes; the fragment is put back so a link token survives.
export function LanguageSwitch({ hash = "" }: LanguageSwitchProps) {
  const t = useTranslations("common");
  const locale = useLocale();
  const pathname = usePathname();

  return (
    <SegmentedControl
      label={t("language")}
      value={locale === "ar" ? "ar" : "en"}
      options={[
        { value: "ar", label: "العربية" },
        { value: "en", label: "English" },
      ]}
      onChange={(next) => {
        if (next === locale) return;
        hardNavigate(`/${next}${pathname === "/" ? "" : pathname}${window.location.search}${hash}`);
      }}
    />
  );
}
