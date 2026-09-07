import { getStockDataConfig } from "@intrinsic/config";
import type { PrismaClient } from "@intrinsic/database";
import {
  BENCHMARK_CATALOG,
  DEFAULT_BENCHMARK_CODE,
  type BenchmarkDailyPrice,
} from "@intrinsic/domain";
import {
  addDays,
  PrismaBenchmarkDataStore,
  startOfIsoWeek,
  subtractYears,
} from "@intrinsic/stock-data";
import { assertQaSecuritySeedingAllowed } from "../stocks/seed-qa-securities";

/**
 * Deterministic benchmark history for browser/E2E testing.
 *
 * A backtest compares against a benchmark, and the V1 benchmark is sourced from a real provider
 * symbol — so without this seed an E2E run would reach FMP for `SPY`, which the deterministic suites
 * must never do. This writes a synthetic but fully deterministic series plus the coverage interval
 * and the tail freshness watermark that tell the canonical benchmark loader nothing is missing and
 * nothing is stale, so a run resolves entirely out of PostgreSQL.
 *
 * It is a test fixture, not product behaviour. The series is deliberately *not* a copy of the QA
 * security's prices: the two must diverge, or portfolio return, benchmark return and alpha would all
 * be indistinguishable and the browser assertions would prove nothing.
 *
 * Freshness expires, so — exactly like the QA stock-data seed — this is a documented precondition of
 * an E2E run rather than a permanent fixture. Rerunning is safe and produces the same data for the
 * same day.
 */

/** Weeks of history, matching the QA security's window so both cover the same simulated period. */
const HISTORY_WEEKS = 160;

const BENCHMARK_SEED_CLOSE = 400;

/** Close of the `index`-th trading day. Pure function of the index: reruns are identical. */
function closeAt(index: number): number {
  return BENCHMARK_SEED_CLOSE + (index % 23) * 0.4 + index * 0.08;
}

export function qaBenchmarkTradingDays(
  benchmarkId: string,
  today: string,
): BenchmarkDailyPrice[] {
  const start = addDays(startOfIsoWeek(today), -7 * HISTORY_WEEKS);
  const rows: BenchmarkDailyPrice[] = [];
  for (let week = 0; week < HISTORY_WEEKS; week += 1) {
    for (let day = 0; day < 5; day += 1) {
      const close = closeAt(rows.length);
      rows.push({
        benchmarkId,
        date: addDays(start, week * 7 + day),
        open: close - 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 50_000_000 + rows.length,
      });
    }
  }
  return rows;
}

export async function seedQaBenchmarkData(
  prisma: PrismaClient,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ code: string; from: string; to: string; tradingDays: number }> {
  assertQaSecuritySeedingAllowed();

  const store = new PrismaBenchmarkDataStore(prisma);
  // Registration goes through the same reconciliation the API runs at startup, so the fixture can
  // never introduce a second definition of what `SP500` is.
  const [benchmark] = await store.reconcileBenchmarkCatalog(
    BENCHMARK_CATALOG.filter((entry) => entry.code === DEFAULT_BENCHMARK_CODE),
  );
  if (!benchmark) {
    throw new Error(
      `QA benchmark seed found no '${DEFAULT_BENCHMARK_CODE}' entry in BENCHMARK_CATALOG`,
    );
  }

  const prices = qaBenchmarkTradingDays(benchmark.id, today);
  const first = prices[0];
  const last = prices.at(-1);
  if (!first || !last) {
    throw new Error("QA benchmark seed produced no trading days");
  }

  const { historyYears } = getStockDataConfig();
  const horizonStart = subtractYears(today, historyYears);
  await store.saveDailyPriceSync({
    benchmarkId: benchmark.id,
    prices,
    successfulCoverage: [{ from: horizonStart, to: today }],
    syncedAt: new Date().toISOString(),
    tailDate: today,
    // The tail watermark is what stops the loader re-reading the recent window from the provider.
    freshThrough: today,
  });

  return {
    code: benchmark.code,
    from: first.date,
    to: last.date,
    tradingDays: prices.length,
  };
}
