import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  BenchmarkWithSeries,
  DateRange,
  Instant,
  LocalDate,
} from "@intrinsic/domain";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import {
  isCurrentBenchmarkHead,
  residentRangeCovering,
} from "./benchmark-cache.js";
import { BENCHMARK_CHUNK_ENCODING_VERSION } from "./benchmark-chunk.js";
import {
  BENCHMARK_DAILY_PRICE_FRESHNESS_VARIANT,
  BENCHMARK_DAILY_PRICE_VARIANT,
  BENCHMARK_PRICE_DATASET_VERSION,
  type BenchmarkCacheHead,
  type BenchmarkCacheRead,
  type BenchmarkDataCache,
  type BenchmarkDataService,
  type BenchmarkDataStore,
  type BenchmarkHistory,
  type BenchmarkHistorySnapshot,
  type BenchmarkRefreshResult,
  type BenchmarkRefreshState,
  type BenchmarkResidency,
  type BenchmarkYearDigest,
  type ObservedBenchmarkHead,
} from "./benchmark-ports.js";
import {
  benchmarkExDateHold,
  changesStoredBenchmarkBars,
} from "./benchmark-price-basis.js";
import type {
  LoadCoordinator,
  LoadLease,
  LoadRunOptions,
} from "./coordination.js";
import type {
  PriceBasisObservation,
  ProviderRequestEvent,
  ProviderRequestReason,
} from "./service.js";
import {
  addDays,
  assertDateRange,
  maxDate,
  minDate,
  missingCoverageRanges,
} from "./dates.js";
import {
  closesDiffer,
  comparePriceHistories,
  UNEXPLAINED_SESSION_SHARE,
} from "./price-basis.js";

export class BenchmarkNotFoundError extends Error {
  constructor(code: string) {
    super(`Benchmark '${code}' was not found`);
    this.name = "BenchmarkNotFoundError";
  }
}

/** What a Redis publication did, for the composition roots to log. */
export type BenchmarkCacheObservation = {
  seriesId: string;
  outcome:
    /** A new head was committed; `stagedYears` chunks were written, the rest reused. */
    | "PUBLISHED"
    /** Another publication won the compare-and-set; this one changed nothing. */
    | "CONFLICT"
    /** A chunk the head would reuse was gone; the publication is retried with every year. */
    | "MISSING_CHUNKS"
    /** No publication could be committed; reads fall back to PostgreSQL. */
    | "FAILED"
    /** The publication's generation was not the fence's; it was re-established and retried. */
    | "FENCED";
  stagedYears?: number;
  years?: number;
  bars?: number;
  basisGeneration?: number;
  durationMs?: number;
  err?: unknown;
};

/**
 * One way to log a benchmark Redis publication, shared by every process that builds the loader:
 * quiet when it worked, loud when it did not. A failed publication is never an error the caller
 * sees — reads fall back to PostgreSQL — so this log line is how it becomes visible.
 */
export function logBenchmarkCacheEvent(logger: {
  debug(entry: Record<string, unknown>): void;
  warn(entry: Record<string, unknown>): void;
}): (event: BenchmarkCacheObservation) => void {
  return (event) => {
    const entry = { event: "benchmark.cache.publication", ...event };
    if (event.outcome === "PUBLISHED") {
      logger.debug(entry);
    } else {
      logger.warn(entry);
    }
  };
}

/** Logs a cache chunk that failed to decode; the cache has already deleted it. */
export function logUnreadableBenchmarkChunk(logger: {
  warn(entry: Record<string, unknown>): void;
}): (chunk: {
  seriesId: string;
  year: number;
  key: string;
  reason: string;
}) => void {
  return (chunk) => {
    logger.warn({ event: "benchmark.cache.chunk-unreadable", ...chunk });
  };
}

export type CanonicalBenchmarkDataServiceOptions = {
  /**
   * Accepted and deliberately unused.
   *
   * A benchmark series has exactly one consumer — a backtest, whose period is immutable — so there
   * is no horizon for this service to enforce: applying one would re-decide what an already
   * recorded run simulates. The option is kept so existing callers still compile and so the
   * absence is visible here rather than inferred from its disappearance.
   */
  historyYears?: number;
  recentPriceFreshnessMs?: number;
  recentTailCalendarDays?: number;
  now?: () => Date;
  /** Called before each provider request, with the reason. See `CanonicalStockDataServiceOptions`. */
  onProviderRequest?: (event: ProviderRequestEvent) => void;
  /** Re-base decisions on ETF series, in the stock loader's vocabulary (`logPriceBasisEvent`). */
  onPriceBasisEvent?: (event: PriceBasisObservation) => void;
  /** Redis publications, for operational visibility. */
  onCacheEvent?: (event: BenchmarkCacheObservation) => void;
  /**
   * The longest a provider-free read waits for the hydration lock when it finds no resident
   * projection, before it answers from PostgreSQL. See {@link DEFAULT_RESIDENT_READ_LOCK_WAIT_MS}.
   */
  residentReadLockWaitMs?: number;
};

/** Spans every date a coverage interval can hold. */
const ALL_DATES: Required<DateRange> = { from: "1900-01-01", to: "9999-12-31" };

/** Calendar days of the earliest stored bars re-read to confirm the history was not re-based. */
const EARLIEST_BARS_WINDOW_CALENDAR_DAYS = 30;

/**
 * Attempts at one publication: a fence re-established, a race lost and a missing chunk can each
 * cost one before the commit lands.
 */
const PUBLISH_ATTEMPTS = 4;

/** Series read at once by `readBenchmarkHistories`. */
const HISTORY_READ_CONCURRENCY = 4;

/**
 * How long a read waits for the hydration lock before it stops trying to repair the projection.
 *
 * A read that finds no resident head rebuilds it under the lock, so that concurrent readers after
 * a Redis loss publish once. But the read does not need the rebuild: PostgreSQL has its answer. The
 * coordinator's own wait is sized for a hydration — two minutes by default — and a request must not
 * be held that long because another process holds the lock, or because Redis answers reads and
 * grants no lock at all (out of memory under `noeviction`, a failed save, a read-only replica).
 * One second is several times what a rebuild of one series takes, so a reader behind a rebuild
 * still usually finds the projection resident.
 */
export const DEFAULT_RESIDENT_READ_LOCK_WAIT_MS = 1_000;

type SaveOutcome = {
  outcome: "SAVED" | "REPLACED" | "REFUSED";
  providerReads: number;
};

/**
 * Canonical benchmark loading.
 *
 * It is deliberately the *same* protocol as `CanonicalStockDataService`, applied to a different
 * domain object: check the cache, take the distributed hydration lock, subtract durable coverage
 * from the caller's target, ask the provider (paginated to completeness by the FMP adapter,
 * throttled by the shared provider gate and its 429 cooldown), persist to PostgreSQL, publish the
 * Redis projection. A worker never reaches FMP around this.
 *
 * Two things changed with the market-overview ETFs (`docs/decisions/etf-market-data-v1.md`):
 *
 * - **The Redis projection is the whole durable history.** Every publication describes every
 *   coverage interval PostgreSQL holds, built from one consistent snapshot, so a narrow read never
 *   narrows what is resident and a full-history read never rebuilds from PostgreSQL. Publications
 *   are immutable generations behind one head (`benchmark-cache.ts`), so a reader never combines
 *   two of them.
 * - **ETF series are re-base protected.** A read that may be on a new price basis is checked
 *   against the earliest stored bar before anything is saved, and a measured re-base replaces the
 *   whole history in one transaction under a new generation (`historical-price-basis-v1.md` §12).
 *   Index series cannot split and keep the plain path.
 *
 * What it deliberately does **not** do is calculate anything. A benchmark has no moving averages,
 * no oscillators and no intrinsic values: it is a comparison series, and materializing derived
 * state for it merely because it shares a provider with stocks would be waste.
 */
export class CanonicalBenchmarkDataService implements BenchmarkDataService {
  private readonly recentPriceFreshnessMs: number;
  private readonly recentTailCalendarDays: number;
  private readonly now: () => Date;
  private readonly onProviderRequest: (event: ProviderRequestEvent) => void;
  private readonly onPriceBasisEvent: (event: PriceBasisObservation) => void;
  private readonly onCacheEvent: (event: BenchmarkCacheObservation) => void;
  private readonly residentReadLockWaitMs: number;

  constructor(
    private readonly store: BenchmarkDataStore,
    private readonly provider: FmpBenchmarkProviderPort,
    private readonly cache: BenchmarkDataCache,
    private readonly coordinator: LoadCoordinator,
    options: CanonicalBenchmarkDataServiceOptions = {},
  ) {
    this.recentPriceFreshnessMs =
      options.recentPriceFreshnessMs ?? 6 * 60 * 60 * 1000;
    this.recentTailCalendarDays = options.recentTailCalendarDays ?? 10;
    this.now = options.now ?? (() => new Date());
    this.onProviderRequest = options.onProviderRequest ?? (() => {});
    this.onPriceBasisEvent = options.onPriceBasisEvent ?? (() => {});
    this.onCacheEvent = options.onCacheEvent ?? (() => {});
    this.residentReadLockWaitMs =
      options.residentReadLockWaitMs ?? DEFAULT_RESIDENT_READ_LOCK_WAIT_MS;
    if (
      !Number.isInteger(this.residentReadLockWaitMs) ||
      this.residentReadLockWaitMs <= 0
    ) {
      throw new Error("residentReadLockWaitMs must be a positive integer");
    }
  }

  async listBenchmarks(): Promise<BenchmarkWithSeries[]> {
    return this.store.listActiveBenchmarks();
  }

  /**
   * The benchmark a user is choosing, with the definition currently in force.
   *
   * Selection resolves by code because a code is what a user picks. **Execution never does**: a run
   * pins the series this returns and reads it back with `getSeries`, so a catalog change between
   * submission and execution cannot change what it compares against.
   */
  async getBenchmark(code: string): Promise<BenchmarkWithSeries> {
    const benchmark = await this.store.findBenchmarkByCode(code);
    if (!benchmark || !benchmark.isActive) {
      throw new BenchmarkNotFoundError(code);
    }
    return benchmark;
  }

  async getSeries(seriesId: string): Promise<BenchmarkSeries> {
    const series = await this.store.findSeriesById(seriesId);
    if (!series) {
      throw new BenchmarkNotFoundError(seriesId);
    }
    return series;
  }

  async ensureBenchmarkHydrated(
    series: BenchmarkSeries,
    required: Required<DateRange>,
  ): Promise<void> {
    const target = this.loadTarget(required);
    if (this.isReady(await this.cache.getHead(series.id), target)) {
      return;
    }
    await this.coordinator.run(this.resource(series), async (lease) => {
      // Re-check under the lock: a concurrent process may have materialized this range while this
      // one waited, and paying for the same provider read twice is exactly what the lock prevents.
      if (this.isReady(await this.cache.getHead(series.id), target)) {
        return;
      }
      await this.hydrateWithinLease(series, target, lease.assertOwned);
    });
  }

  async getBenchmarkDailyPrices(
    series: BenchmarkSeries,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]> {
    assertDateRange(range);
    const bounded = this.projectionRange(range);
    if (!bounded) {
      return [];
    }
    await this.ensureBenchmarkHydrated(series, bounded);
    const cached = await this.cache.readDailyPrices(series.id, bounded);
    if (cached) {
      return cached.rows;
    }
    // A cache miss is repaired from the durable store rather than from the provider: PostgreSQL is
    // the source of truth and Redis is a disposable projection of it.
    const rows = await this.store.getDailyPrices(series.id, bounded);
    await this.ensureBenchmarkResident(series);
    return rows;
  }

  // ── Worker reads: the resident projection, never the provider ─────────────────────────────

  async readBenchmarkHistory(
    series: BenchmarkSeries,
    range: Required<DateRange>,
  ): Promise<BenchmarkHistory> {
    assertDateRange(range);
    const bounded = { from: range.from, to: minDate(range.to, this.today()) };
    if (bounded.from > bounded.to) {
      return this.emptyHistory(series, "REDIS");
    }
    const resident = await this.readResident(series, () =>
      this.cache.readDailyPrices(series.id, bounded),
    );
    if (resident) {
      return this.redisHistory(series, resident, bounded);
    }
    const snapshot = await this.store.readHistorySnapshot(series.id, {
      range: bounded,
    });
    return this.postgresHistory(series, snapshot, bounded);
  }

  async readFullBenchmarkHistory(
    series: BenchmarkSeries,
    through?: LocalDate,
  ): Promise<BenchmarkHistory> {
    const end = minDate(through ?? this.today(), this.today());
    const resident = await this.readResident(series, () =>
      this.cache.readHistoryThrough(series.id, end),
    );
    if (resident) {
      return end < resident.from
        ? {
            ...this.emptyHistory(series, "REDIS"),
            basisGeneration: resident.head.basisGeneration,
          }
        : this.redisHistory(series, resident, { from: resident.from, to: end });
    }
    const snapshot = await this.store.readHistorySnapshot(series.id, {
      range: { from: ALL_DATES.from, to: end },
    });
    const from = [snapshot.coverage[0]?.from, snapshot.rows[0]?.date]
      .filter((date): date is LocalDate => date !== undefined)
      .sort()[0];
    if (from === undefined || end < from) {
      return {
        ...this.emptyHistory(series, "POSTGRESQL"),
        basisGeneration: snapshot.basisGeneration,
      };
    }
    return this.postgresHistory(series, snapshot, { from, to: end });
  }

  async readBenchmarkSession(
    series: BenchmarkSeries,
    date: LocalDate,
  ): Promise<BenchmarkDailyPrice | null> {
    const history = await this.readBenchmarkHistory(series, {
      from: date,
      to: date,
    });
    return history.rows[0] ?? null;
  }

  async readBenchmarkSessions(
    series: BenchmarkSeries,
    window: { through: LocalDate; sessions: number },
  ): Promise<BenchmarkHistory> {
    if (!Number.isInteger(window.sessions) || window.sessions <= 0) {
      throw new Error("sessions must be a positive integer");
    }
    const through = minDate(window.through, this.today());
    const resident = await this.readResident(series, () =>
      this.cache.readSessionsThrough(series.id, through, window.sessions),
    );
    if (resident) {
      return this.redisHistory(series, resident, {
        from: resident.rows[0]?.date ?? through,
        to: through,
      });
    }
    const snapshot = await this.store.readHistorySnapshot(series.id, {
      through,
      sessions: window.sessions,
    });
    return this.postgresHistory(series, snapshot, {
      from: snapshot.rows[0]?.date ?? through,
      to: through,
    });
  }

  async readBenchmarkHistories(
    series: readonly BenchmarkSeries[],
    range: Required<DateRange>,
  ): Promise<BenchmarkHistory[]> {
    const histories: BenchmarkHistory[] = new Array(series.length);
    for (
      let offset = 0;
      offset < series.length;
      offset += HISTORY_READ_CONCURRENCY
    ) {
      const batch = series.slice(offset, offset + HISTORY_READ_CONCURRENCY);
      const read = await Promise.all(
        batch.map((one) => this.readBenchmarkHistory(one, range)),
      );
      read.forEach((history, index) => {
        histories[offset + index] = history;
      });
    }
    return histories;
  }

  // ── Residency and the scheduled refresh ─────────────────────────────────────────────────────

  async ensureBenchmarkResident(
    series: BenchmarkSeries,
  ): Promise<BenchmarkResidency> {
    return this.repairResidency(series);
  }

  /**
   * Verifies the projection and republishes it under the hydration lock when it differs.
   *
   * `lock` bounds how long the caller is prepared to wait for that lock. A refresh or a bootstrap
   * leaves it out and waits as long as a hydration does; a read passes a short wait, because it has
   * PostgreSQL to answer from.
   */
  private async repairResidency(
    series: BenchmarkSeries,
    lock?: LoadRunOptions,
  ): Promise<BenchmarkResidency> {
    const verdict = await this.residency(series);
    if (verdict.resident) {
      return verdict.residency;
    }
    const repair = async (lease: LoadLease): Promise<BenchmarkResidency> => {
      // Re-checked under the lock, so concurrent rebuilds after a Redis loss publish once.
      const locked = await this.residency(series);
      if (locked.resident) {
        return locked.residency;
      }
      const head = await this.publishWithinLease(series, lease.assertOwned);
      if (head) {
        return {
          status: "REPUBLISHED",
          bars: head.bars,
          years: Object.keys(head.chunks).length,
          basisGeneration: head.basisGeneration,
        };
      }
      // Nothing durable to project is EMPTY; anything else that did not publish is reported as
      // such, never as an empty history: reads fall back to PostgreSQL until a publication lands.
      return {
        ...locked.residency,
        status: locked.residency.status === "EMPTY" ? "EMPTY" : "UNPUBLISHED",
      };
    };
    return lock
      ? this.coordinator.run(this.resource(series), repair, lock)
      : this.coordinator.run(this.resource(series), repair);
  }

  async benchmarkRefreshState(
    series: BenchmarkSeries,
  ): Promise<BenchmarkRefreshState> {
    const [coverage, latestBar, tail] = await Promise.all([
      this.allCoverage(series),
      this.store.getLatestDailyPriceDate(series.id),
      this.store.getDatasetState(
        series.id,
        "DAILY_PRICE",
        BENCHMARK_DAILY_PRICE_FRESHNESS_VARIANT,
      ),
    ]);
    const coverageEnd = coverage.at(-1)?.to;
    return {
      ...(coverageEnd ? { coverageEnd } : {}),
      ...(latestBar ? { latestBar } : {}),
      ...(tail?.lastSuccessfulSyncAt
        ? { lastTailSyncAt: tail.lastSuccessfulSyncAt }
        : {}),
    };
  }

  async refreshBenchmarkSeries(
    series: BenchmarkSeries,
    input: { expectedSession?: LocalDate },
  ): Promise<BenchmarkRefreshResult> {
    return this.coordinator.run(this.resource(series), async (lease) => {
      const coverage = await this.allCoverage(series);
      const first = coverage[0];
      const last = coverage.at(-1);
      if (!first || !last) {
        return {
          status: "NOT_BOOTSTRAPPED",
          basisGeneration: await this.store.getPriceBasisGeneration(series.id),
          providerReads: 0,
        };
      }
      const today = this.today();
      // One bounded read: the recent tail, the previous sync's unsettled tail, and whatever days
      // passed since coverage last ended. Never the history before them.
      const unsettledFrom = await this.unsettledTailStart(series, {
        from: first.from,
        to: today,
      });
      let from = minDate(
        addDays(today, -this.recentTailCalendarDays),
        addDays(last.to, 1),
      );
      if (unsettledFrom !== undefined) {
        from = minDate(from, unsettledFrom);
      }
      from = minDate(maxDate(from, first.from), today);
      const range = { from, to: today };

      // Read before the provider is: the save is refused if a replacement commits another
      // generation while this read is in flight, so bars on the old basis cannot land beside it.
      const generation = await this.store.getPriceBasisGeneration(series.id);
      const prices = await this.read(series, range, "SCHEDULED_REFRESH");
      lease.assertOwned();
      const saved = await this.saveRange(series, {
        range,
        prices,
        syncedAt: this.nowInstant(),
        tailDate: today,
        freshThrough: today,
        assertOwned: lease.assertOwned,
        expectedGeneration: generation,
      });
      await this.publishWithinLease(series, lease.assertOwned);

      const latestBar = await this.store.getLatestDailyPriceDate(series.id);
      const basisGeneration = await this.store.getPriceBasisGeneration(
        series.id,
      );
      const status =
        saved.outcome === "REPLACED"
          ? "REBASED"
          : saved.outcome === "REFUSED"
            ? "REBASE_REFUSED"
            : input.expectedSession !== undefined &&
                (latestBar === null || latestBar < input.expectedSession)
              ? "AWAITING_PUBLICATION"
              : "REFRESHED";
      return {
        status,
        ...(latestBar ? { latestBar } : {}),
        basisGeneration,
        providerReads: 1 + saved.providerReads,
      };
    });
  }

  // ── Hydration ───────────────────────────────────────────────────────────────────────────────

  private async hydrateWithinLease(
    series: BenchmarkSeries,
    target: Required<DateRange>,
    assertOwned: () => void,
  ): Promise<void> {
    const coverage = await this.store.getDatasetCoverage(
      series.id,
      "DAILY_PRICE",
      BENCHMARK_DAILY_PRICE_VARIANT,
      target,
    );
    // A gap that extends the leading edge also re-reads what the previous sync fetched while it
    // was still unsettled — the same rule as the stock loader's `unsettledTailStart` (AUD-04).
    const unsettledFrom = await this.unsettledTailStart(series, target);
    const missing = missingCoverageRanges(target, coverage).map((range) =>
      unsettledFrom !== undefined && range.to >= target.to
        ? { from: minDate(range.from, unsettledFrom), to: range.to }
        : range,
    );

    // The recent tail is mutable until a session closes, so it is re-read when the durable
    // freshness watermark has aged past the configured window — and only then. Reading it
    // unconditionally would send a provider request on every cold cache even when PostgreSQL is
    // already current, which is exactly what a deterministic environment (and a seeded E2E stack)
    // must not do.
    // Only a read that actually reaches the present has a mutable tail to refresh. A historical
    // window ends years ago: every bar in it closed long before, so re-reading its last ten days
    // would be provider traffic for data that cannot have changed.
    const reachesPresent = target.to >= this.today();
    const tail =
      reachesPresent && (await this.isTailStale(series))
        ? this.recentTailRange(target, unsettledFrom)
        : null;
    const ranges = tail ? [...missing, tail] : missing;

    const syncedAt = this.nowInstant();
    // Read before the provider is, for the reason `refreshBenchmarkSeries` gives.
    const generation = await this.store.getPriceBasisGeneration(series.id);
    for (const range of ranges) {
      const prices = await this.read(
        series,
        range,
        tail !== null && range === tail
          ? "RECENT_TAIL_STALE"
          : "MISSING_COVERAGE",
      );
      assertOwned();
      const saved = await this.saveRange(series, {
        range,
        prices,
        syncedAt,
        tailDate: target.to,
        // Only a read that actually reached *today* may say the tail is fresh. Backfilling an
        // older gap — or serving a historical window that ends in 2010 — tells us nothing about
        // today's bar, and advancing the watermark for it would let a genuinely stale tail pass
        // the freshness check on the next read.
        ...(reachesPresent && range.to >= target.to
          ? { freshThrough: target.to }
          : {}),
        assertOwned,
        expectedGeneration: generation,
      });
      // A replacement read and saved the whole history; a refused one saves nothing beside it.
      if (saved.outcome !== "SAVED") {
        break;
      }
    }

    await this.publishWithinLease(series, assertOwned);
  }

  /**
   * Saves one provider read, with the re-base protection applied to ETF series.
   *
   * A read that would add or change a stored bar is saved only once the earliest stored bars
   * confirm the provider has not re-based the history since (`historical-price-basis-v1.md` §7,
   * rule 2 — the stock loader's rule). Unchanged, the read is saved: a changed recent bar is an
   * ordinary correction. Changed, the whole history is read and compared, and a measured re-base
   * replaces it in one transaction. Bars after a split-sized move at the newest edge are held back
   * until the move is confirmed (`benchmarkExDateHold`).
   */
  private async saveRange(
    series: BenchmarkSeries,
    input: {
      range: Required<DateRange>;
      prices: readonly BenchmarkDailyPrice[];
      syncedAt: Instant;
      tailDate: LocalDate;
      freshThrough?: LocalDate;
      assertOwned: () => void;
      /** The generation the provider read was made under; see `saveDailyPriceSync`. */
      expectedGeneration: number;
    },
  ): Promise<SaveOutcome> {
    let prices = [...input.prices];
    let successfulCoverage: Required<DateRange>[] = [input.range];
    let freshThrough = input.freshThrough;
    let providerReads = 0;

    if (series.seriesType === "ETF_PROXY") {
      const newestStored = await this.newestStoredBar(series);
      if (newestStored !== undefined && prices.length > 0) {
        const stored = await this.store.getDailyPrices(series.id, input.range);
        if (changesStoredBenchmarkBars(stored, prices)) {
          providerReads += 1;
          if (!(await this.earliestStoredBarUnchanged(series))) {
            const replacement = await this.replaceHistoryWithinLease(
              series,
              input.assertOwned,
            );
            providerReads += 1;
            if (replacement !== "UNCHANGED") {
              return { outcome: replacement, providerReads };
            }
            this.onPriceBasisEvent({
              securityId: series.id,
              symbol: series.providerSymbol,
              outcome: "EARLIEST_ROW_UNCONFIRMED",
              detail: `benchmark:${series.id}`,
            });
          }
        }
      }
      const hold = benchmarkExDateHold({ newestStored, loaded: prices });
      if (hold.heldFrom !== undefined) {
        this.onPriceBasisEvent({
          securityId: series.id,
          symbol: series.providerSymbol,
          outcome: "HELD",
          heldFrom: hold.heldFrom,
          detail: `benchmark:${series.id}`,
        });
        prices = hold.rows;
        successfulCoverage =
          hold.heldFrom > input.range.from
            ? [{ from: input.range.from, to: addDays(hold.heldFrom, -1) }]
            : [];
        freshThrough = undefined;
      }
    }

    await this.store.saveDailyPriceSync({
      seriesId: series.id,
      prices,
      successfulCoverage,
      syncedAt: input.syncedAt,
      tailDate: input.tailDate,
      ...(freshThrough !== undefined ? { freshThrough } : {}),
      assertOwned: input.assertOwned,
      expectedGeneration: input.expectedGeneration,
    });
    return { outcome: "SAVED", providerReads };
  }

  /**
   * Whether the earliest stored bars still read as they were stored (§7, rule 2).
   *
   * A re-base rescales every bar before its ex-date, so the earliest ones change whenever any
   * re-base happened, however long ago. A window with no session in common confirms nothing, and
   * the caller compares the whole history instead.
   */
  private async earliestStoredBarUnchanged(
    series: BenchmarkSeries,
  ): Promise<boolean> {
    const earliest = await this.store.getEarliestDailyPriceDate(series.id);
    if (earliest === null) {
      return true;
    }
    const window = {
      from: earliest,
      to: addDays(earliest, EARLIEST_BARS_WINDOW_CALENDAR_DAYS),
    };
    const stored = await this.store.getDailyPrices(series.id, window);
    const fresh = new Map(
      (await this.read(series, window, "PRICE_BASIS_EARLIEST_ROW")).map(
        (bar) => [bar.date, bar.close],
      ),
    );
    const compared = stored.find((bar) => fresh.has(bar.date));
    if (!compared) {
      return false;
    }
    return !closesDiffer(compared.close, fresh.get(compared.date) as number);
  }

  /**
   * Reads the whole covered history again and, when it measures as re-based, replaces the stored
   * one in one transaction under the next generation (§8–§9).
   *
   * The generation fence is raised, and the old generation's projection removed with it, inside the
   * replacement's transaction just before it commits. Until then readers are served the old
   * generation, which is still what PostgreSQL holds; from then on the old generation can never be
   * published again, and a reader without a head reads PostgreSQL, which the replacement changes
   * atomically. The caller republishes the whole history afterwards.
   *
   * Refused, and nothing written, when the provider no longer returns more than 1 % of the stored
   * sessions: the old history then stays, consistent with itself, and the next refresh asks again.
   */
  private async replaceHistoryWithinLease(
    series: BenchmarkSeries,
    assertOwned: () => void,
  ): Promise<"REPLACED" | "REFUSED" | "UNCHANGED"> {
    const started = performance.now();
    try {
      const [coverage, earliest, generation] = await Promise.all([
        this.allCoverage(series),
        this.store.getEarliestDailyPriceDate(series.id),
        this.store.getPriceBasisGeneration(series.id),
      ]);
      const today = this.today();
      const from =
        [coverage[0]?.from, earliest ?? undefined]
          .filter((date): date is string => date !== undefined)
          .sort()[0] ?? today;
      const readRange = { from, to: today };
      const fresh = (await this.read(series, readRange, "PRICE_REBASE")).sort(
        (left, right) => (left.date < right.date ? -1 : 1),
      );
      const stored = await this.store.getDailyPrices(series.id, readRange);
      const detectedAt = this.nowInstant();
      const comparison = comparePriceHistories({
        securityId: series.id,
        generation: generation + 1,
        detectedAt,
        stored,
        fresh,
      });
      if (
        fresh.length === 0 ||
        comparison.storedOnly.length > stored.length * UNEXPLAINED_SESSION_SHARE
      ) {
        this.onPriceBasisEvent({
          securityId: series.id,
          symbol: series.providerSymbol,
          outcome: "REPLACEMENT_REFUSED",
          storedOnlySessions: comparison.storedOnly.length,
          detail: `benchmark:${series.id}: ${fresh.length} provider sessions against ${stored.length} stored`,
        });
        return "REFUSED";
      }
      if (!comparison.changed) {
        return "UNCHANGED";
      }

      // The hold compares the newest bars with the bar before them on the **new** basis: the
      // provider's own bar for the newest stored session, never the stored one, which a re-base has
      // just shown to be on the old basis.
      const newestStoredDate = stored.at(-1)?.date;
      const base =
        newestStoredDate === undefined
          ? undefined
          : fresh.filter((bar) => bar.date <= newestStoredDate).at(-1);
      const hold = benchmarkExDateHold({ newestStored: base, loaded: fresh });
      const replaced = await this.store.replaceDailyPriceHistory({
        seriesId: series.id,
        expectedGeneration: generation,
        prices: hold.rows,
        events: comparison.events,
        coverage: {
          from: readRange.from,
          to:
            hold.heldFrom === undefined
              ? readRange.to
              : maxDate(readRange.from, addDays(hold.heldFrom, -1)),
        },
        syncedAt: detectedAt,
        tailDate: today,
        ...(hold.heldFrom === undefined ? { freshThrough: today } : {}),
        assertOwned,
        // Inside the transaction, holding the series write lock, just before the commit: the
        // fence moves to the new generation and, atomically, the old generation's projection goes.
        // From then on no head of the old generation can be committed — however stale its
        // publisher, whether or not this process still holds its lease — so nothing of the old basis
        // is visible from Redis once the new one is committed. A failure rolls the replacement back.
        beforeCommit: (next) => this.cache.fenceGeneration(series.id, next),
      });
      this.onPriceBasisEvent({
        securityId: series.id,
        symbol: series.providerSymbol,
        outcome: "REPLACED",
        generation: replaced.generation,
        measuredEvents: comparison.events.filter(
          (event) => event.kind === "MEASURED",
        ).length,
        unexplainedEvents: comparison.events.filter(
          (event) => event.kind === "UNEXPLAINED",
        ).length,
        storedOnlySessions: comparison.storedOnly.length,
        ...(hold.heldFrom === undefined ? {} : { heldFrom: hold.heldFrom }),
        durationMs: Math.round(performance.now() - started),
        detail: `benchmark:${series.id}`,
      });
      return "REPLACED";
    } catch (err) {
      this.onPriceBasisEvent({
        securityId: series.id,
        symbol: series.providerSymbol,
        outcome: "REPLACEMENT_FAILED",
        durationMs: Math.round(performance.now() - started),
        err,
        detail: `benchmark:${series.id}`,
      });
      throw err;
    }
  }

  // ── Publication ─────────────────────────────────────────────────────────────────────────────

  /**
   * Publishes the series' whole durable history as one new head, reusing every year whose digest
   * the current head already publishes and staging only the years that changed.
   *
   * Never fails the caller: PostgreSQL is already committed, so a publication that cannot commit
   * leaves reads to fall back to PostgreSQL and the next publication to try again.
   */
  private async publishWithinLease(
    series: BenchmarkSeries,
    assertOwned: () => void,
  ): Promise<BenchmarkCacheHead | null> {
    const started = performance.now();
    const failed = (err: unknown): null => {
      this.onCacheEvent({
        seriesId: series.id,
        outcome: "FAILED",
        durationMs: Math.round(performance.now() - started),
        ...(err === undefined ? {} : { err }),
      });
      return null;
    };
    // Reuse unchanged years unless a commit just found a chunk missing or lost a race: the retry
    // is then rebuilt from PostgreSQL year by year.
    let reuse = true;
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
      let observed: ObservedBenchmarkHead | null;
      let snapshot: Awaited<
        ReturnType<BenchmarkDataStore["readPublicationSnapshot"]>
      >;
      try {
        observed = await this.cache.getHead(series.id);
        const reusable =
          reuse && observed && isCurrentBenchmarkHead(observed.head)
            ? new Map(
                Object.entries(observed.head.chunks).map(
                  ([year, digest]) => [Number(year), digest] as const,
                ),
              )
            : new Map<number, string>();
        snapshot = await this.store.readPublicationSnapshot(
          series.id,
          reusable,
        );
        if (snapshot.coverage.length === 0) {
          // Nothing durable to project; a head left behind is dropped so it cannot claim otherwise.
          if (observed) {
            await this.cache.invalidateManifest(series.id);
          }
          return null;
        }
        // A head commits only under the series' generation fence. Checked before anything is
        // staged, so a publication that would be refused writes nothing: when the fence is missing
        // (Redis lost it) or differs (a replacement is committing, or committed after this snapshot
        // was read), it is re-established from PostgreSQL under the series write lock — which
        // waits out a replacement in flight — and a snapshot older than that generation is read
        // again. The commit re-checks the fence atomically; this only saves the wasted work.
        if (
          (await this.cache.getGenerationFence(series.id)) !==
          snapshot.basisGeneration
        ) {
          const committed = await this.establishGenerationFence(series);
          if (committed !== snapshot.basisGeneration) {
            this.onCacheEvent({ seriesId: series.id, outcome: "FENCED" });
            continue;
          }
        }
      } catch (err) {
        return failed(err);
      }
      const head = this.headFor(series, snapshot);
      // Outside the error handling on purpose: a lost lease must stop the caller's writes, while a
      // cache failure is harmless because PostgreSQL is already committed and reads fall back to it.
      assertOwned();
      let outcome: Awaited<ReturnType<BenchmarkDataCache["publish"]>>;
      try {
        outcome = await this.cache.publish({
          expected: observed,
          head,
          stage: snapshot.rows,
        });
      } catch (err) {
        return failed(err);
      }
      if (outcome === "COMMITTED") {
        this.onCacheEvent({
          seriesId: series.id,
          outcome: "PUBLISHED",
          stagedYears: snapshot.rows.size,
          years: snapshot.years.length,
          bars: head.bars,
          basisGeneration: head.basisGeneration,
          durationMs: Math.round(performance.now() - started),
        });
        return head;
      }
      this.onCacheEvent({ seriesId: series.id, outcome });
      if (outcome === "FENCED") {
        // The fence moved between the check and the commit: a replacement raised it. Wait for it
        // under the lock and publish what it committed.
        try {
          await this.establishGenerationFence(series);
        } catch (err) {
          return failed(err);
        }
      } else {
        reuse = false;
      }
    }
    return failed(undefined);
  }

  /**
   * Sets the generation fence to what PostgreSQL has committed, holding the series write lock, and
   * returns it.
   *
   * Every fence write happens under that lock — a replacement raises it inside its transaction,
   * this re-establishes it — so the writes are ordered with the generation changes themselves: a
   * replacement in flight is waited for, and the fence is never set behind a generation that has
   * committed. It also repairs a fence a replacement raised and then rolled back.
   */
  private async establishGenerationFence(
    series: BenchmarkSeries,
  ): Promise<number> {
    return this.store.withPriceBasisLock(series.id, async (generation) => {
      await this.cache.fenceGeneration(series.id, generation);
      return generation;
    });
  }

  private headFor(
    series: BenchmarkSeries,
    snapshot: {
      basisGeneration: number;
      coverage: Required<DateRange>[];
      years: BenchmarkYearDigest[];
    },
  ): BenchmarkCacheHead {
    const firstYear = snapshot.years[0];
    const lastYear = snapshot.years.at(-1);
    return {
      seriesId: series.id,
      chunkEncodingVersion: BENCHMARK_CHUNK_ENCODING_VERSION,
      priceDatasetVersion: BENCHMARK_PRICE_DATASET_VERSION,
      basisGeneration: snapshot.basisGeneration,
      residentRanges: snapshot.coverage,
      chunks: Object.fromEntries(
        snapshot.years.map((year) => [String(year.year), year.digest]),
      ),
      bars: snapshot.years.reduce((sum, year) => sum + year.bars, 0),
      ...(firstYear ? { firstDate: firstYear.firstDate } : {}),
      ...(lastYear ? { lastDate: lastYear.lastDate } : {}),
      materializedAt: this.nowInstant(),
    };
  }

  /**
   * Whether the published head is a complete image of PostgreSQL: the same coverage, the same
   * generation and the same digest for every year.
   */
  private async residency(series: BenchmarkSeries): Promise<{
    resident: boolean;
    residency: BenchmarkResidency;
  }> {
    const [observed, digests, coverage, basisGeneration] = await Promise.all([
      this.cache.getHead(series.id),
      this.store.getDailyPriceYearDigests(series.id),
      this.allCoverage(series),
      this.store.getPriceBasisGeneration(series.id),
    ]);
    const residency: BenchmarkResidency = {
      status: "RESIDENT",
      bars: digests.reduce((sum, year) => sum + year.bars, 0),
      years: digests.length,
      basisGeneration,
    };
    if (coverage.length === 0) {
      // Nothing durable to project. A head left behind (a reset of the durable rows) still claims
      // a history, so it is not "resident": the publication that follows drops it.
      return {
        resident: observed === null,
        residency: { ...residency, status: "EMPTY" },
      };
    }
    const head = observed?.head;
    const matches =
      head !== undefined &&
      isCurrentBenchmarkHead(head) &&
      head.basisGeneration === basisGeneration &&
      sameRanges(head.residentRanges, coverage) &&
      Object.keys(head.chunks).length === digests.length &&
      digests.every((year) => head.chunks[String(year.year)] === year.digest);
    // A head that names a chunk Redis no longer holds — deleted as unreadable, or evicted under an
    // accepted `allkeys-*` policy — answers no read, so it is not resident either: republishing
    // rebuilds the missing years from PostgreSQL.
    const resident =
      matches && head !== undefined && (await this.cache.chunksPresent(head));
    return { resident, residency };
  }

  /**
   * A resident read, rebuilding the projection from PostgreSQL once when Redis cannot answer but
   * PostgreSQL could — a Redis restart, an invalidated head — so a cache loss costs one rebuild and
   * never a provider request.
   */
  private async readResident<T>(
    series: BenchmarkSeries,
    read: () => Promise<T | null>,
  ): Promise<T | null> {
    // A Redis that cannot be read at all is an outage and fails the read (`AGENTS.md` invariant
    // 16): nothing degrades to PostgreSQL-only then.
    const first = await read();
    if (first) {
      return first;
    }
    let residency: BenchmarkResidency;
    try {
      // Bounded: the read waits a moment for the lock, never as long as a hydration would.
      residency = await this.repairResidency(series, {
        waitMs: this.residentReadLockWaitMs,
      });
    } catch (err) {
      // The repair failed — the hydration lock was not had in time, or its lease was lost while
      // republishing — but the read still has an answer: PostgreSQL's, which the caller reads.
      this.onCacheEvent({ seriesId: series.id, outcome: "FAILED", err });
      return null;
    }
    if (residency.status !== "REPUBLISHED") {
      return null;
    }
    return read();
  }

  // ── Coverage and freshness ──────────────────────────────────────────────────────────────────

  /**
   * Whether the durable tail watermark has aged past the freshness window.
   *
   * The watermark is PostgreSQL state, not a cache entry, so a Redis flush cannot make the loader
   * think the series is stale and re-download it.
   */
  private async isTailStale(series: BenchmarkSeries): Promise<boolean> {
    const state = await this.store.getDatasetState(
      series.id,
      "DAILY_PRICE",
      BENCHMARK_DAILY_PRICE_FRESHNESS_VARIANT,
    );
    if (!state?.lastSuccessfulSyncAt) {
      return true;
    }
    const age = this.now().valueOf() - Date.parse(state.lastSuccessfulSyncAt);
    return !Number.isFinite(age) || age > this.recentPriceFreshnessMs;
  }

  /**
   * Whether a published head answers `target` without the lock: it publishes a resident range that
   * holds the whole target, and — for a target that reaches today, whose tail is still mutable —
   * it was published inside the freshness window. A historical target is answered however old the
   * head: every bar in it closed long ago, and a re-base republishes the head anyway.
   */
  private isReady(
    observed: ObservedBenchmarkHead | null,
    target: Required<DateRange>,
  ): boolean {
    if (!observed || !isCurrentBenchmarkHead(observed.head)) {
      return false;
    }
    if (!residentRangeCovering(observed.head.residentRanges, target)) {
      return false;
    }
    return target.to < this.today() || !this.isStale(observed.head);
  }

  /**
   * The range one hydration must materialize: what the caller asked for, and nothing narrower.
   *
   * Deliberately no retained-horizon floor. This service's only consumer is a backtest, whose
   * period is immutable and was validated against the selectable horizon **at submission**; a
   * floor computed from the current clock would silently shorten it later, which is exactly the
   * defect. Nothing prunes benchmark rows, so history that was once loaded is still there to be
   * read — and where it genuinely is not, {@link missingBenchmarkCoverage} says so rather than a
   * clip quietly deciding.
   *
   * Still clamped at the upper end, because a range cannot be materialized into the future. What is
   * *published* to Redis is not this range but the whole durable history, so a narrow target never
   * narrows the projection.
   */
  private loadTarget(required: Required<DateRange>): Required<DateRange> {
    const today = this.today();
    return {
      from: minDate(required.from, today),
      to: minDate(required.to, today),
    };
  }

  /**
   * What a read may return: **exactly** the caller's range.
   *
   * The single consumer is a backtest — the execution calendar and the comparison series both come
   * from here — and a backtest's period is immutable. Any bound derived from the clock at execution
   * time is therefore wrong by construction, not merely inconvenient: it re-decides what a run
   * simulates months after the run recorded it. So there is no floor. If the rows are there the run
   * reads them; if they are not, {@link missingBenchmarkCoverage} reports it against the period
   * that was *requested* and the worker fails the attempt explicitly rather than simulating a
   * shorter one.
   */
  private projectionRange(
    requested: Required<DateRange>,
  ): Required<DateRange> | null {
    return requested.from <= requested.to ? { ...requested } : null;
  }

  /**
   * Ranges inside `period` the series has no durable coverage for.
   *
   * Empty means the provider was asked for the whole period with complete requests, so whatever
   * bars exist are all there are — an empty prefix is then the series' own history starting later,
   * not a gap. Anything else means the canonical data a run needs is genuinely unavailable, and a
   * run must fail explicitly rather than execute a shorter period than the one it recorded.
   */
  async missingBenchmarkCoverage(
    series: BenchmarkSeries,
    period: Required<DateRange>,
  ): Promise<Required<DateRange>[]> {
    if (period.from > period.to) {
      return [period];
    }
    // Against the period the run **recorded**, never a clipped version of it. Asking only about
    // the range that survived a clip is what made a silently shortened run pass: the answer always
    // agreed with the clip, because the clip had chosen the question.
    const coverage = await this.store.getDatasetCoverage(
      series.id,
      "DAILY_PRICE",
      BENCHMARK_DAILY_PRICE_VARIANT,
      period,
    );
    return missingCoverageRanges(period, coverage);
  }

  private recentTailRange(
    target: Required<DateRange>,
    unsettledFrom: string | undefined,
  ): Required<DateRange> | null {
    const tailFrom = maxDate(
      addDays(target.to, -this.recentTailCalendarDays),
      target.from,
    );
    const from =
      unsettledFrom === undefined ? tailFrom : minDate(tailFrom, unsettledFrom);
    return from <= target.to ? { from, to: target.to } : null;
  }

  /**
   * The start of the previous leading-edge sync's own tail window, or undefined.
   *
   * Re-reading only the tail behind today leaves a bar the previous sync fetched while it was
   * still in progress — or a session it asked for before it existed — wrong for good once the next
   * sync is more than `recentTailCalendarDays` later. The execution calendar is this series' own
   * bars, so a session lost that way would disappear from every backtest.
   */
  private async unsettledTailStart(
    series: BenchmarkSeries,
    target: Required<DateRange>,
  ): Promise<string | undefined> {
    const state = await this.store.getDatasetState(
      series.id,
      "DAILY_PRICE",
      BENCHMARK_DAILY_PRICE_FRESHNESS_VARIANT,
    );
    const previousTail = state?.latestDate;
    if (previousTail === undefined || previousTail > target.to) {
      return undefined;
    }
    return maxDate(
      addDays(previousTail, -this.recentTailCalendarDays),
      target.from,
    );
  }

  private async allCoverage(
    series: BenchmarkSeries,
  ): Promise<Required<DateRange>[]> {
    return this.store.getDatasetCoverage(
      series.id,
      "DAILY_PRICE",
      BENCHMARK_DAILY_PRICE_VARIANT,
      ALL_DATES,
    );
  }

  private async newestStoredBar(
    series: BenchmarkSeries,
  ): Promise<BenchmarkDailyPrice | undefined> {
    const latest = await this.store.getLatestDailyPriceDate(series.id);
    if (latest === null) {
      return undefined;
    }
    const [bar] = await this.store.getDailyPrices(series.id, {
      from: latest,
      to: latest,
    });
    return bar;
  }

  /** One provider read, explained first. */
  private async read(
    series: BenchmarkSeries,
    range: Required<DateRange>,
    reason: ProviderRequestReason,
  ): Promise<BenchmarkDailyPrice[]> {
    this.onProviderRequest({
      symbol: series.providerSymbol,
      securityId: series.id,
      dataset: "DAILY_PRICE",
      reason,
      from: range.from,
      to: range.to,
      detail: `benchmark:${series.id}`,
    });
    return this.provider.getBenchmarkDailyPrices(
      series.providerSymbol,
      series.id,
      range,
    );
  }

  /**
   * A read answered from one Redis publication. The head is a complete image of PostgreSQL, so
   * what it does not cover is exactly what PostgreSQL does not cover: `missing` is computed from it,
   * with no database call.
   */
  private redisHistory(
    series: BenchmarkSeries,
    read: BenchmarkCacheRead,
    period: Required<DateRange>,
  ): BenchmarkHistory {
    return {
      seriesId: series.id,
      basisGeneration: read.head.basisGeneration,
      rows: read.rows,
      missing: missingCoverageRanges(period, read.head.residentRanges),
      source: "REDIS",
    };
  }

  /** A read answered from one PostgreSQL snapshot: rows, generation and coverage together. */
  private postgresHistory(
    series: BenchmarkSeries,
    snapshot: BenchmarkHistorySnapshot,
    period: Required<DateRange>,
  ): BenchmarkHistory {
    return {
      seriesId: series.id,
      basisGeneration: snapshot.basisGeneration,
      rows: snapshot.rows,
      missing: missingCoverageRanges(period, snapshot.coverage),
      source: "POSTGRESQL",
    };
  }

  private emptyHistory(
    series: BenchmarkSeries,
    source: BenchmarkHistory["source"],
  ): BenchmarkHistory {
    return {
      seriesId: series.id,
      basisGeneration: 0,
      rows: [],
      missing: [],
      source,
    };
  }

  private isStale(head: { materializedAt: string }): boolean {
    const age = this.now().valueOf() - Date.parse(head.materializedAt);
    return !Number.isFinite(age) || age > this.recentPriceFreshnessMs;
  }

  private resource(series: BenchmarkSeries): string {
    return `benchmark:hydrate:${series.id}`;
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private nowInstant(): Instant {
    return this.now().toISOString();
  }
}

function sameRanges(
  left: readonly Required<DateRange>[],
  right: readonly Required<DateRange>[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (range, index) =>
        range.from === right[index]?.from && range.to === right[index]?.to,
    )
  );
}
