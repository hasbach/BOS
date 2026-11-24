import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";
import { getServerStockHistory } from "@/lib/serverCatalogScreens";

import { StockHistory } from "./StockHistory";

export const generateMetadata = titleFrom("catalog.history.title");

export default async function StockHistoryPage({ params }: { params: Promise<{ locale: string; productId: string; variantId: string }> }) {
  const { locale, productId, variantId } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const seed = await getServerStockHistory(locale, productId, variantId);
  return <StockHistory key={seed?.id ?? crypto.randomUUID()} productId={productId} variantId={variantId} seed={seed} />;
}
