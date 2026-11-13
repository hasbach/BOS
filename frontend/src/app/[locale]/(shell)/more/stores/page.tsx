import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";
import { getServerStores, toSeed } from "@/lib/serverSession";

import { StoresList } from "./StoresList";

export const generateMetadata = titleFrom("stores.title");

export default async function StoresPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  // The first list comes in the HTML when the server can load it (SC-009); otherwise the screen
  // loads it in the browser as before.
  const stores = await getServerStores(locale);
  return <StoresList initial={toSeed(stores)} />;
}
