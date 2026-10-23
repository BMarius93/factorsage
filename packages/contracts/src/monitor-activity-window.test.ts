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
