import {
  DAILY_MOVING_AVERAGES,
  DAILY_OSCILLATORS,
  RSI_VALUE_RANGE,
  type DailyPrice,
  type LocalDate,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import { calculateDailyOscillators, calculateWilderRsi } from "./oscillators.js";
import { referenceWilderRsi } from "./wilder-rsi-oracle.test-helper.js";

const SECURITY_ID = "security-oscillators";

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

/** Monday-Friday trading days carrying the given closes, starting on `startMonday`. */
function tradingDays(startMonday: LocalDate, closes: readonly number[]): DailyPrice[] {
  return closes.map((close, index) =>
    bar(
      addDays(startMonday, Math.floor(index / 5) * 7 + (index % 5)),
      close,
    ),
  );
}

/**
 * The classic Wilder worked example, so the period-14 expectations below are verifiable against
 * independent published material, not just against this repository. The period-7 and period-21
 * expectations were calculated over the same closes with a separate scripted implementation.
 */
const FIXED_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42,
  45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
  46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45,
  45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
] as const;

/** Independently calculated Wilder RSI values for `FIXED_CLOSES`: [index, expected value]. */
const FIXED_EXPECTATIONS: Record<number, readonly (readonly [number, number])[]> = {
  7: [
    [7, 70.30075187969923],
    [8, 74.92063492063494],
    [32, 31.282034303465988],
  ],
  14: [
    [14, 70.46413502109705],
    [15, 66.24961855355507],
    [32, 37.788771982057824],
  ],
  21: [
    [21, 64.02349486049927],
    [22, 59.10261623966382],
    [32, 42.81241207269459],
  ],
};

// 2020-01-06 is a Monday. Long enough for every registered period to warm up with plenty of tail.
const START_MONDAY = "2020-01-06";
/** Deterministic mixed closes: rises and falls interleave, no randomness, no date dependence. */
function mixedCloseAt(index: number): number {
  return 100 + (index % 13) * 0.8 - (index % 5) * 1.1 + index * 0.03;
}
const MIXED_CLOSES = Array.from({ length: 180 }, (_, index) => mixedCloseAt(index));
const MIXED_PRICES = tradingDays(START_MONDAY, MIXED_CLOSES);
const MIXED_ROWS = calculateDailyOscillators(MIXED_PRICES);

describe("calculateWilderRsi", () => {
  it("runs its registry-driven cases over a non-empty registry", () => {
    // Guards the `it.each` and `for` loops below: an emptied registry would make them pass
    // vacuously by generating no cases at all.
    expect(DAILY_OSCILLATORS.length).toBeGreaterThan(0);
    expect(MIXED_CLOSES.length).toBeGreaterThan(
      Math.max(...DAILY_OSCILLATORS.map((oscillator) => oscillator.period)) + 1,
    );
  });

  it.each(DAILY_OSCILLATORS)(
    "first materializes RSI $period exactly once $period + 1 closes exist",
    ({ period }) => {
      // One close short of the warm-up: no value anywhere.
      const short = calculateWilderRsi(MIXED_CLOSES.slice(0, period), period);
      expect(short).toHaveLength(period);
      expect(short.every((value) => value === undefined)).toBe(true);

      // Exactly period + 1 closes: the seed value appears on the last index and nowhere earlier.
      const seeded = calculateWilderRsi(MIXED_CLOSES.slice(0, period + 1), period);
      expect(seeded).toHaveLength(period + 1);
      expect(seeded.slice(0, period).every((value) => value === undefined)).toBe(true);
      expect(seeded[period]).toBeDefined();
    },
  );

  it.each([7, 14, 21] as const)(
    "matches the independently calculated fixed values for period %i",
    (period) => {
      const values = calculateWilderRsi(FIXED_CLOSES, period);
      for (const [index, expected] of FIXED_EXPECTATIONS[period]!) {
        expect(values[index]).toBeCloseTo(expected, 9);
      }
    },
  );

  it("reproduces the published Wilder book figures for the period-14 example", () => {
    // 70.46 and 66.25 are the rounded values printed in the original worked example, asserted at
    // their published precision so the methodology stays verifiable outside this repository.
    const values = calculateWilderRsi(FIXED_CLOSES, 14);
    expect(values[14]).toBeCloseTo(70.46, 2);
    expect(values[15]).toBeCloseTo(66.25, 2);
  });

  it.each(DAILY_OSCILLATORS)(
    "seeds RSI $period with the simple average of the first $period changes",
    ({ period }) => {
      let gainSum = 0;
      let lossSum = 0;
      for (let index = 1; index <= period; index += 1) {
        const change = MIXED_CLOSES[index]! - MIXED_CLOSES[index - 1]!;
        gainSum += Math.max(change, 0);
        lossSum += Math.max(-change, 0);
      }
      const expected = (100 * gainSum) / (gainSum + lossSum);

      expect(calculateWilderRsi(MIXED_CLOSES, period)[period]).toBeCloseTo(expected, 9);
    },
  );

  it.each(DAILY_OSCILLATORS)(
    "applies Wilder smoothing with weight (N - 1)/N to the value after the seed for period $period",
    ({ period }) => {
      let gainSum = 0;
      let lossSum = 0;
      for (let index = 1; index <= period; index += 1) {
        const change = MIXED_CLOSES[index]! - MIXED_CLOSES[index - 1]!;
        gainSum += Math.max(change, 0);
        lossSum += Math.max(-change, 0);
      }
      const nextChange = MIXED_CLOSES[period + 1]! - MIXED_CLOSES[period]!;
      const avgGain =
        ((gainSum / period) * (period - 1) + Math.max(nextChange, 0)) / period;
      const avgLoss =
        ((lossSum / period) * (period - 1) + Math.max(-nextChange, 0)) / period;
      const expected = (100 * avgGain) / (avgGain + avgLoss);

      expect(calculateWilderRsi(MIXED_CLOSES, period)[period + 1]).toBeCloseTo(expected, 9);
    },
  );

  it.each(DAILY_OSCILLATORS)(
    "agrees with the closed-form oracle across the whole mixed history for period $period",
    ({ period }) => {
      const actual = calculateWilderRsi(MIXED_CLOSES, period);
      const expected = referenceWilderRsi(MIXED_CLOSES, period);
      expect(actual).toHaveLength(expected.length);
      actual.forEach((value, index) => {
        if (expected[index] === undefined) {
          expect(value).toBeUndefined();
        } else {
          expect(value).toBeCloseTo(expected[index]!, 7);
        }
      });
    },
  );

  it.each(DAILY_OSCILLATORS)(
    "reads exactly 100 on an only-gains history for period $period",
    ({ period }) => {
      const rising = Array.from({ length: period * 3 }, (_, index) => 50 + index * 0.5);
      const values = calculateWilderRsi(rising, period);
      for (let index = period; index < rising.length; index += 1) {
        expect(values[index]).toBe(100);
      }
    },
  );

  it.each(DAILY_OSCILLATORS)(
    "reads exactly 0 on an only-losses history for period $period",
    ({ period }) => {
      const falling = Array.from({ length: period * 3 }, (_, index) => 500 - index * 0.5);
      const values = calculateWilderRsi(falling, period);
      for (let index = period; index < falling.length; index += 1) {
        expect(values[index]).toBe(0);
      }
    },
  );

  it.each(DAILY_OSCILLATORS)(
    "reads exactly 50 on a completely flat history for period $period",
    ({ period }) => {
      const flat = Array.from({ length: period * 3 }, () => 123.45);
      const values = calculateWilderRsi(flat, period);
      for (let index = period; index < flat.length; index += 1) {
        expect(values[index]).toBe(50);
      }
    },
  );

  it.each(DAILY_OSCILLATORS)(
    "stays inside the fixed unit range on mixed gains and losses for period $period",
    ({ period }) => {
      const values = calculateWilderRsi(MIXED_CLOSES, period);
      let evaluated = 0;
      for (const value of values) {
        if (value === undefined) {
          continue;
        }
        evaluated += 1;
        expect(value).toBeGreaterThanOrEqual(RSI_VALUE_RANGE.min);
        expect(value).toBeLessThanOrEqual(RSI_VALUE_RANGE.max);
      }
      expect(evaluated).toBe(MIXED_CLOSES.length - period);
    },
  );

  it("never looks ahead: a prefix of history yields the same values for its own days", () => {
    // Truncating the future must not change any already-materialized value: today's RSI can only
    // depend on today's and earlier closes.
    const cutoff = 100;
    for (const oscillator of DAILY_OSCILLATORS) {
      const full = calculateWilderRsi(MIXED_CLOSES, oscillator.period);
      const prefix = calculateWilderRsi(MIXED_CLOSES.slice(0, cutoff), oscillator.period);
      expect(prefix).toHaveLength(cutoff);
      expect(prefix).toEqual(full.slice(0, cutoff));
    }
  });

  it("does not mutate or reorder the caller's closes", () => {
    const closes = Object.freeze([...FIXED_CLOSES]);
    // A frozen array throws on any write in strict mode, so surviving the call proves purity.
    expect(() => calculateWilderRsi(closes, 7)).not.toThrow();
    expect(closes).toEqual([...FIXED_CLOSES]);
  });

  it("rejects a non-positive or fractional period rather than inventing a window", () => {
    // A programming error, not a financial outcome, so it throws instead of returning absence.
    expect(() => calculateWilderRsi([1, 2, 3], 0)).toThrow(
      "RSI period must be a positive integer",
    );
    expect(() => calculateWilderRsi([1, 2, 3], -7)).toThrow(
      "RSI period must be a positive integer",
    );
    expect(() => calculateWilderRsi([1, 2, 3], 7.5)).toThrow(
      "RSI period must be a positive integer",
    );
  });

  it("rejects non-finite closes rather than propagating them", () => {
    expect(() => calculateWilderRsi([1, Number.NaN, 3], 2)).toThrow(
      "RSI inputs must be finite numbers",
    );
    expect(() =>
      calculateWilderRsi([1, Number.POSITIVE_INFINITY, 3], 2),
    ).toThrow("RSI inputs must be finite numbers");
  });
});

describe("relative period sensitivity", () => {
  /**
   * A deterministic shock fixture where the ordering is unambiguous: a long alternating +1/-1
   * baseline (gains and losses both present, every RSI near 50), then one sharp move. A shorter
   * window weighs the shock more, so the 7D reading must move further than the 14D and the 14D
   * further than the 21D — in both directions. This is a property of the formula, not an
   * investment-performance claim.
   */
  function shockCloses(direction: 1 | -1): number[] {
    const closes = Array.from({ length: 60 }, (_, index) => 100 + (index % 2));
    closes.push(101 + direction * 24);
    for (let index = 61; index < 67; index += 1) {
      closes.push(closes[60]! - 1 + (index % 2));
    }
    return closes;
  }

  it("moves RSI 7D further than 14D and 14D further than 21D on a sharp gain", () => {
    const closes = shockCloses(1);
    const rsi7 = calculateWilderRsi(closes, 7);
    const rsi14 = calculateWilderRsi(closes, 14);
    const rsi21 = calculateWilderRsi(closes, 21);
    for (const index of [60, 62, 64]) {
      expect(rsi7[index]!).toBeGreaterThan(rsi14[index]!);
      expect(rsi14[index]!).toBeGreaterThan(rsi21[index]!);
    }
  });

  it("moves RSI 7D further than 14D and 14D further than 21D on a sharp loss", () => {
    const closes = shockCloses(-1);
    const rsi7 = calculateWilderRsi(closes, 7);
    const rsi14 = calculateWilderRsi(closes, 14);
    const rsi21 = calculateWilderRsi(closes, 21);
    for (const index of [60, 62, 64]) {
      expect(rsi7[index]!).toBeLessThan(rsi14[index]!);
      expect(rsi14[index]!).toBeLessThan(rsi21[index]!);
    }
  });
});

describe("calculateDailyOscillators", () => {
  it("produces every registered daily oscillator and nothing else", () => {
    const last = MIXED_ROWS.at(-1)!;
    expect(Object.keys(last).sort()).toEqual(
      ["securityId", "date", ...DAILY_OSCILLATORS.map((oscillator) => oscillator.field)].sort(),
    );
    // The oscillator calculator must not invent moving averages; those belong to
    // `calculateDailyTechnicals`.
    for (const average of DAILY_MOVING_AVERAGES) {
      expect(last).not.toHaveProperty(average.field);
    }
    expect(last).not.toHaveProperty("weeklySourceWeekStart");
    expect(last).not.toHaveProperty("intrinsicValues");
  });

  it("materializes each registered period on its own warm-up boundary", () => {
    for (const oscillator of DAILY_OSCILLATORS) {
      // Trading observations are counted, not calendar days: the boundary is the (period + 1)-th
      // close even though the Monday-Friday fixture spans weekends.
      expect(MIXED_ROWS[oscillator.period - 1]).not.toHaveProperty(oscillator.field);
      expect(MIXED_ROWS[oscillator.period]?.[oscillator.field]).toBeCloseTo(
        referenceWilderRsi(MIXED_CLOSES, oscillator.period)[oscillator.period]!,
        7,
      );
    }
  });

  it("leaves a row with no warmed-up period carrying identity only", () => {
    expect(MIXED_ROWS[0]).toEqual({ securityId: SECURITY_ID, date: START_MONDAY });
    // Absent is absent: never zero, never null.
    expect(Object.values(MIXED_ROWS[0]!)).not.toContain(0);
    expect(JSON.stringify(MIXED_ROWS[0])).not.toContain("null");
  });

  it("counts trading observations, not calendar days, across gaps and the year boundary", () => {
    // Fourteen closes on two calendars: a contiguous Monday-Friday run, and the same closes spread
    // over a Christmas-and-New-Year stretch with holiday gaps. 2020-12-21 is a Monday;
    // 2020-12-25 and 2021-01-01 are skipped entirely.
    const closes = FIXED_CLOSES.slice(0, 14);
    const contiguous = tradingDays("2020-03-02", closes);
    const holidayDates = [
      "2020-12-21", "2020-12-22", "2020-12-23", "2020-12-24",
      "2020-12-28", "2020-12-29", "2020-12-30", "2020-12-31",
      "2021-01-04", "2021-01-05", "2021-01-06", "2021-01-07",
      "2021-01-08", "2021-01-11",
    ];
    const holidays = holidayDates.map((date, index) => bar(date, closes[index]!));

    const fromContiguous = calculateDailyOscillators(contiguous);
    const fromHolidays = calculateDailyOscillators(holidays);

    // Same closes, same observation count, same values — only the dates differ. The eighth close
    // (index 7) carries the first RSI 7D on both calendars, and the ninth (index 8) is the first
    // trading day across the year boundary, whose value depends only on the prior year's closes.
    expect(fromHolidays[7]?.date).toBe("2020-12-31");
    expect(fromHolidays[7]?.rsi7d).toBeDefined();
    expect(fromHolidays[8]?.date).toBe("2021-01-04");
    expect(fromHolidays[8]?.rsi7d).toBeDefined();
    fromHolidays.forEach((row, index) => {
      expect(row.rsi7d).toBe(fromContiguous[index]?.rsi7d);
      expect(row.rsi14d).toBe(fromContiguous[index]?.rsi14d);
      expect(row.rsi21d).toBe(fromContiguous[index]?.rsi21d);
    });
  });

  it("is independent of input ordering", () => {
    const shuffled = [
      ...MIXED_PRICES.filter((_, index) => index % 3 === 2),
      ...MIXED_PRICES.filter((_, index) => index % 3 === 0),
      ...MIXED_PRICES.filter((_, index) => index % 3 === 1),
    ];
    expect(calculateDailyOscillators(shuffled)).toEqual(MIXED_ROWS);
  });

  it("never looks ahead: a prefix of price history yields the same rows for its own days", () => {
    const cutoff = 90;
    const prefixRows = calculateDailyOscillators(MIXED_PRICES.slice(0, cutoff));
    expect(prefixRows).toHaveLength(cutoff);
    expect(prefixRows).toEqual(MIXED_ROWS.slice(0, cutoff));
  });

  it("does not mutate or reorder the caller's price rows", () => {
    const copy = MIXED_PRICES.map((price) => ({ ...price }));
    const frozen = Object.freeze(copy.map((price) => Object.freeze(price)));

    expect(() => calculateDailyOscillators(frozen)).not.toThrow();
    expect(frozen.map((price) => price.date)).toEqual(
      MIXED_PRICES.map((price) => price.date),
    );
    expect(frozen).toEqual(MIXED_PRICES);
  });
});
