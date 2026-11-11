"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { FormEvent } from "react";

import { Banner } from "@/components/Banner";
import { BetaContact } from "@/components/BetaContact";
import { BrandHeader, Screen, ScreenBody, screenStyles } from "@/components/Screen";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { LinkButton } from "@/components/LinkButton";
import { OfflineNotice } from "@/components/OfflineNotice";
import { PasswordField } from "@/components/PasswordField";
import { useRouter } from "@/i18n/navigation";
import { api, isApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { Me } from "@/lib/types";

type Problem = "wrong" | "suspended" | "pending" | "offline" | { other: unknown } | null;

function classify(error: unknown): Problem {
  if (isApiError(error)) {
    if (error.code === "invalid_credentials") return "wrong";
    if (error.code === "business_suspended") return "suspended";
    if (error.code === "business_pending") return "pending";
    if (error.code === "network_error") return "offline";
  }
  return { other: error };
}

// Screens 01 and 39-41: one "Phone or email" field and a password. A wrong sign-in always gets the
// same message; the server never says which part was wrong.
export function SignInForm() {
  const t = useTranslations();
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [missing, setMissing] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (identifier.trim() === "" || password === "") {
      setMissing(true);
      return;
    }
    setMissing(false);
    setProblem(null);
    setBusy(true);
    try {
      const me = await api.post<Me>("/auth/sign-in", { identifier: identifier.trim(), password });
      // The saved language always wins after sign-in (FR-027a).
      router.replace("/", { locale: me.user.locale });
    } catch (error) {
      setProblem(classify(error));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScreenBody center>
        <LanguageSwitch />
        <BrandHeader name={t("home.name")} tagline={t("home.tagline")} />
        <OfflineNotice />
        <form onSubmit={onSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {problem === "suspended" ? (
            <Banner tone="warn" icon="lock" alert>
              <span>{t("auth.signIn.suspended")}</span>
              <BetaContact />
            </Banner>
          ) : null}
          {problem === "pending" ? (
            <Banner tone="warn" icon="lock" alert>
              <span>{t("auth.signIn.pending")}</span>
              <BetaContact />
            </Banner>
          ) : null}
          {problem === "offline" ? (
            <Banner tone="info" icon="wifioff" alert>
              {t("auth.signIn.offline")}
            </Banner>
          ) : null}
          {typeof problem === "object" && problem !== null ? (
            <Banner tone="bad" icon="alert" alert>
              {errorMessage(t, problem.other)}
            </Banner>
          ) : null}
          <Field
            label={t("auth.signIn.identifier")}
            name="identifier"
            dir="ltr"
            autoComplete="username"
            autoCapitalize="none"
            inputMode="email"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            error={missing && identifier.trim() === "" ? t("auth.signIn.required") : undefined}
          />
          <PasswordField
            label={t("auth.signIn.password")}
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={
              problem === "wrong"
                ? t("auth.signIn.wrong")
                : missing && password === ""
                  ? t("fieldErrors.required")
                  : undefined
            }
          />
          <Button type="submit" loading={busy}>
            {problem === "offline" ? t("auth.signIn.retry") : t("auth.signIn.submit")}
          </Button>
        </form>
        <LinkButton href="/reset" variant="ghost">
          {t("auth.signIn.forgot")}
        </LinkButton>
        <p className={`${screenStyles.hint} ${screenStyles["center-text"]}`}>{t("auth.signIn.byBeta")}</p>
      </ScreenBody>
    </Screen>
  );
}
