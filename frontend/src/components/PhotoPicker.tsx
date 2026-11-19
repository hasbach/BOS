"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, Dispatch, SetStateAction } from "react";

import styles from "./PhotoPicker.module.css";
import { isApiError } from "@/lib/api";
import { MAX_PHOTOS, PHOTO_TYPES, checkPhotoFile, photoUrl, uploadPhoto } from "@/lib/catalog";

import { Button } from "./Button";
import { Chip } from "./Chip";
import { AlertIcon, BanIcon, ImageIcon, PlusIcon, WifiOffIcon } from "./icons";
import { Sheet } from "./Sheet";

/** One photo of the product form: saved or staged (`done`, with its id), on its way, or not uploaded. */
export interface PhotoItem {
  key: string;
  status: "uploading" | "done" | "failed" | "refused";
  /** The photo id once the server has it. */
  id?: string;
  /** The picked file, kept to retry. */
  file?: File;
  name: string;
  percent: number;
  /** Why it was refused: `file_not_image` or `file_too_large`. */
  refusal?: "file_not_image" | "file_too_large";
}

export const photoFromId = (id: string): PhotoItem => ({ key: id, status: "done", id, name: "", percent: 100 });

/** Photos still uploading or that failed: saving waits for them (screen 171). */
export const waitingPhotos = (photos: PhotoItem[]) => photos.filter((photo) => photo.status === "uploading" || photo.status === "failed").length;

export interface PhotoPickerProps {
  photos: PhotoItem[];
  onChange: Dispatch<SetStateAction<PhotoItem[]>>;
  /** A message for the photos from the server (for example `photo_ids: invalid`). */
  error?: string;
  disabled?: boolean;
}

let sequence = 0;
const nextKey = () => {
  sequence += 1;
  return `photo-${sequence}`;
};

/**
 * Screens 164, 169 and 171: up to 8 product photos. Each photo is uploaded as soon as it is picked
 * (POST /catalog/photos), with its own progress, retry and remove; a file that is not a PNG, JPEG or
 * WebP, or is over 5 MB, is refused here before uploading. The first photo is the main one; tapping
 * a photo makes it main, moves it or removes it. Refusals show as the field's error.
 */
export function PhotoPicker({ photos, onChange, error, disabled = false }: PhotoPickerProps) {
  const t = useTranslations("catalog.form.photos");
  const input = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const errorId = useId();
  const [tooMany, setTooMany] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running.values()) controller.abort();
    };
  }, []);

  const update = (key: string, change: Partial<PhotoItem>) => onChange((current) => current.map((photo) => (photo.key === key ? { ...photo, ...change } : photo)));

  function upload(key: string, file: File) {
    const controller = new AbortController();
    controllers.current.set(key, controller);
    update(key, { status: "uploading", percent: 0, refusal: undefined });
    uploadPhoto(file, { signal: controller.signal, onProgress: (percent) => update(key, { percent }) }).then(
      (photo) => {
        controllers.current.delete(key);
        update(key, { status: "done", id: photo.id, percent: 100 });
      },
      (caught: unknown) => {
        controllers.current.delete(key);
        if (controller.signal.aborted) return;
        if (isApiError(caught) && (caught.code === "file_not_image" || caught.code === "file_too_large")) update(key, { status: "refused", refusal: caught.code });
        else if (isApiError(caught) && caught.code === "validation_failed") update(key, { status: "refused", refusal: "file_not_image" });
        else update(key, { status: "failed" });
      },
    );
  }

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    // Reset so picking the same file again (after a refusal) still fires.
    event.target.value = "";
    const room = MAX_PHOTOS - photos.length;
    setTooMany(files.length > room);
    const added = files.slice(0, Math.max(0, room)).map((file): PhotoItem => {
      const refusal = checkPhotoFile(file);
      return { key: nextKey(), status: refusal ? "refused" : "uploading", file, name: file.name, percent: 0, refusal: refusal ?? undefined };
    });
    if (added.length === 0) return;
    onChange((current) => [...current, ...added]);
    for (const photo of added) if (photo.status === "uploading" && photo.file) upload(photo.key, photo.file);
  }

  function remove(key: string) {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setTooMany(false);
    setActing(null);
    onChange((current) => current.filter((photo) => photo.key !== key));
  }

  function move(key: string, to: number) {
    setActing(null);
    onChange((current) => {
      const from = current.findIndex((photo) => photo.key === key);
      const item = current[from];
      if (from === -1 || !item || to < 0 || to >= current.length) return current;
      const next = current.filter((photo) => photo.key !== key);
      next.splice(to, 0, item);
      return next;
    });
  }

  const refused = photos.find((photo) => photo.status === "refused");
  const failed = photos.filter((photo) => photo.status === "failed").length;
  let message: string | undefined;
  if (refused) message = t(refused.refusal === "file_too_large" ? "tooLarge" : "notImage", { file: refused.name });
  else if (failed > 0) message = t("failed", { count: failed });
  else if (tooMany) message = t("tooMany");
  else message = error;

  const actingIndex = photos.findIndex((photo) => photo.key === acting);
  const actingPhoto = photos[actingIndex];

  return (
    <div className={styles.stack} style={{ gap: 6 }} role="group" aria-labelledby={`${errorId}-label`} aria-describedby={message ? errorId : undefined}>
      <div className={styles.between}>
        <span id={`${errorId}-label`} className={styles.label}>
          {t("label")}
        </span>
        <span className={styles.small}>{t("count", { count: photos.length })}</span>
      </div>
      <div className={styles.tiles}>
        {photos.map((photo, index) => (
          <Tile key={photo.key} photo={photo} index={index} disabled={disabled} onOpen={() => setActing(photo.key)} onRetry={() => photo.file && upload(photo.key, photo.file)} onRemove={() => remove(photo.key)} />
        ))}
        {photos.length < MAX_PHOTOS ? (
          <div className={styles.tile}>
            <button type="button" className={`${styles.tileBox} ${styles.tileAdd}`} aria-label={t("add")} disabled={disabled} onClick={() => input.current?.click()}>
              <PlusIcon width={20} height={20} />
              <span aria-hidden="true">{t("addShort")}</span>
            </button>
          </div>
        ) : null}
      </div>
      <input
        ref={input}
        className={styles.hidden}
        type="file"
        multiple
        accept={PHOTO_TYPES.join(",")}
        tabIndex={-1}
        aria-label={t("add")}
        data-testid="photo-input"
        onChange={pick}
      />
      {message ? (
        <p className={styles.error} id={errorId} role="alert">
          <AlertIcon width={16} height={16} />
          <span>{message}</span>
        </p>
      ) : (
        <p className={styles.small}>{t("help")}</p>
      )}

      <Sheet open={actingPhoto !== undefined} onClose={() => setActing(null)} title={t("photo", { n: actingIndex + 1 })}>
        {actingPhoto ? (
          <div className={styles.stack}>
            {actingPhoto.status === "failed" ? (
              <Button
                onClick={() => {
                  setActing(null);
                  if (actingPhoto.file) upload(actingPhoto.key, actingPhoto.file);
                }}
              >
                {t("retry")}
              </Button>
            ) : null}
            {actingIndex > 0 && actingPhoto.status === "done" ? <Button onClick={() => move(actingPhoto.key, 0)}>{t("makeMain")}</Button> : null}
            {actingIndex > 0 ? (
              <Button variant="ghost" onClick={() => move(actingPhoto.key, actingIndex - 1)}>
                {t("moveEarlier")}
              </Button>
            ) : null}
            {actingIndex < photos.length - 1 ? (
              <Button variant="ghost" onClick={() => move(actingPhoto.key, actingIndex + 1)}>
                {t("moveLater")}
              </Button>
            ) : null}
            <Button variant="danger" onClick={() => remove(actingPhoto.key)}>
              {t("remove")}
            </Button>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

function Tile({ photo, index, disabled, onOpen, onRetry, onRemove }: { photo: PhotoItem; index: number; disabled: boolean; onOpen: () => void; onRetry: () => void; onRemove: () => void }) {
  const t = useTranslations("catalog.form.photos");
  const bad = photo.status === "failed" || photo.status === "refused";
  const label = photo.status === "failed" ? t("failedPhoto") : photo.status === "refused" ? t("refusedPhoto") : t("photo", { n: index + 1 });
  const boxClass = [styles.tileBox, bad ? styles.tileBad : "", photo.status === "uploading" ? styles.tileBusy : ""].filter(Boolean).join(" ");

  let content;
  if (photo.status === "done" && photo.id) {
    // eslint-disable-next-line @next/next/no-img-element -- served by the API with the session cookie
    content = <img className={styles.image} src={photoUrl(photo.id, "thumb")} alt="" />;
  } else if (photo.status === "failed") content = <WifiOffIcon width={20} height={20} />;
  else if (photo.status === "refused") content = <BanIcon width={20} height={20} />;
  else content = <ImageIcon width={20} height={20} />;

  let under = null;
  if (photo.status === "uploading") {
    under = (
      <>
        <div className={styles.progress} role="progressbar" aria-label={t("uploading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={photo.percent}>
          <i style={{ inlineSize: `${photo.percent}%` }} />
        </div>
        <span className={styles.small} style={{ textAlign: "center" }}>
          <bdi dir="ltr">{photo.percent}%</bdi>
        </span>
      </>
    );
  } else if (photo.status === "failed") {
    under = (
      <button type="button" className={styles.tileButton} disabled={disabled} onClick={onRetry}>
        {t("retry")}
      </button>
    );
  } else if (photo.status === "refused") {
    under = (
      <button type="button" className={styles.tileButton} disabled={disabled} onClick={onRemove}>
        {t("remove")}
      </button>
    );
  } else if (index === 0) {
    under = (
      <Chip tone="ok" className={styles.nowrap}>
        {t("main")}
      </Chip>
    );
  }

  return (
    <div className={styles.tile}>
      {photo.status === "uploading" ? (
        <div className={boxClass} role="img" aria-label={label}>
          {content}
        </div>
      ) : (
        <button type="button" className={boxClass} aria-label={label} aria-haspopup="dialog" disabled={disabled} onClick={onOpen}>
          {content}
        </button>
      )}
      {under}
    </div>
  );
}
