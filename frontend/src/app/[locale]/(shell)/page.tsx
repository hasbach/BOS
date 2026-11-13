import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getServerMe } from "@/lib/serverSession";
import { isTabKey, tabPath } from "@/lib/tabs";

import { StartRedirect } from "./StartRedirect";

// The entry point: moves to the tab the server chose for this person, in their saved language. When
// the server already knows the person this is a plain redirect; otherwise the client does it once the
// guard has loaded /me.
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const session = await getServerMe();
  if (session.k === "ready" && hasLocale(routing.locales, session.me.user.locale)) {
    const start = session.me.start_tab;
    redirect({ href: isTabKey(start) ? tabPath(start) : "/more", locale: session.me.user.locale });
  }

  return <StartRedirect />;
}
