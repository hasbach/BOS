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
import { SegmentedControl } from "@/components/SegmentedControl";
import { OpsGuard } from "@/components/SessionGuard";
import { useRouter } from "@/i18n/navigation";
import { api, isApiError } from "@/lib/api";
import { errorMessage, fieldErrorMessages } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import type { Currency, Edition, OpsBusinessCreate, OpsBusinessCreated } from "@/lib/types";

import styles from "../ops.module.css";

const RATE = /^\d+(\.\d{1,2})?$/;

type Errors = Partial<Record<"business_name" | "store_name" | "usd_lbp_rate" | "owner_name" | "owner_phone" | "owner_email", string>>;
const FIELD_NAMES = ["business_name", "store_name", "usd_lbp_rate", "owner_name", "owner_phone", "owner_email"] as const;

interface Attempt {
  key: string;
  body: string;
}

// Screens 37, 45, 38. The setup form is Idempotent: one Idempotency-Key per submission attempt,
// reused when the same details are sent again after a failure, so a retry never creates a second
// business. Changed details get a new key (the same key with a different body is a conflict).
function SetUp() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [edition, setEdition] = useState<Edition>("social");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [rate, setRate] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<OpsBusinessCreated | null>(null);
  const attempt = useRef<Attempt | null>(null);

  function validate(): Errors {
    const found: Errors = {};
    if (businessName.trim() === "") found.business_name = t("ops.new.businessNameRequired");
    if (storeName.trim() === "") found.store_name = t("ops.new.storeNameRequired");
    if (rate.trim() === "") found.usd_lbp_rate = t("ops.new.rateRequired");
    else if (!RATE.test(rate.trim())) found.usd_lbp_rate = t("ops.new.rateInvalid");
    if (ownerName.trim() === "") found.owner_name = t("ops.new.ownerNameRequired");
    if (ownerPhone.trim() === "" && ownerEmail.trim() === "") found.owner_phone = t("ops.new.ownerContactRequired");
    return found;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = validate();
    setFormError(null);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const body: OpsBusinessCreate = {
      business_name: businessName.trim(),
      store_name: storeName.trim(),
      edition,
      default_currency: currency,
      usd_lbp_rate: rate.trim(),
      owner_name: ownerName.trim(),
      ...(ownerPhone.trim() ? { owner_phone: ownerPhone.trim() } : {}),
      ...(ownerEmail.trim() ? { owner_email: ownerEmail.trim() } : {}),
    };
    const serialised = JSON.stringify(body);
    if (!attempt.current || attempt.current.body !== serialised) {
      attempt.current = { key: crypto.randomUUID(), body: serialised };
    }

    setBusy(true);
    try {
      const result = await api.post<OpsBusinessCreated>("/ops/businesses", body, { idempotencyKey: attempt.current.key });
      attempt.current = null;
      setCreated(result);
    } catch (error) {
      if (isApiError(error) && error.code === "identifier_unavailable") {
        // Operators may be told; merchants never are.
        setErrors(
          body.owner_phone
            ? { owner_phone: t("ops.new.phoneUnavailable") }
            : { owner_email: t("ops.new.emailUnavailable") },
        );
      } else if (isApiError(error) && error.code === "validation_failed") {
        const mapped = fieldErrorMessages(t, error.fields);
        const next: Errors = {};
        for (const name of FIELD_NAMES) if (mapped[name]) next[name] = mapped[name];
        setErrors(next);
        if (Object.keys(next).length === 0) setFormError(error);
      } else {
        setFormError(error);
      }
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <OneTimeLink
        title={t("ops.link.createdTitle")}
        subtitle={created.business.name}
        okText={t("ops.link.createdOk", { name: created.business.name })}
        label={t("ops.link.activationLabel", { owner: ownerName.trim() })}
        link={created.link}
        validity={t("ops.link.validDays", { date: formatDate(created.expires_at, locale) })}
        lost={t("ops.link.lostActivation")}
        onDone={() => router.replace("/ops")}
      />
    );
  }

  const errorCount = Object.keys(errors).length;

  return (
    <Screen>
      <AppBar
        ops
        title={t("ops.new.title")}
        subtitle={t("ops.new.subtitle")}
        backHref="/ops"
        backLabel={t("ops.back")}
        badge={t("ops.badge")}
      />
      <form onSubmit={onSubmit} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          {errorCount > 0 ? (
            <Banner tone="bad" icon="alert" alert>
              {t("ops.new.errorCount", { count: errorCount })}
            </Banner>
          ) : null}
          {formError ? (
            <Banner tone="bad" icon="alert" alert>
              {errorMessage(t, formError)}
            </Banner>
          ) : null}
          <Field
            label={t("ops.new.businessName")}
            name="business_name"
            value={businessName}
            onChange={(event) => setBusinessName(event.target.value)}
            error={errors.business_name}
          />
          <Field
            label={t("ops.new.storeName")}
            name="store_name"
            placeholder={t("ops.new.storeNamePlaceholder")}
            value={storeName}
            onChange={(event) => setStoreName(event.target.value)}
            helper={t("ops.new.storeNameHint")}
            error={errors.store_name}
          />
          <div className={styles.seg}>
            <span className={styles.segLabel}>{t("ops.new.edition")}</span>
            <SegmentedControl
              label={t("ops.new.edition")}
              value={edition}
              onChange={setEdition}
              options={[
                { value: "social", label: t("ops.list.edition.social") },
                { value: "commerce", label: t("ops.list.edition.commerce") },
              ]}
            />
          </div>
          <div className={styles.seg}>
            <span className={styles.segLabel}>{t("ops.new.currency")}</span>
            <SegmentedControl
              label={t("ops.new.currency")}
              value={currency}
              onChange={setCurrency}
              options={[
                { value: "USD", label: "USD" },
                { value: "LBP", label: "LBP" },
              ]}
            />
          </div>
          <Field
            label={t("ops.new.rate")}
            name="usd_lbp_rate"
            dir="ltr"
            inputMode="decimal"
            placeholder="89500"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            helper={t("ops.new.rateUnit")}
            error={errors.usd_lbp_rate}
          />
          <p className={styles.sectionLabel}>{t("ops.new.owner")}</p>
          <Field
            label={t("ops.new.ownerName")}
            name="owner_name"
            value={ownerName}
            onChange={(event) => setOwnerName(event.target.value)}
            error={errors.owner_name}
          />
          <Field
            label={t("ops.new.ownerPhone")}
            name="owner_phone"
            type="tel"
            dir="ltr"
            autoComplete="off"
            value={ownerPhone}
            onChange={(event) => setOwnerPhone(event.target.value)}
            error={errors.owner_phone}
          />
          <Field
            label={t("ops.new.ownerEmail")}
            name="owner_email"
            type="email"
            dir="ltr"
            autoComplete="off"
            autoCapitalize="none"
            value={ownerEmail}
            onChange={(event) => setOwnerEmail(event.target.value)}
            helper={t("ops.new.ownerEmailHint")}
            error={errors.owner_email}
          />
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy}>
            {t("ops.new.submit")}
          </Button>
        </ScreenFooter>
      </form>
    </Screen>
  );
}

export function OpsNewBusiness() {
  return (
    <OpsGuard>
      <SetUp />
    </OpsGuard>
  );
}
