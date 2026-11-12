"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { CloseIcon, SendIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { OneTimeLink } from "@/components/OneTimeLink";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { Sheet } from "@/components/Sheet";
import { useRouter } from "@/i18n/navigation";
import { api, isApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import type { InviteResult, StaffInvitation } from "@/lib/staff";

import styles from "../../employees.module.css";
import { Avatar, Contact, EMPLOYEES, NotFoundScreen, RoleChips, StaffLoader, StatusChip, StoreChips, useStaffAccess } from "../../parts";
import type { StaffContext } from "../../parts";

type Busy = "resend" | "revoke" | null;

/** Screens 64 to 68: one invitation. Resend makes a new link; Revoke (pending only) asks first. */
export function InvitationDetail({ invitationId }: { invitationId: string }) {
  return (
    <StaffLoader>
      {(ctx) => {
        const invitation = ctx.list.invitations.find((i) => i.invitation_id === invitationId);
        return invitation ? <Detail invitation={invitation} ctx={ctx} /> : <NotFoundScreen />;
      }}
    </StaffLoader>
  );
}

function Detail({ invitation, ctx }: { invitation: StaffInvitation; ctx: StaffContext }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const access = useStaffAccess();

  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [gone, setGone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [resent, setResent] = useState<InviteResult | null>(null);

  if (gone) return <NotFoundScreen />;

  // Managers cannot resend or revoke an invitation that carries the Owner role. Hidden here, still enforced by the server.
  const ownerLocked = invitation.roles.includes("owner") && !access.manageOwners;
  const canAct = access.manage && !ownerLocked && !closed;
  const pending = invitation.status === "pending";

  function fail(caught: unknown) {
    if (isApiError(caught) && caught.code === "not_found") {
      setGone(true);
    } else if (isApiError(caught) && caught.code === "invitation_closed") {
      setClosed(true);
      setError(null);
    } else {
      setError(errorMessage(t, caught));
    }
  }

  async function resend() {
    setBusy("resend");
    setError(null);
    try {
      setResent(await api.post<InviteResult>(`/staff/invitations/${invitation.invitation_id}/resend`));
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    setBusy("revoke");
    setError(null);
    try {
      await api.delete(`/staff/invitations/${invitation.invitation_id}`);
      router.replace(EMPLOYEES);
    } catch (caught) {
      setConfirming(false);
      fail(caught);
      setBusy(null);
    }
  }

  if (resent) {
    return (
      <OneTimeLink
        ops={false}
        title={t("staff.link.resentTitle")}
        subtitle={invitation.name}
        okText={t("staff.link.resentOk", { name: invitation.name })}
        label={t("staff.link.resentLabel", { name: invitation.name })}
        link={resent.link}
        validity={t("ops.link.validDays", { date: formatDate(resent.expires_at, locale) })}
        note={t("staff.link.resentNote")}
        lost={t("staff.link.resentLost")}
        onDone={() => {
          setResent(null);
          ctx.reload();
        }}
      />
    );
  }

  return (
    <Screen>
      <AppBar title={invitation.name} subtitle={t("staff.invitation.subtitle")} backHref={EMPLOYEES} backLabel={t("common.back")} />
      <ScreenBody>
        {closed ? (
          <Banner tone="bad" icon="alert" alert>
            {t("staff.invitation.closed")}
          </Banner>
        ) : null}
        {error ? (
          <Banner tone="bad" icon="alert" alert>
            {error}
          </Banner>
        ) : null}
        <Card>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <Avatar name={invitation.name} large />
            <div className={styles.personText}>
              <span className={styles.name} style={{ fontSize: 17 }}>
                {invitation.name}
              </span>
              <Contact phone={invitation.phone} email={invitation.email} />
            </div>
            {closed ? null : <StatusChip status={invitation.status} />}
          </div>
          <div className={styles.stack} style={{ marginBlockStart: 10 }}>
            <div>
              <span className={styles.muted}>{t("staff.form.roles")}</span>
              <RoleChips roles={invitation.roles} />
            </div>
            <div>
              <span className={styles.muted}>{t("staff.stores")}</span>
              <div className={styles.pills}>
                <StoreChips allStores={invitation.all_stores} storeIds={invitation.store_ids} />
              </div>
            </div>
            <p className={styles.muted}>
              {pending
                ? t("staff.expires", { date: formatDate(invitation.expires_at, locale) })
                : t("staff.expiredOn", { date: formatDate(invitation.expires_at, locale) })}
            </p>
          </div>
        </Card>
        {closed ? null : ownerLocked ? (
          <Banner icon="lock">{t("staff.invitation.ownerOnly")}</Banner>
        ) : (
          <Banner>{pending ? t("staff.invitation.pendingHint") : t("staff.invitation.expiredHint")}</Banner>
        )}
      </ScreenBody>
      <ScreenFooter>
        {closed || !canAct ? (
          <LinkButton href={EMPLOYEES} variant="ghost">
            {t("staff.backToEmployees")}
          </LinkButton>
        ) : (
          <>
            <Button loading={busy === "resend"} onClick={resend}>
              <SendIcon width={16} height={16} /> {t("staff.invitation.resend")}
            </Button>
            {pending ? (
              <Button variant="danger" onClick={() => setConfirming(true)}>
                <CloseIcon width={16} height={16} /> {t("staff.invitation.revoke")}
              </Button>
            ) : null}
          </>
        )}
      </ScreenFooter>
      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("staff.invitation.revokeTitle", { name: invitation.name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t("staff.invitation.keep")}
            </Button>
            <Button variant="danger" loading={busy === "revoke"} onClick={revoke}>
              <CloseIcon width={16} height={16} /> {t("staff.invitation.revokeConfirm")}
            </Button>
          </>
        }
      >
        <p>{t("staff.invitation.revokeBody")}</p>
      </Sheet>
    </Screen>
  );
}
