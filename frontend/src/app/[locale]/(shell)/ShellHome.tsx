"use client";

import { useTranslations } from "next-intl";

import { AppBar } from "@/components/AppBar";
import { Card } from "@/components/Card";
import { Screen, ScreenBody, screenStyles } from "@/components/Screen";
import { SignOutButton } from "@/components/SignOutButton";
import { useMe } from "@/lib/session";

export function ShellHome() {
  const t = useTranslations();
  const me = useMe();

  return (
    <Screen>
      <AppBar title={t("shell.homeTitle")} />
      <ScreenBody>
        <Card>
          <p className={screenStyles.label}>{t("shell.business")}</p>
          <p className={screenStyles.title} style={{ fontSize: 18 }}>
            {me.business.name}
          </p>
          <p className={screenStyles.label} style={{ marginBlockStart: 12 }}>
            {t("shell.signedInAs")}
          </p>
          <p className={screenStyles.title}>{me.user.name}</p>
        </Card>
        <SignOutButton />
      </ScreenBody>
    </Screen>
  );
}
