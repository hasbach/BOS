"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import type { BannerTone } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Field } from "@/components/Field";
import { AlertIcon, CheckIcon, CloseIcon, EditIcon, InfoIcon, LockIcon, PlusIcon, SyncIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { OfflineNotice } from "@/components/OfflineNotice";
import { PhotoPicker, photoFromId, waitingPhotos } from "@/components/PhotoPicker";
import type { PhotoItem } from "@/components/PhotoPicker";
import { Screen, ScreenBody, ScreenFooter } from "@/components/Screen";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SessionEnded } from "@/components/SessionEnded";
import { Sheet } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { useStoreChoices } from "@/components/StoresProvider";
import { useRovingRadio } from "@/components/useRovingRadio";
import { useRouter } from "@/i18n/navigation";
import { isApiError, isSessionEnded } from "@/lib/api";
import { CATALOG, changedProduct, createProduct, getProduct, photoUrl, productName, skuConflicts, updateProduct } from "@/lib/catalog";
import type { Product } from "@/lib/catalog";
import { catalogScreenScope } from "@/lib/catalogScreenSeed";
import type { CatalogScreenSeed } from "@/lib/catalogScreenSeed";
import { normaliseDigits } from "@/lib/digits";
import { formatAmount, formatApproximate, formatMoney, parseMoney, PRICE_RULE } from "@/lib/money";
import { useSeed } from "@/lib/seed";
import { useMe } from "@/lib/session";
import { newIdempotencyKey } from "@/lib/staff";
import { formatClock } from "@/lib/time";
import type { Currency } from "@/lib/types";

import styles from "./catalog.module.css";
import { CatalogStatus, NotAllowedToEdit, ProductNotFound, useBusinessSettings, useCatalogAccess } from "./parts";
import {
  MAX_OPTIONS,
  MAX_VALUES,
  activeRows,
  buildRequest,
  comboLabel,
  combos,
  emptyForm,
  emptyVariant,
  formFromProduct,
  newKey,
  parseCount,
  saveRefusal,
} from "./validation";
import type { Combo, Errors, FormState, LowMode, OptionDraft, VariantDraft } from "./validation";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const CURRENCIES = [
  { value: "USD" as const, label: "USD" },
  { value: "LBP" as const, label: "LBP" },
];

/** Screen 164 onwards: Add product, for catalog.manage holders. */
export function NewProduct() {
  const access = useCatalogAccess();
  const me = useMe();
  if (!access.manage) return <NotAllowedToEdit />;
  return <Form initial={emptyForm(me.stores.map((store) => store.id))} />;
}

type Load = { k: "loading" } | { k: "error"; error: unknown } | { k: "gone" } | { k: "ready"; product: Product };
type EditRead = { renderId: string; seed?: CatalogScreenSeed<Product> };

/** Screens 174 and 175: Edit product, loaded fresh so the form saves against the version it shows. */
export function EditProduct({ productId, renderId = "initial", seed }: { productId: string; renderId?: string; seed?: CatalogScreenSeed<Product> }) {
  const me = useMe();
  const scope = catalogScreenScope(me);
  const locale = useLocale();
  if (!me.permissions.includes("catalog.manage")) return <NotAllowedToEdit backHref={`${CATALOG}/${productId}`} />;
  const current = me.user.locale === locale && seed?.value.scope === scope ? seed : undefined;
  return <EditSession key={JSON.stringify([me.user.id, me.business.id, scope, locale, productId])} productId={productId} read={{ renderId, seed: current }} />;
}

function EditSession({ productId, read }: { productId: string; read: EditRead }) {
  // Once editing starts, keep the shown fields, their version, and transient state (e.g. uploads)
  // together. A refresh can replace a pristine load but must not remount this draft.
  const [draftRead, setDraftRead] = useState<EditRead>();
  // A sheet temporarily holds the same baseline without committing its local draft.
  const [sheetRead, setSheetRead] = useState<EditRead>();
  const active = draftRead ?? sheetRead ?? read;
  return <EditLoader
    key={active.renderId}
    productId={productId}
    seed={active.seed}
    onEdit={() => setDraftRead((current) => current ?? active)}
    onDetailsOpenChange={(open) => setSheetRead(open ? active : undefined)}
  />;
}

type EditDraftHandlers = { onEdit: () => void; onDetailsOpenChange: (open: boolean) => void };

function EditLoader({ productId, seed, ...draftHandlers }: { productId: string; seed?: CatalogScreenSeed<Product> } & EditDraftHandlers) {
  const t = useTranslations();
  const c = useTranslations("catalog");
  const initial = useSeed(seed)?.data;
  const [load, setLoad] = useState<Load>(() => initial ? { k: "ready", product: initial } : { k: "loading" });
  const [attempt, setAttempt] = useState(0);
  const back = `${CATALOG}/${productId}`;

  useEffect(() => {
    if (initial) return;
    const controller = new AbortController();
    getProduct(productId, controller.signal).then(
      (product) => { if (!controller.signal.aborted) setLoad({ k: "ready", product }); },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(isApiError(error) && error.code === "not_found" ? { k: "gone" } : { k: "error", error });
      },
    );
    return () => controller.abort();
  }, [productId, attempt, initial]);

  if (load.k === "gone") return <ProductNotFound />;
  if (load.k === "error") {
    if (isSessionEnded(load.error)) return <SessionEnded />;
    if (isApiError(load.error) && load.error.code === "forbidden") return <NotAllowedToEdit backHref={back} />;
    return (
      <CatalogStatus title={c("form.editTitle")} heading={c("productLoadError.title")} text={c("productLoadError.text")} tone="warn" icon="wifioff" alert backHref={back}>
        <Button
          onClick={() => {
            setLoad({ k: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          <SyncIcon width={16} height={16} /> {t("ui.retry")}
        </Button>
      </CatalogStatus>
    );
  }
  if (load.k === "loading") {
    return (
      <Screen>
        <AppBar title={c("form.editTitle")} backHref={back} backLabel={t("common.back")} />
        <ScreenBody>
          <p className={styles.muted} role="status" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <SyncIcon width={16} height={16} /> {t("ui.loading")}
          </p>
        </ScreenBody>
      </Screen>
    );
  }
  if (load.product.status === "archived") {
    return (
      <CatalogStatus title={c("form.editTitle")} heading={c("form.archivedProduct.title")} text={c("form.archivedProduct.text")} tone="info" icon="lock" backHref={back}>
        <LinkButton href={back}>{c("form.backToProduct")}</LinkButton>
      </CatalogStatus>
    );
  }
  return <Form key={load.product.id} product={load.product} initial={formFromProduct(load.product)} {...draftHandlers} />;
}

interface Notice {
  tone: BannerTone;
  text: string;
}

function Form({ product, initial, onEdit, onDetailsOpenChange }: { product?: Product; initial: FormState } & Partial<EditDraftHandlers>) {
  const t = useTranslations();
  const c = useTranslations("catalog");
  const locale = useLocale();
  const router = useRouter();
  const me = useMe();
  const settings = useBusinessSettings();
  const create = product === undefined;

  const [form, setForm] = useState<FormState>(initial);
  const [photos, setPhotos] = useState<PhotoItem[]>(() => (product ? product.photos.map((photo) => photoFromId(photo.id)) : []));
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(false);
  const [version, setVersion] = useState(product?.version ?? 0);
  const [locked, setLocked] = useState(product?.has_history ?? false);
  const [refused, setRefused] = useState<"gone" | "denied" | "ended" | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  // One key for this opened form, reused for every save of it (R44): a retry never creates the product twice.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const stores = useStoreChoices();

  if (refused === "gone") return <ProductNotFound />;
  if (refused === "denied") return <NotAllowedToEdit />;
  if (refused === "ended") return <SessionEnded />;

  const back = product ? `${CATALOG}/${product.id}` : CATALOG;
  const single = form.options.length === 0;
  const grid = combos(form.options);
  const rows = activeRows(form);
  const waiting = waitingPhotos(photos);
  const refusedPhoto = photos.some((photo) => photo.status === "refused");
  const donePhotos = photos.filter((photo) => photo.status === "done" && photo.id).map((photo) => photo.id as string);

  const changeForm = (update: (current: FormState) => FormState) => {
    onEdit?.();
    setForm(update);
  };
  const set = (change: Partial<FormState>) => changeForm((current) => ({ ...current, ...change }));
  const variantOf = (key: string): VariantDraft => form.variants[key] ?? emptyVariant();
  const setVariant = (key: string, change: Partial<VariantDraft>) =>
    changeForm((current) => ({ ...current, variants: { ...current.variants, [key]: { ...(current.variants[key] ?? emptyVariant()), ...change } } }));
  const setOption = (key: string, change: (option: OptionDraft) => OptionDraft) =>
    changeForm((current) => ({ ...current, options: current.options.map((option) => (option.key === key ? change(option) : option)) }));

  function openDetails(key: string) {
    onDetailsOpenChange?.(true);
    setDetails(key);
  }

  function closeDetails() {
    setDetails(null);
    onDetailsOpenChange?.(false);
  }

  function addValue(option: OptionDraft) {
    const label = option.adding.trim();
    if (label === "") return;
    const existing = option.values.find((value) => value.label.trim().toLowerCase() === label.toLowerCase());
    if (existing && !existing.removed) {
      setErrors((current) => ({ ...current, [`options.${option.key}.adding`]: c("form.fe.duplicateValue") }));
      return;
    }
    if (option.values.filter((value) => !value.removed).length >= MAX_VALUES) {
      setErrors((current) => ({ ...current, [`options.${option.key}.adding`]: c("form.fe.tooManyValues") }));
      return;
    }
    setErrors((current) => {
      const next = { ...current };
      delete next[`options.${option.key}.adding`];
      delete next[`options.${option.key}.values`];
      return next;
    });
    setOption(option.key, (o) => ({
      ...o,
      adding: "",
      values: existing ? o.values.map((value) => (value.key === existing.key ? { ...value, removed: false } : value)) : [...o.values, { key: newKey("value"), label, removed: false }],
    }));
  }

  function removeValue(option: OptionDraft, valueKey: string) {
    setOption(option.key, (o) => ({
      ...o,
      values: o.values.flatMap((value) => {
        if (value.key !== valueKey) return [value];
        return value.id ? [{ ...value, removed: !value.removed }] : [];
      }),
    }));
  }

  function addOption() {
    set({ options: [...form.options, { key: newKey("option"), name: "", values: [], adding: "" }] });
  }

  function removeOption(key: string) {
    set({ options: form.options.filter((option) => option.key !== key) });
  }

  function toggleStore(id: string) {
    set({ storeIds: form.storeIds.includes(id) ? form.storeIds.filter((storeId) => storeId !== id) : [...form.storeIds, id] });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || waiting > 0) return;
    onEdit?.();
    const built = buildRequest(t, form, donePhotos, create);
    const found = Object.keys(built.errors).length + (refusedPhoto ? 1 : 0);
    if (found > 0) {
      setErrors(built.errors);
      setNotice({ tone: "bad", text: c("form.fix", { count: found }) });
      setRetry(false);
      return;
    }
    setBusy(true);
    setNotice(null);
    setErrors({});
    try {
      const saved = create ? await createProduct(built.input, idempotencyKey) : await updateProduct(product.id, { ...built.input, version });
      // Shown as saved only on the product screen, after the server answered (screen 173).
      router.replace(`${CATALOG}/${saved.id}?saved=${create ? "created" : "updated"}`);
    } catch (error) {
      setBusy(false);
      if (isSessionEnded(error)) {
        setRefused("ended");
        return;
      }
      const current = changedProduct(error);
      const refusal = saveRefusal(t, error, form, built, current, skuConflicts(error), (iso) => formatClock(iso, locale));
      if (refusal.gone) setRefused("gone");
      else if (refusal.forbidden) setRefused("denied");
      if (refusal.current) {
        setForm(formFromProduct(refusal.current));
        setPhotos(refusal.current.photos.map((photo) => photoFromId(photo.id)));
        setVersion(refusal.current.version);
        setLocked(refusal.current.has_history);
      }
      if (isApiError(error) && error.code === "options_locked") setLocked(true);
      setErrors(refusal.errors);
      setNotice({ tone: "bad", text: refusal.banner });
      setRetry(refusal.connection === true);
    }
  }

  const units = rows.reduce((sum, combo) => sum + (parseCount(variantOf(combo.key).opening, 0) ?? 0), 0);
  const added = rows.filter((combo) => !variantOf(combo.key).id).length;
  const toArchive =
    grid.filter((combo) => combo.removing && form.variants[combo.key]?.id && form.variants[combo.key]?.hasHistory && form.variants[combo.key]?.status === "active").length +
    Object.values(form.variants).filter((draft) => draft.initialStatus === "active" && draft.status === "archived").length;
  const summary = create ? c("form.footerCreate", { variants: rows.length, units }) : c("form.footerEdit", { added, archived: toArchive });

  let saveLabel: ReactNode = create ? c("form.save") : c("form.saveChanges");
  if (busy) saveLabel = c("form.saving");
  else if (waiting > 0)
    saveLabel = (
      <>
        <SyncIcon width={16} height={16} /> {c("form.waiting", { count: waiting })}
      </>
    );
  else if (retry)
    saveLabel = (
      <>
        <SyncIcon width={16} height={16} /> {c("form.retry")}
      </>
    );

  const productLabel = product ? productName(product, locale) || product.code : me.business.name;
  const sheetCombo = details === null ? null : (grid.find((combo) => combo.key === details) ?? null);

  return (
    <Screen>
      <AppBar title={create ? c("form.addTitle") : c("form.editTitle")} subtitle={productLabel} backHref={back} backLabel={t("common.back")} />
      <form onSubmit={save} noValidate style={{ display: "contents" }}>
        <ScreenBody>
          <OfflineNotice />
          {notice ? (
            <Banner tone={notice.tone} icon="alert" alert>
              {notice.text}
            </Banner>
          ) : null}

          <PhotoPicker photos={photos} onChange={(next) => { onEdit?.(); setPhotos(next); }} error={errors.photos} disabled={busy} />

          <Field
            label={c("form.nameEn")}
            value={form.nameEn}
            placeholder={c("form.nameEnPh")}
            dir="ltr"
            autoComplete="off"
            maxLength={120}
            error={errors.name_en}
            onChange={(event) => set({ nameEn: event.target.value })}
          />
          <Field
            label={c("form.nameAr")}
            value={form.nameAr}
            placeholder={c("form.nameArPh")}
            dir="rtl"
            autoComplete="off"
            maxLength={120}
            helper={errors.name_en || errors.name_ar ? undefined : c("form.nameHint")}
            error={errors.name_ar}
            onChange={(event) => set({ nameAr: event.target.value })}
          />
          <Field
            label={c("form.code")}
            value={form.code}
            placeholder="JN-SLIM"
            dir="ltr"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={32}
            helper={errors.code ? undefined : c("form.codeHint")}
            error={errors.code}
            onChange={(event) => set({ code: event.target.value })}
          />
          <Field multiline label={c("form.descEn")} value={form.descEn} placeholder={c("form.descPh")} dir="ltr" maxLength={2000} rows={3} error={errors.description_en} onChange={(event) => set({ descEn: event.target.value })} />
          <Field multiline label={c("form.descAr")} value={form.descAr} placeholder={c("form.descPh")} dir="rtl" maxLength={2000} rows={3} error={errors.description_ar} onChange={(event) => set({ descAr: event.target.value })} />

          <fieldset className={styles.stack} style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
            <legend className={styles.label} style={{ marginBlockEnd: 6 }}>
              {c("form.soldIn")}
            </legend>
            <Card style={{ paddingBlock: 0 }}>
              {stores.map((store) => (
                <label key={store.id} className={styles.choice}>
                  <input type="checkbox" checked={form.storeIds.includes(store.id)} onChange={() => toggleStore(store.id)} style={{ inlineSize: 22, blockSize: 22, accentColor: "var(--accent)" }} />
                  <span className={styles.grow}>{store.name}</span>
                </label>
              ))}
            </Card>
            {errors.store_ids ? <FieldError text={errors.store_ids} /> : null}
            {form.storeIds.length > 0 ? (
              <p className={styles.small}>{c("form.storesHint")}</p>
            ) : (
              <Banner tone="warn" icon="alert">
                {c("form.noStore")}
              </Banner>
            )}
          </fieldset>

          <section className={styles.stack} aria-label={c("form.options.title")}>
            <div>
              <h2 className={styles.label}>{c("form.options.title")}</h2>
              <p className={styles.small}>{c("form.options.hint")}</p>
            </div>
            {single ? (
              <Card className={styles.stack}>
                <p className={styles.muted}>{c("form.options.none")}</p>
                {!locked ? (
                  <Button variant="ghost" size="small" onClick={addOption}>
                    <PlusIcon width={16} height={16} /> {c("form.options.addOption")}
                  </Button>
                ) : null}
              </Card>
            ) : (
              <>
                {form.options.map((option, index) => (
                  <OptionCard
                    key={option.key}
                    option={option}
                    n={index + 1}
                    locked={locked}
                    errors={errors}
                    form={form}
                    onName={(name) => setOption(option.key, (o) => ({ ...o, name }))}
                    onAdding={(adding) => setOption(option.key, (o) => ({ ...o, adding }))}
                    onAdd={() => addValue(option)}
                    onRemoveValue={(valueKey) => removeValue(option, valueKey)}
                    onRemove={() => removeOption(option.key)}
                  />
                ))}
                <Banner icon="info">{variantCountText(c, form)}</Banner>
                {locked ? (
                  <Banner icon="lock">{c("form.options.locked")}</Banner>
                ) : form.options.length < MAX_OPTIONS ? (
                  <Button variant="ghost" size="small" onClick={addOption}>
                    <PlusIcon width={16} height={16} /> {c("form.options.addOption")}
                  </Button>
                ) : (
                  <p className={styles.small}>
                    <LockIcon width={14} height={14} /> {c("form.options.max")}
                  </p>
                )}
              </>
            )}
          </section>

          <PriceField
            label={c("form.price")}
            price={form.price}
            currency={form.currency}
            rate={settings.rate}
            error={errors.price}
            onPrice={(price) => set({ price })}
            onCurrency={(currency) => set({ currency })}
          />

          {single ? (
            <SingleVariant
              draft={variantOf("")}
              create={create}
              errors={errors}
              lowDefault={settings.lowDefault}
              onChange={(change) => setVariant("", change)}
              onDetails={() => openDetails("")}
            />
          ) : (
            <>
              <Card style={{ paddingBlock: 0 }}>
                <label className={styles.choice}>
                  <input type="checkbox" checked={form.samePrice} onChange={() => set({ samePrice: !form.samePrice })} style={{ inlineSize: 22, blockSize: 22, accentColor: "var(--accent)" }} />
                  <span className={styles.grow}>
                    <span className={styles.name}>{c("form.samePrice")}</span>
                    <br />
                    <span className={styles.muted}>{c("form.samePriceHint")}</span>
                  </span>
                </label>
              </Card>
              <div>
                <h2 className={styles.label}>{create ? `${c("form.variants")} · ${rows.length}` : c("form.afterSave")}</h2>
                {create ? <p className={styles.small}>{c("form.openingHint")}</p> : null}
              </div>
              {errors.variants ? <FieldError text={errors.variants} /> : null}
              <Card style={{ paddingBlock: 0 }}>
                {grid
                  .filter((combo) => isShown(combo, form))
                  .map((combo) => (
                    <VariantRow
                      key={combo.key}
                      combo={combo}
                      draft={variantOf(combo.key)}
                      create={create}
                      samePrice={form.samePrice}
                      errors={errors}
                      onOpening={(opening) => setVariant(combo.key, { opening })}
                      onDetails={() => openDetails(combo.key)}
                    />
                  ))}
              </Card>
              {settings.lowDefault !== null ? <p className={styles.small}>{c("form.lowHint", { level: settings.lowDefault })}</p> : null}
              {!create && added > 0 ? <Banner icon="info">{c("form.newStartZero")}</Banner> : null}
              {!create ? (
                <ArchivedVariants
                  form={form}
                  grid={grid}
                  onToggle={(key, status) => setVariant(key, { status })}
                  onToggleOrphan={(id, status) => set({ orphans: { ...form.orphans, [id]: { ...(form.orphans[id] as VariantDraft), status } } })}
                />
              ) : null}
            </>
          )}
        </ScreenBody>
        <ScreenFooter>
          <p className={styles.summary}>{summary}</p>
          <Button type="submit" loading={busy} disabled={waiting > 0}>
            {saveLabel}
          </Button>
        </ScreenFooter>
      </form>

      {details !== null && (sheetCombo || single) ? (
        <VariantSheet
          title={single ? c("form.sheet.title") : comboLabel(sheetCombo as Combo)}
          draft={variantOf(details)}
          single={single}
          canArchive={!create && Boolean(variantOf(details).id) && !single}
          sharedPrice={form.price}
          sharedCurrency={form.currency}
          rate={settings.rate}
          lowDefault={settings.lowDefault}
          photos={donePhotos}
          onClose={closeDetails}
          onDone={(draft) => {
            setVariant(details, draft);
            closeDetails();
          }}
        />
      ) : null}
    </Screen>
  );
}

function variantCountText(c: Translate, form: FormState): string {
  const counts = form.options.map((option) => option.values.filter((value) => !value.removed).length);
  const total = counts.reduce((product, count) => product * count, 1);
  if (counts.length === 2) return c("form.options.countTwo", { a: counts[0] ?? 0, b: counts[1] ?? 0, count: total });
  return c("form.options.countOne", { count: total });
}

/** Rows of the edit list: what stays or is new, and removed rows with history (they will be archived). */
function isShown(combo: Combo, form: FormState): boolean {
  const draft = form.variants[combo.key];
  if (combo.removing) return Boolean(draft?.id && draft.hasHistory && draft.status === "active");
  return (draft?.status ?? "active") === "active";
}

function FieldError({ text, id }: { text: string; id?: string }) {
  return (
    <p className={styles.error} id={id}>
      <AlertIcon width={16} height={16} />
      <span>{text}</span>
    </p>
  );
}

function OptionCard({
  option,
  n,
  locked,
  errors,
  form,
  onName,
  onAdding,
  onAdd,
  onRemoveValue,
  onRemove,
}: {
  option: OptionDraft;
  n: number;
  locked: boolean;
  errors: Errors;
  form: FormState;
  onName: (name: string) => void;
  onAdding: (value: string) => void;
  onAdd: () => void;
  onRemoveValue: (valueKey: string) => void;
  onRemove: () => void;
}) {
  const c = useTranslations("catalog.form.options");
  const addError = errors[`options.${option.key}.adding`];
  const valuesError = errors[`options.${option.key}.values`];
  const addErrorId = useId();
  // A removed value whose variants have history: they are archived, not deleted (screen 174).
  const archiving = option.values.filter(
    (value) =>
      value.removed &&
      combos(form.options).some((combo) => combo.values.some((v) => v.key === value.key) && form.variants[combo.key]?.hasHistory),
  );

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onAdd();
    }
  }

  return (
    <Card className={styles.stack}>
      <div className={styles.between}>
        <span className={styles.label}>{c("option", { n })}</span>
        {locked ? (
          <LockIcon width={16} height={16} />
        ) : (
          <Button variant="ghost" size="small" onClick={onRemove}>
            <CloseIcon width={16} height={16} /> {c("remove")}
          </Button>
        )}
      </div>
      <Field label={c("name")} value={option.name} autoComplete="off" maxLength={40} error={errors[`options.${option.key}.name`]} onChange={(event) => onName(event.target.value)} />
      <div className={styles.stack} style={{ gap: 6 }}>
        <span className={styles.label}>{c("values")}</span>
        {option.values.length > 0 ? (
          <div className={styles.pills}>
            {option.values.map((value) => (
              <span key={value.key} className={[styles.pill, value.removed ? styles.pillOff : "", !value.id && option.id ? styles.pillNew : ""].filter(Boolean).join(" ")}>
                <bdi>{value.label}</bdi>
                {!value.id && option.id ? <span className={styles.small}>{c("newValue")}</span> : null}
                <button type="button" className={styles.pillButton} aria-label={value.removed ? c("keepValue", { value: value.label }) : c("removeValue", { value: value.label })} onClick={() => onRemoveValue(value.key)}>
                  {value.removed ? <SyncIcon width={14} height={14} /> : <CloseIcon width={14} height={14} />}
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {valuesError ? <FieldError text={valuesError} /> : null}
      </div>
      <div className={styles.valueRow}>
        <input
          className={styles.valueInput}
          value={option.adding}
          placeholder={c("valuePh")}
          aria-label={c("addValue", { n })}
          aria-describedby={addError ? addErrorId : undefined}
          aria-invalid={addError ? true : undefined}
          maxLength={40}
          autoComplete="off"
          onChange={(event) => onAdding(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button variant="ghost" size="small" onClick={onAdd}>
          <PlusIcon width={16} height={16} /> {c("add")}
        </Button>
      </div>
      {addError ? <FieldError text={addError} id={addErrorId} /> : null}
      {archiving.map((value) => (
        <p key={value.key} className={styles.small} style={{ color: "var(--warn-fg)" }}>
          <AlertIcon width={14} height={14} /> {c("willArchive", { value: value.label })}
        </p>
      ))}
    </Card>
  );
}

function PriceField({
  label,
  price,
  currency,
  rate,
  error,
  onPrice,
  onCurrency,
}: {
  label: string;
  price: string;
  currency: Currency;
  rate: string | null;
  error?: string;
  onPrice: (price: string) => void;
  onCurrency: (currency: Currency) => void;
}) {
  const c = useTranslations("catalog.form");
  const locale = useLocale();
  const parsed = parseMoney(normaliseDigits(price), PRICE_RULE);
  const approx = parsed.ok && rate ? formatApproximate(parsed.value, currency, rate, locale) : null;
  let helper: string | undefined;
  if (currency === "LBP") helper = approx ? `${c("approxShort", { amount: approx })} ${c("lbpWhole")}` : c("lbpWhole");
  else if (approx && rate) helper = c("approx", { amount: approx, rate: formatMoney(rate, { trimZeros: true }) });
  return (
    <div className={styles.moneyRow}>
      <Field label={label} value={price} inputMode="decimal" dir="ltr" autoComplete="off" placeholder="0" helper={helper} error={error} onChange={(event) => onPrice(event.target.value)} />
      <SegmentedControl label={c("currency")} options={CURRENCIES} value={currency} onChange={onCurrency} />
    </div>
  );
}

function levelText(c: Translate, draft: VariantDraft, lowDefault: number | null): string {
  if (draft.lowMode === "none") return c("form.level.none");
  if (draft.lowMode === "own") return c("form.level.own", { level: draft.lowLevel });
  return c("form.level.default", { level: lowDefault ?? "–" });
}

function SingleVariant({
  draft,
  create,
  errors,
  lowDefault,
  onChange,
  onDetails,
}: {
  draft: VariantDraft;
  create: boolean;
  errors: Errors;
  lowDefault: number | null;
  onChange: (change: Partial<VariantDraft>) => void;
  onDetails: () => void;
}) {
  const c = useTranslations("catalog");
  return (
    <>
      <Field
        label={c("form.sku")}
        value={draft.sku}
        dir="ltr"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={64}
        helper={errors["variants..sku"] ? undefined : c("form.skuHintSingle")}
        error={errors["variants..sku"]}
        onChange={(event) => onChange({ sku: event.target.value })}
      />
      {create ? <Stepper value={draft.opening} label={c("form.opening")} visibleLabel error={errors["variants..opening_quantity"]} onChange={(opening) => onChange({ opening })} /> : null}
      {errors["variants..low_stock_level"] ? <FieldError text={errors["variants..low_stock_level"]} /> : null}
      {errors["variants..photo_id"] ? <FieldError text={errors["variants..photo_id"]} /> : null}
      <p className={styles.small}>
        {c("form.lowSingle", { level: levelText(c, draft, lowDefault) })}{" "}
        <button type="button" className={styles.linkButton} onClick={onDetails}>
          {c("form.change")}
        </button>
      </p>
    </>
  );
}

function VariantRow({
  combo,
  draft,
  create,
  samePrice,
  errors,
  onOpening,
  onDetails,
}: {
  combo: Combo;
  draft: VariantDraft;
  create: boolean;
  samePrice: boolean;
  errors: Errors;
  onOpening: (value: string) => void;
  onDetails: () => void;
}) {
  const c = useTranslations("catalog.form");
  const locale = useLocale();
  const label = comboLabel(combo);
  const base = `variants.${combo.key}`;
  const rowErrors = ["sku", "price", "low_stock_level", "photo_id", "opening_quantity", "currency"].map((field) => errors[`${base}.${field}`]).filter((text): text is string => Boolean(text));

  let chip: ReactNode = null;
  let info: string;
  if (combo.removing) {
    chip = <Chip tone="warn">{c("willArchiveChip")}</Chip>;
    info = `${c("onHand", { count: draft.onHand })} · ${c("hasHistory")}`;
  } else if (!create && !draft.id) {
    chip = <Chip tone="info">{c("newChip")}</Chip>;
    info = c("startsAtZero");
  } else if (!create) {
    info = c("onHand", { count: draft.onHand });
  } else {
    info = draft.sku.trim() ? c("skuLine", { sku: draft.sku.trim() }) : c("skuAuto");
  }
  const ownPrice = draft.ownPrice ? formatPriceTyped(draft.ownPrice.price, draft.ownPrice.currency, locale) : null;

  return (
    <div className={styles.variantRow}>
      <div className={styles.grow}>
        <div className={styles.chips} style={{ alignItems: "center" }}>
          <span className={styles.name}>{label}</span>
          {chip}
        </div>
        <div className={styles.small}>
          {create ? info : `${draft.sku.trim() ? c("skuLine", { sku: draft.sku.trim() }) : c("skuAuto")} · ${info}`}
          {ownPrice ? ` · ${c("ownPriceLine", { price: ownPrice })}` : !samePrice ? ` · ${c("noPrice")}` : null}
        </div>
        {rowErrors.map((text) => (
          <FieldError key={text} text={text} />
        ))}
      </div>
      {create ? <Stepper value={draft.opening} label={c("openingFor", { variant: label })} error={errors[`${base}.opening_quantity`]} onChange={onOpening} /> : null}
      {combo.removing ? null : (
        <button type="button" className={styles.iconButton} aria-label={c("details", { variant: label })} onClick={onDetails}>
          <EditIcon width={18} height={18} />
        </button>
      )}
    </div>
  );
}

function formatPriceTyped(price: string, currency: Currency, locale: string): string {
  const parsed = parseMoney(normaliseDigits(price), PRICE_RULE);
  return parsed.ok ? formatAmount(parsed.value, currency, locale) : price;
}

function ArchivedVariants({
  form,
  grid,
  onToggle,
  onToggleOrphan,
}: {
  form: FormState;
  grid: Combo[];
  onToggle: (key: string, status: "active" | "archived") => void;
  onToggleOrphan: (id: string, status: "active" | "archived") => void;
}) {
  const c = useTranslations("catalog.form");
  const archived = grid.filter((combo) => !combo.removing && form.variants[combo.key]?.status === "archived");
  const orphans = Object.entries(form.orphans);
  if (archived.length === 0 && orphans.length === 0) return null;
  const row = (key: string, label: string, draft: VariantDraft, toggle: (status: "active" | "archived") => void) => {
    const restoring = draft.status === "active";
    return (
      <div key={key} className={styles.variantRow}>
        <div className={styles.grow}>
          <div className={styles.chips} style={{ alignItems: "center" }}>
            <span className={styles.name}>{label}</span>
            {restoring ? <Chip tone="info">{c("willRestore")}</Chip> : null}
          </div>
          <div className={styles.small}>
            <bdi dir="ltr">{draft.sku}</bdi> · {c("onHand", { count: draft.onHand })}
          </div>
        </div>
        <Button variant="ghost" size="small" aria-label={c("restoreVariantOf", { variant: label })} aria-pressed={restoring} onClick={() => toggle(restoring ? "archived" : "active")}>
          {restoring ? <CheckIcon width={16} height={16} /> : <SyncIcon width={16} height={16} />} {c("restoreVariant")}
        </Button>
      </div>
    );
  };
  return (
    <>
      <h2 className={styles.label}>
        {c("archivedVariants")} · {archived.length + orphans.length}
      </h2>
      <Card style={{ paddingBlock: 0 }}>
        {archived.map((combo) => row(combo.key, comboLabel(combo), form.variants[combo.key] as VariantDraft, (status) => onToggle(combo.key, status)))}
        {orphans.map(([id, draft]) => row(id, (draft.labels ?? []).join(" · "), draft, (status) => onToggleOrphan(id, status)))}
      </Card>
    </>
  );
}

const LOW_MODES: readonly LowMode[] = ["default", "own", "none"];

/** Screen 167: a variant's SKU, own price, low-stock level and photo. Nothing is sent until the form is saved. */
function VariantSheet({
  title,
  draft: initial,
  single,
  canArchive,
  sharedPrice,
  sharedCurrency,
  rate,
  lowDefault,
  photos,
  onClose,
  onDone,
}: {
  title: string;
  draft: VariantDraft;
  single: boolean;
  canArchive: boolean;
  sharedPrice: string;
  sharedCurrency: Currency;
  rate: string | null;
  lowDefault: number | null;
  photos: string[];
  onClose: () => void;
  onDone: (draft: VariantDraft) => void;
}) {
  const c = useTranslations("catalog");
  const locale = useLocale();
  const [draft, setDraft] = useState(initial);
  const lowItem = useRovingRadio(LOW_MODES, draft.lowMode, (lowMode) => setDraft((d) => ({ ...d, lowMode })));
  const photoValues = ["", ...photos];
  const photoItem = useRovingRadio(photoValues, draft.photoId ?? "", (id) => setDraft((d) => ({ ...d, photoId: id || null })));
  const shared = formatPriceTyped(sharedPrice, sharedCurrency, locale);
  const changed = draft.sku !== initial.sku || draft.ownPrice?.price !== initial.ownPrice?.price ||
    draft.ownPrice?.currency !== initial.ownPrice?.currency || draft.lowMode !== initial.lowMode ||
    (draft.lowMode === "own" && draft.lowLevel !== initial.lowLevel) || draft.photoId !== initial.photoId;

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      footer={
        <Button onClick={() => changed ? onDone(draft) : onClose()}>
          <CheckIcon width={16} height={16} /> {c("form.sheet.done")}
        </Button>
      }
    >
      <div className={styles.stack}>
        {single ? null : (
          <>
            <p className={styles.small}>{c("form.sheet.title")}</p>
            <Field
              label={c("form.sku")}
              value={draft.sku}
              dir="ltr"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={64}
              helper={c("form.sheet.skuHint")}
              onChange={(event) => setDraft((d) => ({ ...d, sku: event.target.value }))}
            />
            <Card style={{ paddingBlock: 0 }}>
              <label className={styles.choice}>
                <input
                  type="checkbox"
                  checked={draft.ownPrice === null}
                  onChange={() => setDraft((d) => ({ ...d, ownPrice: d.ownPrice === null ? { price: sharedPrice, currency: sharedCurrency } : null }))}
                  style={{ inlineSize: 22, blockSize: 22, accentColor: "var(--accent)" }}
                />
                <span className={styles.grow}>{c("form.sheet.useShared", { price: shared || "–" })}</span>
              </label>
            </Card>
            {draft.ownPrice ? (
              <PriceField
                label={c("form.ownPrice")}
                price={draft.ownPrice.price}
                currency={draft.ownPrice.currency}
                rate={rate}
                onPrice={(price) => setDraft((d) => ({ ...d, ownPrice: { price, currency: d.ownPrice?.currency ?? sharedCurrency } }))}
                onCurrency={(currency) => setDraft((d) => ({ ...d, ownPrice: { price: d.ownPrice?.price ?? "", currency } }))}
              />
            ) : null}
          </>
        )}

        <div className={styles.stack} style={{ gap: 6 }}>
          <span className={styles.label}>
            {c("form.sheet.low")}
          </span>
          <Card style={{ paddingBlock: 0 }}>
            <div role="radiogroup" aria-label={c("form.sheet.low")}>
              {LOW_MODES.map((mode) => {
                const on = draft.lowMode === mode;
                const text = mode === "default" ? (lowDefault === null ? c("form.level.default", { level: "–" }) : c("form.sheet.lowDefault", { level: lowDefault })) : mode === "own" ? c("form.sheet.lowOwn") : c("form.sheet.lowNone");
                return (
                  <button key={mode} type="button" role="radio" aria-checked={on} className={styles.choice} {...lowItem(mode)} onClick={() => setDraft((d) => ({ ...d, lowMode: mode }))}>
                    <span className={`${styles.box} ${styles.radio} ${on ? styles.boxOn : ""}`} aria-hidden="true">
                      <CheckIcon width={14} height={14} />
                    </span>
                    <span className={styles.grow}>{text}</span>
                  </button>
                );
              })}
            </div>
          </Card>
          {draft.lowMode === "own" ? (
            <input
              className={styles.levelInput}
              value={draft.lowLevel}
              inputMode="numeric"
              dir="ltr"
              aria-label={c("form.sheet.lowOwnLabel")}
              onChange={(event) => setDraft((d) => ({ ...d, lowLevel: event.target.value }))}
            />
          ) : null}
        </div>

        {photos.length > 0 ? (
          <div className={styles.stack} style={{ gap: 6 }}>
            <span className={styles.label}>{c("form.sheet.photo")}</span>
            <div className={styles.pills} role="radiogroup" aria-label={c("form.sheet.photo")}>
              {photoValues.map((id, index) => {
                const on = (draft.photoId ?? "") === id;
                return id === "" ? (
                  <button key="none" type="button" role="radio" aria-checked={on} className={`${styles.pill} ${on ? styles.pillOn : ""}`} {...photoItem(id)} onClick={() => setDraft((d) => ({ ...d, photoId: null }))}>
                    {on ? <CheckIcon width={14} height={14} /> : null}
                    {c("form.sheet.photoNone")}
                  </button>
                ) : (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={c("form.sheet.photoN", { n: index })}
                    className={`${styles.photoChoice} ${on ? styles.photoChoiceOn : ""}`}
                    {...photoItem(id)}
                    onClick={() => setDraft((d) => ({ ...d, photoId: id }))}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- served by the API with the session cookie */}
                    <img className={styles.image} src={photoUrl(id, "thumb")} alt="" />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {canArchive ? (
          <div className={styles.stack} style={{ gap: 6 }}>
            <p className={styles.small}>
              <InfoIcon width={14} height={14} /> {c("form.sheet.archiveHint")}
            </p>
            <Button variant="ghost" onClick={() => onDone({ ...draft, status: "archived" })}>
              {c("form.sheet.archive")}
            </Button>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
