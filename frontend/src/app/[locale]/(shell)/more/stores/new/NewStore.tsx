"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { FormEvent } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { STORES, checkLogoFile } from "@/lib/stores";
import type { Store } from "@/lib/stores";

import { LogoField } from "../LogoField";
import { NotAllowedScreen, NotFoundScreen, useStoreAccess } from "../parts";
import { StoreEditor } from "../[storeId]/StoreEditor";
import { logoErrorText, storeOutcome } from "../validation";
import type { FormErrors } from "../validation";

/** Screens 78 to 82: add a store. The logo, if any, is sent right after the store exists. */
export function NewStore() {
  const access = useStoreAccess();
  if (!access.manage) return <NotAllowedScreen />;
  return <Form />;
}

function Form() {
  const t = useTranslations();
  const router = useRouter();
  const me = useMe();

  const [name, setName] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [logo, setLogo] = useState<File | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The store exists but its logo was refused: the screen turns into Edit store (screen 82).
  const [created, setCreated] = useState<{ store: Store; logoError: string } | null>(null);
  const [refused, setRefused] = useState<"gone" | "denied" | null>(null);

  if (refused === "gone") return <NotFoundScreen />;
  if (refused === "denied") return <NotAllowedScreen />;
  if (created) {
    return (
      <StoreEditor
        key={created.store.id}
        store={created.store}
        initialNotice={{ tone: "warn", icon: "alert", text: t("stores.form.created", { name: created.store.name }) }}
        initialLogoError={created.logoError}
      />
    );
  }

  function pick(file: File) {
    const problem = checkLogoFile(file);
    if (problem) {
      setLogo(null);
      setErrors((current) => ({ ...current, logo: t(problem === "file_too_large" ? "stores.fe.big" : "stores.fe.img") }));
      return;
    }
    setErrors((current) => ({ ...current, logo: undefined }));
    setLogo(file);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setErrors({ name: t("stores.fe.name"), logo: errors.logo });
      setBanner(t("stores.form.fix", { count: 1 }));
      return;
    }

    setBusy(true);
    setBanner(null);
    setErrors({ logo: errors.logo });
    let store: Store;
    try {
      store = await api.post<Store>("/stores", { name: trimmed, whatsapp_number: whatsapp.trim() === "" ? null : whatsapp.trim() });
    } catch (caught) {
      const outcome = storeOutcome(t, caught);
      if (outcome.forbidden) setRefused("denied");
      setErrors({ ...outcome.fields, logo: errors.logo });
      setBanner(outcome.banner);
      setBusy(false);
      return;
    }

    if (logo) {
      try {
        store = await api.upload<Store>(`/stores/${store.id}/logo`, logo);
      } catch (caught) {
        // The store exists: go on to its edit screen with the logo error (screen 82).
        setCreated({ store, logoError: logoErrorText(t, caught) });
        setBusy(false);
        return;
      }
    }
    router.replace(STORES);
  }

  return (
    <Screen>
      <AppBar title={t("stores.form.addTitle")} subtitle={me.business.name} backHref={STORES} backLabel={t("common.back")} />
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          {banner ? (
            <Banner tone="bad" icon="alert" alert>
              {banner}
            </Banner>
          ) : null}
          <Field
            label={t("stores.form.name")}
            value={name}
            placeholder={t("stores.form.namePlaceholder")}
            autoComplete="off"
            error={errors.name}
            onChange={(event) => setName(event.target.value)}
          />
          <Field
            label={t("stores.form.whatsapp")}
            type="tel"
            inputMode="tel"
            dir="ltr"
            placeholder="+961 70 000 000"
            autoComplete="off"
            value={whatsapp}
            helper={errors.wa ? undefined : t("stores.form.whatsappHint")}
            error={errors.wa}
            onChange={(event) => setWhatsapp(event.target.value)}
          />
          <LogoField store={null} chosen={logo} error={errors.logo} disabled={busy} onPick={pick} onRemove={() => setLogo(null)} />
          <Banner>{t("stores.form.afterSave")}</Banner>
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy}>
            {busy ? t("stores.form.saving") : t("stores.form.save")}
          </Button>
        </ScreenFooter>
      </form>
    </Screen>
  );
}
