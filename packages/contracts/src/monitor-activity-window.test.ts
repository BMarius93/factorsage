import { describe, expect, it } from "vitest";
import {
  MONITOR_ACTIVITY_WINDOW_DAYS,
  monitorActivityWindowStart,
} from "./monitors.js";

/**
 * The Monitor activity window is thirty **calendar** days ending at the newest finalized session
 * (`docs/decisions/monitor-eod-v2.md` §12) — never thirty trading sessions. Weekends and holidays
 * are days of the window; they simply hold no session.
 */
describe("monitorActivityWindowStart", () => {
  it("is the latest day and the 29 calendar days before it", () => {
    expect(MONITOR_ACTIVITY_WINDOW_DAYS).toBe(30);
    expect(monitorActivityWindowStart("2026-10-14")).toBe("2026-09-15");
  });

  it("holds exactly 30 calendar dates, inclusive: Oct 23 → Sep 24, and Sep 23 is outside", () => {
    const start = monitorActivityWindowStart("2026-10-23");
    expect(start).toBe("2026-09-24");
    const days: string[] = [];
    for (
      let cursor = new Date(`${start}T00:00:00.000Z`);
      cursor.toISOString().slice(0, 10) <= "2026-10-23";
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      days.push(cursor.toISOString().slice(0, 10));
    }
    expect(days).toHaveLength(30);
    expect(days[0]).toBe("2026-09-24");
    expect(days.at(-1)).toBe("2026-10-23");
    // The day before the oldest included date is the newest excluded one.
    expect("2026-09-23" < start).toBe(true);
  });

  it("advances one calendar day per day the newest session moves", () => {
    expect(monitorActivityWindowStart("2026-10-26")).toBe("2026-09-27");
    // Friday Oct 23 → Monday Oct 26: three calendar days, the start moves by three.
    expect(
      Date.parse(monitorActivityWindowStart("2026-10-26")) -
        Date.parse(monitorActivityWindowStart("2026-10-23")),
    ).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("counts weekends and holidays as days, so a Monday window starts on a Sunday", () => {
    // Monday Oct 12 → Sunday Sep 13: about 21 trading sessions, never 30.
    expect(monitorActivityWindowStart("2026-10-12")).toBe("2026-09-13");
    // After Thanksgiving week: still 30 calendar days.
    expect(monitorActivityWindowStart("2026-11-30")).toBe("2026-11-01");
  });

  it("crosses months, years and leap days", () => {
    expect(monitorActivityWindowStart("2026-01-15")).toBe("2025-12-17");
    expect(monitorActivityWindowStart("2024-03-15")).toBe("2024-02-15");
    expect(monitorActivityWindowStart("2023-03-15")).toBe("2023-02-14");
  });

  it("refuses a date that is not a calendar day", () => {
    expect(() => monitorActivityWindowStart("2026-02-31")).toThrow();
  });
});
