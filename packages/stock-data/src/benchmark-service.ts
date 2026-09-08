import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  BenchmarkWithSeries,
  DateRange,
} from "@intrinsic/domain";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import { yearsInRange } from "./cache.js";
import {
  BENCHMARK_DAILY_PRICE_FRESHNESS_VARIANT,
  BENCHMARK_DAILY_PRICE_VARIANT,
  BENCHMARK_PRICE_DATASET_VERSION,
  type BenchmarkDataCache,
  type BenchmarkDataService,
  type BenchmarkDataStore,
} from "./benchmark-ports.js";
import type { LoadCoordinator } from "./coordination.js";
import type { ProviderRequestEvent } from "./service.js";
import {
  addDays,
  assertDateRange,
  maxDate,
  minDate,
  missingCoverageRanges,
  subtractYears,
} from "./dates.js";

export class BenchmarkNotFoundError extends Error {
  constructor(code: string) {
    super(`Benchmark '${code}' was not found`);
    this.name = "BenchmarkNotFoundError";
  }
}

export type CanonicalBenchmarkDataServiceOptions = {
  historyYears?: number;
  recentPriceFreshnessMs?: number;
  recentTailCalendarDays?: number;
  now?: () => Date;
  /** Called before each provider request, with the reason. See `CanonicalStockDataServiceOptions`. */
  onProviderRequest?: (event: ProviderRequestEvent) => void;
};

/**
 * Canonical benchmark loading.
 *
 * It is deliberately the *same* protocol as `CanonicalStockDataService`, applied to a different
 * domain object: check the cache manifest, take the distributed hydration lock, subtract durable
 * coverage from the caller's target, ask the provider (paginated to completeness by the FMP
 * adapter, throttled by the shared provider gate and its 429 cooldown), persist to PostgreSQL,
 * publish yearly Redis chunks. A worker never reaches FMP around this.
 *
 * What it deliberately does **not** do is calculate anything. A benchmark has no moving averages,
 * no oscillators and no intrinsic values: it is a comparison series, and materializing derived
 * state for it merely because it shares a provider with stocks would be waste.
 */
export class CanonicalBenchmarkDataService implements BenchmarkDataService {
  private readonly historyYears: number;
  private readonly recentPriceFreshnessMs: number;
  private readonly recentTailCalendarDays: number;
  private readonly now: () => Date;
  private readonly onProviderRequest: (event: ProviderRequestEvent) => void;

  constructor(
    private readonly store: BenchmarkDataStore,
    private readonly provider: FmpBenchmarkProviderPort,
    private readonly cache: BenchmarkDataCache,
    private readonly coordinator: LoadCoordinator,
    options: CanonicalBenchmarkDataServiceOptions = {},
  ) {
    this.historyYears = options.historyYears ?? 30;
    this.recentPriceFreshnessMs =
      options.recentPriceFreshnessMs ?? 6 * 60 * 60 * 1000;
    this.recentTailCalendarDays = options.recentTailCalendarDays ?? 10;
    this.now = options.now ?? (() => new Date());
    this.onProviderRequest = options.onProviderRequest ?? (() => {});
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
    const manifest = await this.cache.getManifest(series.id);
    if (
      manifest &&
      manifest.coverageStart <= target.from &&
      manifest.coverageEnd >= target.to &&
      !this.isStale(manifest)
    ) {
      return;
    }
    await this.coordinator.run(this.resource(series), async (lease) => {
      // Re-check under the lock: a concurrent process may have materialized this range while this
      // one waited, and paying for the same provider read twice is exactly what the lock prevents.
      const locked = await this.cache.getManifest(series.id);
      if (
        locked &&
        locked.coverageStart <= target.from &&
        locked.coverageEnd >= target.to &&
        !this.isStale(locked)
      ) {
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
      return cached;
    }
    // A cache miss is repaired from the durable store rather than from the provider: PostgreSQL is
    // the source of truth and Redis is a disposable projection of it.
    const rows = await this.store.getDailyPrices(series.id, bounded);
    await this.publish(series, bounded, rows);
    return rows;
  }

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
    const missing = missingCoverageRanges(target, coverage);

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
        ? this.recentTailRange(target)
        : null;
    const ranges = tail ? [...missing, tail] : missing;

    const syncedAt = this.now().toISOString();
    for (const range of ranges) {
      this.onProviderRequest({
        symbol: series.providerSymbol,
        securityId: series.id,
        dataset: "DAILY_PRICE",
        reason:
          tail !== null && range === tail
            ? "RECENT_TAIL_STALE"
            : "MISSING_COVERAGE",
        from: range.from,
        to: range.to,
        detail: `benchmark:${series.id}`,
      });
      const prices = await this.provider.getBenchmarkDailyPrices(
        series.providerSymbol,
        series.id,
        range,
      );
      assertOwned();
      await this.store.saveDailyPriceSync({
        seriesId: series.id,
        prices,
        successfulCoverage: [range],
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
      });
    }

    const rows = await this.store.getDailyPrices(series.id, target);
    assertOwned();
    await this.publish(series, target, rows);
  }

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

  private async publish(
    series: BenchmarkSeries,
    target: Required<DateRange>,
    rows: readonly BenchmarkDailyPrice[],
  ): Promise<void> {
    await this.cache.writeDailyPriceYears(
      series.id,
      rows,
      yearsInRange(target),
    );
    await this.cache.setManifest({
      seriesId: series.id,
      coverageStart: target.from,
      coverageEnd: target.to,
      materializedAt: this.now().toISOString(),
      priceDatasetVersion: BENCHMARK_PRICE_DATASET_VERSION,
    });
  }

  /**
   * The caller's range widened to today and clamped to the retention horizon.
   *
   * The upper bound is always today for the same reason the stock loader uses it: a resident series
   * is only usable while its tail is current, and freshness keys off it.
   */
  /**
   * The range one hydration must leave materialized: what the caller asked for, clamped to the
   * retention horizon and to today.
   *
   * Deliberately **not** widened to today. A backtest of 2005–2010 has no use for 2011 onwards,
   * and materializing it would fetch two decades it never asked for, write yearly Redis chunks
   * through the present, and re-read a "recent tail" that is fifteen years old. The stock loader
   * pays for its caller's range plus the warm-up its calculations need; this now matches it.
   *
   * Existing resident coverage is never narrowed by this — coverage is unioned, and a later read
   * that does reach today materializes the suffix incrementally.
   */
  private loadTarget(required: Required<DateRange>): Required<DateRange> {
    const today = this.today();
    const horizonStart = subtractYears(today, this.historyYears);
    return {
      from: maxDate(minDate(required.from, today), horizonStart),
      to: maxDate(minDate(required.to, today), horizonStart),
    };
  }

  private projectionRange(
    requested: Required<DateRange>,
  ): Required<DateRange> | null {
    const today = this.today();
    const from = maxDate(
      requested.from,
      subtractYears(today, this.historyYears),
    );
    const to = minDate(requested.to, today);
    return from <= to ? { from, to } : null;
  }

  private recentTailRange(
    target: Required<DateRange>,
  ): Required<DateRange> | null {
    const from = maxDate(
      addDays(target.to, -this.recentTailCalendarDays),
      target.from,
    );
    return from <= target.to ? { from, to: target.to } : null;
  }

  private isStale(manifest: { materializedAt: string }): boolean {
    const age = this.now().valueOf() - Date.parse(manifest.materializedAt);
    return !Number.isFinite(age) || age > this.recentPriceFreshnessMs;
  }

  private resource(series: BenchmarkSeries): string {
    return `benchmark:hydrate:${series.id}`;
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }
}
