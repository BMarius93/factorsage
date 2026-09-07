import type { LocalDate } from "./stock-data.js";

/**
 * Benchmarks are a first-class product concept, deliberately separate from `Security`.
 *
 * A benchmark is passive comparison data: it is never bought, never consumes portfolio cash, never
 * occupies a position slot, and carries no derived series — no moving averages, no oscillators, no
 * intrinsic values. Modelling it as `Security.isBenchmark = true` would drag every one of those
 * behaviours along with it, so it has its own identity and its own market-data tables.
 *
 * What is *shared* is the loading machinery: coverage reconciliation, the hydration lock, provider
 * retries and cooldown, durable PostgreSQL persistence and the yearly Redis projection all follow
 * the same principles as stock loading, because duplicating them would be the real mistake.
 */

/** How a benchmark's series is sourced. V1 ships one kind; the union is the extension point. */
export const BENCHMARK_SOURCE_KINDS = ["FMP_SYMBOL"] as const;

export type BenchmarkSourceKind = (typeof BENCHMARK_SOURCE_KINDS)[number];

export type BenchmarkId = string;

export type Benchmark = {
  id: BenchmarkId;
  code: string;
  name: string;
  description?: string;
  sourceKind: BenchmarkSourceKind;
  /** Provider identifier for `FMP_SYMBOL`. Server-side only; never part of a browser contract. */
  providerSymbol: string;
  currency: string;
  methodologyVersion: number;
  isActive: boolean;
  displayOrder: number;
};

/** One daily bar of a benchmark series. Stored apart from `DailyPrice` by design. */
export type BenchmarkDailyPrice = {
  benchmarkId: BenchmarkId;
  date: LocalDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** The datasets a benchmark materializes. A benchmark has no fundamentals and no derived state. */
export const BENCHMARK_DATASETS = ["DAILY_PRICE"] as const;

export type BenchmarkDataset = (typeof BENCHMARK_DATASETS)[number];

/**
 * The canonical registration of every benchmark the product ships.
 *
 * This is the single source of benchmark metadata: the API reconciles it into PostgreSQL at
 * startup, so a normal local, development, CI or test database has the catalog after `migrate`
 * without manual SQL. No frontend array and no second backend list repeats it.
 *
 * `methodologyVersion` describes what the *series* means. V1's `SP500` is currently backed by the
 * `SPY` ETF, which tracks the index including its own expense ratio and distribution behaviour.
 * Replacing that with a direct index feed would change the numbers, so it would raise this version
 * — and because every run snapshots the value it executed under, an old run stays interpretable.
 */
export const BENCHMARK_CATALOG: readonly Omit<Benchmark, "id">[] = [
  {
    code: "SP500",
    name: "S&P 500",
    description:
      "Large-cap US equity benchmark. Currently sourced from the SPY ETF, which tracks the S&P 500.",
    sourceKind: "FMP_SYMBOL",
    providerSymbol: "SPY",
    currency: "USD",
    methodologyVersion: 1,
    isActive: true,
    displayOrder: 0,
  },
];

/** The benchmark a submission selects when it names none. */
export const DEFAULT_BENCHMARK_CODE = "SP500";

export function findBenchmarkCatalogEntry(
  code: string,
): Omit<Benchmark, "id"> | undefined {
  return BENCHMARK_CATALOG.find((entry) => entry.code === code);
}
