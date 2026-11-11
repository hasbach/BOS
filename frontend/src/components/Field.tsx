import { forwardRef, useId } from "react";
import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from "react";

import { AlertIcon } from "./icons";
import styles from "./Field.module.css";

interface FieldCommon {
  /** The label is always visible; a placeholder never replaces it. */
  label: string;
  helper?: string;
  /** Error text shown next to the field and linked to it for assistive technology. */
  error?: string;
}

export type FieldProps =
  | (FieldCommon & { multiline?: false } & InputHTMLAttributes<HTMLInputElement>)
  | (FieldCommon & { multiline: true } & TextareaHTMLAttributes<HTMLTextAreaElement>);

export const Field = forwardRef<HTMLInputElement | HTMLTextAreaElement, FieldProps>(function Field(props, ref) {
  const generatedId = useId();
  const { label, helper, error, id, ...rest } = props;
  const inputId = id ?? generatedId;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [rest["aria-describedby"], helperId, errorId].filter(Boolean).join(" ") || undefined;
  const classes = [styles.control, props.multiline ? styles.area : "", error ? styles.invalid : ""]
    .filter(Boolean)
    .join(" ");

  let control;
  if (props.multiline) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { multiline, label: _l, helper: _h, error: _e, id: _i, ...textareaProps } = props;
    control = (
      <textarea
        {...textareaProps}
        id={inputId}
        className={classes}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        ref={ref as Ref<HTMLTextAreaElement>}
      />
    );
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { multiline, label: _l, helper: _h, error: _e, id: _i, ...inputProps } = props;
    control = (
      <input
        {...inputProps}
        id={inputId}
        className={classes}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        ref={ref as Ref<HTMLInputElement>}
      />
    );
  }

  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.label}>
        {label}
      </label>
      {control}
      {helper ? (
        <p id={helperId} className={styles.helper}>
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={styles.error}>
          <AlertIcon width={16} height={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
});
