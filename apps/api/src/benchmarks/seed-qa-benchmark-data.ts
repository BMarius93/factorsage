import type { PrismaClient } from "@intrinsic/database";
import {
  BENCHMARK_CATALOG,
  DEFAULT_BENCHMARK_CODE,
  MARKET_REFERENCE_SERIES,
  type BenchmarkDailyPrice,
} from "@intrinsic/domain";
import {
  addDays,
  PrismaBenchmarkDataStore,
  startOfIsoWeek,
  type BenchmarkDataStore,
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
  seriesId: string,
  today: string,
): BenchmarkDailyPrice[] {
  const start = addDays(startOfIsoWeek(today), -7 * HISTORY_WEEKS);
  const rows: BenchmarkDailyPrice[] = [];
  for (let week = 0; week < HISTORY_WEEKS; week += 1) {
    for (let day = 0; day < 5; day += 1) {
      const close = closeAt(rows.length);
      rows.push({
        seriesId,
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

/**
 * Weeks of history for a market-reference series.
 *
 * Far less than the backtest benchmark above needs: nothing simulates over these, and the Dashboard
 * draws seven sessions. It is deliberately more than the overview's own lookback window so the read
 * is exercised against a series that has *more* data than it asks for, which is the real shape.
 */
const MARKET_REFERENCE_WEEKS = 12;

/**
 * The closes a seeded market reference ends on, oldest last-ten first.
 *
 * Fixed values, not a formula, and that is the point: a screenshot of the Dashboard must not change
 * because the real S&P 500 moved, and an assertion on `+1.13%` must mean the arithmetic was right
 * rather than that today happened to be a good day. The last of each array is the latest session,
 * the one before it is the previous close the percentage is computed against, and the last seven
 * are exactly the sparkline.
 *
 * VIX falls while the two equity indices rise, so the negative treatment is covered by a fixture
 * rather than by waiting for a bad week.
 */
const MARKET_REFERENCE_CLOSES: Record<string, readonly number[]> = {
  SP500_INDEX: [
    7480.11, 7502.44, 7466.9, 7521.35, 7588.02, 7612.3, 7604.77, 7599.18,
    7551.81, 7637.05,
  ],
  DJIA_INDEX: [
    50820.15, 50944.6, 51102.33, 51288.7, 51660.02, 52010.44, 52260.18,
    52303.24, 51461.9, 51778.04,
  ],
  VIX_INDEX: [
    18.22, 17.64, 18.05, 16.98, 16.4, 15.92, 16.88, 17.2, 17.71, 15.43,
  ],
};

/**
 * Weekday sessions for one market reference, ending at the last weekday that is not in the future.
 *
 * Weekdays only, and never past `today`: the overview's "latest session" and "previous session" are
 * only meaningful against a series that has no weekend bars, and a fixture that invented a Saturday
 * close would make the weekend behaviour untestable by making it wrong.
 */
export function qaMarketReferenceTradingDays(
  code: string,
  seriesId: string,
  today: string,
): BenchmarkDailyPrice[] {
  const closes = MARKET_REFERENCE_CLOSES[code];
  if (!closes) {
    throw new Error(`No QA market-reference fixture for '${code}'`);
  }

  const start = addDays(
    startOfIsoWeek(today),
    -7 * (MARKET_REFERENCE_WEEKS - 1),
  );
  const dates: string[] = [];
  for (let week = 0; week < MARKET_REFERENCE_WEEKS; week += 1) {
    for (let day = 0; day < 5; day += 1) {
      const date = addDays(start, week * 7 + day);
      if (date <= today) {
        dates.push(date);
      }
    }
  }
  if (dates.length < closes.length) {
    throw new Error(
      `QA market-reference fixture for '${code}' produced ${dates.length} sessions, fewer than the ${closes.length} it pins`,
    );
  }

  const firstPinned = dates.length - closes.length;
  return dates.map((date, index) => {
    // Before the pinned tail the exact value does not matter and only has to be stable and
    // plausible; from the tail onwards it is the fixture the tests and screenshots assert on.
    const close =
      index >= firstPinned
        ? (closes[index - firstPinned] as number)
        : Math.round(
            ((closes[0] as number) * (0.82 + (index % 17) * 0.01) + index) *
              100,
          ) / 100;
    return {
      seriesId,
      date,
      open: round2(close * 0.998),
      high: round2(close * 1.004),
      low: round2(close * 0.995),
      close,
      // `^VIX` has no traded volume, and the fixture says so rather than inventing one.
      volume: code === "VIX_INDEX" ? 0 : 1_000_000 + index,
    };
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Deterministic bars for every market-reference series behind the Dashboard cards.
 *
 * Written through the same store and the same coverage/watermark claims as the backtest benchmark
 * above, because they are the same kind of thing: one benchmark infrastructure, several series.
 */
export async function seedQaMarketReferenceData(
  prisma: PrismaClient,
  today = new Date().toISOString().slice(0, 10),
): Promise<
  {
    code: string;
    seriesId: string;
    from: string;
    to: string;
    tradingDays: number;
  }[]
> {
  assertQaSecuritySeedingAllowed();
  return seedQaMarketReferenceDataWith(
    new PrismaBenchmarkDataStore(prisma),
    today,
  );
}

export async function seedQaMarketReferenceDataWith(
  store: Pick<
    BenchmarkDataStore,
    "reconcileBenchmarkCatalog" | "saveDailyPriceSync"
  >,
  today = new Date().toISOString().slice(0, 10),
): Promise<
  {
    code: string;
    seriesId: string;
    from: string;
    to: string;
    tradingDays: number;
  }[]
> {
  const codes = MARKET_REFERENCE_SERIES.map((reference) => reference.code);
  const benchmarks = await store.reconcileBenchmarkCatalog(
    BENCHMARK_CATALOG.filter((entry) =>
      (codes as readonly string[]).includes(entry.code),
    ),
  );

  const seeded: {
    code: string;
    seriesId: string;
    from: string;
    to: string;
    tradingDays: number;
  }[] = [];
  for (const benchmark of benchmarks) {
    const prices = qaMarketReferenceTradingDays(
      benchmark.code,
      benchmark.series.id,
      today,
    );
    const first = prices[0];
    const last = prices.at(-1);
    if (!first || !last) {
      throw new Error(
        `QA market-reference seed produced no trading days for ${benchmark.code}`,
      );
    }
    await store.saveDailyPriceSync({
      seriesId: benchmark.series.id,
      prices,
      // Exactly what was generated, through today — the same honest claim the benchmark seed makes.
      // Ending at `today` is what tells the loader the missing weekend is a weekend and not a gap.
      successfulCoverage: [{ from: first.date, to: today }],
      syncedAt: new Date().toISOString(),
      tailDate: today,
      freshThrough: today,
    });
    seeded.push({
      code: benchmark.code,
      seriesId: benchmark.series.id,
      from: first.date,
      to: last.date,
      tradingDays: prices.length,
    });
  }
  return seeded;
}

/**
 * Removes benchmark rows the canonical catalog does not know and nothing references.
 *
 * Integration suites register benchmarks of their own — a versioning fixture, a retention fixture —
 * and a suite that crashed, or predates its own cleanup, leaves them behind as real catalog rows. In
 * a shared test database that is not a cosmetic problem: an active, selectable leftover is a genuine
 * entry in `GET /benchmarks`, and the Backtest picker's "exactly S&P 500" invariant cannot be
 * asserted against a catalog that other suites have been writing into for weeks.
 *
 * So the canonical seed restores it. The rule is structural, never a list of test codes:
 *
 * - a row whose `code` is in `BENCHMARK_CATALOG` is product data and is never touched;
 * - a row any `BacktestRun` still references is somebody's history and is never touched (the
 *   foreign key is `Restrict` for exactly that reason) — the entitlement fixtures' inactive
 *   benchmark is one;
 * - anything else is an orphaned fixture, and goes. Its series, bars, coverage and watermarks
 *   cascade.
 *
 * Test databases only: `seedQaBenchmarkData`'s callers are guarded by
 * `assertQaSecuritySeedingAllowed` and target `TEST_DATABASE_URL`.
 */
export async function pruneOrphanedFixtureBenchmarks(
  prisma: PrismaClient,
): Promise<string[]> {
  assertQaSecuritySeedingAllowed();
  const catalogCodes = BENCHMARK_CATALOG.map((entry) => entry.code);
  const orphaned = await prisma.benchmark.findMany({
    where: {
      code: { notIn: catalogCodes },
      backtestRuns: { none: {} },
      series: {
        every: {
          comparisonRuns: { none: {} },
          executionCalendarRuns: { none: {} },
        },
      },
    },
    select: { id: true, code: true },
  });
  if (orphaned.length > 0) {
    await prisma.benchmark.deleteMany({
      where: { id: { in: orphaned.map((row) => row.id) } },
    });
  }
  return orphaned.map((row) => row.code).sort();
}

export async function seedQaBenchmarkData(
  prisma: PrismaClient,
  today = new Date().toISOString().slice(0, 10),
): Promise<{
  code: string;
  seriesId: string;
  from: string;
  to: string;
  tradingDays: number;
}> {
  assertQaSecuritySeedingAllowed();
  return seedQaBenchmarkDataWith(new PrismaBenchmarkDataStore(prisma), today);
}

/**
 * The seed itself, against the store port.
 *
 * Split out so the coverage claim — the one thing here that can silently corrupt a real database —
 * is provable without a PostgreSQL round trip. `seedQaBenchmarkData` keeps the production guard.
 */
export async function seedQaBenchmarkDataWith(
  store: Pick<
    BenchmarkDataStore,
    "reconcileBenchmarkCatalog" | "saveDailyPriceSync"
  >,
  today = new Date().toISOString().slice(0, 10),
): Promise<{
  code: string;
  seriesId: string;
  from: string;
  to: string;
  tradingDays: number;
}> {
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

  const prices = qaBenchmarkTradingDays(benchmark.series.id, today);
  const first = prices[0];
  const last = prices.at(-1);
  if (!first || !last) {
    throw new Error("QA benchmark seed produced no trading days");
  }

  await store.saveDailyPriceSync({
    seriesId: benchmark.series.id,
    prices,
    // Exactly the interval this seed generated over, and not one day more.
    //
    // Claiming the whole retention horizon would be a lie of precisely the kind coverage exists to
    // prevent: the loader reads a coverage interval as "asking again is pointless", so a seed that
    // claimed thirty years while writing three would make every earlier date permanently
    // unfetchable — and a real thirty-year backtest would silently compare against synthetic data.
    // The window ends at `today` because the seed did decide there are no rows after its last
    // complete week, which is the same claim a real sync makes about a weekend.
    successfulCoverage: [{ from: first.date, to: today }],
    syncedAt: new Date().toISOString(),
    tailDate: today,
    // The tail watermark is what stops the loader re-reading the recent window from the provider.
    freshThrough: today,
  });

  return {
    code: benchmark.code,
    seriesId: benchmark.series.id,
    from: first.date,
    to: last.date,
    tradingDays: prices.length,
  };
}
