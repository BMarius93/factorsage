import type {
  BenchmarkCatalogEntry,
  BenchmarkDailyPrice,
  BenchmarkDataset,
  BenchmarkSeries,
  BenchmarkWithSeries,
  DateRange,
  Instant,
  LocalDate,
} from "@intrinsic/domain";
import type { PriceBasisEvent } from "./price-basis.js";

/**
 * Revision of what a persisted benchmark coverage interval *means*.
 *
 * The same mechanism `PRICE_DATASET_VERSION` uses for stocks: it is a rebuild trigger, never a row
 * identity. Bumping it makes every earlier coverage interval and cache manifest invisible to the
 * loader, and the affected range is re-verified against the provider lazily on the next read.
 *
 * Revision history:
 * - v1: coverage recorded from the requested range, re-read only behind today.
 * - v2: re-established after the leading-edge rule (AUD-04). These bars are the backtest execution
 *   calendar, so a session lost the way stock prices lost 2026-09-04 would remove a date from
 *   every run; this bump re-verifies every interval recorded before the rule existed.
 */
export const BENCHMARK_PRICE_DATASET_VERSION = 2;

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
  /** The first stored bar's date, or null when the series holds none. */
  getEarliestDailyPriceDate(seriesId: string): Promise<LocalDate | null>;
  /** The last stored bar's date, or null when the series holds none. */
  getLatestDailyPriceDate(seriesId: string): Promise<LocalDate | null>;
  /** The last `limit` stored bars on or before `through`, ascending. */
  getDailyPricesThrough(
    seriesId: string,
    through: LocalDate,
    limit: number,
  ): Promise<BenchmarkDailyPrice[]>;
  /** One digest per calendar year that holds at least one stored bar, ascending by year. */
  getDailyPriceYearDigests(seriesId: string): Promise<BenchmarkYearDigest[]>;
  /**
   * Everything one Redis publication needs, read in **one** repeatable-read snapshot: the durable
   * coverage, every year's digest, the price-basis generation, and the bars of each year whose
   * digest differs from the one in `held` (the digest the current projection already publishes).
   *
   * One snapshot is what makes a published chunk key and its content agree: a key is named by the
   * digest of the rows it was built from, and both are read before any concurrent write can land.
   */
  readPublicationSnapshot(
    seriesId: string,
    held: ReadonlyMap<number, string>,
  ): Promise<BenchmarkPublicationSnapshot>;
  /** The series' price-basis generation: 0 until its stored history is first replaced. */
  getPriceBasisGeneration(seriesId: string): Promise<number>;
  /**
   * Stored bars with the generation and the durable coverage they were read under, all from one
   * `REPEATABLE READ` snapshot, so a replacement committing meanwhile can never pair one basis's
   * bars with the other's generation. `range` reads every bar inside it; `through` reads the last
   * `sessions` bars on or before it.
   */
  readHistorySnapshot(
    seriesId: string,
    query:
      { range: Required<DateRange> } | { through: LocalDate; sessions: number },
  ): Promise<BenchmarkHistorySnapshot>;
  /**
   * Replaces the series' whole stored history after a measured re-base, in one transaction
   * (`docs/decisions/etf-market-data-v1.md`; `historical-price-basis-v1.md` §9): every bar, the
   * coverage the replacement read, the measured events and the next generation.
   *
   * Refused with `PriceBasisConflictError`, and nothing written, when the generation is no longer
   * `expectedGeneration`: another writer replaced it after this one compared.
   */
  replaceDailyPriceHistory(input: {
    seriesId: string;
    expectedGeneration: number;
    prices: readonly BenchmarkDailyPrice[];
    events: readonly PriceBasisEvent[];
    coverage: Required<DateRange>;
    syncedAt: Instant;
    tailDate: LocalDate;
    freshThrough?: LocalDate;
    assertOwned?: () => void;
  }): Promise<{ generation: number }>;
}

/** The digest of one calendar year of a series' stored bars. */
export type BenchmarkYearDigest = {
  year: number;
  /** Changes whenever any bar of the year is added, removed or changes in any field. */
  digest: string;
  bars: number;
  firstDate: LocalDate;
  lastDate: LocalDate;
};

export type BenchmarkPublicationSnapshot = {
  basisGeneration: number;
  /** Durable coverage under the current variant, ascending and disjoint. */
  coverage: Required<DateRange>[];
  years: BenchmarkYearDigest[];
  /** The bars of every year whose digest is not the one the caller already holds. */
  rows: Map<number, BenchmarkDailyPrice[]>;
};

/**
 * The head of a series' Redis projection: one immutable publication of its **whole** durable
 * history (`docs/decisions/etf-market-data-v1.md`).
 *
 * A read reads the head, then exactly the year chunks it names. Chunk keys carry the digest of the
 * stored bars they were built from and are never rewritten, so every chunk a head names belongs to
 * that one publication: a reader can see an older publication or a newer one, never two at once. A
 * chunk the head names that has already gone means the head moved on, and the read is retried.
 */
export type BenchmarkCacheHead = {
  seriesId: string;
  chunkEncodingVersion: number;
  priceDatasetVersion: number;
  /** `BenchmarkSeriesPriceBasis.generation` the published bars were read under. */
  basisGeneration: number;
  /**
   * The durable coverage when published, ascending and disjoint. A range is answered only inside
   * one of these: there, the published bars are every bar PostgreSQL holds.
   */
  residentRanges: Required<DateRange>[];
  /** Year to digest of that year's bars. A year inside a resident range but absent here has none. */
  chunks: Record<string, string>;
  bars: number;
  firstDate?: LocalDate;
  lastDate?: LocalDate;
  /** When this head was published. */
  materializedAt: Instant;
};

/** A head as it was read, with the exact stored text a compare-and-set commit compares against. */
export type ObservedBenchmarkHead = { head: BenchmarkCacheHead; raw: string };

export type BenchmarkPublishOutcome =
  /** The head now names this publication. */
  | "COMMITTED"
  /** Another publication committed since the expected head was read; nothing changed. */
  | "CONFLICT"
  /** A chunk the head would name is gone (an expired stage, an eviction); nothing changed. */
  | "MISSING_CHUNKS";

/** A read answered from one publication, with the head that answered it. */
export type BenchmarkCacheRead = {
  rows: BenchmarkDailyPrice[];
  head: BenchmarkCacheHead;
};

export interface BenchmarkDataCache {
  getHead(seriesId: string): Promise<ObservedBenchmarkHead | null>;
  /**
   * Stages the chunks `stage` holds, then commits `head` atomically if the stored head is still
   * `expected` (absent when null). Staged chunks expire unless the commit adopts them, and the
   * commit removes every chunk of the series the new head no longer names.
   */
  publish(input: {
    expected: ObservedBenchmarkHead | null;
    head: BenchmarkCacheHead;
    stage: ReadonlyMap<number, readonly BenchmarkDailyPrice[]>;
  }): Promise<BenchmarkPublishOutcome>;
  /** Drops the head, so the next read rebuilds the projection from PostgreSQL. */
  invalidateManifest(seriesId: string): Promise<void>;
  /**
   * Removes the head and every chunk of the series atomically, returning how many chunks went. A
   * reader that already holds the previous head then finds its chunks gone, so nothing of that
   * publication can be served once this returns.
   */
  discardProjection(seriesId: string): Promise<number>;
  /** Whether every chunk `head` names exists. */
  chunksPresent(head: BenchmarkCacheHead): Promise<boolean>;
  /**
   * Every bar inside `range` from one publication, or null when there is no current head or its
   * chunks cannot be read. A head is a complete image of PostgreSQL — every stored bar and every
   * coverage interval — so this answers any range: what coverage does not hold is the caller's to
   * report as missing, from `head.residentRanges`.
   */
  readDailyPrices(
    seriesId: string,
    range: Required<DateRange>,
  ): Promise<BenchmarkCacheRead | null>;
  /**
   * The last `sessions` bars on or before `through` from one publication, reading only the years
   * that hold them, or null when there is no current head or its chunks cannot be read.
   */
  readSessionsThrough(
    seriesId: string,
    through: LocalDate,
    sessions: number,
  ): Promise<BenchmarkCacheRead | null>;
  /**
   * Every bar from the start of the published history through `through`, with that start, from
   * one publication; null as for `readDailyPrices`.
   */
  readHistoryThrough(
    seriesId: string,
    through: LocalDate,
  ): Promise<(BenchmarkCacheRead & { from: LocalDate }) | null>;
}

/**
 * One series' bars as a reader got them, and where from.
 *
 * `basisGeneration` is the price basis the bars are on, so a caller that must be reproducible can
 * record it. `missing` lists the parts of the requested range PostgreSQL has never been asked for;
 * a reader never asks the provider, so a caller that needs them must hydrate first.
 */
export type BenchmarkHistorySnapshot = {
  rows: BenchmarkDailyPrice[];
  basisGeneration: number;
  /** Every durable coverage interval of the series, ascending. */
  coverage: Required<DateRange>[];
};

export type BenchmarkHistory = {
  seriesId: string;
  basisGeneration: number;
  rows: BenchmarkDailyPrice[];
  missing: Required<DateRange>[];
  source: "REDIS" | "POSTGRESQL";
};

/**
 * The historical read boundary for workers (`docs/decisions/etf-market-data-v1.md`).
 *
 * Never asks the provider: it reads the resident Redis projection, rebuilds it from PostgreSQL when
 * Redis lost it, and falls back to PostgreSQL for a range Redis cannot answer. Every read is bounded
 * by an explicit end date and never returns a bar after it.
 */
export interface BenchmarkHistoryReader {
  readBenchmarkHistory(
    series: BenchmarkSeries,
    range: Required<DateRange>,
  ): Promise<BenchmarkHistory>;
  /** Everything stored, through `through` (today when omitted). */
  readFullBenchmarkHistory(
    series: BenchmarkSeries,
    through?: LocalDate,
  ): Promise<BenchmarkHistory>;
  readBenchmarkSession(
    series: BenchmarkSeries,
    date: LocalDate,
  ): Promise<BenchmarkDailyPrice | null>;
  /** The last `sessions` bars on or before `through`, inclusive. */
  readBenchmarkSessions(
    series: BenchmarkSeries,
    window: { through: LocalDate; sessions: number },
  ): Promise<BenchmarkHistory>;
  readBenchmarkHistories(
    series: readonly BenchmarkSeries[],
    range: Required<DateRange>,
  ): Promise<BenchmarkHistory[]>;
}

/** What the scheduled refresh decides from (`market-data-refresh.ts`). */
export type BenchmarkRefreshState = {
  /** The end of the latest durable coverage interval, or undefined before any bootstrap. */
  coverageEnd?: LocalDate;
  latestBar?: LocalDate;
  /** When the bounded tail last synced successfully: a read that reached today and saved. */
  lastTailSyncAt?: Instant;
  /**
   * When the provider last answered a read that was saved, whatever it reached — including one whose
   * newest bars were held back at a possible ex-date. What spaces repeated reads of one session.
   */
  lastAskedAt?: Instant;
};

export type BenchmarkRefreshStatus =
  /** The expected session is stored and was read after it became final. Nothing was asked. */
  | "UP_TO_DATE"
  /** The tail was read and the expected session is stored. */
  | "REFRESHED"
  /** The tail was read and the provider has not published the expected session yet. */
  | "AWAITING_PUBLICATION"
  /** The provider re-based the history, and it was replaced whole under a new generation. */
  | "REBASED"
  /** A re-base was detected and could not be replaced yet; nothing new was saved. */
  | "REBASE_REFUSED"
  /** The series was never bootstrapped; the refresh does not bootstrap. */
  | "NOT_BOOTSTRAPPED";

export type BenchmarkRefreshResult = {
  status: BenchmarkRefreshStatus;
  latestBar?: LocalDate;
  basisGeneration: number;
  /** Provider reads this refresh made (one per walk; a walk may page). */
  providerReads: number;
};

/** What `ensureBenchmarkResident` found. */
export type BenchmarkResidency = {
  /**
   * `RESIDENT` — the head already matched PostgreSQL; `REPUBLISHED` — it did not and now does;
   * `EMPTY` — nothing durable to project; `UNPUBLISHED` — it did not match and could not be
   * published (Redis refused or kept losing the race), so reads fall back to PostgreSQL.
   */
  status: "RESIDENT" | "REPUBLISHED" | "EMPTY" | "UNPUBLISHED";
  bars: number;
  years: number;
  basisGeneration: number;
};

/** The read boundary a backtest consumes. It never learns which provider symbol backs a code. */
export interface BenchmarkDataService extends BenchmarkHistoryReader {
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
  /**
   * Makes the series' Redis projection a complete image of PostgreSQL: verifies the published head
   * against every year's digest and republishes what differs. Never asks the provider.
   */
  ensureBenchmarkResident(series: BenchmarkSeries): Promise<BenchmarkResidency>;
  /** What the scheduled refresh decides from. Reads PostgreSQL only. */
  benchmarkRefreshState(
    series: BenchmarkSeries,
  ): Promise<BenchmarkRefreshState>;
  /**
   * The scheduled refresh of one bootstrapped series: one bounded tail read, never the history,
   * with the re-base protection applied, then the projection republished.
   */
  refreshBenchmarkSeries(
    series: BenchmarkSeries,
    input: { expectedSession?: LocalDate },
  ): Promise<BenchmarkRefreshResult>;
}
