"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { FormEvent } from "react";

import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field } from "@/components/Field";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { LinkButton } from "@/components/LinkButton";
import { OfflineNotice } from "@/components/OfflineNotice";
import { PasswordField } from "@/components/PasswordField";
import { LockIcon } from "@/components/icons";
import { Screen, ScreenBody, screenStyles } from "@/components/Screen";
import { useRouter } from "@/i18n/navigation";
import { api, isApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useFocusFirstInvalid } from "@/lib/focus";
import type { OpsMe } from "@/lib/types";

import styles from "../ops.module.css";

// Screen 35. A wrong sign-in shows one message and never says which part was wrong.
export function OpsSignInForm() {
  const t = useTranslations();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  const { formRef, flagInvalid } = useFocusFirstInvalid();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (email.trim() === "" || password === "") {
      setMissing(true);
      flagInvalid();
      return;
    }
    setMissing(false);
    setError(null);
    setBusy(true);
    try {
      await api.post<OpsMe>("/ops/auth/sign-in", { email: email.trim(), password });
      router.replace("/ops");
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  const wrong = isApiError(error) && error.code === "invalid_credentials";

  return (
    <Screen>
      <div className={styles.hero}>
        <div className={styles.heroLogo} aria-hidden="true">
          BOS
        </div>
        <h1 className={styles.heroTitle}>{t("ops.signIn.title")}</h1>
        <span className={styles.heroChip}>
          <LockIcon width={14} height={14} /> {t("ops.signIn.staffOnly")}
        </span>
      </div>
      <ScreenBody>
        <LanguageSwitch />
        <OfflineNotice />
        <form ref={formRef} onSubmit={onSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {error && !wrong ? (
            <Banner tone="bad" icon="alert" alert>
              {errorMessage(t, error)}
            </Banner>
          ) : null}
          <Field
            label={t("ops.signIn.email")}
            name="email"
            type="email"
            dir="ltr"
            autoComplete="username"
            autoCapitalize="none"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={missing && email.trim() === "" ? t("fieldErrors.required") : undefined}
          />
          <PasswordField
            label={t("ops.signIn.password")}
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={wrong ? t("ops.signIn.wrong") : missing && password === "" ? t("fieldErrors.required") : undefined}
          />
          <Button type="submit" variant="ink" loading={busy}>
            {t("ops.signIn.submit")}
          </Button>
        </form>
        <Card>
          <p className={screenStyles.title}>{t("ops.signIn.merchantTitle")}</p>
          <p className={screenStyles.muted}>{t("ops.signIn.merchantText")}</p>
          <div style={{ marginBlockStart: 8 }}>
            <LinkButton href="/sign-in" variant="ghost">
              {t("ops.signIn.merchantButton")}
            </LinkButton>
          </div>
        </Card>
      </ScreenBody>
    </Screen>
  );
}
