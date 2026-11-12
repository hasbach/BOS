"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { FormEvent } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import type { BannerTone } from "@/components/Banner";
import { Button } from "@/components/Button";
import { LinkButton } from "@/components/LinkButton";
import { PasswordField } from "@/components/PasswordField";
import { Screen, ScreenBody, ScreenFooter, StatusHeader } from "@/components/Screen";
import { api, isApiError } from "@/lib/api";
import { writeFailureMessage } from "@/lib/errors";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";

type Errors = { current?: string; next?: string; confirm?: string };
type Notice = { tone: BannerTone; text: string };

/** Screens 126 to 128: POST /me/password. The server ends the person's other sessions. */
export function PasswordScreen() {
  const t = useTranslations("changePassword");
  const all = useTranslations();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [retry, setRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const bar = <AppBar title={t("title")} backHref="/more/profile" backLabel={all("common.back")} />;

  if (done) {
    return (
      <Screen>
        {bar}
        <ScreenBody>
          <StatusHeader tone="accent" icon="check" title={t("doneTitle")} text={t("doneText")} />
        </ScreenBody>
        <ScreenFooter>
          <LinkButton href="/more/profile">{t("backToProfile")}</LinkButton>
        </ScreenFooter>
      </Screen>
    );
  }

  function fail(found: Errors) {
    setErrors(found);
    setNotice({ tone: "bad", text: t("fix", { count: Object.keys(found).length }) });
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setNotice(null);
    setRetry(false);

    // Checked here first; the server checks again (weak_password).
    const found: Errors = {};
    if (current === "") found.current = t("wrong");
    if (next.length < MIN_PASSWORD_LENGTH) found.next = t("weak");
    if (confirm !== next) found.confirm = t("mismatch");
    if (Object.keys(found).length > 0) {
      fail(found);
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      await api.post("/me/password", { current_password: current, new_password: next });
      // The done screen only now, after the server answered 204.
      setDone(true);
    } catch (caught) {
      if (isApiError(caught) && caught.code === "wrong_password") fail({ current: t("wrong") });
      else if (isApiError(caught) && caught.code === "weak_password") fail({ next: t("weak") });
      else {
        setNotice({ tone: "bad", text: writeFailureMessage(all, caught) });
        setRetry(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {bar}
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          {notice ? (
            <Banner tone={notice.tone} icon="alert" alert>
              {notice.text}
            </Banner>
          ) : null}
          <PasswordField label={t("current")} value={current} autoComplete="current-password" disabled={busy} error={errors.current} onChange={(event) => setCurrent(event.target.value)} />
          <PasswordField
            label={t("next")}
            value={next}
            autoComplete="new-password"
            disabled={busy}
            helper={all("password.hint")}
            error={errors.next}
            onChange={(event) => setNext(event.target.value)}
          />
          <PasswordField label={t("confirm")} value={confirm} autoComplete="new-password" disabled={busy} error={errors.confirm} onChange={(event) => setConfirm(event.target.value)} />
          <Banner>{t("info")}</Banner>
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy}>
            {busy ? t("submitting") : retry ? t("retry") : t("submit")}
          </Button>
        </ScreenFooter>
      </form>
    </Screen>
  );
}
