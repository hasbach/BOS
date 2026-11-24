import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";
import { getServerLowStockShortcut } from "@/lib/serverLowStock";

import { TabPlaceholder } from "../TabPlaceholder";
import { LowStockRow } from "./LowStockRow";

export const generateMetadata = titleFrom("tabs.sales");

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  // Owners and managers start here; the low-stock row is theirs only (screen 157).
  const seed = await getServerLowStockShortcut(locale);
  return <TabPlaceholder tab="sales" top={<LowStockRow key={seed?.id ?? crypto.randomUUID()} seed={seed} />} />;
}
