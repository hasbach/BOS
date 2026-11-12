"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "./Button";
import { Card } from "./Card";
import { DownloadIcon } from "./icons";
import styles from "./InstallCard.module.css";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

const DISMISSED_KEY = "bos.install.dismissed";

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage is blocked: the card simply comes back next time.
  }
}

/** Safari on iPhone and iPad cannot be asked to install; it needs the Share sheet. */
function isIosBrowser(): boolean {
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent);
}

function isInstalled(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches === true;
}

/**
 * Screen 131: a small card offering to add BOS to the home screen. It shows only when the browser
 * says BOS can be installed (beforeinstallprompt), or on iPhone with a one-line instruction; "Not now"
 * hides it for good on this phone.
 */
const noopSubscribe = () => () => {};

export function InstallCard() {
  const t = useTranslations("install");
  // True once running in the browser (the checks below need window).
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const onPrompt = (raw: Event) => {
      // Hold the browser's own mini-bar back; Install opens the real prompt.
      raw.preventDefault();
      setEvent(raw as InstallPromptEvent);
    };
    const onInstalled = () => {
      setEvent(null);
      setGone(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const eligible = mounted && !gone && !wasDismissed() && !isInstalled();
  const ios = mounted && isIosBrowser();
  if (!eligible || (!event && !ios)) return null;

  async function install() {
    if (!event) return;
    const chosen = event;
    setEvent(null);
    setGone(true);
    await chosen.prompt();
    await chosen.userChoice.catch(() => undefined);
  }

  function notNow() {
    remember();
    setEvent(null);
    setGone(true);
  }

  return (
    <Card as="section" aria-label={t("region")} className={styles.card}>
      <div className={styles.top}>
        <div className={styles.logo} aria-hidden="true">
          BOS
        </div>
        <div className={styles.text}>
          <p className={styles.title}>{t("title")}</p>
          <p className={styles.muted}>{ios && !event ? t("ios") : t("text")}</p>
        </div>
      </div>
      <div className={styles.buttons}>
        <Button variant="ghost" size="small" onClick={notNow}>
          {t("notNow")}
        </Button>
        {event ? (
          <Button size="small" onClick={install}>
            <DownloadIcon width={16} height={16} /> {t("install")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
