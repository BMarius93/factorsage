import type {
  Benchmark,
  BenchmarkDailyPrice,
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
  }

  async listBenchmarks(): Promise<Benchmark[]> {
    return this.store.listActiveBenchmarks();
  }

  async getBenchmark(code: string): Promise<Benchmark> {
    const benchmark = await this.store.findBenchmarkByCode(code);
    if (!benchmark || !benchmark.isActive) {
      throw new BenchmarkNotFoundError(code);
    }
    return benchmark;
  }

  async ensureBenchmarkHydrated(
    benchmark: Benchmark,
    required: Required<DateRange>,
  ): Promise<void> {
    const target = this.loadTarget(required);
    const manifest = await this.cache.getManifest(benchmark.id);
    if (
      manifest &&
      manifest.coverageStart <= target.from &&
      manifest.coverageEnd >= target.to &&
      !this.isStale(manifest)
    ) {
      return;
    }
    await this.coordinator.run(this.resource(benchmark), async (lease) => {
      // Re-check under the lock: a concurrent process may have materialized this range while this
      // one waited, and paying for the same provider read twice is exactly what the lock prevents.
      const locked = await this.cache.getManifest(benchmark.id);
      if (
        locked &&
        locked.coverageStart <= target.from &&
        locked.coverageEnd >= target.to &&
        !this.isStale(locked)
      ) {
        return;
      }
      await this.hydrateWithinLease(benchmark, target, lease.assertOwned);
    });
  }

  async getBenchmarkDailyPrices(
    benchmark: Benchmark,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]> {
    assertDateRange(range);
    const bounded = this.projectionRange(range);
    if (!bounded) {
      return [];
    }
    await this.ensureBenchmarkHydrated(benchmark, bounded);
    const cached = await this.cache.readDailyPrices(benchmark.id, bounded);
    if (cached) {
      return cached;
    }
    // A cache miss is repaired from the durable store rather than from the provider: PostgreSQL is
    // the source of truth and Redis is a disposable projection of it.
    const rows = await this.store.getDailyPrices(benchmark.id, bounded);
    await this.publish(benchmark, bounded, rows);
    return rows;
  }

  private async hydrateWithinLease(
    benchmark: Benchmark,
    target: Required<DateRange>,
    assertOwned: () => void,
  ): Promise<void> {
    const coverage = await this.store.getDatasetCoverage(
      benchmark.id,
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
    const tail = (await this.isTailStale(benchmark))
      ? this.recentTailRange(target)
      : null;
    const ranges = tail ? [...missing, tail] : missing;

    const syncedAt = this.now().toISOString();
    for (const range of ranges) {
      const prices = await this.provider.getBenchmarkDailyPrices(
        benchmark.providerSymbol,
        benchmark.id,
        range,
      );
      assertOwned();
      await this.store.saveDailyPriceSync({
        benchmarkId: benchmark.id,
        prices,
        successfulCoverage: [range],
        syncedAt,
        tailDate: target.to,
        // Only a read that actually reached the tail may say the tail is fresh. Backfilling an
        // older gap tells us nothing about today's bar, and advancing the watermark for it would
        // let a genuinely stale tail pass the freshness check on the next read.
        ...(range.to >= target.to ? { freshThrough: target.to } : {}),
        assertOwned,
      });
    }

    const rows = await this.store.getDailyPrices(benchmark.id, target);
    assertOwned();
    await this.publish(benchmark, target, rows);
  }

  /**
   * Whether the durable tail watermark has aged past the freshness window.
   *
   * The watermark is PostgreSQL state, not a cache entry, so a Redis flush cannot make the loader
   * think the series is stale and re-download it.
   */
  private async isTailStale(benchmark: Benchmark): Promise<boolean> {
    const state = await this.store.getDatasetState(
      benchmark.id,
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
    benchmark: Benchmark,
    target: Required<DateRange>,
    rows: readonly BenchmarkDailyPrice[],
  ): Promise<void> {
    await this.cache.writeDailyPriceYears(
      benchmark.id,
      rows,
      yearsInRange(target),
    );
    await this.cache.setManifest({
      benchmarkId: benchmark.id,
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
  private loadTarget(required: Required<DateRange>): Required<DateRange> {
    const today = this.today();
    const horizonStart = subtractYears(today, this.historyYears);
    return {
      from: maxDate(minDate(required.from, today), horizonStart),
      to: today,
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

  private resource(benchmark: Benchmark): string {
    return `benchmark:hydrate:${benchmark.id}`;
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }
}
