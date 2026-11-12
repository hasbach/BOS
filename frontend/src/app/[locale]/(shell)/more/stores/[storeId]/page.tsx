import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";

import { StoreDetail } from "./StoreDetail";

export const generateMetadata = titleFrom("stores.detail.subtitle");

export default async function StorePage({ params }: { params: Promise<{ locale: string; storeId: string }> }) {
  const { locale, storeId } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return <StoreDetail storeId={storeId} />;
}
