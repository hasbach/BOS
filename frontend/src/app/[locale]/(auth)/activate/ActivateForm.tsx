"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Banner } from "@/components/Banner";
import { BrandHeader, Screen, ScreenBody, ScreenFooter, screenStyles } from "@/components/Screen";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { ErrorState } from "@/components/ErrorState";
import { Field } from "@/components/Field";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { IdentifierUnavailableScreen, LinkInvalidScreen, LinkUsedScreen } from "@/components/LinkScreens";
import { Loading } from "@/components/Loading";
import { PasswordField } from "@/components/PasswordField";
import { UserIcon } from "@/components/icons";
import { useRouter } from "@/i18n/navigation";
import { api, isApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useFocusFirstInvalid } from "@/lib/focus";
import { useFragmentToken } from "@/lib/fragment";
import { checkNewPassword } from "@/lib/password";
import type { InvitationPreview, Locale, Me } from "@/lib/types";

type View =
  | { k: "loading" }
  | { k: "invalid" }
  | { k: "used" }
  | { k: "identifier" }
  | { k: "error"; error: unknown }
  | { k: "form"; preview: InvitationPreview };

/** The code as six ASCII digits (spaces dropped, Arabic digits read), or null. */
export function normalizeCode(value: string): string | null {
  const code = value
    .replace(/\s+/g, "")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return /^[0-9]{6}$/.test(code) ? code : null;
}

/** The status screen a failed link call leads to, or null when the failure is something else. */
function linkView(error: unknown): View | null {
  if (!isApiError(error)) return null;
  if (error.code === "link_invalid") return { k: "invalid" };
  if (error.code === "link_already_used") return { k: "used" };
  return null;
}

// Screen 29 (and 30, 31, 32, 42): opened from an activation or invitation link. The token comes from
// the URL fragment only, is removed from the address bar at once, and travels in request bodies.
// An employee invited by email first has a code emailed to that address and enters it with the
// password (FR-012a): only then can the answer say the address cannot be used.
export function ActivateForm() {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { ready, token } = useFragmentToken();
  const [view, setView] = useState<View>({ k: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; code?: string }>({});
  const [formError, setFormError] = useState<unknown>(null);
  const { formRef, flagInvalid } = useFocusFirstInvalid();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready) return;
    if (token === null) {
      setView({ k: "invalid" });
      return;
    }
    const controller = new AbortController();
    api.post<InvitationPreview>("/invitations/preview", { token }, { signal: controller.signal }).then(
      (preview) => setView({ k: "form", preview }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setView(linkView(error) ?? { k: "error", error });
      },
    );
    return () => controller.abort();
  }, [ready, token, attempt]);

  const retry = useCallback(() => {
    setView({ k: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const codeRequired = view.k === "form" && view.preview.code_required;

  async function sendCode() {
    if (sending || token === null) return;
    setSendError(null);
    setSending(true);
    try {
      await api.post("/invitations/send-code", { token, locale });
      setCodeSent(true);
      setCode("");
      setErrors((current) => ({ ...current, code: undefined }));
      codeRef.current?.focus();
    } catch (error) {
      const link = linkView(error);
      if (link) setView(link);
      else if (isApiError(error) && error.code === "too_many_requests") setSendError(t("auth.activate.tooManyCodes"));
      else setSendError(errorMessage(t, error));
    } finally {
      setSending(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || token === null) return;
    const problems = checkNewPassword(password, confirm);
    const typedCode = codeRequired ? normalizeCode(code) : null;
    const codeProblem = codeRequired && typedCode === null;
    setErrors({
      password: problems.password ? t("password.tooShort") : undefined,
      confirm: problems.confirm ? t("password.mismatch") : undefined,
      code: codeProblem ? t("auth.activate.codeRequired") : undefined,
    });
    if (problems.password || problems.confirm || codeProblem) {
      flagInvalid();
      return;
    }

    setFormError(null);
    setBusy(true);
    try {
      const body = typedCode === null ? { token, password, locale } : { token, password, locale, code: typedCode };
      const me = await api.post<Me>("/invitations/accept", body);
      // The language chosen here is now the saved one; go to the shell in it.
      router.replace("/", { locale: me.user.locale });
    } catch (error) {
      setBusy(false);
      if (isApiError(error) && error.code === "weak_password") {
        setErrors({ password: t("errors.weak_password") });
        flagInvalid();
      } else if (isApiError(error) && error.code === "code_invalid") {
        setErrors({ code: t("errors.code_invalid") });
        flagInvalid();
      } else if (isApiError(error) && error.code === "identifier_unavailable") {
        setView({ k: "identifier" });
      } else {
        setView((current) => linkView(error) ?? current);
        if (!linkView(error)) setFormError(error);
      }
    }
  }

  switch (view.k) {
    case "loading":
      return <Loading label={t("auth.activate.checking")} />;
    case "invalid":
      return <LinkInvalidScreen />;
    case "used":
      return <LinkUsedScreen />;
    case "identifier":
      return <IdentifierUnavailableScreen />;
    case "error":
      return <ErrorState message={errorMessage(t, view.error)} onRetry={retry} />;
  }

  const { preview } = view;
  return (
    <Screen>
      <form ref={formRef} onSubmit={onSubmit} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          <BrandHeader name={t("home.name")} />
          <Card>
            <p className={screenStyles.label}>{t("auth.activate.yourBusiness")}</p>
            <p className={screenStyles.title} style={{ fontSize: 17 }}>
              {preview.business_name}
            </p>
            <div className={screenStyles.row} style={{ marginBlockStart: 10 }}>
              <UserIcon />
              <div>
                <p className={screenStyles.title}>{t("auth.activate.welcome", { name: preview.invitee_name })}</p>
                <p className={screenStyles.muted}>
                  {preview.kind === "owner_activation" ? t("auth.activate.addedByBeta") : t("auth.activate.addedByManager")}
                </p>
              </div>
            </div>
            <div style={{ marginBlockStart: 8 }}>
              <p className={screenStyles.hint} style={{ marginBlockEnd: 4 }}>
                {t("auth.activate.yourRoles")}
              </p>
              <div className={screenStyles.pills}>
                {preview.roles.map((role) => (
                  <Chip key={role} tone="ok">
                    {t(`roles.${role}`)}
                  </Chip>
                ))}
              </div>
            </div>
          </Card>
          <div className={screenStyles.stack} style={{ gap: 4 }}>
            <span className={screenStyles.label}>{t("auth.activate.language")}</span>
            <LanguageSwitch hash={token ? `#${token}` : ""} />
            <p className={screenStyles.hint}>{t("auth.activate.languageHint")}</p>
          </div>
          {formError ? (
            <Banner tone="bad" icon="alert" alert>
              {errorMessage(t, formError)}
            </Banner>
          ) : null}
          {preview.code_required ? (
            <section className={screenStyles.stack} aria-labelledby="activate-code-title">
              <h2 id="activate-code-title" className={screenStyles.label}>
                {t("auth.activate.codeTitle")}
              </h2>
              <p className={screenStyles.muted}>{t("auth.activate.codeIntro")}</p>
              {codeSent ? (
                <Banner tone="ok" icon="check" alert>
                  {t("auth.activate.codeSent")}
                </Banner>
              ) : null}
              {sendError ? (
                <Banner tone="bad" icon="alert" alert>
                  {sendError}
                </Banner>
              ) : null}
              <Button variant={codeSent ? "ghost" : "ink"} loading={sending} onClick={() => void sendCode()}>
                {codeSent ? t("auth.activate.sendNewCode") : t("auth.activate.sendCode")}
              </Button>
              <Field
                ref={codeRef}
                label={t("auth.activate.code")}
                name="one-time-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                dir="ltr"
                maxLength={12}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                helper={t("auth.activate.codeHint")}
                error={errors.code}
              />
            </section>
          ) : null}
          <PasswordField
            label={t("auth.activate.password")}
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            helper={t("password.hint")}
            error={errors.password}
          />
          <PasswordField
            label={t("auth.activate.confirm")}
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            error={errors.confirm}
          />
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy}>
            {t("auth.activate.submit")}
          </Button>
        </ScreenFooter>
      </form>
    </Screen>
  );
}
