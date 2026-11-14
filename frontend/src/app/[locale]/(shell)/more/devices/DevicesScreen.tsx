"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import type { BannerTone } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { CheckIcon, LaptopIcon, LogoutIcon, PhoneIcon } from "@/components/icons";
import { Loading } from "@/components/Loading";
import { Screen, ScreenBody, ScreenFooter, StatusHeader, screenStyles } from "@/components/Screen";
import { SessionEnded } from "@/components/SessionEnded";
import { Sheet } from "@/components/Sheet";
import { api, isSessionEnded } from "@/lib/api";
import { currentFirst, deviceLabel } from "@/lib/devices";
import type { Session } from "@/lib/devices";
import { writeFailureMessage } from "@/lib/errors";
import { daysAgo, formatDateTime, formatClock } from "@/lib/time";

import styles from "../account.module.css";

type Load = { k: "loading" } | { k: "ended" } | { k: "error" } | { k: "ready"; sessions: Session[] };
type Notice = { tone: BannerTone; icon: "check" | "alert"; text: string };

/** Screens 115 to 118: the person's own signed-in devices; end one, or all the others. */
export function DevicesScreen() {
  const t = useTranslations();
  const locale = useLocale();
  const [state, setState] = useState<Load>({ k: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busyAll, setBusyAll] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.get<Session[]>("/me/sessions", { signal: controller.signal }).then(
      (sessions) => setState({ k: "ready", sessions: currentFirst(sessions) }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // A 401 is not a connection problem: the guard is taking the person to sign-in.
        setState(isSessionEnded(error) ? { k: "ended" } : { k: "error" });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ k: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const bar = <AppBar title={t("devices.title")} subtitle={t("devices.subtitle")} backHref="/more" backLabel={t("common.back")} />;

  if (state.k === "loading") {
    return (
      <Screen>
        {bar}
        <ScreenBody>
          <Loading label={t("devices.loading")} />
        </ScreenBody>
      </Screen>
    );
  }
  if (state.k === "ended") return <SessionEnded />;
  if (state.k === "error") {
    return (
      <Screen>
        {bar}
        <ScreenBody>
          <div role="alert">
            <StatusHeader tone="warn" icon="wifioff" title={t("devices.loadError.title")} text={t("devices.loadError.text")} />
          </div>
        </ScreenBody>
        <ScreenFooter>
          <Button onClick={retry}>{t("ui.retry")}</Button>
        </ScreenFooter>
      </Screen>
    );
  }

  const sessions = state.sessions;
  const others = sessions.filter((session) => !session.current);

  function lastActive(session: Session): string {
    const when = daysAgo(session.last_seen_at) <= 0 ? t("devices.today", { time: formatClock(session.last_seen_at, locale) }) : formatDateTime(session.last_seen_at, locale);
    return t("devices.lastActive", { when });
  }

  async function endOne(session: Session) {
    if (busyId) return;
    setBusyId(session.id);
    setNotice(null);
    try {
      await api.delete(`/me/sessions/${session.id}`);
      // Shown only now, after the server answered 204.
      setState({ k: "ready", sessions: sessions.filter((item) => item.id !== session.id) });
      setNotice({ tone: "ok", icon: "check", text: t("devices.signedOutOne", { device: deviceLabel(session, t) }) });
    } catch (error) {
      setNotice({ tone: "bad", icon: "alert", text: writeFailureMessage(t, error) });
    } finally {
      setBusyId(null);
    }
  }

  async function endOthers() {
    setBusyAll(true);
    setNotice(null);
    try {
      await api.delete("/me/sessions");
      setState({ k: "ready", sessions: sessions.filter((item) => item.current) });
      setNotice({ tone: "ok", icon: "check", text: t("devices.signedOutOthers", { count: others.length }) });
    } catch (error) {
      setNotice({ tone: "bad", icon: "alert", text: writeFailureMessage(t, error) });
    } finally {
      setBusyAll(false);
      setConfirm(false);
    }
  }

  return (
    <Screen>
      {bar}
      <ScreenBody>
        {notice ? (
          <Banner tone={notice.tone} icon={notice.icon} alert={notice.tone === "bad"}>
            {notice.text}
          </Banner>
        ) : null}
        <Card style={{ padding: 0 }}>
          <ul className={styles.list}>
            {sessions.map((session) => {
              const label = deviceLabel(session, t);
              const Icon = /iPhone|iPad|Android/.test(session.os ?? "") ? PhoneIcon : LaptopIcon;
              return (
                <li key={session.id} className={styles.row} style={{ alignItems: "center" }}>
                  <div className={styles.avatar} aria-hidden="true">
                    <Icon width={20} height={20} />
                  </div>
                  <div className={styles.text}>
                    <span className={styles.name}>{label}</span>
                    <span className={styles.muted}>{session.current ? t("devices.activeNow") : lastActive(session)}</span>
                    {session.current ? (
                      <span className={styles.chipRow}>
                        <Chip tone="ok">
                          <CheckIcon width={14} height={14} /> {t("devices.thisDevice")}
                        </Chip>
                      </span>
                    ) : null}
                  </div>
                  {session.current ? null : (
                    <Button variant="ghost" size="small" loading={busyId === session.id} aria-label={t("devices.signOutOn", { device: label })} onClick={() => void endOne(session)}>
                      {t("devices.signOut")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
        {others.length === 0 ? <p className={screenStyles.muted}>{t("devices.none")}</p> : null}
        <Banner>{t("devices.info")}</Banner>
        <p className={screenStyles.hint}>{t("devices.hint")}</p>
      </ScreenBody>
      {others.length > 0 ? (
        <ScreenFooter>
          <Button variant="danger" onClick={() => setConfirm(true)}>
            <LogoutIcon className={styles.flipRtl} width={18} height={18} /> {t("devices.signOutOthers")}
          </Button>
        </ScreenFooter>
      ) : null}
      <Sheet
        open={confirm}
        onClose={() => (busyAll ? undefined : setConfirm(false))}
        title={t("devices.confirm.title")}
        footer={
          <>
            <Button variant="ghost" disabled={busyAll} onClick={() => setConfirm(false)}>
              {t("devices.confirm.cancel")}
            </Button>
            <Button variant="danger" loading={busyAll} onClick={() => void endOthers()}>
              {t("devices.confirm.submit")}
            </Button>
          </>
        }
      >
        <p>{t("devices.confirm.text", { count: others.length })}</p>
      </Sheet>
    </Screen>
  );
}
