import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";
import { getServerBusiness, toSeed } from "@/lib/serverSession";

import { SettingsForm } from "./SettingsForm";

export const generateMetadata = titleFrom("settings.title");

export default async function SettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  // The saved settings come in the HTML when the server can load them (SC-009); otherwise the screen
  // loads them in the browser as before.
  const business = await getServerBusiness(locale);
  return <SettingsForm initial={toSeed(business)} />;
}
