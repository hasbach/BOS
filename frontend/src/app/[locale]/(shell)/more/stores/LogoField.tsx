"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { AlertIcon, CloseIcon, ImageIcon, UploadIcon } from "@/components/icons";
import { LOGO_TYPES } from "@/lib/stores";
import type { Store } from "@/lib/stores";

import { StoreLogo } from "./parts";
import styles from "./stores.module.css";

export interface LogoFieldProps {
  store: Pick<Store, "id" | "name" | "has_logo"> | null;
  /** Changes after each upload or removal so the browser fetches the image again. */
  version?: number;
  /** A file picked on the add screen; it is sent after the store is created. */
  chosen?: File | null;
  /** An upload in progress (edit screen). */
  uploading?: { file: string; percent: number } | null;
  error?: string;
  disabled?: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
  onCancel?: () => void;
}

/** A local preview of the chosen file, read in the background. */
function usePreview(file: File | null | undefined): string | null {
  const [loaded, setLoaded] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    let live = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (live && typeof reader.result === "string") setLoaded({ file, url: reader.result });
    };
    reader.readAsDataURL(file);
    return () => {
      live = false;
    };
  }, [file]);
  return file && loaded?.file === file ? loaded.url : null;
}

/** Screens 78 to 86: the logo block of the store form. */
export function LogoField({ store, version = 0, chosen, uploading, error, disabled = false, onPick, onRemove, onCancel }: LogoFieldProps) {
  const t = useTranslations("stores.logo");
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const preview = usePreview(chosen);
  const has = Boolean(chosen) || Boolean(store?.has_logo);

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so choosing the same file again (after an error) still fires.
    event.target.value = "";
    if (file) onPick(file);
  }

  let thumb;
  if (preview) {
    thumb = (
      <div className={`${styles.thumb} ${styles.thumbLarge}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen file */}
        <img className={styles.image} src={preview} alt={t("preview")} />
      </div>
    );
  } else if (store?.has_logo) {
    thumb = <StoreLogo store={store} version={version} large />;
  } else {
    thumb = (
      <div className={`${styles.thumb} ${styles.thumbLarge} ${styles.thumbEmpty}`} aria-hidden="true">
        <ImageIcon width={28} height={28} />
      </div>
    );
  }

  let middle;
  if (uploading) {
    middle = (
      <>
        <p className={styles.name} role="status">
          {t("uploading", { file: uploading.file })}
        </p>
        <div className={styles.progress} role="progressbar" aria-label={t("label")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploading.percent}>
          <i style={{ inlineSize: `${uploading.percent}%` }} />
        </div>
        <p className={styles.muted}>
          <bdi dir="ltr">{uploading.percent}%</bdi> · {t("wait")}
        </p>
      </>
    );
  } else if (chosen) {
    middle = (
      <>
        <p className={styles.name}>
          <bdi dir="ltr">{chosen.name}</bdi>
        </p>
        <p className={styles.muted}>{t("chosenHint")}</p>
      </>
    );
  } else if (store?.has_logo) {
    middle = <p className={styles.name}>{t("current")}</p>;
  } else {
    middle = (
      <>
        <p className={styles.name}>{t("none")}</p>
        <p className={styles.muted}>{t("noneHint")}</p>
      </>
    );
  }

  return (
    <div className={styles.stack}>
      <span className={styles.label}>{t("label")}</span>
      <Card className={styles.stack}>
        <div className={styles.row}>
          {thumb}
          <div className={styles.grow}>{middle}</div>
        </div>
        <div className={styles.actions}>
          {uploading ? (
            <Button variant="ghost" size="small" onClick={onCancel}>
              <CloseIcon width={16} height={16} /> {t("cancel")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="small" disabled={disabled} onClick={() => input.current?.click()}>
                <UploadIcon width={16} height={16} /> {has ? t("change") : t("choose")}
              </Button>
              {has ? (
                <Button variant="ghost" size="small" disabled={disabled} onClick={onRemove}>
                  <CloseIcon width={16} height={16} /> {t("remove")}
                </Button>
              ) : null}
            </>
          )}
        </div>
        <input
          ref={input}
          id={inputId}
          className={styles.hidden}
          type="file"
          accept={LOGO_TYPES.join(",")}
          tabIndex={-1}
          aria-label={t("choose")}
          data-testid="logo-input"
          onChange={onChange}
        />
      </Card>
      {error ? (
        <p className={styles.error} role="alert">
          <AlertIcon width={16} height={16} />
          <span>{error}</span>
        </p>
      ) : (
        <p className={styles.muted}>{t("help")}</p>
      )}
    </div>
  );
}
