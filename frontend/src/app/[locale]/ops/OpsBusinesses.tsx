"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Empty } from "@/components/Empty";
import { ErrorState } from "@/components/ErrorState";
import { BanIcon, CheckIcon, ClockIcon, LockIcon, PlusIcon, SendIcon } from "@/components/icons";
import { Loading } from "@/components/Loading";
import { OneTimeLink } from "@/components/OneTimeLink";
import { OpsGuard } from "@/components/SessionGuard";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { Sheet } from "@/components/Sheet";
import { LinkButton } from "@/components/LinkButton";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { opsSignOut, useOpsMe } from "@/lib/session";
import type { BusinessStatus, LinkResult, OpsBusiness, OpsOwner } from "@/lib/types";

import styles from "./ops.module.css";

type Filter = "all" | BusinessStatus;
const FILTERS: Filter[] = ["all", "pending", "active", "suspended"];

type Confirm = { business: OpsBusiness; to: "suspended" | "active" };
type LinkView = { kind: "activation" | "reset"; business: OpsBusiness; owner: string; result: LinkResult };

function StatusChip({ status }: { status: BusinessStatus }) {
  const t = useTranslations("ops.list.status");
  // The word carries the status; the icon and colour only reinforce it.
  if (status === "active")
    return (
      <Chip tone="ok">
        <CheckIcon width={14} height={14} /> {t("active")}
      </Chip>
    );
  if (status === "pending")
    return (
      <Chip tone="warn">
        <ClockIcon width={14} height={14} /> {t("pending")}
      </Chip>
    );
  return (
    <Chip tone="bad">
      <BanIcon width={14} height={14} /> {t("suspended")}
    </Chip>
  );
}

interface CardProps {
  business: OpsBusiness;
  busyKey: string | null;
  onSuspend: () => void;
  onReactivate: () => void;
  onResend: () => void;
  onReset: (owner: OpsOwner) => void;
}

function BusinessCard({ business: b, busyKey, onSuspend, onReactivate, onResend, onReset }: CardProps) {
  const t = useTranslations("ops.list");
  const owners = b.owners;
  const noEmailOwners = b.status === "pending" ? [] : owners.filter((owner) => !owner.has_email);

  return (
    <Card as="article" className={styles.bizCard}>
      <div className={styles.between}>
        <h2 className={styles.bizName}>{b.name}</h2>
        <StatusChip status={b.status} />
      </div>
      <div className={styles.meta}>
        <Chip tone={b.edition === "commerce" ? "info" : "neutral"}>{t(`edition.${b.edition}`)}</Chip>
        {b.is_demo ? <Chip>{t("demo")}</Chip> : null}
        <span>
          {t("stores")} <b>{b.store_count}</b> · {t("users")} <b>{b.user_count}</b>
        </span>
      </div>
      {b.status === "pending" ? (
        <>
          <p className={styles.line}>{t("ownerPending")}</p>
          {b.pending_owner_contact ? (
            <p className={`${styles.line} ${styles.ltr}`}>{b.pending_owner_contact}</p>
          ) : null}
        </>
      ) : (
        owners.map((owner) => (
          <div key={owner.user_id}>
            <p className={styles.line}>
              {t("owner")}: {owner.name}
            </p>
            <p className={styles.line}>
              <bdi dir="ltr">{owner.contact}</bdi> {owner.has_email ? null : <Chip>{t("noEmail")}</Chip>}
            </p>
          </div>
        ))
      )}
      {b.status === "active" ? (
        <Button variant="danger" size="small" loading={busyKey === `${b.id}:suspend`} onClick={onSuspend}>
          <BanIcon width={16} height={16} /> {t("suspend")}
        </Button>
      ) : null}
      {b.status === "suspended" ? (
        <Button variant="ghost" size="small" loading={busyKey === `${b.id}:react`} onClick={onReactivate}>
          <CheckIcon width={16} height={16} /> {t("reactivate")}
        </Button>
      ) : null}
      {b.status === "pending" ? (
        <Button variant="ghost" size="small" loading={busyKey === `${b.id}:resend`} onClick={onResend}>
          <SendIcon width={16} height={16} /> {t("resend")}
        </Button>
      ) : null}
      {noEmailOwners.map((owner) => (
        <Button
          key={owner.user_id}
          variant="ghost"
          size="small"
          loading={busyKey === `${b.id}:reset:${owner.user_id}`}
          onClick={() => onReset(owner)}
        >
          <LockIcon width={16} height={16} /> {noEmailOwners.length > 1 ? t("resetFor", { name: owner.name }) : t("reset")}
        </Button>
      ))}
    </Card>
  );
}

function Console() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const operator = useOpsMe();
  const [businesses, setBusinesses] = useState<OpsBusiness[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [linkView, setLinkView] = useState<LinkView | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.get<OpsBusiness[]>("/ops/businesses", { signal: controller.signal }).then(
      (list) => {
        setBusinesses(list);
        setLoadError(null);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error);
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => {
    setBusinesses(null);
    setLoadError(null);
    setAttempt((n) => n + 1);
  }, []);

  async function changeStatus({ business, to }: Confirm) {
    const key = `${business.id}:${to === "suspended" ? "suspend" : "react"}`;
    setBusyKey(key);
    setActionError(null);
    try {
      const updated = await api.patch<OpsBusiness>(`/ops/businesses/${business.id}`, { status: to });
      setBusinesses((list) => (list ?? []).map((item) => (item.id === updated.id ? updated : item)));
      setConfirm(null);
    } catch (error) {
      setConfirm(null);
      setActionError(error);
    } finally {
      setBusyKey(null);
    }
  }

  async function resend(business: OpsBusiness) {
    setBusyKey(`${business.id}:resend`);
    setActionError(null);
    try {
      const result = await api.post<LinkResult>(`/ops/businesses/${business.id}/owner-activation`);
      setLinkView({ kind: "activation", business, owner: business.pending_owner_contact ?? business.name, result });
    } catch (error) {
      setActionError(error);
    } finally {
      setBusyKey(null);
    }
  }

  async function resetOwner(business: OpsBusiness, owner: OpsOwner) {
    setBusyKey(`${business.id}:reset:${owner.user_id}`);
    setActionError(null);
    try {
      const result = await api.post<LinkResult>(`/ops/businesses/${business.id}/owner-password-reset`, {
        owner_user_id: owner.user_id,
      });
      setLinkView({ kind: "reset", business, owner: owner.name, result });
    } catch (error) {
      setActionError(error);
    } finally {
      setBusyKey(null);
    }
  }

  async function signOut() {
    try {
      await opsSignOut();
      router.replace("/ops/sign-in");
    } catch (error) {
      setActionError(error);
    }
  }

  if (linkView) {
    const { kind, business, owner, result } = linkView;
    const isReset = kind === "reset";
    return (
      <OneTimeLink
        title={t(isReset ? "ops.link.resetTitle" : "ops.link.resentTitle")}
        subtitle={isReset ? `${business.name} · ${owner}` : business.name}
        okText={t(isReset ? "ops.link.resetOk" : "ops.link.resentOk", { owner })}
        label={t(isReset ? "ops.link.resetLabel" : "ops.link.activationLabel", { owner })}
        link={result.link}
        validity={isReset ? t("ops.link.validHour") : t("ops.link.validDays", { date: formatDate(result.expires_at, locale) })}
        note={isReset ? t("ops.link.resetNote") : undefined}
        lost={t(isReset ? "ops.link.lostReset" : "ops.link.lostActivation")}
        onDone={() => {
          setLinkView(null);
          reload();
        }}
      />
    );
  }

  const list = businesses ?? [];
  const counts = (status: Filter) => (status === "all" ? list.length : list.filter((b) => b.status === status).length);
  const visible = filter === "all" ? list : list.filter((b) => b.status === filter);

  return (
    <Screen>
      <AppBar
        ops
        title={t("ops.list.title")}
        subtitle={operator.name}
        badge={t("ops.badge")}
        onSignOut={signOut}
        signOutLabel={t("ops.signOut")}
      />
      {loadError ? (
        <ErrorState message={errorMessage(t, loadError)} onRetry={reload} />
      ) : businesses === null ? (
        <Loading />
      ) : list.length === 0 ? (
        <>
          <ScreenBody center>
            <Empty
              title={t("ops.list.emptyTitle")}
              description={t("ops.list.emptyText")}
              action={
                <LinkButton href="/ops/new">
                  <PlusIcon width={18} height={18} /> {t("ops.list.setUp")}
                </LinkButton>
              }
            />
          </ScreenBody>
        </>
      ) : (
        <>
          <ScreenBody>
            {actionError ? (
              <Banner tone="bad" icon="alert" alert>
                {errorMessage(t, actionError)}
              </Banner>
            ) : null}
            <div className={styles.pills} role="group" aria-label={t("ops.list.title")}>
              {FILTERS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={styles.pill}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value === "all" ? t("ops.list.all") : t(`ops.list.status.${value}`)} {counts(value)}
                </button>
              ))}
            </div>
            {visible.length === 0 ? <p className={styles.line}>{t("ops.list.noMatch")}</p> : null}
            {visible.map((business) => (
              <BusinessCard
                key={business.id}
                business={business}
                busyKey={busyKey}
                onSuspend={() => setConfirm({ business, to: "suspended" })}
                onReactivate={() => setConfirm({ business, to: "active" })}
                onResend={() => resend(business)}
                onReset={(owner) => resetOwner(business, owner)}
              />
            ))}
            <Banner>{t("ops.list.accountOnly")}</Banner>
          </ScreenBody>
          <ScreenFooter>
            <LinkButton href="/ops/new">
              <PlusIcon width={18} height={18} /> {t("ops.list.setUp")}
            </LinkButton>
          </ScreenFooter>
        </>
      )}
      <Sheet
        open={confirm !== null}
        onClose={() => (busyKey ? undefined : setConfirm(null))}
        title={
          confirm
            ? t(confirm.to === "suspended" ? "ops.list.suspendTitle" : "ops.list.reactivateTitle", { name: confirm.business.name })
            : ""
        }
        footer={
          confirm ? (
            <div className={styles.sheetActions}>
              <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busyKey !== null}>
                {t("ops.list.cancel")}
              </Button>
              <Button
                variant={confirm.to === "suspended" ? "danger" : "primary"}
                loading={busyKey !== null}
                onClick={() => changeStatus(confirm)}
              >
                {confirm.to === "suspended" ? <BanIcon width={16} height={16} /> : <CheckIcon width={16} height={16} />}
                {t(confirm.to === "suspended" ? "ops.list.suspend" : "ops.list.reactivate")}
              </Button>
            </div>
          ) : null
        }
      >
        {confirm ? <p>{t(confirm.to === "suspended" ? "ops.list.suspendText" : "ops.list.reactivateText")}</p> : null}
      </Sheet>
    </Screen>
  );
}

export function OpsBusinesses() {
  return (
    <OpsGuard>
      <Console />
    </OpsGuard>
  );
}
