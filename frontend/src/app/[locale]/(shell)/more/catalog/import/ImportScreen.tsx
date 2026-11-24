"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { ChangeEvent, MouseEventHandler, ReactNode, Ref } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import buttonStyles from "@/components/Button.module.css";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { CheckIcon, DownloadIcon, ImageIcon, ListIcon, SyncIcon, UploadIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { OfflineNotice } from "@/components/OfflineNotice";
import { Screen, ScreenBody, ScreenFooter, StatusHeader } from "@/components/Screen";
import { SessionEnded } from "@/components/SessionEnded";
import { ApiError, isApiError, isSessionEnded } from "@/lib/api";
import { CATALOG } from "@/lib/catalog";
import { importErrorMessageKey, writeFailureMessage } from "@/lib/errors";
import { IMPORT_MAX_BYTES, IMPORT_TEMPLATE_URL, confirmImport, conflictRows, refusedColumns, rowsWithErrors, uploadImport } from "@/lib/imports";
import type { ImportBatch, ImportRowError } from "@/lib/imports";
import { formatDateTime } from "@/lib/time";

import styles from "../catalog.module.css";
import { NotAllowedToEdit, useCatalogAccess } from "../parts";
import own from "./import.module.css";

interface FileInfo {
  name: string;
  size: number;
}

type State =
  | { k: "start" }
  | { k: "checking"; file: FileInfo; percent: number }
  | { k: "refused"; file: FileInfo; error: unknown }
  | { k: "preview"; file: FileInfo; batch: ImportBatch; confirming: boolean; failure: unknown }
  | { k: "conflict"; file: FileInfo; rows: ImportRowError[] }
  | { k: "expired" }
  | { k: "done"; batch: ImportBatch }
  | { k: "ended" }
  | { k: "forbidden" };

/** Screens 176 to 183: upload a CSV, see every problem, confirm; nothing is saved until the server confirms. */
export function ImportScreen() {
  const access = useCatalogAccess();
  if (!access.manage) return <NotAllowedToEdit />;
  return <Importer />;
}

function Bar() {
  const i = useTranslations("catalog.import");
  const common = useTranslations("common");
  return <AppBar title={i("title")} subtitle={i("subtitle")} backHref={CATALOG} backLabel={common("back")} />;
}

function Importer() {
  const t = useTranslations();
  const i = useTranslations("catalog.import");
  const [state, setState] = useState<State>({ k: "start" });
  // The chooser is a native file input, so it works from the server HTML, before hydration.
  const input = useRef<HTMLInputElement>(null);
  const run = useRef(0);

  async function upload(file: File) {
    const info: FileInfo = { name: file.name, size: file.size };
    if (file.size > IMPORT_MAX_BYTES) {
      // The server would refuse it the same way; checked here so a big file is not sent for nothing.
      setState({ k: "refused", file: info, error: new ApiError({ status: 400, code: "file_too_large" }) });
      return;
    }
    const mine = (run.current += 1);
    setState({ k: "checking", file: info, percent: 0 });
    try {
      const batch = await uploadImport(file, {
        onProgress: (percent) => setState((current) => (current.k === "checking" && run.current === mine ? { ...current, percent } : current)),
      });
      if (run.current !== mine) return;
      setState(batch.status === "committed" ? { k: "done", batch } : { k: "preview", file: info, batch, confirming: false, failure: null });
    } catch (error) {
      if (run.current !== mine || (error instanceof DOMException && error.name === "AbortError")) return;
      if (isSessionEnded(error)) setState({ k: "ended" });
      else if (isApiError(error) && error.code === "forbidden") setState({ k: "forbidden" });
      else setState({ k: "refused", file: info, error });
    }
  }

  function take(element: HTMLInputElement) {
    const file = element.files?.[0];
    if (!file) return;
    // Cleared so that choosing the same file again (after fixing it) is noticed.
    element.value = "";
    void upload(file);
  }

  const chosen = (event: ChangeEvent<HTMLInputElement>) => take(event.currentTarget);

  // A file chosen before hydration fired its change event with no handler attached: take it once now.
  // Whichever of this and a replayed change event runs first clears the input, so the other finds nothing.
  const takeEarly = useEffectEvent(() => {
    if (input.current) take(input.current);
  });
  useEffect(() => {
    takeEarly();
  }, []);

  async function confirm() {
    if (state.k !== "preview" || state.confirming || state.batch.status !== "previewed") return;
    const { file, batch } = state;
    setState({ ...state, confirming: true, failure: null });
    try {
      const result = await confirmImport(batch.id);
      // Success is shown only now, after the server answered 2xx.
      setState({ k: "done", batch: result });
    } catch (error) {
      if (isSessionEnded(error)) setState({ k: "ended" });
      else if (isApiError(error) && error.code === "forbidden") setState({ k: "forbidden" });
      else if (isApiError(error) && error.code === "import_conflict") setState({ k: "conflict", file, rows: conflictRows(error) });
      else if (isApiError(error) && error.code === "import_expired") setState({ k: "expired" });
      else setState({ k: "preview", file, batch, confirming: false, failure: error });
    }
  }

  if (state.k === "ended") return <SessionEnded />;
  if (state.k === "forbidden") return <NotAllowedToEdit />;

  if (state.k === "done") {
    const { batch } = state;
    return (
      <Screen>
        <Bar />
        <ScreenBody>
          <div role="status">
            <StatusHeader
              tone="accent"
              icon="check"
              title={i("done.title")}
              text={i("done.text", { products: batch.products, variants: batch.variants, units: batch.opening_units })}
            />
          </div>
          <Banner>{i("done.photos")}</Banner>
        </ScreenBody>
        <ScreenFooter>
          <LinkButton href={`${CATALOG}?no_photo=1`}>
            <ImageIcon width={16} height={16} /> {i("done.addPhotos")}
          </LinkButton>
          <LinkButton href={CATALOG} variant="ghost">
            {i("done.viewCatalog")}
          </LinkButton>
        </ScreenFooter>
      </Screen>
    );
  }

  // Footer slots: [lead, chooser, trail]. The chooser keeps its slot in every state, so React keeps the same
  // <input> when the state changes while the native chooser is open (the expired screen returns to start).
  const chooser = (label: string, options: { ghost?: boolean; disabled?: boolean; onClick?: MouseEventHandler<HTMLInputElement> } = {}) => (
    <FilePicker ref={input} variant={options.ghost ? "ghost" : "primary"} disabled={options.disabled} onChange={chosen} onClick={options.onClick}>
      {options.ghost ? (
        label
      ) : (
        <>
          <UploadIcon width={16} height={16} /> {label}
        </>
      )}
    </FilePicker>
  );
  let body: ReactNode;
  let lead: ReactNode = null;
  let picker: ReactNode = null;
  let trail: ReactNode = null;

  if (state.k === "start") {
    body = (
      <>
        <Card>
          <p className={styles.label} style={{ marginBlockEnd: 8 }}>
            {i("how")}
          </p>
          <ol className={own.steps}>
            {([1, 2, 3] as const).map((n) => (
              <li key={n}>
                <div className={own.stepTitle}>{i(`step${n}`)}</div>
                <div className={styles.small}>{i(`step${n}Text`)}</div>
              </li>
            ))}
          </ol>
        </Card>
        <TemplateLink />
        <Banner>{i("limits")}</Banner>
        <Banner tone="warn" icon="alert">
          {i("photos")}
        </Banner>
      </>
    );
    picker = chooser(i("choose"));
  } else if (state.k === "expired") {
    body = (
      <div role="alert">
        <StatusHeader tone="warn" icon="clock" title={i("expired.title")} text={i("expired.text")} />
      </div>
    );
    picker = chooser(i("uploadAgain"), { onClick: () => setState({ k: "start" }) });
  } else if (state.k === "checking") {
    body = (
      <div aria-busy="true">
        <FileCard file={state.file} progress={state.percent} />
      </div>
    );
    lead = (
      <Button disabled>
        <SyncIcon width={16} height={16} /> {i("checking")}
      </Button>
    );
  } else if (state.k === "refused") {
    const columns = refusedColumns(state.error);
    body = (
      <>
        <Banner tone="bad" icon="alert" alert>
          {writeFailureMessage(t, state.error)}
          {columns.length > 0 ? (
            <>
              {" "}
              <bdi dir="ltr">{i("columns", { columns: columns.join(", ") })}</bdi>
            </>
          ) : null}
        </Banner>
        <FileCard file={state.file} sub={i("notChecked")} />
      </>
    );
    picker = chooser(i("chooseAnother"));
    trail = <TemplateLink />;
  } else if (state.k === "conflict") {
    body = (
      <>
        <Banner tone="bad" icon="alert" alert>
          {i("conflict")}
        </Banner>
        <Problems rows={state.rows} />
        <FileCard file={state.file} />
      </>
    );
    picker = chooser(i("uploadAgain"));
  } else if (state.batch.errors.length > 0 || state.batch.status === "failed") {
    const { batch } = state;
    const rows = rowsWithErrors(batch.errors);
    body = (
      <>
        <FileCard file={state.file} rows={batch.row_count} />
        <Banner tone="bad" icon="alert" alert>
          {i("rowsToFix", { count: rows })}
        </Banner>
        <Problems rows={batch.errors} />
      </>
    );
    picker = chooser(i("uploadFixed"));
    trail = <Button disabled>{i("importBlocked", { count: rows })}</Button>;
  } else {
    const { batch, confirming, failure } = state;
    body = (
      <>
        {failure ? (
          <Banner tone="bad" icon="alert" alert>
            {writeFailureMessage(t, failure)}
          </Banner>
        ) : null}
        <FileCard
          file={state.file}
          rows={batch.row_count}
          end={
            <Chip tone="ok">
              <CheckIcon width={14} height={14} /> {i("noErrors")}
            </Chip>
          }
        />
        <Counts batch={batch} />
        <KeptUntil iso={batch.expires_at} />
      </>
    );
    lead = (
      <Button loading={confirming} onClick={() => void confirm()}>
        {confirming ? i("importing") : i("confirm", { count: batch.products })}
      </Button>
    );
    picker = chooser(i("chooseAnother"), { ghost: true, disabled: confirming });
  }

  return (
    <Screen>
      <Bar />
      <ScreenBody>
        {state.k === "expired" ? null : <OfflineNotice />}
        {body}
      </ScreenBody>
      <ScreenFooter>
        {lead}
        {picker}
        {trail}
      </ScreenFooter>
    </Screen>
  );
}

/**
 * A native file input laid over a label styled as a button. The input is the one keyboard stop and the
 * click target, so the chooser opens from the server HTML without JavaScript; the label shows its focus.
 */
function FilePicker({
  ref,
  variant,
  disabled,
  onChange,
  onClick,
  children,
}: {
  ref: Ref<HTMLInputElement>;
  variant: "primary" | "ghost";
  disabled?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onClick?: MouseEventHandler<HTMLInputElement>;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={own.picker}>
      <input
        ref={ref}
        id={id}
        type="file"
        accept=".csv,text/csv"
        // No restored file after Back: a file is only taken when someone chose it on this page.
        autoComplete="off"
        className={own.pickerInput}
        disabled={disabled}
        data-testid="csv-input"
        onChange={onChange}
        onClick={onClick}
      />
      <label htmlFor={id} className={`${buttonStyles.button} ${buttonStyles[variant]} ${own.pickerLabel}`}>
        {children}
      </label>
    </div>
  );
}

function TemplateLink() {
  const i = useTranslations("catalog.import");
  return (
    <a href={IMPORT_TEMPLATE_URL} download className={`${buttonStyles.button} ${buttonStyles.ghost} ${own.download}`}>
      <DownloadIcon width={16} height={16} /> {i("template")}
    </a>
  );
}

/** "48 KB" or "1.2 MB"; Latin digits in both languages, as the designs show. */
function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function FileCard({ file, rows, sub, progress, end }: { file: FileInfo; rows?: number; sub?: string; progress?: number; end?: ReactNode }) {
  const i = useTranslations("catalog.import");
  const details = [fileSize(file.size), rows !== undefined ? i("rows", { count: rows }) : sub].filter(Boolean).join(" · ");
  return (
    <Card className={own.fileCard}>
      <div className={own.fileRow}>
        <ListIcon width={22} height={22} aria-hidden="true" />
        <div className={own.fileText}>
          <bdi dir="ltr" className={styles.name}>
            {file.name}
          </bdi>
          <span className={styles.small}>{details}</span>
        </div>
        {end}
      </div>
      {progress !== undefined ? (
        <>
          <div className={own.progress} role="progressbar" aria-label={i("progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span className={own.progressFill} style={{ inlineSize: `${progress}%` }} />
          </div>
          <p className={styles.small} role="status">
            {i("checkingText")}
          </p>
        </>
      ) : null}
    </Card>
  );
}

function Counts({ batch }: { batch: ImportBatch }) {
  const i = useTranslations("catalog.import");
  const id = useId();
  const figures: Array<[string, number]> = [
    [i("products"), batch.products],
    [i("variants"), batch.variants],
    [i("units"), batch.opening_units],
    [i("rowsChecked"), batch.row_count],
  ];
  return (
    <Card>
      <p id={id} className={styles.label} style={{ marginBlockEnd: 8 }}>
        {i("ifImport")}
      </p>
      <div className={own.counts} role="group" aria-labelledby={id}>
        {figures.map(([label, value]) => (
          <div key={label}>
            <span className={styles.small}>{label}</span>
            <span className={own.count}>{value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function KeptUntil({ iso }: { iso: string }) {
  const i = useTranslations("catalog.import");
  const locale = useLocale();
  return <Banner>{i("keptUntil", { when: formatDateTime(iso, locale) })}</Banner>;
}

function Problems({ rows }: { rows: readonly ImportRowError[] }) {
  const t = useTranslations();
  const i = useTranslations("catalog.import");
  const id = useId();
  return (
    <>
      <p id={id} className={styles.label}>
        {i("problems")} · {rows.length}
      </p>
      <Card style={{ paddingBlock: 0 }}>
        <ul className={styles.list} aria-labelledby={id}>
          {rows.map((row, index) => (
            <li key={`${row.row}-${row.column ?? ""}-${row.code}-${index}`} className={`${styles.item} ${own.problem}`}>
              <Chip tone="bad">{i("row", { row: row.row })}</Chip>
              <span className={styles.rowText}>
                <span className={styles.name}>{row.column ? <bdi dir="ltr" className={own.mono}>{row.column}</bdi> : i("wholeRow")}</span>
                <span className={styles.muted}>{t(importErrorMessageKey(row.code))}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

