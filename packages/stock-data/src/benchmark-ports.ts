import type {
  BenchmarkCatalogEntry,
  BenchmarkDailyPrice,
  BenchmarkDataset,
  BenchmarkSeries,
  BenchmarkWithSeries,
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
  seriesId: string;
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
  listActiveBenchmarks(): Promise<BenchmarkWithSeries[]>;
  findBenchmarkByCode(code: string): Promise<BenchmarkWithSeries | null>;
  /** The exact immutable series a run pinned, by id. Null when it no longer exists. */
  findSeriesById(seriesId: string): Promise<BenchmarkSeries | null>;
  /**
   * Registers the canonical catalog idempotently, keyed by `code`, and returns the persisted rows
   * with the series currently in force.
   *
   * This is what makes the V1 benchmark exist after `migrate` without manual SQL. The metadata it
   * writes comes from `BENCHMARK_CATALOG` in `@intrinsic/domain` — the one source — so no second
   * array anywhere repeats `SP500`/`SPY`.
   *
   * Identity fields are **never updated**: a definition that differs from the current series
   * appends a new version instead, so bars already fetched under the old one keep their meaning.
   */
  reconcileBenchmarkCatalog(
    entries: readonly BenchmarkCatalogEntry[],
  ): Promise<BenchmarkWithSeries[]>;
  getDatasetState(
    seriesId: string,
    dataset: BenchmarkDataset,
    variant: string,
  ): Promise<BenchmarkDatasetStateRecord | null>;
  /** Coverage intervals intersecting `range`, under the current variant, ascending. */
  getDatasetCoverage(
    seriesId: string,
    dataset: BenchmarkDataset,
    variant: string,
    range: Required<DateRange>,
  ): Promise<Required<DateRange>[]>;
  getDailyPrices(
    seriesId: string,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]>;
  /**
   * Persists provider rows and records `successfulCoverage` under the current variant.
   *
   * Each interval must have been asked for completely — the FMP adapter's pagination is what makes
   * that true — because a coverage interval is the durable claim that asking again is pointless.
   */
  saveDailyPriceSync(input: {
    seriesId: string;
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
 * The namespace is deliberately distinct — `benchmark:<seriesId>:daily-price:<year>` — rather
 * than pretending benchmark bars are ordinary security data. A stock eviction must never take a
 * benchmark with it, and a benchmark must never appear in the resident-stock LRU.
 */
export type BenchmarkManifest = {
  seriesId: string;
  /** Range resident in Redis. Narrower than durable coverage after an eviction or a narrow read. */
  coverageStart: string;
  coverageEnd: string;
  materializedAt: string;
  priceDatasetVersion: number;
};

export interface BenchmarkDataCache {
  getManifest(seriesId: string): Promise<BenchmarkManifest | null>;
  setManifest(manifest: BenchmarkManifest): Promise<void>;
  invalidateManifest(seriesId: string): Promise<void>;
  readDailyPrices(
    seriesId: string,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[] | null>;
  writeDailyPriceYears(
    seriesId: string,
    prices: readonly BenchmarkDailyPrice[],
    years: readonly number[],
  ): Promise<void>;
}

/** The read boundary a backtest consumes. It never learns which provider symbol backs a code. */
export interface BenchmarkDataService {
  listBenchmarks(): Promise<BenchmarkWithSeries[]>;
  getBenchmark(code: string): Promise<BenchmarkWithSeries>;
  /**
   * The exact series a run pinned at submission.
   *
   * This — never `getBenchmark(code)` — is how execution resolves a benchmark, so a catalog change
   * between submission and execution cannot change what the run reads.
   */
  getSeries(seriesId: string): Promise<BenchmarkSeries>;
  ensureBenchmarkHydrated(
    series: BenchmarkSeries,
    required: Required<DateRange>,
  ): Promise<void>;
  getBenchmarkDailyPrices(
    series: BenchmarkSeries,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]>;
  /**
   * Ranges inside `period` the series has no durable coverage for; empty means complete.
   *
   * Execution uses it to tell "the series' own history starts later" from "the canonical data is
   * missing". The first is ordinary; the second must fail a run rather than shorten it.
   */
  missingBenchmarkCoverage(
    series: BenchmarkSeries,
    period: Required<DateRange>,
  ): Promise<Required<DateRange>[]>;
}
