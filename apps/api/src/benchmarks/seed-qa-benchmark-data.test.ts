import { describe, expect, it } from "vitest";
import {
  qaBenchmarkTradingDays,
  seedQaBenchmarkDataWith,
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
