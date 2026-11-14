"use client";

import { useTranslations } from "next-intl";

import { Loading } from "./Loading";

/**
 * Shown by a screen whose request was answered "your session has ended" (isSessionEnded): the guard is
 * already taking the person to sign-in, so the screen says that instead of "couldn't reach BOS".
 */
export function SessionEnded() {
  const t = useTranslations("shell");
  return <Loading label={t("sessionEnded")} />;
}
