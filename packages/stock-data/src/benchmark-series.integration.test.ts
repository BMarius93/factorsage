import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type {
  BenchmarkCatalogEntry,
  BenchmarkDailyPrice,
  DateRange,
} from "@intrinsic/domain";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisBenchmarkDataCache } from "./benchmark-cache.js";
import { BENCHMARK_DAILY_PRICE_VARIANT } from "./benchmark-ports.js";
import { PrismaBenchmarkDataStore } from "./benchmark-prisma-store.js";
import { CanonicalBenchmarkDataService } from "./benchmark-service.js";
import { InMemoryLoadCoordinator } from "./coordination.js";
import {
  IoredisCacheClient,
  createStockDataRedisClient,
} from "./redis-client.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
const describeSeries = redisUrl ? describe : describe.skip;

/** A provider that answers with a constant close, so which series was read is visible in the data. */
class ConstantProvider implements FmpBenchmarkProviderPort {
  readonly requests: { symbol: string; seriesId: string }[] = [];

  constructor(
    private readonly close: number,
    private readonly dates: readonly string[],
  ) {}

  async getBenchmarkDailyPrices(
    providerSymbol: string,
    seriesId: string,
    _range: DateRange,
  ): Promise<BenchmarkDailyPrice[]> {
    this.requests.push({ symbol: providerSymbol, seriesId });
    return this.dates.map((date) => ({
      seriesId,
      date,
      open: this.close,
      high: this.close,
      low: this.close,
      close: this.close,
      volume: 1,
    }));
  }
}

/**
 * A benchmark's definition is immutable, and a run pins it.
 *
 * The bug these guard against is quiet: a benchmark's source, provider symbol or methodology could
 * be edited in place, which reinterpreted every bar already stored under that benchmark and changed
 * what an already-queued run would compare against. Both are reproducibility failures, and neither
 * announces itself in a result.
 */
describeSeries("immutable benchmark series", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const code = `SERIES_${suffix}`;
  const namespace = `benchmark:series-test:${suffix}`;
  const dates = ["2020-01-02", "2020-01-03", "2020-01-06"];
  const range = { from: "2020-01-01", to: "2020-01-31" };

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const store = new PrismaBenchmarkDataStore(prisma);
  const cache = new RedisBenchmarkDataCache(new IoredisCacheClient(redis), {
    namespace,
  });

  function serviceWith(provider: FmpBenchmarkProviderPort) {
    return new CanonicalBenchmarkDataService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      { now: () => new Date("2020-02-01T12:00:00.000Z") },
    );
  }

  function entry(
    overrides: Partial<BenchmarkCatalogEntry>,
  ): BenchmarkCatalogEntry {
    return {
      code,
      name: "Series Fixture",
      sourceKind: "FMP_SYMBOL",
      providerSymbol: "OLDSPY",
      currency: "USD",
      methodologyVersion: 1,
      isActive: true,
      displayOrder: 99,
      ...overrides,
    };
  }

  afterAll(async () => {
    await prisma.benchmark.deleteMany({ where: { code } });
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    redis.disconnect();
    await prisma.$disconnect();
  });

  beforeAll(async () => {
    await prisma.benchmark.deleteMany({ where: { code } });
  });

  it("A: a catalog change after submission cannot change what the pinned run reads", async () => {
    const [v1] = await store.reconcileBenchmarkCatalog([entry({})]);
    const pinnedSeriesId = v1?.series.id as string;
    expect(pinnedSeriesId).toBeTruthy();

    // A run submits here and records `pinnedSeriesId` — nothing else.
    const first = new ConstantProvider(100, dates);
    const before = await serviceWith(first).getBenchmarkDailyPrices(
      v1?.series as never,
      range,
    );
    expect(before.map((row) => row.close)).toEqual([100, 100, 100]);

    // The catalog then advances: a different source and a new methodology.
    const [v2] = await store.reconcileBenchmarkCatalog([
      entry({ providerSymbol: "NEWSPY", methodologyVersion: 2 }),
    ]);
    expect(v2?.series.id).not.toBe(pinnedSeriesId);
    expect(v2?.series.version).toBe(2);

    // Execution resolves the pinned id, not the code, and still reads exactly what it read before.
    const later = new ConstantProvider(999, dates);
    const pinned = await serviceWith(later).getSeries(pinnedSeriesId);
    expect(pinned.providerSymbol).toBe("OLDSPY");
    expect(pinned.methodologyVersion).toBe(1);
    const after = await serviceWith(later).getBenchmarkDailyPrices(
      pinned,
      range,
    );
    expect(after.map((row) => row.close)).toEqual([100, 100, 100]);
    expect(later.requests).toEqual([]);
  });

  it("B: v1 bars cannot be overwritten or reinterpreted as v2", async () => {
    const current = await store.findBenchmarkByCode(code);
    const v2 = current?.series;
    expect(v2?.version).toBe(2);

    // v2 fetches its own history, at its own prices.
    const provider = new ConstantProvider(555, dates);
    const v2Rows = await serviceWith(provider).getBenchmarkDailyPrices(
      v2 as never,
      range,
    );
    expect(v2Rows.map((row) => row.close)).toEqual([555, 555, 555]);
    // Whatever it asked for — missing history, and the recent tail — it asked the *new* source,
    // under the new series id. v1's symbol is never touched again.
    expect(provider.requests.length).toBeGreaterThan(0);
    for (const request of provider.requests) {
      expect(request.symbol).toBe("NEWSPY");
      expect(request.seriesId).toBe(v2?.id);
    }

    // And v1's rows are untouched: two series, two sets of bars, same dates.
    const versions = await prisma.benchmarkSeries.findMany({
      where: { benchmark: { code } },
      orderBy: { version: "asc" },
      include: { dailyPrices: { orderBy: { date: "asc" } } },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0]?.dailyPrices.map((row) => Number(row.close))).toEqual([
      100, 100, 100,
    ]);
    expect(versions[1]?.dailyPrices.map((row) => Number(row.close))).toEqual([
      555, 555, 555,
    ]);

    // Coverage is per series too, so v2 fetching does not make v1 look already-covered or stale.
    for (const version of versions) {
      const coverage = await store.getDatasetCoverage(
        version.id,
        "DAILY_PRICE",
        BENCHMARK_DAILY_PRICE_VARIANT,
        range,
      );
      expect(coverage.length).toBeGreaterThan(0);
    }
  });

  it("C: a completed run's configuration stays interpretable after the catalog advances", async () => {
    const versions = await prisma.benchmarkSeries.findMany({
      where: { benchmark: { code } },
      orderBy: { version: "asc" },
    });
    const v1 = versions[0];
    expect(v1).toBeTruthy();

    // Everything a completed run needs in order to explain itself is still readable by id, and
    // still says what it said at submission — including the provider symbol it was sourced from.
    const resolved = await store.findSeriesById(v1?.id as string);
    expect(resolved).toMatchObject({
      version: 1,
      providerSymbol: "OLDSPY",
      methodologyVersion: 1,
      currency: "USD",
    });

    // The product identity may be renamed freely; that is not what decides the numbers.
    await store.reconcileBenchmarkCatalog([
      entry({
        name: "Renamed Fixture",
        providerSymbol: "NEWSPY",
        methodologyVersion: 2,
      }),
    ]);
    const stillThere = await store.findSeriesById(v1?.id as string);
    expect(stillThere?.providerSymbol).toBe("OLDSPY");
    // A rename does not append a version: only a changed definition does.
    expect(
      await prisma.benchmarkSeries.count({ where: { benchmark: { code } } }),
    ).toBe(2);
    expect((await store.findBenchmarkByCode(code))?.name).toBe(
      "Renamed Fixture",
    );
  });
});
