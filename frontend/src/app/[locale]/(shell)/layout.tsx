import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { preload } from "react-dom";
import type { ReactNode } from "react";

import { AppShell } from "@/components/AppShell";
import { SessionGuard } from "@/components/SessionGuard";
import { routing } from "@/i18n/routing";

// Everything signed-in lives under this layout: the guard loads /me, sends visitors without a
// session to sign-in and moves the page to the saved language; the shell adds the offline notice
// and the tab bar.
export default async function ShellLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  // The guard needs GET /me before anything else on screen. Starting it from the page head, instead of
  // after the scripts have downloaded and run, takes a whole round trip (SC-009, T088) off the critical
  // path of every signed-in screen on a slow connection. The guard's own fetch picks up the answer.
  preload("/api/v1/me", { as: "fetch", crossOrigin: "anonymous" });

  return (
    <SessionGuard>
      <AppShell>{children}</AppShell>
    </SessionGuard>
  );
}
