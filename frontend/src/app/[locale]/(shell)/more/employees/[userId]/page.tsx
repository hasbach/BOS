import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";

import { EmployeeDetail } from "./EmployeeDetail";

export const generateMetadata = titleFrom("staff.detail.subtitle");

export default async function EmployeePage({ params }: { params: Promise<{ locale: string; userId: string }> }) {
  const { locale, userId } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return <EmployeeDetail userId={userId} />;
}
