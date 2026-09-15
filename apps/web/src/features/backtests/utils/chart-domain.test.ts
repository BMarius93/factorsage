import { describe, expect, it } from "vitest";
import { cashScenarioSpan, periodCalendarDays } from "./chart-domain";

describe("cashScenarioSpan", () => {
  it("runs from the initial capital to the initial capital plus every contribution", () => {
    // Thirty years of $500 on top of $100,000. This is the one line on a backtest chart whose
    // extent is known before the run, which is what makes it a truthful starting axis.
    expect(
      cashScenarioSpan({
        initialCapital: 100_000,
        monthlyContribution: 500,
        periodStart: "1996-01-01",
        periodEnd: "2026-01-01",
      }),
    ).toEqual({ min: 100_000, max: 280_000 });
  });

  it("counts a month only once its day has been reached", () => {
    expect(
      cashScenarioSpan({
        initialCapital: 10_000,
        monthlyContribution: 100,
        periodStart: "2021-01-15",
        periodEnd: "2021-04-14",
      }),
    ).toEqual({ min: 10_000, max: 10_200 });
    expect(
      cashScenarioSpan({
        initialCapital: 10_000,
        monthlyContribution: 100,
        periodStart: "2021-01-15",
        periodEnd: "2021-04-15",
      }),
    ).toEqual({ min: 10_000, max: 10_300 });
  });

  it("is a flat span when the run has no contributions", () => {
    expect(
      cashScenarioSpan({
        initialCapital: 25_000,
        monthlyContribution: 0,
        periodStart: "2021-01-04",
        periodEnd: "2026-01-02",
      }),
    ).toEqual({ min: 25_000, max: 25_000 });
  });

  it("has nothing to say when there is no capital to say it about", () => {
    // Better no axis hint at all than one invented from a zero: the curves size the axis then.
    expect(
      cashScenarioSpan({
        initialCapital: 0,
        monthlyContribution: 500,
        periodStart: "2021-01-04",
        periodEnd: "2026-01-02",
      }),
    ).toBeNull();
  });
});

describe("periodCalendarDays", () => {
  it("covers the period a day at a time, both ends included", () => {
    expect(periodCalendarDays("2021-01-04", "2021-01-08")).toEqual([
      "2021-01-04",
      "2021-01-05",
      "2021-01-06",
      "2021-01-07",
      "2021-01-08",
    ]);
  });

  it("crosses a leap day and a year boundary without drifting", () => {
    const days = periodCalendarDays("2024-02-27", "2024-03-02");
    expect(days).toEqual([
      "2024-02-27",
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
      "2024-03-02",
    ]);
    // A thirty-year period is about eleven thousand slots, and every one is a distinct day.
    const long = periodCalendarDays("1996-01-01", "2026-01-01");
    expect(long).toHaveLength(10_959);
    expect(new Set(long).size).toBe(long.length);
  });

  it("is a single slot for a one-day period, and nothing for an impossible one", () => {
    expect(periodCalendarDays("2021-01-04", "2021-01-04")).toEqual([
      "2021-01-04",
    ]);
    expect(periodCalendarDays("2026-01-01", "2021-01-01")).toEqual([]);
    expect(periodCalendarDays("", "")).toEqual([]);
  });
});
