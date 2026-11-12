import { afterEach, describe, expect, it } from "vitest";

import { beirutDayKey, daysAgo, formatBeirutDate, formatClock, formatDateTime, formatWeekdayDate } from "@/lib/time";

// 2026-11-11 22:30 UTC is 00:30 on 12 November in Beirut (UTC+2 in November) and still the 11th in
// New York (17:30), so a formatter that used the phone's zone would get the date wrong in one place.
const LATE = "2026-11-11T22:30:00Z";
const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const ZONES = ["UTC", "America/New_York", "Pacific/Auckland", "Asia/Tokyo", "Asia/Beirut"];

describe("Beirut time (FR-030)", () => {
  it.each(ZONES)("shows the same Beirut time on a phone set to %s", (zone) => {
    process.env.TZ = zone;
    expect(formatClock(LATE, "en")).toBe("00:30");
    expect(formatBeirutDate(LATE, "en")).toBe("12 Nov 2026");
    expect(formatDateTime(LATE, "en")).toBe("12 Nov 2026, 00:30");
    expect(formatWeekdayDate(LATE, "en")).toBe("Thu 12 Nov");
    expect(beirutDayKey(LATE)).toBe("2026-11-12");
  });

  it("writes Arabic with Arabic month and day names but Latin digits", () => {
    expect(formatDateTime("2026-11-03T17:40:00Z", "ar")).toBe("3 تشرين الثاني 2026، 19:40");
    expect(formatWeekdayDate("2026-11-12T08:00:00Z", "ar")).toBe("الخميس 12 تشرين الثاني");
    expect(formatClock("2026-11-12T07:41:00Z", "ar")).toBe("09:41");
  });

  it("uses the 24-hour clock, never a 12-hour one", () => {
    expect(formatClock("2026-11-12T15:05:00Z", "en")).toBe("17:05");
  });

  it("moves with Beirut's daylight saving time (UTC+3 in summer)", () => {
    expect(formatClock("2026-07-01T12:00:00Z", "en")).toBe("15:00");
  });

  it("counts days in Beirut, not on the phone", () => {
    process.env.TZ = "America/New_York";
    const now = new Date("2026-11-12T10:00:00Z");
    expect(daysAgo(LATE, now)).toBe(0);
    expect(daysAgo("2026-11-11T09:00:00Z", now)).toBe(1);
    expect(daysAgo("2026-11-10T09:00:00Z", now)).toBe(2);
  });

  it("returns what it was given when it is not a date", () => {
    expect(formatClock("not a date", "en")).toBe("not a date");
    expect(formatDateTime("", "en")).toBe("");
  });
});
