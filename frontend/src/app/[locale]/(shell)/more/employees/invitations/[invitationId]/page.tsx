import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { titleFrom } from "@/lib/metadata";

import { InvitationDetail } from "./InvitationDetail";

export const generateMetadata = titleFrom("staff.invitation.subtitle");

export default async function InvitationPage({ params }: { params: Promise<{ locale: string; invitationId: string }> }) {
  const { locale, invitationId } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return <InvitationDetail invitationId={invitationId} />;
}
