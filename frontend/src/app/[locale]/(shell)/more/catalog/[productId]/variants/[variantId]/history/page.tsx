import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";

import { StockHistory } from "./StockHistory";

export const generateMetadata = titleFrom("catalog.history.title");

export default async function StockHistoryPage({ params }: { params: Promise<{ locale: string; productId: string; variantId: string }> }) {
  const { locale, productId, variantId } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return <StockHistory productId={productId} variantId={variantId} />;
}
