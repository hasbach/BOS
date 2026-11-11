import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { SessionGuard } from "@/components/SessionGuard";
import { routing } from "@/i18n/routing";

// Everything signed-in lives under this layout: the guard loads /me, sends visitors without a
// session to sign-in and moves the page to the user's saved language.
export default async function ShellLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return <SessionGuard>{children}</SessionGuard>;
}
