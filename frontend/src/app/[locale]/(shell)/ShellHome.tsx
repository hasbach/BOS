"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Screen, ScreenBody, screenStyles } from "@/components/Screen";
import { useRouter } from "@/i18n/navigation";
import { errorMessage } from "@/lib/errors";
import { signOut, useMe } from "@/lib/session";

export function ShellHome() {
  const t = useTranslations();
  const router = useRouter();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onSignOut() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      router.replace("/sign-in");
    } catch (caught) {
      // Still signed in: say so instead of pretending.
      setError(caught);
      setBusy(false);
    }
  }

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
        {error ? (
          <Banner tone="bad" icon="alert" alert>
            {errorMessage(t, error)}
          </Banner>
        ) : null}
        <Button variant="ghost" onClick={onSignOut} loading={busy}>
          {busy ? t("shell.signingOut") : t("shell.signOut")}
        </Button>
      </ScreenBody>
    </Screen>
  );
}
