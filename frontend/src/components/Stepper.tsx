"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { normaliseDigits } from "@/lib/digits";

import { AlertIcon, MinusIcon, PlusIcon } from "./icons";
import styles from "./Stepper.module.css";

export const STEPPER_MAX = 1_000_000;

/**
 * The whole number typed, or `empty` for nothing typed, or null when it is not a whole number in
 * 0..max. Digits may be 0-9 or ٠-٩ (lib/digits.ts); thousands separators are ignored.
 */
export function parseStepper(typed: string, empty: number | null, max = STEPPER_MAX): number | null {
  const plain = normaliseDigits(typed).replaceAll(",", "").trim();
  if (plain === "") return empty;
  if (!/^\d+$/.test(plain)) return null;
  const number = Number(plain);
  return number <= max ? number : null;
}

export interface StepperProps {
  /** As typed, so "٦" stays on screen until − or + replaces it with Latin digits. */
  value: string;
  onChange: (value: string) => void;
  /** Names the number; shown beside the stepper when `visibleLabel`, otherwise only for assistive technology. */
  label: string;
  visibleLabel?: boolean;
  error?: string;
  min?: number;
  max?: number;
}

/** A quantity typed in 0-9 or ٠-٩, with − and + beside it (screen 14). 44 px targets. */
export function Stepper({ value, onChange, label, visibleLabel = false, error, min = 0, max = STEPPER_MAX }: StepperProps) {
  const t = useTranslations("ui");
  const id = useId();
  const errorId = `${id}-error`;
  const current = parseStepper(value, 0, max) ?? 0;
  const control = (
    <span className={`${styles.stepper} ${error ? styles.bad : ""}`}>
      <button type="button" aria-label={t("decrease")} disabled={current <= min} onClick={() => onChange(String(Math.max(min, current - 1)))}>
        <MinusIcon width={16} height={16} />
      </button>
      <input
        id={id}
        value={value}
        inputMode="numeric"
        placeholder="0"
        autoComplete="off"
        dir="ltr"
        aria-label={visibleLabel ? undefined : label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" aria-label={t("increase")} disabled={current >= max} onClick={() => onChange(String(Math.min(max, Math.max(min, current + 1))))}>
        <PlusIcon width={16} height={16} />
      </button>
    </span>
  );
  if (!visibleLabel) {
    return (
      <>
        {control}
        {error ? (
          <span id={errorId} className={styles.hidden}>
            {error}
          </span>
        ) : null}
      </>
    );
  }
  return (
    <div className={styles.field}>
      <div className={styles.row}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {control}
      </div>
      {error ? (
        <p className={styles.error} id={errorId}>
          <AlertIcon width={16} height={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
