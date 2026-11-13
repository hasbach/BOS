import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { preload } from "react-dom";
import type { ReactNode } from "react";

import { AppShell } from "@/components/AppShell";
import { SessionGuard } from "@/components/SessionGuard";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getServerMe } from "@/lib/serverSession";

// Everything signed-in lives under this layout. The server asks GET /me first (SC-009, T088), so the
// frame, the screen title and the tab bar come in the HTML and the browser does not ask again:
// - a person: the guard starts with them;
// - no session (or a suspended / not yet active business): straight to sign-in, as the guard would;
// - anything else (API down or slow, an unusual answer): the page renders as before and the guard
//   loads /me from the browser, with its loading, retry and error states.
// The guard still moves the page to the person's saved language (FR-027a); the shell adds the offline
// notice and the tab bar. Reading the session cookie makes these pages dynamic, never cached.
export default async function ShellLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const session = await getServerMe();
  if (session.k === "sign-in") redirect({ href: "/sign-in", locale });

  if (session.k !== "ready") {
    // Fallback only: start the guard's request from the page head rather than after the scripts.
    preload("/api/v1/me", { as: "fetch", crossOrigin: "anonymous" });
  }

  return (
    <SessionGuard initialMe={session.k === "ready" ? session.me : undefined}>
      <AppShell>{children}</AppShell>
    </SessionGuard>
  );
}
