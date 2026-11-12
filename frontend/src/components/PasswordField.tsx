"use client";

import { useId, useState } from "react";
import type { InputHTMLAttributes } from "react";
import { useTranslations } from "next-intl";

import { AlertIcon, EyeIcon, EyeOffIcon } from "./icons";
import fieldStyles from "./Field.module.css";
import styles from "./PasswordField.module.css";

export interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  helper?: string;
  error?: string;
}

// A password field with a Show/Hide button (a text label, not just an icon).
export function PasswordField({ label, helper, error, id, className, ...rest }: PasswordFieldProps) {
  const t = useTranslations("common");
  const generated = useId();
  const inputId = id ?? generated;
  const [shown, setShown] = useState(false);
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const Icon = shown ? EyeOffIcon : EyeIcon;

  return (
    <div className={fieldStyles.field}>
      <label htmlFor={inputId} className={fieldStyles.label}>
        {label}
      </label>
      <div className={styles.wrap}>
        <input
          {...rest}
          id={inputId}
          type={shown ? "text" : "password"}
          dir="ltr"
          className={[fieldStyles.control, styles.input, error ? fieldStyles.invalid : "", className ?? ""]
            .filter(Boolean)
            .join(" ")}
          aria-invalid={error ? true : undefined}
          aria-describedby={[rest["aria-describedby"], helperId, errorId].filter(Boolean).join(" ") || undefined}
        />
        <button type="button" className={styles.toggle} aria-pressed={shown} onClick={() => setShown((value) => !value)}>
          <Icon width={16} height={16} />
          {shown ? t("hide") : t("show")}
        </button>
      </div>
      {helper && !error ? (
        <p id={helperId} className={fieldStyles.helper}>
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={fieldStyles.error}>
          <AlertIcon width={16} height={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
