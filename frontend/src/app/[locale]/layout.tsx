import type { Metadata, Viewport } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "@/styles/tokens.css";
import "@/styles/base.css";

import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { dirFor, routing } from "@/i18n/routing";

type Props = { children: ReactNode; params: Promise<{ locale: string }> };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: t("title"),
    description: t("description"),
    manifest: "/manifest.webmanifest",
    icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
    appleWebApp: { capable: true, title: "BOS", statusBarStyle: "default" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the tab bar sit above the phone home indicator (safe-area padding).
  viewportFit: "cover",
  themeColor: "#047857",
};

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <html lang={locale} dir={dirFor(locale)}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
