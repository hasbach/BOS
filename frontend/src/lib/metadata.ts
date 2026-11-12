import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";

import { routing } from "@/i18n/routing";

type PageProps = { params: Promise<{ locale: string }> };

/**
 * Builds a page's generateMetadata that names the browser tab after the screen (WCAG 2.4.2), in the
 * page's language. The locale layout adds " · BOS" through its title template.
 */
export function titleFrom(key: string) {
  return async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { locale } = await params;
    if (!hasLocale(routing.locales, locale)) return {};
    const t = await getTranslations({ locale });
    return { title: t(key as never) };
  };
}
