import {
  WEEKLY_MOVING_AVERAGES,
  type DailyPrice,
  type LocalDate,
  type MovingAverageType,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import { buildDailyDerivedState } from "./derived-state.js";
import { calculateDailyTechnicals } from "./technicals.js";
import {
  aggregateCompletedWeeks,
  calculateWeeklyTechnicalValues,
  startOfIsoWeek,
} from "./weekly.js";

const SECURITY_ID = "security-weekly";

/**
 * Independent reference implementation of the product's moving averages.
 *
 * Deliberately naive and written from the documented convention rather than reusing
 * `movingAverage`: comparing the production function with itself would lock in whatever it does.
 * The EMA seed is the simple average of the first `period` values, matching the convention the
 * daily indicators were locked to.
 */
function referenceMovingAverage(
  values: readonly number[],
  type: MovingAverageType,
  period: number,
): Array<number | undefined> {
  const out: Array<number | undefined> = values.map(() => undefined);
  for (let index = period - 1; index < values.length; index += 1) {
    let sum = 0;
    for (let back = 0; back < period; back += 1) {
      sum += values[index - back]!;
    }
    out[index] = sum / period;
  }
  if (type === "SMA") {
    return out;
  }
  const multiplier = 2 / (period + 1);
  let previous = out[period - 1];
  for (let index = period; index < values.length; index += 1) {
    previous = (values[index]! - previous!) * multiplier + previous!;
    out[index] = previous;
  }
  return out;
}

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

// 2020-01-06 is a Monday. 260 full weeks warm every catalog period including SMA/EMA 200W.
const START_MONDAY = "2020-01-06";
const WEEKS = 260;
const PRICES = tradingDays(START_MONDAY, WEEKS);
const LAST_DAY = PRICES.at(-1)!.date;
// Every week is complete once `asOf` is in a later ISO week than the final bar.
const AS_OF = addDays(LAST_DAY, 3);
const WEEKLY_BARS = aggregateCompletedWeeks(PRICES, AS_OF);
const WEEKLY_CLOSES = WEEKLY_BARS.map((week) => week.close);

describe("weekly moving averages", () => {
  it("aggregates one completed weekly bar per week, closing on the week's last trading day", () => {
    expect(WEEKLY_BARS).toHaveLength(WEEKS);
    expect(WEEKLY_BARS[0]?.weekStartDate).toBe(START_MONDAY);
    expect(WEEKLY_BARS[0]?.weekEndDate).toBe(addDays(START_MONDAY, 4));
    expect(WEEKLY_CLOSES[0]).toBe(closeAt(4));
    expect(WEEKLY_CLOSES[1]).toBe(closeAt(9));
  });

  it.each(WEEKLY_MOVING_AVERAGES)(
    "calculates $type $period over weekly closes with the documented warm-up",
    (average) => {
      const values = calculateWeeklyTechnicalValues(WEEKLY_BARS);
      const expected = referenceMovingAverage(
        WEEKLY_CLOSES,
        average.type,
        average.period,
      );

      WEEKLY_BARS.forEach((week, index) => {
        const actual = values.get(week.weekStartDate)?.[average.field];
        if (index < average.period - 1) {
          // Warm-up: absent, never zero and never a shorter-period substitute.
          expect(actual).toBeUndefined();
        } else {
          expect(actual).toBeCloseTo(expected[index]!, 9);
        }
      });
    },
  );

  it("matches a hand-computable golden value for a 20-week simple average", () => {
    // Weekly closes 1..25, so the 20-week average on the 20th week is (1+...+20)/20 = 10.5 and on
    // the 25th week is (6+...+25)/20 = 15.5.
    const weeks = Array.from({ length: 25 }, (_, index) =>
      Array.from({ length: 5 }, (_unused, day) =>
        bar(addDays(START_MONDAY, index * 7 + day), index + 1),
      ),
    ).flat();
    const values = calculateWeeklyTechnicalValues(
      aggregateCompletedWeeks(weeks, addDays(START_MONDAY, 25 * 7)),
    );

    expect(values.get(addDays(START_MONDAY, 19 * 7))?.sma20w).toBeCloseTo(
      10.5,
      10,
    );
    expect(values.get(addDays(START_MONDAY, 24 * 7))?.sma20w).toBeCloseTo(
      15.5,
      10,
    );
  });

  it("never averages daily moving averages", () => {
    const dailyRows = calculateDailyTechnicals(PRICES);
    const weeklyValues = calculateWeeklyTechnicalValues(WEEKLY_BARS);

    // SMA(20, 1W) spans 20 weekly closes (about 100 trading days); the mean of the trailing
    // twenty SMA(20, 1D) readings spans far less history, so the two must not coincide.
    const week = WEEKLY_BARS[100]!;
    const weekly = weeklyValues.get(week.weekStartDate)?.sma20w;
    const endIndex = dailyRows.findIndex(
      (row) => row.date === week.weekEndDate,
    );
    const trailingDaily = dailyRows
      .slice(endIndex - 19, endIndex + 1)
      .map((row) => row.sma20d!);
    const averageOfDaily =
      trailingDaily.reduce((sum, value) => sum + value, 0) /
      trailingDaily.length;

    expect(weekly).toBeDefined();
    expect(weekly).not.toBeCloseTo(averageOfDaily, 3);
    expect(weekly).toBeCloseTo(
      referenceMovingAverage(WEEKLY_CLOSES, "SMA", 20)[100]!,
      9,
    );
  });

  it("excludes the still-running ISO week from every weekly value", () => {
    const midWeek = addDays(LAST_DAY, -2); // Wednesday of the final week.
    const partial = aggregateCompletedWeeks(PRICES, midWeek);

    expect(partial).toHaveLength(WEEKS - 1);
    expect(partial.at(-1)?.weekStartDate).toBe(
      startOfIsoWeek(addDays(midWeek, -7)),
    );
    // The in-progress week contributes no bar, so no indicator can depend on its close.
    expect(
      partial.some((week) => week.weekStartDate === startOfIsoWeek(midWeek)),
    ).toBe(false);
  });

  it("keeps a genuine IPO week that starts mid-week and drops only a horizon-truncated one", () => {
    // The first observed week runs Wednesday-Friday.
    const partialFirstWeek = [
      bar("2020-01-08", 10),
      bar("2020-01-09", 11),
      bar("2020-01-10", 12),
      ...tradingDays("2020-01-13", 3),
    ];

    const listing = aggregateCompletedWeeks(partialFirstWeek, "2020-02-10", {
      historyStart: "2020-01-08",
      historyStartOrigin: "LISTING",
    });
    expect(listing[0]).toMatchObject({
      weekStartDate: "2020-01-06",
      weekEndDate: "2020-01-10",
      open: 9,
      close: 12,
    });

    const horizon = aggregateCompletedWeeks(partialFirstWeek, "2020-02-10", {
      historyStart: "2020-01-08",
      historyStartOrigin: "HORIZON",
    });
    expect(horizon.map((week) => week.weekStartDate)).not.toContain(
      "2020-01-06",
    );

    // Dropping the artificial week shifts every warm-up by one bar, so the two histories must not
    // silently produce the same indicator values.
    const listingValues = calculateWeeklyTechnicalValues(listing);
    const horizonValues = calculateWeeklyTechnicalValues(horizon);
    expect(listingValues.size).toBe(horizonValues.size + 1);
  });
});

describe("weekly values carried onto the daily derived state", () => {
  const rows = buildDailyDerivedState({
    prices: PRICES,
    weeklyBars: WEEKLY_BARS,
  });
  const byDate = new Map(rows.map((row) => [row.date, row]));

  it("first materializes a weekly value on the final trading day of its completing week", () => {
    // SMA 20W needs twenty completed weekly bars; the twentieth week ends on trading day 99.
    const completingWeek = WEEKLY_BARS[19]!;
    const dayBefore = byDate.get(addDays(completingWeek.weekEndDate, -1));
    const eligibleDay = byDate.get(completingWeek.weekEndDate);

    expect(dayBefore?.sma20w).toBeUndefined();
    expect(eligibleDay?.sma20w).toBeCloseTo(
      referenceMovingAverage(WEEKLY_CLOSES, "SMA", 20)[19]!,
      9,
    );
    expect(eligibleDay?.weeklySourceWeekStart).toBe(
      completingWeek.weekStartDate,
    );
  });

  it("carries the value forward daily and replaces it only when a newer week completes", () => {
    const source = WEEKLY_BARS[100]!;
    const next = WEEKLY_BARS[101]!;
    const expected = byDate.get(source.weekEndDate)?.sma50w;

    expect(expected).toBeDefined();
    // Monday through Thursday of the following week repeat the completed week's value.
    for (let offset = 3; offset <= 6; offset += 1) {
      const day = byDate.get(addDays(source.weekEndDate, offset));
      expect(day?.sma50w).toBe(expected);
      expect(day?.weeklySourceWeekStart).toBe(source.weekStartDate);
    }
    // The newer week's own final trading day replaces it.
    const replacement = byDate.get(next.weekEndDate);
    expect(replacement?.weeklySourceWeekStart).toBe(next.weekStartDate);
    expect(replacement?.sma50w).not.toBe(expected);
  });

  it("never leaks the week-ending close into earlier days of the same week", () => {
    const week = WEEKLY_BARS[150]!;
    const ownValue = byDate.get(week.weekEndDate)?.ema20w;
    expect(ownValue).toBeDefined();

    for (let offset = 1; offset <= 4; offset += 1) {
      const earlier = byDate.get(addDays(week.weekStartDate, offset - 1));
      expect(earlier?.ema20w).not.toBe(ownValue);
      expect(earlier?.weeklySourceWeekStart).toBe(
        WEEKLY_BARS[149]!.weekStartDate,
      );
    }
  });

  it("leaves every weekly field absent, never zero, during warm-up", () => {
    const early = byDate.get(WEEKLY_BARS[0]!.weekEndDate)!;
    for (const average of WEEKLY_MOVING_AVERAGES) {
      expect(early[average.field]).toBeUndefined();
    }
    // A completed week already exists on that day, so a present week start with absent values is
    // exactly the "not warmed up yet" state and must not be read as zero.
    expect(early.weeklySourceWeekStart).toBe(WEEKLY_BARS[0]!.weekStartDate);

    const warmedFor20Only = byDate.get(WEEKLY_BARS[25]!.weekEndDate)!;
    expect(warmedFor20Only.sma20w).toBeDefined();
    expect(warmedFor20Only.sma50w).toBeUndefined();
    expect(warmedFor20Only.sma100w).toBeUndefined();
    expect(warmedFor20Only.sma200w).toBeUndefined();
  });

  it("carries a holiday-shortened week from its actual final trading day", () => {
    // Drop the Friday of week 30; Thursday becomes its final trading day.
    const holidayDate = WEEKLY_BARS[30]!.weekEndDate;
    const prices = PRICES.filter((row) => row.date !== holidayDate);
    const shortenedBars = aggregateCompletedWeeks(prices, AS_OF);
    const shortened = buildDailyDerivedState({
      prices,
      weeklyBars: shortenedBars,
    });
    const shortenedByDate = new Map(shortened.map((row) => [row.date, row]));

    const thursday = addDays(holidayDate, -1);
    const week = shortenedBars.find(
      (candidate) => candidate.weekEndDate === thursday,
    );
    expect(week?.eligibleDate).toBe(thursday);
    expect(shortenedByDate.get(thursday)?.weeklySourceWeekStart).toBe(
      week?.weekStartDate,
    );
    expect(shortenedByDate.get(thursday)?.sma20w).toBeDefined();
  });

  it("materializes every catalog weekly field once the history is long enough", () => {
    const last = byDate.get(LAST_DAY)!;
    for (const average of WEEKLY_MOVING_AVERAGES) {
      expect(last[average.field]).toBeDefined();
      expect(last[average.field]).not.toBe(0);
    }
    expect(Object.keys(last).filter((key) => key.endsWith("w"))).toHaveLength(
      WEEKLY_MOVING_AVERAGES.length,
    );
  });
});
