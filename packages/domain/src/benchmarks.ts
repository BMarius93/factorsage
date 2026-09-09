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
export type BenchmarkSeriesId = string;

/**
 * The product identity a user selects: a stable code and the words shown beside it.
 *
 * Everything that decides what the numbers *are* — the source, the provider identifier, the
 * currency, the methodology — lives on `BenchmarkSeries` instead, because those are not editable
 * facts about a benchmark: changing any of them produces a different series, not a corrected one.
 */
export type Benchmark = {
  id: BenchmarkId;
  code: string;
  name: string;
  description?: string;
  isActive: boolean;
  displayOrder: number;
};

/**
 * One **immutable** definition of what a benchmark's series is, and the identity its market data
 * is stored under.
 *
 * A benchmark's meaning can change: `SP500` is sourced from the `SPY` ETF today and could be
 * sourced from a direct index feed tomorrow, which would change every number it produces. That is
 * not an edit. Reconciliation therefore never rewrites a series row — a changed definition appends
 * a new version, historical bars stay attached to the version they were fetched for, and a
 * backtest pins the exact `BenchmarkSeriesId` it executed against at submission.
 *
 * The consequence is the invariant that matters: a queued or completed run can never be
 * reinterpreted by a later catalog change, because the data it reads is keyed by a version that no
 * longer moves.
 */
export type BenchmarkSeries = {
  id: BenchmarkSeriesId;
  benchmarkId: BenchmarkId;
  /** 1-based, ascending. The highest version of a benchmark is its current definition. */
  version: number;
  sourceKind: BenchmarkSourceKind;
  /** Provider identifier for `FMP_SYMBOL`. Server-side only; never part of a browser contract. */
  providerSymbol: string;
  currency: string;
  methodologyVersion: number;
};

/** A benchmark together with the definition currently in force for it. */
export type BenchmarkWithSeries = Benchmark & { series: BenchmarkSeries };

/** One daily bar of a benchmark series. Stored apart from `DailyPrice` by design. */
export type BenchmarkDailyPrice = {
  seriesId: BenchmarkSeriesId;
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
export type BenchmarkCatalogEntry = Omit<Benchmark, "id"> &
  Omit<BenchmarkSeries, "id" | "benchmarkId" | "version">;

export const BENCHMARK_CATALOG: readonly BenchmarkCatalogEntry[] = [
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

/**
 * The series whose trading days are the engine's execution calendar.
 *
 * A **system input, not a user choice.** The dates a run simulates decide when a contribution
 * lands and what the return index is based at, so letting the selected comparison benchmark supply
 * them would make two otherwise identical runs disagree on their own portfolio. The engine names
 * one reference instead, and every run pins the exact series version of it at submission.
 *
 * It is the same code the product also offers as a comparison today, which costs nothing: one
 * hydration serves both roles. The separation is in the code and in the snapshot, not in the bytes.
 */
export const EXECUTION_CALENDAR_REFERENCE_CODE = "SP500";

export function findBenchmarkCatalogEntry(
  code: string,
): BenchmarkCatalogEntry | undefined {
  return BENCHMARK_CATALOG.find((entry) => entry.code === code);
}
