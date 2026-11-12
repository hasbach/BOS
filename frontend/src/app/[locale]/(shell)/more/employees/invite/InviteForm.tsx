"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { FormEvent } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { OneTimeLink } from "@/components/OneTimeLink";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { StoresProvider, useStoreChoices } from "@/components/StoresProvider";
import { useRouter } from "@/i18n/navigation";
import { api, isApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { ROLES, forcesAllStores, newIdempotencyKey, sortRoles } from "@/lib/staff";
import type { InviteResult, Role } from "@/lib/staff";

import { CheckGroup, CheckItem, EMPLOYEES, NotAllowedScreen, useStaffAccess } from "../parts";
import { fieldMessages } from "../validation";

type Errors = Record<string, string>;

/** Screens 50 to 55: invite a person, ending on the link that is shown once. */
export function InviteForm() {
  const access = useStaffAccess();
  if (!access.manage) return <NotAllowedScreen />;
  return (
    <StoresProvider>
      <Form />
    </StoresProvider>
  );
}

function Form() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const stores = useStoreChoices();
  const access = useStaffAccess();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [allStores, setAllStores] = useState(false);
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  // One key per submission attempt: the same payload retried reuses it, a changed payload gets a new one.
  const attempt = useRef<{ key: string; body: string } | null>(null);

  const forced = forcesAllStores(roles);
  const activeStores = stores.filter((store) => store.status === "active");
  const roleOptions = ROLES.filter((role) => role !== "owner" || access.manageOwners);

  function toggleRole(role: Role) {
    setRoles((current) => sortRoles(current.includes(role) ? current.filter((r) => r !== role) : [...current, role]));
  }

  function toggleStore(id: string) {
    setStoreIds((current) => (current.includes(id) ? current.filter((s) => s !== id) : [...current, id]));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const body: Record<string, unknown> = { name: name.trim(), roles };
    if (phone.trim()) body.phone = phone.trim();
    if (email.trim()) body.email = email.trim();
    body.all_stores = forced || allStores;
    body.store_ids = forced || allStores ? [] : storeIds;

    const serialised = JSON.stringify(body);
    if (!attempt.current || attempt.current.body !== serialised) {
      attempt.current = { key: newIdempotencyKey(), body: serialised };
    }

    setBusy(true);
    setBanner(null);
    setErrors({});
    try {
      const created = await api.post<InviteResult>("/staff/invitations", body, { idempotencyKey: attempt.current.key });
      attempt.current = null;
      setResult(created);
    } catch (caught) {
      if (isApiError(caught) && caught.code === "validation_failed") {
        const found = fieldMessages(t, caught.fields);
        setErrors(found.messages);
        setBanner(t("staff.form.fix", { count: found.count }));
      } else if (isApiError(caught) && caught.code === "already_member") {
        setErrors({ [phone.trim() || !email.trim() ? "phone" : "email"]: t("staff.fe.duplicate") });
        setBanner(t("staff.form.notCreated"));
      } else {
        setBanner(errorMessage(t, caught));
      }
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const person = result.invitation.name || name.trim();
    return (
      <OneTimeLink
        ops={false}
        title={t("staff.link.inviteTitle")}
        subtitle={person}
        okText={t("staff.link.inviteOk", { name: person })}
        label={t("staff.link.inviteLabel", { name: person })}
        link={result.link}
        validity={t("ops.link.validDays", { date: formatDate(result.expires_at, locale) })}
        note={t("staff.link.inviteNote", { name: person })}
        lost={t("staff.link.inviteLost")}
        onDone={() => router.replace(EMPLOYEES)}
      />
    );
  }

  const contactHint = errors.phone || errors.email ? undefined : t("staff.form.contactHint");

  return (
    <Screen>
      <AppBar title={t("staff.invite")} subtitle={t("staff.form.subtitle")} backHref={EMPLOYEES} backLabel={t("common.back")} />
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          {banner ? (
            <Banner tone="bad" icon="alert" alert>
              {banner}
            </Banner>
          ) : null}
          <Field
            label={t("staff.form.name")}
            value={name}
            placeholder={t("staff.form.namePlaceholder")}
            autoComplete="off"
            error={errors.name}
            onChange={(event) => setName(event.target.value)}
          />
          <Field
            label={t("staff.form.phone")}
            type="tel"
            inputMode="tel"
            dir="ltr"
            placeholder="+961 70 000 000"
            autoComplete="off"
            value={phone}
            error={errors.phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          <Field
            label={t("staff.form.email")}
            type="email"
            inputMode="email"
            dir="ltr"
            placeholder="name@demo.example"
            autoComplete="off"
            value={email}
            helper={contactHint}
            error={errors.email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <CheckGroup
            label={t("staff.form.roles")}
            error={errors.roles}
            hint={access.manageOwners ? t("staff.form.rolesHint") : t("staff.form.ownerOnly")}
          >
            {roleOptions.map((role) => (
              <CheckItem
                key={role}
                checked={roles.includes(role)}
                label={t(`staff.roleFull.${role}`)}
                description={t(`staff.roleDesc.${role}`)}
                onToggle={() => toggleRole(role)}
              />
            ))}
          </CheckGroup>
          <CheckGroup label={t("staff.form.stores")} error={errors.store_ids} hint={forced ? undefined : t("staff.form.storesHint")}>
            {forced ? (
              <CheckItem checked locked label={t("staff.allStores")} description={t("staff.form.forcedStores")} />
            ) : (
              <>
                <CheckItem checked={allStores} label={t("staff.allStores")} onToggle={() => setAllStores((on) => !on)} />
                {activeStores.map((store) => (
                  <CheckItem
                    key={store.id}
                    checked={storeIds.includes(store.id)}
                    dim={allStores}
                    label={store.name}
                    onToggle={() => toggleStore(store.id)}
                  />
                ))}
              </>
            )}
          </CheckGroup>
          <Banner>{t("staff.form.passwordNote")}</Banner>
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy}>
            {busy ? t("staff.form.submitting") : t("staff.form.submit")}
          </Button>
        </ScreenFooter>
      </form>
    </Screen>
  );
}
