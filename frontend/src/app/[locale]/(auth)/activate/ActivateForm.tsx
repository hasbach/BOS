"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

import { Banner } from "@/components/Banner";
import { BrandHeader, Screen, ScreenBody, ScreenFooter, screenStyles } from "@/components/Screen";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { ErrorState } from "@/components/ErrorState";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { IdentifierUnavailableScreen, LinkInvalidScreen, LinkUsedScreen } from "@/components/LinkScreens";
import { Loading } from "@/components/Loading";
import { PasswordField } from "@/components/PasswordField";
import { UserIcon } from "@/components/icons";
import { useRouter } from "@/i18n/navigation";
import { api, isApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
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

/** The status screen a failed link call leads to, or null when the failure is something else. */
function linkView(error: unknown): View | null {
  if (!isApiError(error)) return null;
  if (error.code === "link_invalid") return { k: "invalid" };
  if (error.code === "link_already_used") return { k: "used" };
  return null;
}

// Screen 29 (and 30, 31, 32, 42): opened from an activation or invitation link. The token comes from
// the URL fragment only, is removed from the address bar at once, and travels in request bodies.
export function ActivateForm() {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { ready, token } = useFragmentToken();
  const [view, setView] = useState<View>({ k: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<unknown>(null);
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

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || token === null) return;
    const problems = checkNewPassword(password, confirm);
    setErrors({
      password: problems.password ? t("password.tooShort") : undefined,
      confirm: problems.confirm ? t("password.mismatch") : undefined,
    });
    if (problems.password || problems.confirm) return;

    setFormError(null);
    setBusy(true);
    try {
      const me = await api.post<Me>("/invitations/accept", { token, password, locale });
      // The language chosen here is now the saved one; go to the shell in it.
      router.replace("/", { locale: me.user.locale });
    } catch (error) {
      setBusy(false);
      if (isApiError(error) && error.code === "weak_password") {
        setErrors({ password: t("errors.weak_password") });
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
      <form onSubmit={onSubmit} noValidate style={{ display: "contents" }}>
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
