"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { FormEvent } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import type { BannerIcon, BannerTone } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Field } from "@/components/Field";
import { BanIcon, CheckIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { Sheet } from "@/components/Sheet";
import { api, isApiError } from "@/lib/api";
import type { AffectedPerson } from "@/lib/api";
import { sortRoles } from "@/lib/staff";
import type { Role } from "@/lib/staff";
import { STORES, checkLogoFile, formatWhatsapp } from "@/lib/stores";
import type { Store, StoreChange } from "@/lib/stores";

import { initials } from "../../employees/parts";
import { LogoField } from "../LogoField";
import { NotAllowedScreen, NotFoundScreen, StatusChip, StoreLogo, useStoreAccess } from "../parts";
import styles from "../stores.module.css";
import { logoErrorText, storeOutcome } from "../validation";
import type { FormErrors } from "../validation";

export interface Notice {
  tone: BannerTone;
  icon: BannerIcon;
  text: string;
}

type Busy = "save" | "deactivate" | "reactivate" | "remove" | null;

export interface StoreEditorProps {
  store: Store;
  initialNotice?: Notice;
  initialLogoError?: string;
}

/** Screens 83 to 90 for owners and managers, and the read-only page (97) for everyone else. */
export function StoreEditor(props: StoreEditorProps) {
  const access = useStoreAccess();
  if (!access.view) return <NotAllowedScreen />;
  return access.manage ? <Editor {...props} /> : <ReadOnly store={props.store} />;
}

function ReadOnly({ store }: { store: Store }) {
  const t = useTranslations("stores");
  const common = useTranslations("common");
  return (
    <Screen>
      <AppBar title={store.name} subtitle={t("detail.subtitle")} backHref={STORES} backLabel={common("back")} />
      <ScreenBody>
        <Banner icon="lock">{t("detail.readOnly")}</Banner>
        <Card className={styles.stack}>
          <div className={styles.row}>
            <StoreLogo store={store} large />
            <div className={styles.grow}>
              <p className={styles.name} style={{ fontSize: 17 }}>
                {store.name}
              </p>
              <div style={{ marginBlockStart: 4 }}>
                <StatusChip status={store.status} />
              </div>
            </div>
          </div>
          <div>
            <p className={styles.label}>{t("detail.whatsapp")}</p>
            <p className={styles.name}>
              {store.whatsapp_number ? <bdi dir="ltr">{formatWhatsapp(store.whatsapp_number)}</bdi> : t("noWhatsapp")}
            </p>
          </div>
        </Card>
      </ScreenBody>
      <ScreenFooter>
        <LinkButton href={STORES} variant="ghost">
          {t("backToStores")}
        </LinkButton>
      </ScreenFooter>
    </Screen>
  );
}

const compact = (value: string) => value.replace(/\s+/g, "");

function Editor({ store: initial, initialNotice, initialLogoError }: StoreEditorProps) {
  const t = useTranslations();

  const [store, setStore] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [whatsapp, setWhatsapp] = useState(initial.whatsapp_number ? formatWhatsapp(initial.whatsapp_number) : "");
  const [errors, setErrors] = useState<FormErrors>({ logo: initialLogoError });
  const [notice, setNotice] = useState<Notice | null>(initialNotice ?? null);
  const [busy, setBusy] = useState<Busy>(null);
  const [uploading, setUploading] = useState<{ file: string; percent: number } | null>(null);
  const [version, setVersion] = useState(0);
  const [confirming, setConfirming] = useState<AffectedPerson[] | null>(null);
  const [refused, setRefused] = useState<"gone" | "denied" | null>(null);
  const abort = useRef<AbortController | null>(null);

  if (refused === "gone") return <NotFoundScreen />;
  if (refused === "denied") return <NotAllowedScreen />;

  const inactive = store.status === "inactive";

  function failed(caught: unknown) {
    const outcome = storeOutcome(t, caught);
    if (outcome.gone) setRefused("gone");
    else if (outcome.forbidden) setRefused("denied");
    setErrors((current) => ({ ...outcome.fields, logo: current.logo }));
    setNotice({ tone: "bad", icon: "alert", text: outcome.banner });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || uploading) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setErrors((current) => ({ logo: current.logo, name: t("stores.fe.name") }));
      setNotice({ tone: "bad", icon: "alert", text: t("stores.form.fix", { count: 1 }) });
      return;
    }
    setBusy("save");
    setNotice(null);
    setErrors((current) => ({ logo: current.logo }));
    const typed = whatsapp.trim();
    try {
      const updated = await api.patch<Store>(`/stores/${store.id}`, { name: trimmed, whatsapp_number: typed === "" ? null : typed } satisfies StoreChange);
      setStore(updated);
      setName(updated.name);
      const saved = updated.whatsapp_number ? formatWhatsapp(updated.whatsapp_number) : "";
      setWhatsapp(saved);
      // Success is shown only now, after the server answered; a number saved in another form says so.
      const changedForm = saved !== "" && compact(typed) !== compact(saved);
      setNotice({
        tone: "ok",
        icon: "check",
        text: changedForm ? t("stores.form.savedWhatsapp", { number: saved }) : t("stores.form.saved"),
      });
    } catch (caught) {
      failed(caught);
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    const problem = checkLogoFile(file);
    if (problem) {
      setErrors((current) => ({ ...current, logo: t(problem === "file_too_large" ? "stores.fe.big" : "stores.fe.img") }));
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setErrors((current) => ({ ...current, logo: undefined }));
    setNotice(null);
    setUploading({ file: file.name, percent: 0 });
    try {
      const updated = await api.upload<Store>(`/stores/${store.id}/logo`, file, {
        signal: controller.signal,
        onProgress: (percent) => setUploading((current) => (current ? { ...current, percent } : current)),
      });
      setStore((current) => ({ ...current, has_logo: updated.has_logo }));
      setVersion((n) => n + 1);
    } catch (caught) {
      // A cancelled upload is the person's own doing; the previous logo stays.
      if (!controller.signal.aborted) {
        const outcome = storeOutcome(t, caught);
        if (outcome.gone) setRefused("gone");
        else if (outcome.forbidden) setRefused("denied");
        else setErrors((current) => ({ ...current, logo: logoErrorText(t, caught) }));
      }
    } finally {
      abort.current = null;
      setUploading(null);
    }
  }

  async function removeLogo() {
    setBusy("remove");
    setNotice(null);
    setErrors((current) => ({ ...current, logo: undefined }));
    try {
      await api.delete(`/stores/${store.id}/logo`);
      setStore((current) => ({ ...current, has_logo: false }));
      setVersion((n) => n + 1);
      setNotice({ tone: "ok", icon: "check", text: t("stores.logo.removed") });
    } catch (caught) {
      failed(caught);
    } finally {
      setBusy(null);
    }
  }

  async function changeStatus(status: "active" | "inactive", confirm: boolean) {
    const action = status === "active" ? "reactivate" : "deactivate";
    setBusy(action);
    setNotice(null);
    setErrors((current) => ({ logo: current.logo }));
    try {
      const body: StoreChange = confirm ? { status, confirm: true } : { status };
      const updated = await api.patch<Store>(`/stores/${store.id}`, body);
      setStore(updated);
      setNotice({
        tone: "ok",
        icon: "check",
        text: status === "active" ? t("stores.reactivated", { name: updated.name }) : t("stores.deactivate.done", { name: updated.name }),
      });
      setConfirming(null);
    } catch (caught) {
      if (isApiError(caught) && caught.code === "confirmation_required") {
        // The server lists everyone who would lose their only store; confirming sends the request again.
        setConfirming(caught.affected);
      } else {
        setConfirming(null);
        failed(caught);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen>
      <AppBar title={t("stores.form.editTitle")} subtitle={store.name} backHref={STORES} backLabel={t("common.back")} />
      <form onSubmit={save} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          {notice ? (
            <Banner tone={notice.tone} icon={notice.icon} alert>
              {notice.text}
            </Banner>
          ) : null}
          {inactive ? (
            <Banner tone="warn" icon="alert">
              {t("stores.form.inactiveBanner")}
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
          <LogoField
            store={store}
            version={version}
            uploading={uploading}
            error={errors.logo}
            disabled={busy !== null}
            onPick={upload}
            onRemove={removeLogo}
            onCancel={() => abort.current?.abort()}
          />
          <Card className={styles.stack}>
            <div className={styles.between}>
              <span className={styles.label}>{t("stores.state.label")}</span>
              <StatusChip status={store.status} />
            </div>
            {inactive ? (
              <>
                <p className={styles.muted}>{t("stores.state.inactiveText")}</p>
                <Button loading={busy === "reactivate"} onClick={() => changeStatus("active", false)}>
                  <CheckIcon width={16} height={16} /> {t("stores.state.reactivate")}
                </Button>
              </>
            ) : (
              <>
                <p className={styles.muted}>{t("stores.state.activeText")}</p>
                <Button variant="danger" loading={busy === "deactivate" && confirming === null} onClick={() => changeStatus("inactive", false)}>
                  <BanIcon width={16} height={16} /> {t("stores.state.deactivate")}
                </Button>
              </>
            )}
          </Card>
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy === "save"} disabled={uploading !== null}>
            {busy === "save" ? t("stores.form.saving") : uploading ? t("stores.form.waiting") : t("stores.form.saveChanges")}
          </Button>
        </ScreenFooter>
      </form>
      <Sheet
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={t("stores.deactivate.title", { name: store.name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t("stores.deactivate.cancel")}
            </Button>
            <Button variant="danger" loading={busy === "deactivate"} onClick={() => changeStatus("inactive", true)}>
              <BanIcon width={16} height={16} /> {t("stores.deactivate.confirm")}
            </Button>
          </>
        }
      >
        <div className={styles.sheetText}>
          {confirming && confirming.length > 0 ? (
            <>
              <p>{t("stores.deactivate.intro")}</p>
              <ul className={styles.affected}>
                {confirming.map((person) => (
                  <li key={`${person.kind}-${person.id}`} className={styles.affectedItem}>
                    <span aria-hidden="true" style={avatar}>
                      {initials(person.name)}
                    </span>
                    <span className={styles.grow}>
                      <span className={styles.name}>{person.name}</span>
                      <br />
                      <span className={styles.muted}>
                        {sortRoles(person.roles as Role[])
                          .map((role) => t(`staff.role.${role}`))
                          .join(", ")}
                      </span>
                    </span>
                    {person.kind === "invitation" ? <Chip tone="warn">{t("stores.deactivate.invitation")}</Chip> : null}
                  </li>
                ))}
              </ul>
              <p>{t("stores.deactivate.outro")}</p>
            </>
          ) : (
            <p>{t("stores.deactivate.nobody")}</p>
          )}
        </div>
      </Sheet>
    </Screen>
  );
}

const avatar = {
  flex: "none",
  inlineSize: 36,
  blockSize: 36,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "var(--surface-2)",
  color: "var(--fg-2)",
  fontWeight: 700,
  fontSize: 12,
} as const;
