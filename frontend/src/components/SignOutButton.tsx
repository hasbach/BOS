"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { useRouter } from "@/i18n/navigation";
import { errorMessage } from "@/lib/errors";
import { signOut } from "@/lib/session";

import { Banner } from "./Banner";
import { Button } from "./Button";

/** Ends the session and goes to sign-in; if the server does not confirm, says so and stays signed in. */
export function SignOutButton() {
  const t = useTranslations();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onSignOut() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      router.replace("/sign-in");
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  return (
    <>
      {error ? (
        <Banner tone="bad" icon="alert" alert>
          {errorMessage(t, error)}
        </Banner>
      ) : null}
      <Button variant="ghost" onClick={onSignOut} loading={busy}>
        {busy ? t("shell.signingOut") : t("shell.signOut")}
      </Button>
    </>
  );
}
