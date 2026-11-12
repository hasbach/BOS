"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { AppBar } from "./AppBar";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { CopyIcon, SendIcon } from "./icons";
import { Screen, ScreenBody, ScreenFooter } from "./Screen";
import styles from "./OneTimeLink.module.css";

export interface OneTimeLinkProps {
  title: string;
  subtitle: string;
  /** Green confirmation sentence (the link exists on the server because the 2xx came back). */
  okText: string;
  label: string;
  link: string;
  /** How long the link works, already formatted. */
  validity: string;
  note?: string;
  lost: string;
  /** Dark operator app bar (default). Business screens pass false. */
  ops?: boolean;
  onDone: () => void;
}

// Screens 38 and 47. The link is shown once: leaving loses it for good, so Done is the only way out
// and the browser asks before the page is closed or reloaded.
export function OneTimeLink({ title, subtitle, okText, label, link, validity, note, lost, onDone, ops = true }: OneTimeLinkProps) {
  const t = useTranslations("ops");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setMessage({ tone: "ok", text: t("link.copied") });
    } catch {
      setMessage({ tone: "bad", text: t("link.copyFailed") });
    }
  }

  async function share() {
    if (typeof navigator.share !== "function") {
      await copy();
      return;
    }
    try {
      await navigator.share({ url: link });
    } catch (error) {
      // Closing the share sheet is not a failure.
      if (error instanceof DOMException && error.name === "AbortError") return;
      await copy();
    }
  }

  return (
    <Screen>
      <AppBar ops={ops} title={title} subtitle={subtitle} />
      <ScreenBody>
        <Banner tone="ok" icon="check">
          {okText}
        </Banner>
        <Banner tone="warn" icon="alert" strong alert>
          {t("link.warning")}
        </Banner>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
          <div className={styles.linkbox} data-testid="one-time-link">
            {link}
          </div>
          <p className={styles.hint}>{validity}</p>
        </div>
        <Button onClick={copy}>
          <CopyIcon width={18} height={18} />
          {t("link.copy")}
        </Button>
        <Button variant="ghost" onClick={share}>
          <SendIcon width={18} height={18} />
          {t("link.share")}
        </Button>
        {message ? (
          <Banner tone={message.tone} icon={message.tone === "ok" ? "check" : "alert"} alert>
            {message.text}
          </Banner>
        ) : null}
        {note ? <Banner>{note}</Banner> : null}
        <p className={styles.hint}>{lost}</p>
      </ScreenBody>
      <ScreenFooter>
        <Button variant="ghost" onClick={onDone}>
          {t("link.done")}
        </Button>
      </ScreenFooter>
    </Screen>
  );
}
