"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import type { BannerIcon, BannerTone } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { LinkButton } from "@/components/LinkButton";
import { Loading } from "@/components/Loading";
import { Screen, ScreenBody, ScreenFooter, StatusHeader } from "@/components/Screen";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SessionEnded } from "@/components/SessionEnded";
import { api, isApiError, isSessionEnded } from "@/lib/api";
import type { Business, BusinessChange } from "@/lib/business";
import { errorMessage, fieldErrorMessageKey } from "@/lib/errors";
import { FEE_RULE, RATE_RULE, formatMoney, parseMoney } from "@/lib/money";
import type { MoneyProblem } from "@/lib/money";
import { useSeed } from "@/lib/seed";
import type { Seed } from "@/lib/seed";
import { useMe } from "@/lib/session";
import type { Currency } from "@/lib/types";

import styles from "../stores/stores.module.css";

type Errors = { name?: string; rate?: string; fee?: string };
type Notice = { tone: BannerTone; icon: BannerIcon; text: string };
type Load = { k: "loading" } | { k: "error"; error: unknown } | { k: "ready"; value: Business };

const CURRENCIES: Currency[] = ["USD", "LBP"];

/** Screens 91 to 95 and 99: the business name, currency, exchange rate and delivery fee. */
/** `initial` is GET /business as the server already loaded it for this page; then it is not loaded again. */
export function SettingsForm({ initial }: { initial?: Seed<Business> }) {
  const { permissions } = useMe();
  if (!permissions.includes("settings.manage")) return <NotAllowed />;
  return <Loader initial={initial} />;
}

function Bar() {
  const t = useTranslations();
  const me = useMe();
  return <AppBar title={t("settings.title")} subtitle={me.business.name} backHref="/more" backLabel={t("common.back")} />;
}

function NotAllowed() {
  const t = useTranslations("settings");
  const common = useTranslations("common");
  return (
    <Screen>
      <AppBar title={t("title")} backHref="/more" backLabel={common("back")} />
      <ScreenBody>
        <StatusHeader tone="info" icon="lock" title={t("notAllowed.title")} text={t("notAllowed.text")} />
      </ScreenBody>
      <ScreenFooter>
        <LinkButton href="/more">{t("backToMore")}</LinkButton>
      </ScreenFooter>
    </Screen>
  );
}

function Loader({ initial: seed }: { initial?: Seed<Business> }) {
  const t = useTranslations();
  const initial = useSeed(seed);
  const [state, setState] = useState<Load>(() => (initial !== undefined ? { k: "ready", value: initial } : { k: "loading" }));
  const [attempt, setAttempt] = useState(0);
  const [seeded] = useState(initial !== undefined);

  useEffect(() => {
    // The server's answer stands for the first load; Try again (attempt > 0) always asks again.
    if (seeded && attempt === 0) return;
    const controller = new AbortController();
    api.get<Business>("/business", { signal: controller.signal }).then(
      (value) => setState({ k: "ready", value }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ k: "error", error });
      },
    );
    return () => controller.abort();
  }, [attempt, seeded]);

  if (state.k === "error") {
    if (isSessionEnded(state.error)) return <SessionEnded />;
    if (isApiError(state.error) && state.error.code === "forbidden") return <NotAllowed />;
    return (
      <Screen>
        <Bar />
        <ScreenBody>
          <div role="alert">
            <StatusHeader tone="warn" icon="wifioff" title={t("settings.loadError.title")} text={t("settings.loadError.text")} />
          </div>
        </ScreenBody>
        <ScreenFooter>
          <Button
            onClick={() => {
              setState({ k: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            {t("ui.retry")}
          </Button>
          <LinkButton href="/more" variant="ghost">
            {t("settings.backToMore")}
          </LinkButton>
        </ScreenFooter>
      </Screen>
    );
  }
  if (state.k === "loading") {
    return (
      <Screen>
        <Bar />
        <ScreenBody>
          <Loading label={t("settings.loading")} />
        </ScreenBody>
      </Screen>
    );
  }
  return <Form initial={state.value} />;
}

const rateKey = (problem: MoneyProblem) => (problem === "too_large" ? "settings.fe.rateMax" : problem === "too_many_decimals" ? "settings.fe.decimals" : "settings.fe.rate");
const feeKey = (problem: MoneyProblem) => (problem === "too_large" ? "settings.fe.feeMax" : problem === "too_many_decimals" ? "settings.fe.decimals" : "settings.fe.fee");

function Form({ initial }: { initial: Business }) {
  const t = useTranslations();

  const [name, setName] = useState(initial.name);
  const [currency, setCurrency] = useState<Currency>(initial.default_currency);
  const [rate, setRate] = useState(formatMoney(initial.usd_lbp_rate, { trimZeros: true }));
  const [fee, setFee] = useState(formatMoney(initial.default_delivery_fee));
  const [feeCurrency, setFeeCurrency] = useState<Currency>(initial.default_delivery_fee_currency);
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(false);

  function fill(value: Business) {
    setName(value.name);
    setCurrency(value.default_currency);
    setRate(formatMoney(value.usd_lbp_rate, { trimZeros: true }));
    setFee(formatMoney(value.default_delivery_fee));
    setFeeCurrency(value.default_delivery_fee_currency);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;

    // Checked here first so the person gets the message at once; the server checks again.
    const found: Errors = {};
    const trimmed = name.trim();
    if (trimmed === "") found.name = t("settings.fe.name");
    else if (Array.from(trimmed).length > 120) found.name = t("settings.fe.nameTooLong");
    const rateResult = parseMoney(rate, RATE_RULE);
    if (!rateResult.ok) found.rate = t(rateKey(rateResult.problem));
    const feeResult = parseMoney(fee, FEE_RULE);
    if (!feeResult.ok) found.fee = t(feeKey(feeResult.problem));
    const count = Object.keys(found).length;
    setNotice(null);
    setRetry(false);
    if (count > 0 || !rateResult.ok || !feeResult.ok) {
      setErrors(found);
      setNotice({ tone: "bad", icon: "alert", text: t("settings.fix", { count }) });
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      const body: BusinessChange = {
        name: trimmed,
        default_currency: currency,
        usd_lbp_rate: rateResult.value,
        default_delivery_fee: feeResult.value,
        default_delivery_fee_currency: feeCurrency,
      };
      const saved = await api.patch<Business>("/business", body);
      fill(saved);
      // Success is shown only now, after the server answered 2xx.
      setNotice({ tone: "ok", icon: "check", text: t("settings.saved") });
    } catch (caught) {
      if (isApiError(caught) && caught.code === "validation_failed") {
        const next: Errors = {};
        for (const [field, code] of Object.entries(caught.fields)) {
          if (field === "name") next.name = t(code === "too_long" ? "settings.fe.nameTooLong" : code === "required" ? "settings.fe.name" : fieldErrorMessageKey(code));
          else if (field === "usd_lbp_rate") next.rate = t("settings.fe.rate");
          else if (field === "default_delivery_fee") next.fee = t("settings.fe.fee");
        }
        setErrors(next);
        const total = Object.keys(next).length;
        setNotice({ tone: "bad", icon: "alert", text: total > 0 ? t("settings.fix", { count: total }) : errorMessage(t, caught) });
      } else if (isApiError(caught) && caught.code === "network_error") {
        // No answer: nothing was saved, what was typed stays, and Try again is offered (screen 95).
        setNotice({ tone: "bad", icon: "alert", text: t("settings.offline") });
        setRetry(true);
      } else {
        setNotice({ tone: "bad", icon: "alert", text: errorMessage(t, caught) });
      }
    } finally {
      setBusy(false);
    }
  }

  const currencyOptions = CURRENCIES.map((value) => ({ value, label: value }));

  return (
    <Screen>
      <Bar />
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          {notice ? (
            <Banner tone={notice.tone} icon={notice.icon} alert>
              {notice.text}
            </Banner>
          ) : null}
          <div className={`${styles.stack} ${busy ? styles.dim : ""}`} aria-busy={busy || undefined}>
            <Field
              label={t("settings.name")}
              value={name}
              autoComplete="off"
              disabled={busy}
              error={errors.name}
              onChange={(event) => setName(event.target.value)}
            />
            <div className={styles.stack}>
              <span className={styles.label}>{t("settings.currency")}</span>
              <SegmentedControl label={t("settings.currency")} options={currencyOptions} value={currency} onChange={setCurrency} />
            </div>
            <Field
              label={t("settings.rate")}
              inputMode="decimal"
              dir="ltr"
              autoComplete="off"
              value={rate}
              disabled={busy}
              helper={errors.rate ? undefined : t("settings.rateHint")}
              error={errors.rate}
              onChange={(event) => setRate(event.target.value)}
            />
            <div className={styles.stack}>
              <div className={styles.moneyRow}>
                <Field
                  label={t("settings.fee")}
                  inputMode="decimal"
                  dir="ltr"
                  autoComplete="off"
                  value={fee}
                  disabled={busy}
                  helper={errors.fee ? undefined : t("settings.feeHint")}
                  error={errors.fee}
                  onChange={(event) => setFee(event.target.value)}
                />
                <div className={styles.stack}>
                  <span className={styles.label}>{t("settings.feeCurrency")}</span>
                  <SegmentedControl label={t("settings.feeCurrency")} options={currencyOptions} value={feeCurrency} onChange={setFeeCurrency} />
                </div>
              </div>
            </div>
          </div>
          <Banner>{t("settings.info")}</Banner>
        </ScreenBody>
        <ScreenFooter>
          <Button type="submit" loading={busy}>
            {busy ? t("settings.saving") : retry ? t("settings.retry") : t("settings.save")}
          </Button>
        </ScreenFooter>
      </form>
    </Screen>
  );
}
