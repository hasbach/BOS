"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import type { BannerTone } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field } from "@/components/Field";
import { LockIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { PasswordField } from "@/components/PasswordField";
import { Screen, ScreenBody, ScreenFooter, screenStyles } from "@/components/Screen";
import { Sheet } from "@/components/Sheet";
import { api, isApiError } from "@/lib/api";
import { fieldErrorMessageKey, writeFailureMessage } from "@/lib/errors";
import { useMe, useUpdateMe } from "@/lib/session";
import { formatWhatsapp } from "@/lib/stores";
import type { Me } from "@/lib/types";

import { Avatar, RoleChips } from "../employees/parts";
import styles from "../account.module.css";

type Errors = { name?: string; phone?: string; email?: string };
type Notice = { tone: BannerTone; icon: "check" | "alert"; text: ReactNode };

// Keeps a number or an address in its own reading direction inside Arabic text.
const ltr = (chunks: ReactNode) => <bdi dir="ltr">{chunks}</bdi>;

// Phone numbers are shown the way people read them ("+961 71 612 815"), with the one formatter the store screens use.
const showPhone = (phone: string | null) => (phone ? formatWhatsapp(phone) : "");

const same = (typed: string, saved: string | null) => typed.trim() === (saved ?? "").trim();
const samePhone = (typed: string, saved: string | null) => same(typed, saved) || typed.trim() === showPhone(saved);

/** Screens 120 to 125 and 130: name, phone and email. A new phone or email asks for the current password first. */
export function ProfileScreen() {
  const t = useTranslations("profile");
  const all = useTranslations();
  const me = useMe();
  const updateMe = useUpdateMe();

  const [name, setName] = useState(me.user.name);
  const [phone, setPhone] = useState(showPhone(me.user.phone));
  const [email, setEmail] = useState(me.user.email ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [retry, setRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | undefined>();

  const nameChanged = !same(name, me.user.name);
  const phoneChanged = !samePhone(phone, me.user.phone);
  const emailChanged = !same(email, me.user.email);
  const identifierChanged = phoneChanged || emailChanged;
  const dirty = nameChanged || identifierChanged;

  function show(next: Errors, text?: string) {
    const count = Object.keys(next).length;
    setErrors(next);
    setNotice({ tone: "bad", icon: "alert", text: text ?? (count > 0 ? t("fix", { count }) : t("notSaved")) });
  }

  /** What the person typed, checked here first so they get the message at once; the server checks again. */
  function problems(): Errors {
    const found: Errors = {};
    if (name.trim() === "") found.name = t("nameRequired");
    if (phone.trim() === "" && email.trim() === "") found.phone = t("identifierRequired");
    return found;
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy || !dirty) return;
    setNotice(null);
    setRetry(false);
    const found = problems();
    if (Object.keys(found).length > 0) {
      show(found);
      return;
    }
    setErrors({});
    if (identifierChanged) {
      setPasswordError(undefined);
      setSheet(true);
      return;
    }
    void send();
  }

  async function send() {
    setBusy(true);
    try {
      const body: Record<string, string | null> = {};
      if (nameChanged) body.name = name.trim();
      if (phoneChanged) body.phone = phone.trim() === "" ? null : phone.trim();
      if (emailChanged) body.email = email.trim() === "" ? null : email.trim();
      if (identifierChanged) body.current_password = password;

      const saved = await api.patch<Me>("/me", body);
      // Shown only now, after the server answered 200.
      setName(saved.user.name);
      setPhone(showPhone(saved.user.phone));
      setEmail(saved.user.email ?? "");
      setPassword("");
      setSheet(false);
      setErrors({});
      updateMe(saved);
      const signInWith = phoneChanged ? showPhone(saved.user.phone) : emailChanged ? saved.user.email : null;
      setNotice({
        tone: "ok",
        icon: "check",
        text: identifierChanged && signInWith ? t.rich("savedSignIn", { value: signInWith, v: ltr }) : t("saved"),
      });
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  function handleFailure(caught: unknown) {
    if (isApiError(caught) && caught.code === "wrong_password") {
      setPasswordError(t("confirm.wrong"));
      return;
    }
    setSheet(false);
    if (isApiError(caught) && caught.code === "validation_failed") {
      const next: Errors = {};
      for (const [field, code] of Object.entries(caught.fields)) {
        if (field === "phone") next.phone = code === "invalid_phone" ? t("phoneInvalid") : all(fieldErrorMessageKey(code));
        else if (field === "email") next.email = all(fieldErrorMessageKey(code));
        else if (field === "name") next.name = code === "required" ? t("nameRequired") : all(fieldErrorMessageKey(code));
        else if (field === "identifier") next.phone = t("identifierRequired");
      }
      show(next, Object.keys(next).length === 0 ? writeFailureMessage(all, caught) : undefined);
      return;
    }
    if (isApiError(caught) && caught.code === "identifier_unavailable") {
      // The same neutral words whoever holds the identifier; under the field that changed.
      show(phoneChanged ? { phone: t("phoneUnavailable") } : { email: t("emailUnavailable") }, t("notSaved"));
      return;
    }
    // No answer, or something unexpected: nothing was saved, everything typed stays, Try again is offered.
    setNotice({ tone: "bad", icon: "alert", text: writeFailureMessage(all, caught) });
    setRetry(true);
  }

  function confirmSheet() {
    if (password === "") {
      setPasswordError(t("confirm.wrong"));
      return;
    }
    setPasswordError(undefined);
    void send();
  }

  const typedPhone = phone.trim();
  const typedEmail = email.trim();
  const confirmText =
    phoneChanged && emailChanged
      ? t.rich("confirm.both", { phone: typedPhone, email: typedEmail, v: ltr })
      : phoneChanged
        ? t.rich("confirm.phone", { value: typedPhone, v: ltr })
        : t.rich("confirm.email", { value: typedEmail, v: ltr });

  return (
    <Screen>
      <AppBar title={t("title")} subtitle={me.business.name} backHref="/more" backLabel={all("common.back")} />
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          {notice ? (
            <Banner tone={notice.tone} icon={notice.icon} alert={notice.tone === "bad"}>
              {notice.text}
            </Banner>
          ) : null}
          <Card style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Avatar name={name || me.user.name} large />
            <div className={styles.text}>
              <span className={screenStyles.title} style={{ fontSize: 17 }}>
                {name || me.user.name}
              </span>
              <RoleChips roles={me.user.roles} />
            </div>
          </Card>
          <Field label={t("name")} value={name} autoComplete="name" disabled={busy} error={errors.name} onChange={(event) => setName(event.target.value)} />
          <Field
            label={t("phone")}
            value={phone}
            type="tel"
            inputMode="tel"
            dir="ltr"
            autoComplete="tel"
            disabled={busy}
            error={errors.phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          <Field
            label={t("email")}
            value={email}
            type="email"
            inputMode="email"
            dir="ltr"
            autoComplete="email"
            placeholder="name@example.com"
            disabled={busy}
            helper={errors.email ? undefined : t("emailHint")}
            error={errors.email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <p className={screenStyles.hint} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <LockIcon width={14} height={14} /> {t("passwordNote")}
          </p>
          <Card style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className={screenStyles.label}>{t("passwordTitle")}</span>
            <p className={screenStyles.muted}>{t("passwordText")}</p>
            <LinkButton href="/more/profile/password" variant="ghost">
              {t("changePassword")}
            </LinkButton>
          </Card>
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy && !sheet} disabled={!dirty && !retry}>
            {busy && !sheet ? t("saving") : retry ? t("retry") : t("save")}
          </Button>
        </ScreenFooter>
      </form>

      <Sheet
        open={sheet}
        onClose={() => (busy ? undefined : setSheet(false))}
        title={t("confirm.title")}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setSheet(false)}>
              {t("confirm.cancel")}
            </Button>
            <Button loading={busy} onClick={confirmSheet}>
              {t("confirm.submit")}
            </Button>
          </>
        }
      >
        <p className={screenStyles.muted}>{confirmText}</p>
        <PasswordField label={t("confirm.password")} value={password} autoComplete="current-password" error={passwordError} onChange={(event) => setPassword(event.target.value)} />
      </Sheet>
    </Screen>
  );
}
