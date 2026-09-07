import { describe, expect, it } from "vitest";
import { qaBenchmarkTradingDays } from "./seed-qa-benchmark-data";
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

  it("keeps every bar internally consistent and positive", () => {
    for (const row of rows) {
      expect(row.close).toBeGreaterThan(0);
      expect(row.high).toBeGreaterThanOrEqual(row.close);
      expect(row.low).toBeLessThanOrEqual(row.close);
      expect(row.volume).toBeGreaterThan(0);
    }
  });
});
