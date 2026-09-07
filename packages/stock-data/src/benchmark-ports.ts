import type {
  Benchmark,
  BenchmarkDailyPrice,
  BenchmarkDataset,
  DateRange,
} from "@intrinsic/domain";

/**
 * Revision of what a persisted benchmark coverage interval *means*.
 *
 * The same mechanism `PRICE_DATASET_VERSION` uses for stocks: it is a rebuild trigger, never a row
 * identity. Bumping it makes every earlier coverage interval and cache manifest invisible to the
 * loader, and the affected range is re-verified against the provider lazily on the next read.
 */
export const BENCHMARK_PRICE_DATASET_VERSION = 1;

export const BENCHMARK_DAILY_PRICE_VARIANT_FAMILY = "provider-eod-full";
export const BENCHMARK_DAILY_PRICE_VARIANT = `${BENCHMARK_DAILY_PRICE_VARIANT_FAMILY}:v${BENCHMARK_PRICE_DATASET_VERSION}`;
/** Tail watermark, not coverage: it records through which day the bounded refresh last succeeded. */
export const BENCHMARK_DAILY_PRICE_FRESHNESS_VARIANT = `${BENCHMARK_DAILY_PRICE_VARIANT_FAMILY}:recent-tail`;

export type BenchmarkDatasetStateRecord = {
  benchmarkId: string;
  dataset: BenchmarkDataset;
  variant: string;
  earliestDate?: string;
  latestDate?: string;
  lastSuccessfulSyncAt?: string;
};

/**
 * Durable persistence for benchmark identity and market data.
 *
 * Deliberately a **separate port** from `StockDataStore`: a benchmark has no profile, no
 * fundamentals, no derived state and no weekly aggregate, and folding it into the stock port would
 * hand every benchmark implementation and fake a surface it can never satisfy. What is shared is
 * the *shape* of the contract — coverage intervals mean the same thing here as they do there.
 */
export interface BenchmarkDataStore {
  listActiveBenchmarks(): Promise<Benchmark[]>;
  findBenchmarkByCode(code: string): Promise<Benchmark | null>;
  /**
   * Registers the canonical catalog idempotently, keyed by `code`, and returns the persisted rows.
   *
   * This is what makes the V1 benchmark exist after `migrate` without manual SQL. The metadata it
   * writes comes from `BENCHMARK_CATALOG` in `@intrinsic/domain` — the one source — so no second
   * array anywhere repeats `SP500`/`SPY`.
   */
  reconcileBenchmarkCatalog(
    entries: readonly Omit<Benchmark, "id">[],
  ): Promise<Benchmark[]>;
  getDatasetState(
    benchmarkId: string,
    dataset: BenchmarkDataset,
    variant: string,
  ): Promise<BenchmarkDatasetStateRecord | null>;
  /** Coverage intervals intersecting `range`, under the current variant, ascending. */
  getDatasetCoverage(
    benchmarkId: string,
    dataset: BenchmarkDataset,
    variant: string,
    range: Required<DateRange>,
  ): Promise<Required<DateRange>[]>;
  getDailyPrices(
    benchmarkId: string,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]>;
  /**
   * Persists provider rows and records `successfulCoverage` under the current variant.
   *
   * Each interval must have been asked for completely — the FMP adapter's pagination is what makes
   * that true — because a coverage interval is the durable claim that asking again is pointless.
   */
  saveDailyPriceSync(input: {
    benchmarkId: string;
    prices: readonly BenchmarkDailyPrice[];
    successfulCoverage: readonly Required<DateRange>[];
    syncedAt: string;
    tailDate: string;
    freshThrough?: string;
    assertOwned?: () => void;
  }): Promise<void>;
}

/**
 * What a benchmark's Redis projection holds.
 *
 * The namespace is deliberately distinct — `benchmark:<benchmarkId>:daily-price:<year>` — rather
 * than pretending benchmark bars are ordinary security data. A stock eviction must never take a
 * benchmark with it, and a benchmark must never appear in the resident-stock LRU.
 */
export type BenchmarkManifest = {
  benchmarkId: string;
  /** Range resident in Redis. Narrower than durable coverage after an eviction or a narrow read. */
  coverageStart: string;
  coverageEnd: string;
  materializedAt: string;
  priceDatasetVersion: number;
};

export interface BenchmarkDataCache {
  getManifest(benchmarkId: string): Promise<BenchmarkManifest | null>;
  setManifest(manifest: BenchmarkManifest): Promise<void>;
  invalidateManifest(benchmarkId: string): Promise<void>;
  readDailyPrices(
    benchmarkId: string,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[] | null>;
  writeDailyPriceYears(
    benchmarkId: string,
    prices: readonly BenchmarkDailyPrice[],
    years: readonly number[],
  ): Promise<void>;
}

/** The read boundary a backtest consumes. It never learns which provider symbol backs a code. */
export interface BenchmarkDataService {
  listBenchmarks(): Promise<Benchmark[]>;
  getBenchmark(code: string): Promise<Benchmark>;
  ensureBenchmarkHydrated(
    benchmark: Benchmark,
    required: Required<DateRange>,
  ): Promise<void>;
  getBenchmarkDailyPrices(
    benchmark: Benchmark,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]>;
}
