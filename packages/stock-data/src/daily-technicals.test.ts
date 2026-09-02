import {
  DAILY_MOVING_AVERAGES,
  WEEKLY_MOVING_AVERAGES,
  type DailyPrice,
  type LocalDate,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import { referenceMovingAverage } from "./moving-average-oracle.test-helper.js";
import { calculateDailyTechnicals, movingAverage } from "./technicals.js";

const SECURITY_ID = "security-daily";

/** Deterministic close for the `index`-th trading day; no randomness, no date dependence. */
function closeAt(index: number): number {
  return 100 + (index % 37) * 0.5 + index * 0.1;
}

function bar(date: LocalDate, close: number): DailyPrice {
  return {
    securityId: SECURITY_ID,
    date,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1_000,
  };
}

/** `weeks` consecutive Monday-Friday weeks starting on `startMonday`. */
function tradingDays(startMonday: LocalDate, weeks: number): DailyPrice[] {
  const rows: DailyPrice[] = [];
  for (let week = 0; week < weeks; week += 1) {
    for (let day = 0; day < 5; day += 1) {
      rows.push(
        bar(addDays(startMonday, week * 7 + day), closeAt(rows.length)),
      );
    }
  }
  return rows;
}

// 2020-01-06 is a Monday. 260 weeks is 1300 trading days, warming every daily period incl. 200D.
const START_MONDAY = "2020-01-06";
const WEEKS = 260;
const PRICES = tradingDays(START_MONDAY, WEEKS);
const CLOSES = PRICES.map((row) => row.close);
const ROWS = calculateDailyTechnicals(PRICES);
const LAST_ROW = ROWS.at(-1)!;

/**
 * Characterization of the daily moving-average calculator.
 *
 * This suite is the safety net for making the calculator registry-driven: it pins the exact
 * numeric output of the current implementation, the warm-up boundary of every registered period,
 * and the exact field set of a materialized row. A refactor that changes which series are produced,
 * shifts a warm-up boundary by one bar, or perturbs the arithmetic fails here.
 */
describe("daily moving averages", () => {
  it("runs its registry-driven cases over a non-empty registry", () => {
    // Guards the `it.each` and `for` loops below: an emptied registry would make them pass
    // vacuously by generating no cases at all.
    expect(DAILY_MOVING_AVERAGES.length).toBeGreaterThan(0);
    expect(ROWS.length).toBeGreaterThan(
      Math.max(...DAILY_MOVING_AVERAGES.map((average) => average.period)),
    );
  });

  it.each(DAILY_MOVING_AVERAGES)(
    "calculates $type $period over daily closes with the documented warm-up",
    (average) => {
      const expected = referenceMovingAverage(
        CLOSES,
        average.type,
        average.period,
      );

      ROWS.forEach((row, index) => {
        const actual = row[average.field];
        if (index < average.period - 1) {
          // Warm-up: absent, never zero and never a shorter-period substitute.
          expect(actual).toBeUndefined();
        } else {
          expect(actual).toBeCloseTo(expected[index]!, 9);
        }
      });
    },
  );

  it("produces every registered daily moving average and nothing else", () => {
    // The row carries its identity plus exactly the registered daily fields. A weekly field
    // appearing here would mean the daily calculator had started inventing carried-forward state,
    // which belongs to `buildDailyDerivedState` instead.
    expect(Object.keys(LAST_ROW).sort()).toEqual(
      ["securityId", "date", ...DAILY_MOVING_AVERAGES.map((a) => a.field)].sort(),
    );
    for (const weekly of WEEKLY_MOVING_AVERAGES) {
      expect(LAST_ROW).not.toHaveProperty(weekly.field);
    }
    expect(LAST_ROW).not.toHaveProperty("weeklySourceWeekStart");
    expect(LAST_ROW).not.toHaveProperty("intrinsicValues");
  });

  it("keeps the exact values the current methodology materializes", () => {
    // Literals captured from the shipped implementation, so a refactor that silently changes the
    // arithmetic (summation order, seeding, rounding) is caught bit for bit rather than within a
    // tolerance the oracle comparison above would absorb.
    expect(LAST_ROW).toEqual({
      securityId: SECURITY_ID,
      date: "2024-12-27",
      sma20d: 240.075,
      sma50d: 236.81000000000026,
      sma100d: 234.39,
      sma200d: 229.08749999999998,
      ema20d: 237.69956913192334,
      ema50d: 236.8089759117156,
      ema200d: 229.1012884623138,
    });
  });

  it("first materializes each period exactly on its warm-up boundary", () => {
    for (const average of DAILY_MOVING_AVERAGES) {
      expect(ROWS[average.period - 2]?.[average.field]).toBeUndefined();
      expect(ROWS[average.period - 1]?.[average.field]).toBeDefined();
    }
    // The seed day of an EMA is its SMA, which is what the documented convention fixes.
    expect(ROWS[19]).toEqual({
      securityId: SECURITY_ID,
      date: "2020-01-31",
      sma20d: 105.7,
      ema20d: 105.7,
    });
  });

  it("leaves a row with no warmed-up period carrying identity only", () => {
    expect(ROWS[0]).toEqual({ securityId: SECURITY_ID, date: START_MONDAY });
    // Absent is absent: never zero, never null, never a shorter period standing in.
    for (const average of DAILY_MOVING_AVERAGES) {
      expect(ROWS[0]).not.toHaveProperty(average.field);
      expect(Object.values(ROWS[0]!)).not.toContain(0);
    }
    expect(JSON.stringify(ROWS[0])).not.toContain("null");
  });

  it("is independent of input ordering", () => {
    const shuffled = [
      ...PRICES.filter((_, index) => index % 3 === 2),
      ...PRICES.filter((_, index) => index % 3 === 0),
      ...PRICES.filter((_, index) => index % 3 === 1),
    ];
    expect(calculateDailyTechnicals(shuffled)).toEqual(ROWS);
  });

  it("never looks ahead: a prefix of history yields the same values for its own days", () => {
    // Truncating the future must not change any already-materialized day. This is the
    // point-in-time property the backtest relies on, expressed without reimplementing the
    // calculator: today's value can only depend on today and earlier.
    const cutoff = 900;
    const prefixRows = calculateDailyTechnicals(PRICES.slice(0, cutoff));

    expect(prefixRows).toHaveLength(cutoff);
    expect(prefixRows).toEqual(ROWS.slice(0, cutoff));
  });

  it("rejects a non-positive or fractional period rather than inventing a window", () => {
    // A programming error, not a financial outcome, so it throws instead of returning absence.
    expect(() => movingAverage([1, 2, 3], "SMA", 0)).toThrow(
      "Moving-average period must be a positive integer",
    );
    expect(() => movingAverage([1, 2, 3], "SMA", 1.5)).toThrow(
      "Moving-average period must be a positive integer",
    );
  });
});
