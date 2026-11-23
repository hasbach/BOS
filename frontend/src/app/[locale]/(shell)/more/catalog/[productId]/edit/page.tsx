import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";
import { getServerProductEdit } from "@/lib/serverCatalogScreens";

import { EditProduct } from "../../ProductForm";

export const generateMetadata = titleFrom("catalog.form.editTitle");

export default async function EditProductPage({ params }: { params: Promise<{ locale: string; productId: string }> }) {
  const { locale, productId } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const seed = await getServerProductEdit(locale, productId);
  // Identify refreshes, including failed reads, without remounting an open draft.
  return <EditProduct productId={productId} renderId={seed?.id ?? crypto.randomUUID()} seed={seed} />;
}
