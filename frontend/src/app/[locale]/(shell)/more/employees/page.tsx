import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";
import { getServerStaff, getServerStores, toSeed } from "@/lib/serverSession";

import { EmployeesList } from "./EmployeesList";

export const generateMetadata = titleFrom("staff.title");

export default async function EmployeesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  // The first list comes in the HTML when the server can load it (SC-009); otherwise the screen
  // loads it in the browser as before.
  const [staff, stores] = await Promise.all([getServerStaff(locale), getServerStores(locale)]);
  return <EmployeesList initial={toSeed(staff)} initialStores={toSeed(stores)} />;
}
