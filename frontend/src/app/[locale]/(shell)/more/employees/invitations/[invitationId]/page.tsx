import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";

import { InvitationDetail } from "./InvitationDetail";

export default async function InvitationPage({ params }: { params: Promise<{ locale: string; invitationId: string }> }) {
  const { locale, invitationId } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return <InvitationDetail invitationId={invitationId} />;
}
