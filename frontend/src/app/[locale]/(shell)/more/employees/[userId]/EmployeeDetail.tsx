"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import type { BannerIcon, BannerTone } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { BanIcon, CheckIcon, LockIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { OneTimeLink } from "@/components/OneTimeLink";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { Sheet } from "@/components/Sheet";
import { api, isApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/session";
import { ROLES, forcesAllStores, sortRoles } from "@/lib/staff";
import type { Role, StaffLink, StaffMember, StaffUpdate } from "@/lib/staff";

import styles from "../employees.module.css";
import {
  Avatar,
  CheckGroup,
  CheckItem,
  Contact,
  EMPLOYEES,
  NotFoundScreen,
  RoleChips,
  StaffLoader,
  StatusChip,
  StoreChips,
  useStaffAccess,
} from "../parts";
import type { StaffContext } from "../parts";
import { fieldMessages } from "../validation";

type Notice = { tone: BannerTone; icon: BannerIcon; text: string };
type Busy = "save" | "deactivate" | "reactivate" | "reset" | null;

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/** Screens 57 to 63: one employee. Roles and stores are saved together; the rules are shown, the server enforces them. */
export function EmployeeDetail({ userId }: { userId: string }) {
  return (
    <StaffLoader>
      {(ctx) => {
        const member = ctx.list.members.find((m) => m.user_id === userId);
        return member ? <Detail member={member} ctx={ctx} /> : <NotFoundScreen />;
      }}
    </StaffLoader>
  );
}

function Head({ member, you }: { member: StaffMember; you: boolean }) {
  const t = useTranslations("staff");
  return (
    <Card>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Avatar name={member.name} large />
        <div className={styles.personText}>
          <span className={styles.name} style={{ fontSize: 17 }}>
            {member.name}
            {you ? (
              <>
                {" "}
                <Chip>{t("you")}</Chip>
              </>
            ) : null}
          </span>
          <Contact phone={member.phone} email={member.email} />
          {member.email ? null : (
            <span>
              <Chip>{t("noEmail")}</Chip>
            </span>
          )}
        </div>
        <StatusChip status={member.status} />
      </div>
    </Card>
  );
}

function ReadOnly({ member, reason, you, onlyOwner }: { member: StaffMember; reason: string | null; you: boolean; onlyOwner: boolean }) {
  const t = useTranslations("staff");
  const common = useTranslations("common");
  return (
    <Screen>
      <AppBar title={member.name} subtitle={t("detail.subtitle")} backHref={EMPLOYEES} backLabel={common("back")} />
      <ScreenBody>
        {reason ? (
          <Banner icon="lock">{reason}</Banner>
        ) : null}
        <Head member={member} you={you} />
        <Card>
          <p className={styles.fieldLabel}>
            <LockIcon width={14} height={14} aria-hidden="true" /> {t("detail.rolesReadOnly")}
          </p>
          <div style={{ margin: "6px 0 12px" }}>
            <RoleChips roles={member.roles} />
          </div>
          <p className={styles.fieldLabel}>{t("detail.storesReadOnly")}</p>
          <div className={styles.pills} style={{ marginBlockStart: 6 }}>
            <StoreChips allStores={member.all_stores} storeIds={member.store_ids} />
          </div>
        </Card>
        {you && onlyOwner ? (
          <Banner tone="warn" icon="alert">
            {t("detail.selfOnlyOwner")}
          </Banner>
        ) : null}
        {you ? <p className={styles.muted}>{t("detail.selfPassword")}</p> : null}
      </ScreenBody>
      <ScreenFooter>
        <LinkButton href={EMPLOYEES} variant="ghost">
          {t("backToEmployees")}
        </LinkButton>
      </ScreenFooter>
    </Screen>
  );
}

function Detail({ member, ctx }: { member: StaffMember; ctx: StaffContext }) {
  const t = useTranslations();
  const me = useMe();
  const access = useStaffAccess();

  const [roles, setRoles] = useState<Role[]>(sortRoles(member.roles));
  const [allStores, setAllStores] = useState(member.all_stores);
  const [storeIds, setStoreIds] = useState<string[]>(member.store_ids);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirming, setConfirming] = useState(false);
  const [link, setLink] = useState<StaffLink | null>(null);
  const [gone, setGone] = useState(false);

  const isSelf = member.user_id === me.user.id;
  const isOwner = member.roles.includes("owner");
  const activeOwners = ctx.list.members.filter((m) => m.status === "active" && m.roles.includes("owner"));
  // Computed from the list so the buttons are disabled up front; the server still answers last_owner if two changes race.
  const onlyOwner = member.status === "active" && isOwner && activeOwners.length === 1;

  if (gone) return <NotFoundScreen />;

  if (isSelf) return <ReadOnly member={member} you onlyOwner={onlyOwner} reason={t("staff.detail.self")} />;
  if (isOwner && !access.manageOwners) return <ReadOnly member={member} you={false} onlyOwner={false} reason={t("staff.detail.managerOwner")} />;
  if (!access.manage) return <ReadOnly member={member} you={false} onlyOwner={false} reason={null} />;

  const forced = forcesAllStores(roles);
  const roleOptions = ROLES.filter((role) => role !== "owner" || access.manageOwners || member.roles.includes("owner"));
  const activeStores = me.stores.filter((store) => store.status === "active" || member.store_ids.includes(store.id));
  const memberForced = forcesAllStores(member.roles);
  const dirty =
    !sameSet(roles, member.roles) ||
    (forced || allStores) !== (memberForced || member.all_stores) ||
    (!(forced || allStores) && !sameSet(storeIds, member.store_ids));

  function toggleRole(role: Role) {
    setRoles((current) => sortRoles(current.includes(role) ? current.filter((r) => r !== role) : [...current, role]));
  }

  function toggleStore(id: string) {
    setStoreIds((current) => (current.includes(id) ? current.filter((s) => s !== id) : [...current, id]));
  }

  function fail(caught: unknown) {
    if (isApiError(caught) && caught.code === "not_found") {
      setGone(true);
      return;
    }
    if (isApiError(caught) && caught.code === "validation_failed") {
      const found = fieldMessages(t, caught.fields);
      setErrors(found.messages);
      setNotice({ tone: "bad", icon: "alert", text: t("staff.detail.fix", { count: found.count }) });
      return;
    }
    setNotice({ tone: "bad", icon: "alert", text: errorMessage(t, caught) });
  }

  async function change(action: Exclude<Busy, "reset" | null>, body: StaffUpdate, success: string) {
    setBusy(action);
    setNotice(null);
    setErrors({});
    try {
      const updated = await api.patch<StaffMember>(`/staff/${member.user_id}`, body);
      ctx.update((list) => ({ ...list, members: list.members.map((m) => (m.user_id === updated.user_id ? updated : m)) }));
      setRoles(sortRoles(updated.roles));
      setAllStores(updated.all_stores);
      setStoreIds(updated.store_ids);
      setNotice({ tone: "ok", icon: "check", text: success });
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  const save = () =>
    change(
      "save",
      { roles, all_stores: forced || allStores, store_ids: forced || allStores ? [] : storeIds },
      t("staff.detail.saved"),
    );
  const deactivate = () => change("deactivate", { status: "inactive" }, t("staff.detail.deactivated", { name: member.name }));
  const reactivate = () => change("reactivate", { status: "active" }, t("staff.detail.reactivated", { name: member.name }));

  async function issueReset() {
    setBusy("reset");
    setNotice(null);
    try {
      setLink(await api.post<StaffLink>(`/staff/${member.user_id}/password-reset`));
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  }

  if (link) {
    return (
      <OneTimeLink
        ops={false}
        title={t("staff.link.resetTitle")}
        subtitle={member.name}
        okText={t("staff.link.resetOk", { name: member.name })}
        label={t("staff.link.resetLabel", { name: member.name })}
        link={link.link}
        validity={t("ops.link.validHour")}
        note={t("staff.link.resetNote", { name: member.name })}
        lost={t("staff.link.resetLost")}
        onDone={() => setLink(null)}
      />
    );
  }

  const inactive = member.status === "inactive";

  return (
    <Screen>
      <AppBar title={member.name} subtitle={t("staff.detail.subtitle")} backHref={EMPLOYEES} backLabel={t("common.back")} />
      <ScreenBody>
        {notice ? (
          <Banner tone={notice.tone} icon={notice.icon} alert>
            {notice.text}
          </Banner>
        ) : null}
        {inactive ? (
          <Banner tone="warn" icon="alert">
            {t("staff.detail.inactiveBanner")}
          </Banner>
        ) : null}
        <Head member={member} you={false} />
        <CheckGroup label={t("staff.form.roles")} error={errors.roles} hint={t("staff.form.rolesHint")}>
          {roleOptions.map((role) => {
            const protectedOwner = role === "owner" && onlyOwner;
            return (
              <CheckItem
                key={role}
                checked={roles.includes(role)}
                locked={protectedOwner}
                label={t(`staff.roleFull.${role}`)}
                description={protectedOwner ? t("staff.detail.onlyOwnerRole") : t(`staff.roleDesc.${role}`)}
                onToggle={() => toggleRole(role)}
              />
            );
          })}
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
        <Banner>{t("staff.detail.nextAction")}</Banner>
        <Card className={styles.stack}>
          <p className={styles.fieldLabel}>{t("staff.detail.account")}</p>
          {inactive ? (
            <>
              <p className={styles.muted}>{t("staff.detail.reactivateText")}</p>
              <Button loading={busy === "reactivate"} onClick={reactivate}>
                <CheckIcon width={16} height={16} /> {t("staff.detail.reactivate")}
              </Button>
            </>
          ) : (
            <>
              <p className={styles.muted}>{onlyOwner ? t("staff.detail.onlyOwnerDeactivate") : t("staff.detail.deactivateText")}</p>
              <Button variant="danger" disabled={onlyOwner} onClick={() => setConfirming(true)}>
                <BanIcon width={16} height={16} /> {t("staff.detail.deactivate")}
              </Button>
            </>
          )}
          {inactive ? null : (
            <div className={`${styles.stack} ${styles.divider}`}>
              <p className={styles.muted}>{t("staff.detail.resetText")}</p>
              <Button variant="ghost" loading={busy === "reset"} onClick={issueReset}>
                <LockIcon width={16} height={16} /> {t("staff.detail.reset")}
              </Button>
            </div>
          )}
        </Card>
      </ScreenBody>
      <ScreenFooter>
        <Button loading={busy === "save"} disabled={!dirty} onClick={save}>
          {busy === "save" ? t("staff.detail.saving") : t("staff.detail.save")}
        </Button>
      </ScreenFooter>
      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("staff.detail.deactivateTitle", { name: member.name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t("staff.detail.cancel")}
            </Button>
            <Button variant="danger" loading={busy === "deactivate"} onClick={deactivate}>
              <BanIcon width={16} height={16} /> {t("staff.detail.deactivate")}
            </Button>
          </>
        }
      >
        <p>{t("staff.detail.deactivateBody")}</p>
      </Sheet>
    </Screen>
  );
}
