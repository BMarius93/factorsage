import {
  DAILY_OSCILLATORS,
  INTRINSIC_VALUE_BLENDS,
  MATERIALIZED_MOVING_AVERAGES,
  WEEKLY_MOVING_AVERAGES,
} from "@intrinsic/domain";
import {
  aggregateCompletedWeeks,
  buildDailyDerivedState,
  calculateWilderRsi,
} from "@intrinsic/stock-data";
import { describe, expect, it } from "vitest";
import {
  qaIntrinsicFixture,
  qaTradingDays,
  seedHistoryStart,
} from "./seed-qa-stock-data";

const SECURITY_ID = "qa-security";
const TODAY = "2026-08-28";
const SOURCE_AS_OF = "2026-01-05T20:00:00.000Z";

/**
 * The deterministic QA seed underpins the Playwright indicators journey, which asserts that
 * `SMA 200W` is unavailable while `SMA 100W` is available, and that `Balanced` and `Conservative`
 * are selectable while `Dividend` is not. Those expectations are properties of this seed, so they
 * are proven here rather than only in a browser run that CI does not perform.
 */
describe("QA stock-data seed", () => {
  const prices = qaTradingDays(SECURITY_ID, TODAY);
  const weeklyBars = aggregateCompletedWeeks(prices, TODAY, {
    historyStart: seedHistoryStart(TODAY),
    historyStartOrigin: "HORIZON",
  });
  const rows = buildDailyDerivedState({ prices, weeklyBars });
  const lastRow = rows.at(-1)!;

  it("produces a deterministic Monday-Friday history that reruns identically", () => {
    expect(qaTradingDays(SECURITY_ID, TODAY)).toEqual(prices);
    expect(prices.length % 5).toBe(0);
    // Every generated day is a weekday, so no bar is invented on a weekend.
    for (const price of prices) {
      const weekday = new Date(`${price.date}T00:00:00.000Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
    }
    expect(prices[0]?.date).toBe(seedHistoryStart(TODAY));
  });

  it("seeds enough history for the shorter weekly periods and not the longest", () => {
    // This is exactly what the Playwright journey asserts through the picker.
    const warmed = WEEKLY_MOVING_AVERAGES.filter(
      (average) => lastRow[average.field] !== undefined,
    ).map((average) => average.field);
    const unwarmed = WEEKLY_MOVING_AVERAGES.filter(
      (average) => lastRow[average.field] === undefined,
    ).map((average) => average.field);

    expect(warmed).toContain("sma100w");
    expect(unwarmed).toContain("sma200w");
    expect(unwarmed).toContain("ema200w");
    // Unavailable means absent, never zero.
    for (const field of unwarmed) {
      expect(lastRow).not.toHaveProperty(field);
    }
    expect(weeklyBars.length).toBeGreaterThanOrEqual(100);
    expect(weeklyBars.length).toBeLessThan(200);
  });

  it("materializes every daily moving average on the final seeded trading day", () => {
    for (const average of MATERIALIZED_MOVING_AVERAGES.filter(
      (candidate) => candidate.timeframe === "1D",
    )) {
      expect(lastRow[average.field]).toBeTypeOf("number");
    }
  });

  it("materializes every RSI period through the production calculator", () => {
    // The Playwright oscillator journey selects all three RSI periods on the seeded stock, so all
    // three must be evaluable — and equal to what the production Wilder calculator produces over
    // the seeded closes, because the seed calls buildDailyDerivedState rather than a copy.
    expect(DAILY_OSCILLATORS.length).toBeGreaterThan(0);
    const closes = prices.map((price) => price.close);
    for (const oscillator of DAILY_OSCILLATORS) {
      const expected = calculateWilderRsi(closes, oscillator.period);
      expect(lastRow[oscillator.field]).toBe(expected.at(-1));
      expect(lastRow[oscillator.field]).toBeTypeOf("number");
      // Warm-up boundary: absent one day before the first evaluable close, present on it.
      expect(rows[oscillator.period - 1]).not.toHaveProperty(oscillator.field);
      expect(rows[oscillator.period]?.[oscillator.field]).toBe(
        expected[oscillator.period],
      );
    }
  });

  it("derives blend values from the canonical definitions rather than restating weights", () => {
    const fixture = qaIntrinsicFixture(SOURCE_AS_OF);

    for (const [blendId, value] of Object.entries(fixture.blends)) {
      const definition =
        INTRINSIC_VALUE_BLENDS[blendId as keyof typeof INTRINSIC_VALUE_BLENDS];
      const expected = definition.components.reduce(
        (sum, component) =>
          sum + (fixture.values[component.model] ?? Number.NaN) * component.weight,
        0,
      );
      expect(value).toBeCloseTo(expected, 10);
    }
  });

  it("leaves DDM and the blend that requires it unavailable", () => {
    const fixture = qaIntrinsicFixture(SOURCE_AS_OF);

    // The fictional company pays no dividend, so DDM is not applicable and DIVIDEND — the only
    // blend requiring it — must be absent rather than renormalized over the remaining components.
    expect(fixture.values.DDM).toBeUndefined();
    expect(fixture.blends.DIVIDEND).toBeUndefined();
    expect(fixture.blends.BALANCED).toBeTypeOf("number");
    expect(fixture.blends.CONSERVATIVE).toBeTypeOf("number");
    expect(
      INTRINSIC_VALUE_BLENDS.DIVIDEND.components.some(
        (component) => component.model === "DDM",
      ),
    ).toBe(true);
  });

  it("keeps every seeded valuation in one currency", () => {
    expect(qaIntrinsicFixture(SOURCE_AS_OF).currency).toBe("USD");
  });
});
