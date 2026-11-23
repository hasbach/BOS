import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";
import { getServerProductDetail } from "@/lib/serverCatalogScreens";

import { ProductDetail } from "./ProductDetail";

export const generateMetadata = titleFrom("catalog.title");

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; productId: string }>;
  searchParams: Promise<{ saved?: string | string[] }>;
}) {
  const { locale, productId } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const [{ saved }, seed] = await Promise.all([searchParams, getServerProductDetail(locale, productId)]);

  // Give each fresh render its own load state, even when the browser must make the first read.
  const renderId = seed?.id ?? crypto.randomUUID();
  // ?saved=created|updated is set by the product form after the server confirmed the save (screen 173).
  return <ProductDetail key={renderId} productId={productId} saved={saved === "created" || saved === "updated" ? saved : undefined} seed={seed} />;
}
