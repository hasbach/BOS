// Every time BOS shows is Beirut time, whatever time zone the phone is set to (FR-030). All the
// screens format through this file, so there is exactly one place that names the zone. Digits are
// always Latin (research R36), in Arabic too.

export const BEIRUT_TIME_ZONE = "Asia/Beirut";

// "ar-LB" carries the Levantine month names the approved designs use (تشرين الثاني).
const intlLocale = (locale: string) => (locale === "ar" ? "ar-LB-u-nu-latn" : "en-GB");

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: BEIRUT_TIME_ZONE });
    cache.set(key, found);
  }
  return found;
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "19:40": the 24-hour clock in Beirut. */
export function formatClock(iso: string, locale: string): string {
  const date = parse(iso);
  if (!date) return iso;
  return formatter(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/** "3 Nov 2026": the calendar date in Beirut. */
export function formatBeirutDate(iso: string, locale: string): string {
  const date = parse(iso);
  if (!date) return iso;
  return formatter(locale, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

/** "3 Nov 2026, 19:40" (Arabic uses its own comma). */
export function formatDateTime(iso: string, locale: string): string {
  if (!parse(iso)) return iso;
  return `${formatBeirutDate(iso, locale)}${locale === "ar" ? "، " : ", "}${formatClock(iso, locale)}`;
}

/** "Thu 12 Nov" / "الخميس 12 تشرين الثاني": weekday, day and month in Beirut. */
export function formatWeekdayDate(iso: string, locale: string): string {
  const date = parse(iso);
  if (!date) return iso;
  const text = formatter(locale, { weekday: locale === "ar" ? "long" : "short", day: "numeric", month: "short" }).format(date);
  return locale === "ar" ? text.replace(/،\s*/, " ") : text.replace(",", "");
}

/** The calendar day in Beirut as "2026-11-12", for grouping entries by day. */
export function beirutDayKey(iso: string): string {
  const date = parse(iso);
  if (!date) return iso;
  // en-CA prints year-month-day with Latin digits.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BEIRUT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 0 for a time that falls on today in Beirut, 1 for yesterday, and so on. */
export function daysAgo(iso: string, now: Date = new Date()): number {
  const day = Date.parse(`${beirutDayKey(iso)}T00:00:00Z`);
  const today = Date.parse(`${beirutDayKey(now.toISOString())}T00:00:00Z`);
  if (Number.isNaN(day)) return Number.NaN;
  return Math.round((today - day) / 86_400_000);
}
