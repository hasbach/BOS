"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { ClockIcon, SyncIcon } from "@/components/icons";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Sheet } from "@/components/Sheet";
import { Stepper, parseStepper } from "@/components/Stepper";
import { useRovingRadio } from "@/components/useRovingRadio";
import { Link } from "@/i18n/navigation";
import { isApiError, isConnectionError } from "@/lib/api";
import type { StockNumbers, Variant } from "@/lib/catalog";
import { errorMessage, fieldErrorMessageKey, writeFailureMessage } from "@/lib/errors";
import { NOTE_MAX, REASONS_BY_MODE, adjustStock, buildAdjustment, currentBalance, newAdjustmentKey, preview, stockProblem } from "@/lib/stock";
import type { AdjustMode, AdjustReason, AdjustmentResult } from "@/lib/stock";

import styles from "../catalog.module.css";
import { variantLabel } from "../parts";
import own from "./stock.module.css";

export interface AdjustStockSheetProps {
  open: boolean;
  /** The variants the Variant field offers. */
  variants: Variant[];
  /** The variant chosen when the sheet opens. */
  variantId: string;
  /** A product without options: its variant is called "Only variant". */
  single: boolean;
  /** Where "History" goes for a variant; no History button without it (on the history screen itself). */
  historyHref?: (variantId: string) => string;
  onClose: () => void;
  /** Called only after the server recorded the change. */
  onSaved: (variantId: string, result: AdjustmentResult) => void;
  /** Called with the current numbers a refusal carried, so the screen behind can show them too. */
  onBalance?: (variantId: string, balance: StockNumbers) => void;
}

/** "+3", "−1" or "0": the sign is always written, with a real minus. */
export function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${-n}`;
  return "0";
}

/** Screen 14 (designs 146 to 152). Mounted only while open, so each opening starts fresh with a new key. */
export function AdjustStockSheet({ open, ...props }: AdjustStockSheetProps) {
  return open ? <SheetBody {...props} /> : null;
}

type Errors = Partial<Record<"reason" | "quantity" | "note", string>>;
type Notice = { kind: "changed" } | { kind: "failed" } | { kind: "other"; text: string } | null;

function SheetBody({ variants, variantId: initialId, single, historyHref, onClose, onSaved, onBalance }: Omit<AdjustStockSheetProps, "open">) {
  const t = useTranslations();
  const c = useTranslations("catalog");
  const a = useTranslations("catalog.adjust");
  const selectId = useId();

  // One Idempotency-Key per opened sheet, reused for every retry of its save (R44).
  const [key] = useState(newAdjustmentKey);
  const [variantId, setVariantId] = useState(initialId);
  const chosen = variants.find((variant) => variant.id === variantId) ?? variants[0];
  const [numbers, setNumbers] = useState<StockNumbers | null>(chosen ? chosen.stock : null);
  const [mode, setMode] = useState<AdjustMode>("add");
  const [reason, setReason] = useState<AdjustReason | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const reasons = mode === "count" ? [] : REASONS_BY_MODE[mode];
  const reasonItem = useRovingRadio<AdjustReason>(reasons, reason, pickReason);

  if (!chosen || !numbers) return null;
  const stock = numbers;

  const labelOf = (variant: Variant) => {
    const label = single ? c("detail.onlyVariant") : variantLabel(variant.option_values);
    return variant.status === "archived" ? a("archivedVariant", { variant: label }) : label;
  };

  function pickReason(next: AdjustReason) {
    setReason(next);
    setErrors((e) => ({ ...e, reason: undefined, note: next === "other" ? e.note : undefined }));
  }

  function pickMode(next: AdjustMode) {
    if (next === mode) return;
    // The amount means something else in Set count (a count, not a change), so it starts again there.
    if (next === "count" || mode === "count") setAmount("");
    setReason((r) => (next !== "count" && r !== null && REASONS_BY_MODE[next].includes(r) ? r : null));
    setMode(next);
    setErrors({});
  }

  function pickVariant(id: string) {
    const next = variants.find((variant) => variant.id === id);
    if (!next) return;
    setVariantId(id);
    setNumbers(next.stock);
    setErrors({});
    setNotice(null);
  }

  /** Why the numbers don't allow this change, in the person's words. */
  function stockText(problem: "not_enough_stock" | "too_large", current: StockNumbers): string {
    if (problem === "too_large") return a("fe.tooLarge");
    if (mode === "count") return a("fe.countBelowReserved", { reserved: current.allocated });
    const max = Math.max(0, current.on_hand - current.allocated);
    if (max === 0) return a("fe.nothingToRemove", { onHand: current.on_hand });
    if (current.allocated > 0) return a("fe.maxRemove", { max, reserved: current.allocated, onHand: current.on_hand });
    return a("fe.maxRemoveAll", { max });
  }

  const typed = parseStepper(amount, null);
  // The amount when it is one the mode accepts (1 to 1,000,000; Set count also 0), else null.
  const value = typed !== null && (mode === "count" || typed >= 1) ? typed : null;
  const problem = value !== null ? stockProblem(mode, value, stock) : null;
  const after = value !== null && !problem ? preview(mode, value, stock) : null;
  const noteRequired = mode !== "count" && reason === "other";

  function check(): Errors {
    const found: Errors = {};
    if (mode !== "count" && reason === null) found.reason = a("fe.reason");
    if (value === null) found.quantity = mode === "count" ? a("fe.counted") : a("fe.quantity");
    else if (problem) found.quantity = stockText(problem, stock);
    if (noteRequired && note.trim() === "") found.note = a("fe.note");
    else if (note.trim().length > NOTE_MAX) found.note = a("fe.noteLong");
    return found;
  }

  async function save() {
    if (busy) return;
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0 || value === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await adjustStock(variantId, buildAdjustment(mode, reason, value, note, stock.version), key);
      onSaved(variantId, result);
    } catch (error) {
      failed(error);
      setBusy(false);
    }
  }

  function failed(error: unknown) {
    const balance = currentBalance(error);
    if (balance) {
      setNumbers(balance);
      onBalance?.(variantId, balance);
    }
    if (!isApiError(error)) {
      setNotice({ kind: "other", text: errorMessage(t, error) });
      return;
    }
    if (error.code === "stock_changed") {
      setNotice({ kind: "changed" });
      return;
    }
    if (error.code === "not_enough_stock") {
      const fresh = balance ?? stock;
      const again = value !== null ? stockProblem(mode, value, fresh) : null;
      setErrors({ quantity: again ? stockText(again, fresh) : t("errors.not_enough_stock") });
      return;
    }
    if (isConnectionError(error) || error.code === "try_again") {
      setNotice({ kind: "failed" });
      return;
    }
    if (error.code === "validation_failed") {
      const fields: Errors = {};
      const amountCode = error.fields.quantity ?? error.fields.counted_quantity;
      if (amountCode === "too_large") fields.quantity = a("fe.tooLarge");
      else if (amountCode) fields.quantity = t(fieldErrorMessageKey(amountCode));
      if (error.fields.note) fields.note = error.fields.note === "too_long" ? a("fe.noteLong") : a("fe.note");
      setErrors(fields);
      if (Object.keys(fields).length > 0) return;
    }
    setNotice({ kind: "other", text: writeFailureMessage(t, error) });
  }

  const modes = [
    { value: "add" as const, label: a("modes.add") },
    { value: "remove" as const, label: a("modes.remove") },
    { value: "count" as const, label: a("modes.count") },
  ];

  const footer = (
    <div className={own.footer}>
      <Button loading={busy} onClick={() => void save()}>
        {busy ? (
          <>
            <SyncIcon width={16} height={16} /> {a("saving")}
          </>
        ) : notice?.kind === "failed" ? (
          <>
            <SyncIcon width={16} height={16} /> {a("retry")}
          </>
        ) : (
          a("save")
        )}
      </Button>
      <p className={own.once}>{a("once")}</p>
    </div>
  );

  return (
    <Sheet open onClose={onClose} title={a("title")} footer={footer}>
      <div className={own.sheetBody}>
        {historyHref ? (
          <Link href={historyHref(variantId)} className={own.historyLink}>
            <ClockIcon width={16} height={16} /> {a("history")}
          </Link>
        ) : null}

        {variants.length > 1 ? (
          <div className={own.selectField}>
            <label htmlFor={selectId} className={own.selectLabel}>
              {a("variant")}
            </label>
            <select id={selectId} className={own.select} value={variantId} disabled={busy} onChange={(event) => pickVariant(event.target.value)}>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {`${labelOf(variant)} · ${variant.sku}`}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className={own.selectField}>
            <span className={own.selectLabel}>{a("variant")}</span>
            <span>
              <b>{labelOf(chosen)}</b> ·{" "}
              <bdi dir="ltr" className={styles.muted}>
                {chosen.sku}
              </bdi>
            </span>
          </div>
        )}

        {notice?.kind === "changed" ? (
          <Banner tone="warn" icon="alert" alert>
            {a("changed")}
          </Banner>
        ) : null}
        {notice?.kind === "failed" ? (
          <Banner tone="bad" icon="alert" alert>
            {a("failed")}
          </Banner>
        ) : null}
        {notice?.kind === "other" ? (
          <Banner tone="bad" icon="alert" alert>
            {notice.text}
          </Banner>
        ) : null}

        <StockFigures numbers={stock} first={a("onHandNow")} label={a("numbers")} />

        <SegmentedControl label={a("modeGroup")} options={modes} value={mode} onChange={pickMode} />

        {mode !== "count" ? (
          <div>
            <p className={styles.label} style={{ marginBlockEnd: 6 }}>
              {a("reasonLabel")}
            </p>
            <div className={styles.pills} role="radiogroup" aria-label={a("reasonGroup")} aria-invalid={errors.reason ? true : undefined}>
              {reasons.map((r) => {
                const on = reason === r;
                return (
                  <button key={r} type="button" role="radio" aria-checked={on} className={`${styles.pill} ${on ? styles.pillOn : ""}`} {...reasonItem(r)} onClick={() => pickReason(r)}>
                    {c(`reasons.${r}`)}
                  </button>
                );
              })}
            </div>
            {errors.reason ? <FieldError text={errors.reason} /> : null}
          </div>
        ) : null}

        <Stepper
          key={mode === "count" ? "count" : "change"}
          value={amount}
          onChange={(value) => {
            setAmount(value);
            setErrors((e) => ({ ...e, quantity: undefined }));
          }}
          label={mode === "count" ? a("counted") : a("quantity")}
          visibleLabel
          min={mode === "count" ? 0 : 1}
          error={errors.quantity}
        />

        <Field
          label={noteRequired ? a("noteRequired") : a("noteOptional")}
          placeholder={a("notePlaceholder")}
          value={note}
          autoComplete="off"
          error={errors.note}
          onChange={(event) => {
            setNote(event.target.value);
            setErrors((e) => ({ ...e, note: undefined }));
          }}
        />

        {after ? (
          <div role="status">
            <Banner tone="ok" icon="info">
              {mode === "count"
                ? a("previewCount", { change: signed(after.change), onHand: after.onHand, available: after.available })
                : a("preview", { onHand: after.onHand, available: after.available })}
            </Banner>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

function FieldError({ text }: { text: string }) {
  return (
    <p className={styles.error} role="alert" style={{ marginBlockStart: 6 }}>
      <span>{text}</span>
    </p>
  );
}

/** On hand / Reserved / Available side by side ("Reserved" is the screen word for allocated). */
export function StockFigures({ numbers, first, label }: { numbers: StockNumbers; first?: string; label: string }) {
  const c = useTranslations("catalog.stock");
  return (
    <div className={own.figures} role="group" aria-label={label}>
      <div>
        <span className={own.figureLabel}>{first ?? c("onHand")}</span>
        <span className={own.figure}>{numbers.on_hand}</span>
      </div>
      <div>
        <span className={own.figureLabel}>{c("reserved")}</span>
        <span className={own.figure}>{numbers.allocated}</span>
      </div>
      <div>
        <span className={own.figureLabel}>{c("available")}</span>
        <span className={own.figure}>{numbers.available}</span>
      </div>
    </div>
  );
}
