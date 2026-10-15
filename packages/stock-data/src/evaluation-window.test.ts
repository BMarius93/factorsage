import { describe, expect, it } from "vitest";
import { monitorWindowCalendarDays } from "./evaluation-window.js";

describe("monitorWindowCalendarDays", () => {
  it("converts sessions at 252 a year, plus a fixed margin, so a long read is never short", () => {
    expect(monitorWindowCalendarDays(0)).toBe(30);
    // A year of sessions spans a calendar year and the margin.
    expect(monitorWindowCalendarDays(252)).toBe(366 + 30);
    // The 1,580 sessions an EMA 200D warm-up needs: generous, not 7/5 of it.
    expect(monitorWindowCalendarDays(1580)).toBeGreaterThan(
      Math.ceil((1580 * 7) / 5),
    );
  });
});
