import { describe, expect, it } from "vitest";
import {
  qaBenchmarkTradingDays,
  qaMarketReferenceTradingDays,
  seedQaBenchmarkDataWith,
  seedQaMarketReferenceDataWith,
} from "./seed-qa-benchmark-data";
import { qaTradingDays } from "../stocks/seed-qa-stock-data";

const BENCHMARK_ID = "qa-benchmark";
const SECURITY_ID = "qa-security";
const TODAY = "2026-08-28";

/**
 * The Playwright backtest journey asserts that Portfolio and S&P 500 are two visibly different
 * curves and that alpha is a real number. Both are properties of this seed, so they are proven here
 * rather than only in a browser run CI does not perform.
 */
describe("QA benchmark seed", () => {
  const rows = qaBenchmarkTradingDays(BENCHMARK_ID, TODAY);

  it("produces a deterministic Monday-Friday history that reruns identically", () => {
    expect(qaBenchmarkTradingDays(BENCHMARK_ID, TODAY)).toEqual(rows);
    expect(rows.length % 5).toBe(0);
    for (const row of rows) {
      const weekday = new Date(`${row.date}T00:00:00.000Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
    }
  });

  it("covers exactly the same trading days as the QA security", () => {
    // Both series must span the same window, or a seeded backtest would have dates on which the
    // benchmark simply has no value and the comparison would be less useful than it looks.
    const securityDates = qaTradingDays(SECURITY_ID, TODAY).map(
      (row) => row.date,
    );
    expect(rows.map((row) => row.date)).toEqual(securityDates);
  });

  it("diverges from the QA security's prices, so return, benchmark return and alpha differ", () => {
    const securityCloses = qaTradingDays(SECURITY_ID, TODAY).map(
      (row) => row.close,
    );
    const benchmarkCloses = rows.map((row) => row.close);
    const securityGrowth =
      (securityCloses.at(-1) as number) / (securityCloses[0] as number);
    const benchmarkGrowth =
      (benchmarkCloses.at(-1) as number) / (benchmarkCloses[0] as number);
    expect(Math.abs(securityGrowth - benchmarkGrowth)).toBeGreaterThan(0.05);
  });

  it("never claims coverage outside the interval it actually generated", async () => {
    // The invariant a coverage row asserts is "the provider was asked for every date in here and
    // everything it returned is persisted". A seed that wrote three years and claimed thirty would
    // make every earlier date permanently unfetchable, and a real thirty-year backtest would then
    // compare against synthetic history without anyone being told. So the claim is captured at the
    // store boundary and checked against the rows the seed actually produced.
    const claimed: { from: string; to: string }[] = [];
    const store = {
      reconcileBenchmarkCatalog: async () => [
        { code: "SP500", series: { id: "series-1" } },
      ],
      saveDailyPriceSync: async (input: {
        successfulCoverage: readonly { from: string; to: string }[];
      }) => {
        claimed.push(
          ...input.successfulCoverage.map((range) => ({ ...range })),
        );
      },
    };

    await seedQaBenchmarkDataWith(store as never, TODAY);

    const earliest = rows[0]?.date as string;
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.from).toBe(earliest);
    // Ending at today is the same claim a real sync makes about a weekend: asked for, nothing to
    // store. Starting before the first generated row would not be.
    expect(claimed[0]?.to).toBe(TODAY);
    expect((claimed[0]?.from ?? "") >= earliest).toBe(true);
  });

  it("keeps every bar internally consistent and positive", () => {
    for (const row of rows) {
      expect(row.close).toBeGreaterThan(0);
      expect(row.high).toBeGreaterThanOrEqual(row.close);
      expect(row.low).toBeLessThanOrEqual(row.close);
      expect(row.volume).toBeGreaterThan(0);
    }
  });
});

/**
 * The Dashboard's market cards are asserted on exact values in unit tests, Playwright and
 * screenshots, so the fixture behind them has to be a fact rather than a tendency.
 */
describe("QA market-reference seed", () => {
  const sp500 = qaMarketReferenceTradingDays(
    "SP500_INDEX",
    "series-sp500-index",
    TODAY,
  );
  const vix = qaMarketReferenceTradingDays("VIX_INDEX", "series-vix", TODAY);

  it("pins the latest session, the previous close and the seven-session trend", () => {
    // These are the numbers a screenshot records and a Playwright assertion reads. They must not
    // depend on what the real S&P 500 did today.
    expect(sp500.at(-1)?.close).toBe(7637.05);
    expect(sp500.at(-2)?.close).toBe(7551.81);
    expect(sp500.slice(-7).map((row) => row.close)).toEqual([
      7521.35, 7588.02, 7612.3, 7604.77, 7599.18, 7551.81, 7637.05,
    ]);
    expect(
      qaMarketReferenceTradingDays("DJIA_INDEX", "series-djia", TODAY).at(-1)
        ?.close,
    ).toBe(51778.04);
  });

  it("gives VIX a fall, so the negative treatment is covered by data", () => {
    const latest = vix.at(-1)?.close as number;
    const previous = vix.at(-2)?.close as number;
    expect(latest).toBe(15.43);
    expect(previous).toBe(17.71);
    expect(latest).toBeLessThan(previous);
  });

  it("produces weekday sessions only, none in the future, and reruns identically", () => {
    expect(
      qaMarketReferenceTradingDays("SP500_INDEX", "series-sp500-index", TODAY),
    ).toEqual(sp500);
    for (const row of sp500) {
      const weekday = new Date(`${row.date}T00:00:00.000Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
      expect(row.date <= TODAY).toBe(true);
    }
    // Ascending and unique, so "the latest session" is unambiguous.
    const dates = sp500.map((row) => row.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("holds the same values whichever weekday it is generated on", () => {
    // The dates slide with the calendar; the closes must not, or every screenshot would differ by
    // the day of the week it was taken on.
    for (const day of [
      "2026-09-14",
      "2026-09-17",
      "2026-09-19",
      "2026-09-20",
    ]) {
      const generated = qaMarketReferenceTradingDays(
        "SP500_INDEX",
        "series-sp500-index",
        day,
      );
      expect(generated.slice(-7).map((row) => row.close)).toEqual(
        sp500.slice(-7).map((row) => row.close),
      );
    }
  });

  it("says VIX has no traded volume rather than inventing one", () => {
    for (const row of vix) {
      expect(row.volume).toBe(0);
      expect(row.close).toBeGreaterThan(0);
      expect(row.high).toBeGreaterThanOrEqual(row.close);
      expect(row.low).toBeLessThanOrEqual(row.close);
    }
  });

  it("claims coverage over exactly what it generated, for each series independently", async () => {
    const claimed: { seriesId: string; from: string; to: string }[] = [];
    const store = {
      reconcileBenchmarkCatalog: async (entries: readonly { code: string }[]) =>
        entries.map((entry) => ({
          code: entry.code,
          series: { id: `series-${entry.code}` },
        })),
      saveDailyPriceSync: async (input: {
        seriesId: string;
        successfulCoverage: readonly { from: string; to: string }[];
      }) => {
        claimed.push(
          ...input.successfulCoverage.map((range) => ({
            seriesId: input.seriesId,
            ...range,
          })),
        );
      },
    };

    const seeded = await seedQaMarketReferenceDataWith(store as never, TODAY);

    expect(seeded.map((entry) => entry.code)).toEqual([
      "SP500_INDEX",
      "DJIA_INDEX",
      "VIX_INDEX",
    ]);
    expect(claimed).toHaveLength(3);
    // One claim per series, each keyed by its own series id: no seed can write into another's rows.
    expect(new Set(claimed.map((range) => range.seriesId)).size).toBe(3);
    for (const range of claimed) {
      expect(range.to).toBe(TODAY);
      expect(range.from <= TODAY).toBe(true);
    }
    // And never into the backtest benchmark's series.
    expect(claimed.map((range) => range.seriesId)).not.toContain(
      "series-SP500",
    );
  });
});
