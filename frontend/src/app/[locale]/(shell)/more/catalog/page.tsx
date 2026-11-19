import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";

import { CatalogList } from "./CatalogList";

export const generateMetadata = titleFrom("catalog.title");

export default async function CatalogPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale } = await params;
  const { no_photo: noPhoto } = await searchParams;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  // `?no_photo=1` opens the list with the no-photo filter on (the import result's Add photos).
  return <CatalogList initialNoPhoto={noPhoto === "1"} />;
}
