import {
  WEEKLY_MOVING_AVERAGES,
  type DailyPrice,
  type LocalDate,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import { buildDailyDerivedState } from "./derived-state.js";
import { referenceMovingAverage } from "./moving-average-oracle.test-helper.js";
import { calculateDailyTechnicals } from "./technicals.js";
import {
  aggregateCompletedWeeks,
  calculateWeeklyTechnicalValues,
  startOfIsoWeek,
} from "./weekly.js";

const SECURITY_ID = "security-weekly";

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

  it("produces nothing at all when history is shorter than the shortest period", () => {
    const shortestPeriod = Math.min(
      ...WEEKLY_MOVING_AVERAGES.map((average) => average.period),
    );
    const tooShort = aggregateCompletedWeeks(
      tradingDays(START_MONDAY, shortestPeriod - 1),
      addDays(START_MONDAY, shortestPeriod * 7),
    );
    const values = calculateWeeklyTechnicalValues(tooShort);

    expect(tooShort).toHaveLength(shortestPeriod - 1);
    // A bar exists for every completed week, but no indicator has warmed up on any of them.
    expect(values.size).toBe(shortestPeriod - 1);
    for (const week of tooShort) {
      expect(values.get(week.weekStartDate)).toEqual({});
    }
  });

  it("first materializes each weekly period exactly on its warm-up boundary", () => {
    const values = calculateWeeklyTechnicalValues(WEEKLY_BARS);
    for (const average of WEEKLY_MOVING_AVERAGES) {
      const before = WEEKLY_BARS[average.period - 2]!;
      const boundary = WEEKLY_BARS[average.period - 1]!;
      expect(values.get(before.weekStartDate)?.[average.field]).toBeUndefined();
      expect(values.get(boundary.weekStartDate)?.[average.field]).toBeDefined();
    }
  });

  it("tracks monotonically rising and falling closes without overshooting the window", () => {
    // A simple average of a strictly monotonic series must sit strictly inside the window's
    // endpoints, and must move in the same direction as the series. This is an ordering property,
    // independent of the implementation's arithmetic.
    const rising = tradingDays(START_MONDAY, 40).map((row, index) => ({
      ...row,
      close: 10 + index,
    }));
    const falling = tradingDays(START_MONDAY, 40).map((row, index) => ({
      ...row,
      close: 1_000 - index,
    }));
    const asOf = addDays(START_MONDAY, 41 * 7);

    for (const [prices, direction] of [
      [rising, "rising"],
      [falling, "falling"],
    ] as const) {
      const bars = aggregateCompletedWeeks(prices, asOf);
      const closes = bars.map((week) => week.close);
      const values = calculateWeeklyTechnicalValues(bars);
      const series = bars.flatMap((week) => {
        const value = values.get(week.weekStartDate)?.sma20w;
        return value === undefined ? [] : [value];
      });

      expect(series.length).toBeGreaterThan(1);
      series.forEach((value, index) => {
        const window = closes.slice(index, index + 20);
        expect(value).toBeGreaterThanOrEqual(Math.min(...window));
        expect(value).toBeLessThanOrEqual(Math.max(...window));
      });
      const deltas = series.slice(1).map((value, index) => value - series[index]!);
      for (const delta of deltas) {
        expect(direction === "rising" ? delta : -delta).toBeGreaterThan(0);
      }
    }
  });

  it("aggregates a week with missing trading days from the days that exist", () => {
    // Tuesday and Thursday are absent; the week is still complete and uses its real first/last bar.
    const sparse = [
      bar("2020-01-06", 10),
      bar("2020-01-08", 14),
      bar("2020-01-10", 12),
      ...tradingDays("2020-01-13", 2),
    ];
    const bars = aggregateCompletedWeeks(sparse, "2020-02-03");
    const first = bars[0]!;

    expect(first).toMatchObject({
      weekStartDate: "2020-01-06",
      weekEndDate: "2020-01-10",
      eligibleDate: "2020-01-10",
      close: 12,
    });
    expect(first.high).toBe(16);
    expect(first.low).toBe(8);
  });

  it("keeps a week that spans a calendar-year boundary as one bar", () => {
    // 2020-12-28 is a Monday and that ISO week ends on 2021-01-01.
    const bars = aggregateCompletedWeeks(
      [
        bar("2020-12-28", 50),
        bar("2020-12-29", 51),
        bar("2020-12-30", 52),
        bar("2020-12-31", 53),
        bar("2021-01-01", 54),
        ...tradingDays("2021-01-04", 1),
      ],
      "2021-01-18",
    );

    expect(bars[0]).toMatchObject({
      weekStartDate: "2020-12-28",
      weekEndDate: "2021-01-01",
      eligibleDate: "2021-01-01",
      close: 54,
    });
    expect(bars.map((week) => week.weekStartDate)).toEqual([
      "2020-12-28",
      "2021-01-04",
    ]);
  });

  it("calculates every catalog weekly series simultaneously from one pass", () => {
    const values = calculateWeeklyTechnicalValues(WEEKLY_BARS);
    const warmed = values.get(WEEKLY_BARS.at(-1)!.weekStartDate)!;

    // All seven registered series are present together, each matching its own oracle.
    expect(Object.keys(warmed).sort()).toEqual(
      WEEKLY_MOVING_AVERAGES.map((average) => average.field).sort(),
    );
    for (const average of WEEKLY_MOVING_AVERAGES) {
      expect(warmed[average.field]).toBeCloseTo(
        referenceMovingAverage(
          WEEKLY_CLOSES,
          average.type,
          average.period,
        ).at(-1)!,
        9,
      );
    }
  });

  it("never looks ahead: a prefix of history yields the same weekly values", () => {
    // Truncating later weeks must not change an already-completed week's value.
    const prefixBars = WEEKLY_BARS.slice(0, 210);
    const prefixValues = calculateWeeklyTechnicalValues(prefixBars);
    const fullValues = calculateWeeklyTechnicalValues(WEEKLY_BARS);

    for (const week of prefixBars) {
      expect(prefixValues.get(week.weekStartDate)).toEqual(
        fullValues.get(week.weekStartDate),
      );
    }
  });

  it("is independent of input ordering", () => {
    // Ordering carries no information: the aggregator sorts, so a shuffled feed is the same
    // canonical history.
    const shuffled = [
      ...PRICES.filter((_, index) => index % 3 === 2),
      ...PRICES.filter((_, index) => index % 3 === 0),
      ...PRICES.filter((_, index) => index % 3 === 1),
    ];
    const shuffledBars = aggregateCompletedWeeks(shuffled, AS_OF);

    expect(shuffledBars).toEqual(WEEKLY_BARS);
    expect(calculateWeeklyTechnicalValues(shuffledBars)).toEqual(
      calculateWeeklyTechnicalValues(WEEKLY_BARS),
    );
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
