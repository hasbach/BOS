"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { FormEvent } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { LinkInvalidScreen } from "@/components/LinkScreens";
import { LinkButton } from "@/components/LinkButton";
import { Loading } from "@/components/Loading";
import { PasswordField } from "@/components/PasswordField";
import { Screen, ScreenBody, ScreenFooter, StatusHeader, screenStyles } from "@/components/Screen";
import { api, isApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useFocusFirstInvalid } from "@/lib/focus";
import { useFragmentToken } from "@/lib/fragment";
import { checkNewPassword } from "@/lib/password";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function NoEmailNote() {
  const t = useTranslations("auth.reset");
  return (
    <Banner>
      <span>
        <b>{t("noEmailTitle")}</b>
        <br />
        {t("noEmailText")}
      </span>
    </Banner>
  );
}

// Screens 33 and 43: ask for a reset link by email. The same "sent" screen appears whether or not
// the address belongs to an account; it is shown only once the server answered 204.
function RequestReset() {
  const t = useTranslations();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const { formRef, flagInvalid } = useFocusFirstInvalid();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = email.trim();
    if (value === "" || !EMAIL.test(value)) {
      setFieldError(value === "" ? t("fieldErrors.required") : t("auth.reset.emailInvalid"));
      flagInvalid();
      return;
    }
    setFieldError(undefined);
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/password-reset/request", { email: value });
      setSent(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Screen>
        <AppBar title={t("auth.reset.requestTitle")} backHref="/sign-in" backLabel={t("common.back")} />
        <ScreenBody>
          <StatusHeader tone="accent" icon="send" title={t("auth.reset.sentTitle")} text={t("auth.reset.sentText")} />
          <p className={`${screenStyles.hint} ${screenStyles["center-text"]}`}>{t("auth.reset.sentHint")}</p>
          <NoEmailNote />
        </ScreenBody>
        <ScreenFooter>
          <LinkButton href="/sign-in">{t("common.backToSignIn")}</LinkButton>
          <Button
            variant="ghost"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
          >
            {t("auth.reset.useAnother")}
          </Button>
        </ScreenFooter>
      </Screen>
    );
  }

  return (
    <Screen>
      <AppBar title={t("auth.reset.requestTitle")} backHref="/sign-in" backLabel={t("common.back")} />
      <form ref={formRef} onSubmit={onSubmit} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          <p className={screenStyles.muted}>{t("auth.reset.intro")}</p>
          {error ? (
            <Banner tone="bad" icon="alert" alert>
              {errorMessage(t, error)}
            </Banner>
          ) : null}
          <Field
            label={t("auth.reset.email")}
            name="email"
            type="email"
            dir="ltr"
            autoComplete="email"
            autoCapitalize="none"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldError}
          />
          <NoEmailNote />
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy}>
            {t("auth.reset.send")}
          </Button>
        </ScreenFooter>
      </form>
    </Screen>
  );
}

// Screens 34 and 44: choose a new password from a reset link. Setting it ends every session, this
// device's included, so the next step is signing in.
function SetNewPassword({ token }: { token: string }) {
  const t = useTranslations();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const { formRef, flagInvalid } = useFocusFirstInvalid();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"form" | "done" | "invalid">("form");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problems = checkNewPassword(password, confirm);
    setErrors({
      password: problems.password ? t("password.tooShort") : undefined,
      confirm: problems.confirm ? t("password.mismatch") : undefined,
    });
    if (problems.password || problems.confirm) {
      flagInvalid();
      return;
    }

    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/password-reset/complete", { token, new_password: password });
      setState("done");
    } catch (caught) {
      if (isApiError(caught) && caught.code === "weak_password") {
        setErrors({ password: t("errors.weak_password") });
        flagInvalid();
      } else if (isApiError(caught) && caught.code === "link_invalid") {
        setState("invalid");
      } else {
        setError(caught);
      }
    } finally {
      setBusy(false);
    }
  }

  if (state === "invalid") return <LinkInvalidScreen />;

  if (state === "done") {
    return (
      <Screen>
        <AppBar title={t("auth.reset.newTitle")} />
        <ScreenBody>
          <StatusHeader tone="accent" icon="check" title={t("auth.reset.doneTitle")} text={t("auth.reset.doneText")} />
        </ScreenBody>
        <ScreenFooter>
          <LinkButton href="/sign-in">{t("common.signIn")}</LinkButton>
        </ScreenFooter>
      </Screen>
    );
  }

  return (
    <Screen>
      <AppBar title={t("auth.reset.newTitle")} />
      <form ref={formRef} onSubmit={onSubmit} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          <p className={screenStyles.muted}>{t("auth.reset.newIntro")}</p>
          {error ? (
            <Banner tone="bad" icon="alert" alert>
              {errorMessage(t, error)}
            </Banner>
          ) : null}
          <PasswordField
            label={t("auth.reset.newPassword")}
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            helper={t("password.hint")}
            error={errors.password}
          />
          <PasswordField
            label={t("auth.reset.confirmNew")}
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            error={errors.confirm}
          />
          <Banner>{t("auth.reset.signOutOthers")}</Banner>
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy}>
            {t("auth.reset.save")}
          </Button>
        </ScreenFooter>
      </form>
    </Screen>
  );
}

export function ResetForm() {
  const { ready, token } = useFragmentToken();
  if (!ready) return <Loading />;
  return token === null ? <RequestReset /> : <SetNewPassword token={token} />;
}
