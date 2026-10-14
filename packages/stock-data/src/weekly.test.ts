import type { DailyPrice, LocalDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import { buildDailyDerivedState } from "./derived-state.js";
import {
  aggregateCompletedWeeks,
  completedWeeklyBarLookup,
  latestCompletedWeeklyBar,
  type WeeklyPrice,
} from "./weekly.js";

/**
 * `completedWeeklyBarLookup` answers the daily materializer's "which completed week is effective on
 * this day?" for a whole history at once. `latestCompletedWeeklyBar` is the definition it must
 * agree with: these cases hold the two to each other on every date of real and degenerate
 * histories, and hold the cost to what makes the lookup worth having.
 */

const SECURITY = "security-weekly";

/** A deterministic value in [0, 1) for one index: a fixture's own noise, never `Math.random`. */
function noise(index: number): number {
  const value = Math.sin(index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** Weekday sessions from `from`, with roughly one in forty removed as a holiday or a gap. */
function sessions(from: LocalDate, count: number): DailyPrice[] {
  const rows: DailyPrice[] = [];
  let date = from;
  let considered = 0;
  while (rows.length < count) {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) {
      considered += 1;
      if (noise(considered) > 0.025) {
        const close = 50 + rows.length * 0.01 + 4 * Math.sin(rows.length / 13);
        rows.push({
          securityId: SECURITY,
          date,
          open: close,
          high: close + 1,
          low: close - 1,
          close,
          volume: 1_000_000 + (rows.length % 11) * 10_000,
        });
      }
    }
    date = addDays(date, 1);
  }
  return rows;
}

function everyDay(from: LocalDate, to: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function weeklyBar(
  weekStartDate: LocalDate,
  eligibleDate: LocalDate,
  close: number,
): WeeklyPrice {
  return {
    securityId: SECURITY,
    weekStartDate,
    weekEndDate: eligibleDate,
    eligibleDate,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  };
}

describe("completedWeeklyBarLookup", () => {
  // A Wednesday listing, eight years of sessions with holidays and gaps, and a partial last week.
  const prices = sessions("2015-03-04", 2_000);
  const lastDate = prices[prices.length - 1]!.date;
  const bars = aggregateCompletedWeeks(prices, lastDate, {
    historyStart: prices[0]!.date,
    historyStartOrigin: "LISTING",
  });

  it("returns the very bar the definition returns, on every calendar day of a real history", () => {
    expect(bars.length).toBeGreaterThan(400);
    const lookup = completedWeeklyBarLookup(bars);
    // From before the listing to after the last bar, weekends and holidays included: a trading day
    // is not the only date the materializer can be asked about.
    for (const date of everyDay("2015-02-20", addDays(lastDate, 14))) {
      expect(lookup(date), date).toBe(latestCompletedWeeklyBar(bars, date));
    }
    // Before the first completed week there is honestly none.
    expect(lookup(prices[0]!.date)).toBeUndefined();
    expect(lookup(bars[0]!.eligibleDate)).toBe(bars[0]);
    expect(lookup(addDays(bars[0]!.eligibleDate, -1))).toBeUndefined();
  });

  it("does not depend on the order the bars are given in", () => {
    // Deterministically shuffled: the definition sorts, so the lookup must too.
    const shuffled = bars
      .map((bar, index) => ({ bar, key: noise(index + 1) }))
      .sort((left, right) => left.key - right.key)
      .map(({ bar }) => bar);
    expect(shuffled[0]).not.toBe(bars[0]);
    const lookup = completedWeeklyBarLookup(shuffled);
    for (const date of everyDay("2015-02-20", addDays(lastDate, 14))) {
      expect(lookup(date), date).toBe(latestCompletedWeeklyBar(shuffled, date));
    }
  });

  it("returns the same one of several bars sharing an eligible date as the definition does", () => {
    // Not a shape production creates — a week has one bar — but the definition has an answer for
    // it, and an equivalent must give the same one rather than merely a bar of the right date.
    const tied = [
      weeklyBar("2026-01-05", "2026-01-09", 1),
      weeklyBar("2026-01-12", "2026-01-16", 2),
      weeklyBar("2026-01-12", "2026-01-16", 3),
      weeklyBar("2026-01-12", "2026-01-16", 4),
      weeklyBar("2026-01-19", "2026-01-23", 5),
      weeklyBar("2026-01-05", "2026-01-09", 6),
    ];
    const lookup = completedWeeklyBarLookup(tied);
    for (const date of everyDay("2026-01-01", "2026-01-31")) {
      const expected = latestCompletedWeeklyBar(tied, date);
      expect(lookup(date), date).toBe(expected);
    }
    expect(lookup("2026-01-16")?.close).toBe(2);
    expect(lookup("2026-01-10")?.close).toBe(1);
  });

  it("answers nothing for no bars, and leaves the bars it was given untouched", () => {
    expect(completedWeeklyBarLookup([])("2026-01-09")).toBeUndefined();
    const given = [
      weeklyBar("2026-01-12", "2026-01-16", 2),
      weeklyBar("2026-01-05", "2026-01-09", 1),
    ];
    const before = [...given];
    completedWeeklyBarLookup(given)("2026-01-20");
    expect(given).toEqual(before);
    expect(given[0]).toBe(before[0]);
  });

  it("carries the definition's week onto every row the daily materializer builds", () => {
    const rows = buildDailyDerivedState({ prices, weeklyBars: bars });
    expect(rows).toHaveLength(prices.length);
    for (const row of rows) {
      expect(row.weeklySourceWeekStart, row.date).toBe(
        latestCompletedWeeklyBar(bars, row.date)?.weekStartDate,
      );
    }
    // And it did carry weeks: a history this long has a week behind almost every row.
    expect(
      rows.filter((row) => row.weeklySourceWeekStart !== undefined).length,
    ).toBeGreaterThan(prices.length - 10);
  });

  it("costs the days times the logarithm of the weeks, not the days times the weeks", () => {
    // Thirty-four years: the length of the oldest ETF history a Strategy Condition reads, which is
    // computed per backtest run and per Monitor cycle rather than once at hydration.
    const long = sessions("1993-01-29", 8_600);
    const end = long[long.length - 1]!.date;
    const weeks = aggregateCompletedWeeks(long, end, {
      historyStart: long[0]!.date,
      historyStartOrigin: "LISTING",
    });
    // Every read of a bar's eligible date is counted: the one thing both algorithms must do.
    let reads = 0;
    const counted = weeks.map(
      (bar) =>
        new Proxy(bar, {
          get(target, property, receiver) {
            if (property === "eligibleDate") {
              reads += 1;
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
    );
    const lookup = completedWeeklyBarLookup(counted);
    const answers = long.map((price) => lookup(price.date));
    expect(answers[answers.length - 1]?.eligibleDate).toBe(
      weeks[weeks.length - 1]!.eligibleDate,
    );
    // Filtering every bar for every day reads at least days x weeks: fifteen million here.
    expect(long.length * weeks.length).toBeGreaterThan(15_000_000);
    // One ordering plus a binary search a day stays under a thirtieth of that.
    expect(reads).toBeLessThan(500_000);
  });
});
