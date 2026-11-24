"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType, SVGProps } from "react";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Empty } from "@/components/Empty";
import {
  AlertIcon,
  BanIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  FilterIcon,
  FlagIcon,
  GearIcon,
  LockIcon,
  LogoutIcon,
  PhoneIcon,
  SearchIcon,
  SendIcon,
  StoreIcon,
  SyncIcon,
  UserIcon,
  UsersIcon,
} from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { Loading } from "@/components/Loading";
import { Screen, ScreenBody, ScreenFooter, StatusHeader } from "@/components/Screen";
import { SessionEnded } from "@/components/SessionEnded";
import { Sheet } from "@/components/Sheet";
import { useRovingRadio } from "@/components/useRovingRadio";
import { api, isApiError, isSessionEnded } from "@/lib/api";
import { EVENT_GROUPS, EVENT_ICONS, actorLabel, describeEntry, eventName } from "@/lib/audit";
import type { AuditEntry, AuditPage, EventIcon } from "@/lib/audit";
import { useMe } from "@/lib/session";
import type { StaffList, StaffMember } from "@/lib/staff";
import { beirutDayKey, daysAgo, formatBeirutDate, formatClock, formatWeekdayDate } from "@/lib/time";

import styles from "../account.module.css";

const ICONS: Record<EventIcon, ComponentType<SVGProps<SVGSVGElement>>> = {
  user: UserIcon,
  alert: AlertIcon,
  logout: LogoutIcon,
  phone: PhoneIcon,
  lock: LockIcon,
  edit: EditIcon,
  send: SendIcon,
  check: CheckIcon,
  x: CloseIcon,
  users: UsersIcon,
  ban: BanIcon,
  store: StoreIcon,
  gear: GearIcon,
  flag: FlagIcon,
};

interface Filters {
  event: string;
  person: { id: string; name: string } | null;
}
const NO_FILTERS: Filters = { event: "", person: null };

type Page = { k: "loading" } | { k: "forbidden" } | { k: "ended" } | { k: "error" } | { k: "ready"; entries: AuditEntry[]; next: string | null };
type More = "idle" | "loading" | "error";

function NotAllowed() {
  const t = useTranslations("history");
  const common = useTranslations("common");
  return (
    <Screen>
      <AppBar title={t("title")} backHref="/more" backLabel={common("back")} />
      <ScreenBody>
        <StatusHeader tone="info" icon="lock" title={t("notAllowed.title")} text={t("notAllowed.text")} />
      </ScreenBody>
      <ScreenFooter>
        <LinkButton href="/more">{t("backToMore")}</LinkButton>
      </ScreenFooter>
    </Screen>
  );
}

/** Screens 109 to 114: GET /audit, owners only. Newest first, grouped by Beirut day, 50 at a time. */
export function HistoryScreen() {
  const me = useMe();
  if (!me.permissions.includes("audit.view")) return <NotAllowed />;
  return <History />;
}

function History() {
  const t = useTranslations();
  const h = useTranslations("history");
  const locale = useLocale();
  const me = useMe();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState<Page>({ k: "loading" });
  const [more, setMore] = useState<More>("idle");
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState<"event" | "person" | null>(null);

  const query = useCallback((cursor?: string) => ({ cursor, event: filters.event || undefined, actor_id: filters.person?.id }), [filters]);

  useEffect(() => {
    const controller = new AbortController();
    api.get<AuditPage>("/audit", { query: query(), signal: controller.signal }).then(
      (result) => setPage({ k: "ready", entries: result.items, next: result.next_cursor }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (isSessionEnded(error)) setPage({ k: "ended" });
        else setPage(isApiError(error) && error.code === "forbidden" ? { k: "forbidden" } : { k: "error" });
      },
    );
    return () => controller.abort();
  }, [query, attempt]);

  function apply(next: Filters) {
    setPage({ k: "loading" });
    setMore("idle");
    setFilters(next);
    setSheet(null);
  }

  async function loadMore() {
    if (page.k !== "ready" || !page.next || more === "loading") return;
    setMore("loading");
    try {
      const result = await api.get<AuditPage>("/audit", { query: query(page.next) });
      setPage((current) => (current.k === "ready" ? { k: "ready", entries: [...current.entries, ...result.items], next: result.next_cursor } : current));
      setMore("idle");
    } catch {
      setMore("error");
    }
  }

  const bar = <AppBar title={h("title")} subtitle={me.business.name} backHref="/more" backLabel={t("common.back")} />;
  const filtered = filters.event !== "" || filters.person !== null;

  if (page.k === "ended") return <SessionEnded />;
  if (page.k === "forbidden") return <NotAllowed />;
  if (page.k === "error") {
    return (
      <Screen>
        {bar}
        <ScreenBody>
          <div role="alert">
            <StatusHeader tone="warn" icon="wifioff" title={h("loadError.title")} text={h("loadError.text")} />
          </div>
        </ScreenBody>
        <ScreenFooter>
          <Button
            onClick={() => {
              setPage({ k: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            {t("ui.retry")}
          </Button>
        </ScreenFooter>
      </Screen>
    );
  }

  return (
    <Screen>
      {bar}
      <ScreenBody>
        <div className={styles.pills} role="group" aria-label={h("filters")}>
          <button type="button" className={`${styles.pill} ${filters.event ? styles.pillOn : ""}`} aria-haspopup="dialog" onClick={() => setSheet("event")}>
            <FilterIcon width={16} height={16} />
            {filters.event ? eventName(filters.event, t as never) : h("allEvents")}
          </button>
          <button type="button" className={`${styles.pill} ${filters.person ? styles.pillOn : ""}`} aria-haspopup="dialog" onClick={() => setSheet("person")}>
            <UserIcon width={16} height={16} />
            {filters.person ? filters.person.name : h("everyone")}
          </button>
          {filtered ? (
            <button type="button" className={styles.pill} onClick={() => apply(NO_FILTERS)}>
              <CloseIcon width={16} height={16} />
              {h("clear")}
            </button>
          ) : null}
        </div>
        <p className={styles.small}>{h("note")}</p>

        {page.k === "loading" ? <Loading label={h("loading")} /> : <Entries page={page} filters={filters} more={more} onMore={() => void loadMore()} onClear={() => apply(NO_FILTERS)} locale={locale} />}
      </ScreenBody>

      <EventSheet open={sheet === "event"} current={filters.event} onClose={() => setSheet(null)} onApply={(event) => apply({ ...filters, event })} />
      <PersonSheet open={sheet === "person"} current={filters.person?.id ?? ""} meId={me.user.id} onClose={() => setSheet(null)} onApply={(person) => apply({ ...filters, person })} />
    </Screen>
  );
}

function Entries({
  page,
  filters,
  more,
  onMore,
  onClear,
  locale,
}: {
  page: Extract<Page, { k: "ready" }>;
  filters: Filters;
  more: More;
  onMore: () => void;
  onClear: () => void;
  locale: string;
}) {
  const t = useTranslations();
  const h = useTranslations("history");
  const now = new Date();

  const days = useMemo(() => {
    const groups: Array<{ key: string; at: string; entries: AuditEntry[] }> = [];
    for (const entry of page.entries) {
      const key = beirutDayKey(entry.at);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.entries.push(entry);
      else groups.push({ key, at: entry.at, entries: [entry] });
    }
    return groups;
  }, [page.entries]);

  if (page.entries.length === 0) {
    const event = filters.event ? eventName(filters.event, t as never) : "";
    const person = filters.person?.name ?? "";
    const filtered = event !== "" || person !== "";
    if (!filtered) return <Empty title={t("ui.emptyTitle")} />;
    const text = event && person ? h("emptyBoth", { event, person }) : event ? h("emptyEvent", { event }) : h("emptyPerson", { person });
    return (
      <div className={styles.center}>
        <div className={styles.emptyCircle} aria-hidden="true">
          <SearchIcon width={28} height={28} />
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>{h("emptyTitle")}</h2>
        <p style={{ fontSize: 14, color: "var(--fg-2)", maxInlineSize: 280 }}>{text}</p>
        <Button variant="ghost" size="small" onClick={onClear}>
          <CloseIcon width={16} height={16} /> {h("clearFilters")}
        </Button>
      </div>
    );
  }

  function heading(at: string): string {
    const ago = daysAgo(at, now);
    if (ago >= 180) return formatBeirutDate(at, locale);
    const date = formatWeekdayDate(at, locale);
    if (ago <= 0) return h("today", { date });
    if (ago === 1) return h("yesterday", { date });
    return date;
  }

  return (
    <>
      {days.map((day) => {
        const title = heading(day.at);
        return (
          <section key={day.key} className={styles.group} aria-label={title}>
            <h2 className={styles.label}>{title}</h2>
            <Card style={{ padding: 0 }}>
              <ul className={styles.list}>
                {day.entries.map((entry) => (
                  <Row key={entry.id} entry={entry} locale={locale} />
                ))}
              </ul>
            </Card>
          </section>
        );
      })}
      {more === "loading" ? (
        <Card style={{ padding: 0 }} aria-busy="true">
          <ul className={styles.list}>
            {[0, 1].map((n) => (
              <li key={n} className={styles.row} aria-hidden="true">
                <div className={`${styles.skeleton} ${styles.avatar}`} />
                <div className={styles.text} style={{ gap: 8 }}>
                  <div className={styles.skeleton} style={{ blockSize: 14, inlineSize: "50%" }} />
                  <div className={styles.skeleton} style={{ blockSize: 12, inlineSize: "75%" }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {more === "error" ? (
        <Banner tone="bad" icon="alert" alert>
          {h("moreError")}
        </Banner>
      ) : null}
      {page.next ? (
        <Button variant="ghost" loading={more === "loading"} onClick={onMore}>
          {more === "loading" ? (
            <>
              <SyncIcon width={16} height={16} /> {h("loadingMore")}
            </>
          ) : (
            h("loadMore")
          )}
        </Button>
      ) : null}
    </>
  );
}

function Row({ entry, locale }: { entry: AuditEntry; locale: string }) {
  const t = useTranslations();
  const h = useTranslations("history");
  const meta = EVENT_ICONS[entry.event] ?? { icon: "flag" as const };
  const Icon = ICONS[meta.icon];
  const details = describeEntry(entry, t as never);

  return (
    <li className={styles.row}>
      <div className={styles.avatar} aria-hidden="true">
        <Icon width={18} height={18} style={meta.flip ? { transform: locale === "ar" ? "scaleX(-1)" : undefined } : undefined} />
      </div>
      <div className={styles.text}>
        <div className={styles.between}>
          <span className={styles.name}>{eventName(entry.event, t as never)}</span>
          <bdi dir="ltr" className={styles.time}>
            {formatClock(entry.at, locale)}
          </bdi>
        </div>
        {details.map((line) => (
          <span key={line} className={styles.muted}>
            {line}
          </span>
        ))}
        <span className={styles.small}>{h("by", { who: actorLabel(entry, t as never) })}</span>
      </div>
    </li>
  );
}

function EventSheet({ open, current, onClose, onApply }: { open: boolean; current: string; onClose: () => void; onApply: (event: string) => void }) {
  // Mounted only while open, so each opening starts from what is applied now.
  return open ? <EventSheetBody current={current} onClose={onClose} onApply={onApply} /> : null;
}

function EventSheetBody({ current, onClose, onApply }: { current: string; onClose: () => void; onApply: (event: string) => void }) {
  const t = useTranslations();
  const h = useTranslations("history");
  const [draft, setDraft] = useState(current);

  return (
    <Sheet
      open
      onClose={onClose}
      title={h("showEvents")}
      footer={<Button onClick={() => onApply(draft)}>{h("showResults")}</Button>}
    >
      <div className={styles.sheetScroll}>
        <div className={styles.pills} role="radiogroup" aria-label={h("allEvents")}>
          <EventOptions values={[""]} labels={{ "": h("allEvents") }} draft={draft} onPick={setDraft} />
        </div>
        {EVENT_GROUPS.map((group) => (
          <div key={group.key}>
            <p className={styles.label} style={{ marginBlockEnd: 6 }}>
              {h(`group.${group.key}`)}
            </p>
            <div className={styles.pills} role="radiogroup" aria-label={h(`group.${group.key}`)}>
              <EventOptions values={group.events} labels={Object.fromEntries(group.events.map((event) => [event, eventName(event, t as never)]))} draft={draft} onPick={setDraft} />
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/** The radios of one group: arrow keys, Home and End move the choice (one Tab stop per group). */
function EventOptions({ values, labels, draft, onPick }: { values: readonly string[]; labels: Record<string, string>; draft: string; onPick: (value: string) => void }) {
  const item = useRovingRadio<string>(values, draft, onPick);
  return (
    <>
      {values.map((value) => {
        const on = draft === value;
        return (
          <button key={value || "all"} type="button" role="radio" aria-checked={on} className={`${styles.option} ${on ? styles.optionOn : ""}`} {...item(value)} onClick={() => onPick(value)}>
            {on ? <CheckIcon width={14} height={14} /> : null}
            {labels[value]}
          </button>
        );
      })}
    </>
  );
}

type People = { k: "idle" } | { k: "loading" } | { k: "error" } | { k: "ready"; members: StaffMember[] };
type PersonProps = { current: string; meId: string; onClose: () => void; onApply: (person: { id: string; name: string } | null) => void };

function PersonSheet({ open, ...props }: PersonProps & { open: boolean }) {
  const [people, setPeople] = useState<People>({ k: "idle" });
  const [attempt, setAttempt] = useState(0);
  const loaded = people.k === "ready";

  // The people come from the employee list, loaded the first time the sheet opens.
  useEffect(() => {
    if (!open || loaded) return;
    const controller = new AbortController();
    api.get<StaffList>("/staff", { signal: controller.signal }).then(
      (list) => setPeople({ k: "ready", members: list.members }),
      () => {
        if (!controller.signal.aborted) setPeople({ k: "error" });
      },
    );
    return () => controller.abort();
  }, [open, loaded, attempt]);

  if (!open) return null;
  return (
    <PersonSheetBody
      {...props}
      people={people}
      onRetry={() => {
        setPeople({ k: "loading" });
        setAttempt((n) => n + 1);
      }}
    />
  );
}

function PersonSheetBody({ current, meId, onClose, onApply, people, onRetry }: PersonProps & { people: People; onRetry: () => void }) {
  const t = useTranslations();
  const h = useTranslations("history");
  // Mounted only while open, so each opening starts from what is applied now.
  const [draft, setDraft] = useState(current);

  const members = people.k === "ready" ? people.members : [];
  const chosen = members.find((member) => member.user_id === draft);
  const item = useRovingRadio<string>(["", ...members.map((member) => member.user_id)], draft, setDraft);

  return (
    <Sheet
      open
      onClose={onClose}
      title={h("showEntriesBy")}
      footer={<Button onClick={() => onApply(chosen ? { id: chosen.user_id, name: chosen.name } : null)}>{h("showResults")}</Button>}
    >
      <div className={styles.sheetScroll}>
        {people.k === "error" ? (
          <>
            <Banner tone="bad" icon="alert" alert>
              {h("loadError.text")}
            </Banner>
            <Button variant="ghost" onClick={onRetry}>
              {t("ui.retry")}
            </Button>
          </>
        ) : null}
        {people.k === "loading" || people.k === "idle" ? <Loading /> : null}
        {people.k === "ready" ? (
          <div role="radiogroup" aria-label={h("person")}>
            <button type="button" role="radio" aria-checked={draft === ""} className={styles.radioRow} {...item("")} onClick={() => setDraft("")}>
              <span className={`${styles.radio} ${draft === "" ? styles.radioOn : ""}`} aria-hidden="true" />
              <span className={styles.name}>{h("everyone")}</span>
            </button>
            {members.map((member) => {
              const on = draft === member.user_id;
              return (
                <button key={member.user_id} type="button" role="radio" aria-checked={on} className={styles.radioRow} {...item(member.user_id)} onClick={() => setDraft(member.user_id)}>
                  <span className={`${styles.radio} ${on ? styles.radioOn : ""}`} aria-hidden="true" />
                  <span className={styles.name} style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span>{member.name}</span>
                    {member.user_id === meId ? <Chip>{h("you")}</Chip> : null}
                    {member.status === "inactive" ? (
                      <Chip>
                        <BanIcon width={14} height={14} />
                        {h("inactive")}
                      </Chip>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <p className={styles.small}>{h("personNote")}</p>
      </div>
    </Sheet>
  );
}
