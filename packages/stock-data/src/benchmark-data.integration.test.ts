import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import {
  BENCHMARK_CATALOG,
  type Benchmark,
  type BenchmarkDailyPrice,
  type DateRange,
} from "@intrinsic/domain";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RedisBenchmarkDataCache } from "./benchmark-cache.js";
import {
  BENCHMARK_DAILY_PRICE_VARIANT,
  BENCHMARK_PRICE_DATASET_VERSION,
} from "./benchmark-ports.js";
import { PrismaBenchmarkDataStore } from "./benchmark-prisma-store.js";
import {
  BenchmarkNotFoundError,
  CanonicalBenchmarkDataService,
} from "./benchmark-service.js";
import { InMemoryLoadCoordinator } from "./coordination.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Benchmark loading tests require TEST_REDIS_URL or REDIS_URL. They are the only coverage " +
      "proving the benchmark Redis projection and PostgreSQL agree, and CI must not skip them.",
  );
}
const describeBenchmark = redisUrl ? describe : describe.skip;

/** Weekday bars, so a fixture looks like a real series without needing a trading calendar. */
function series(
  benchmarkId: string,
  from: string,
  count: number,
): BenchmarkDailyPrice[] {
  const rows: BenchmarkDailyPrice[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  let close = 400;
  while (rows.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const date = cursor.toISOString().slice(0, 10);
      rows.push({
        benchmarkId,
        date,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1_000_000,
      });
      close += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

class RecordingBenchmarkProvider implements FmpBenchmarkProviderPort {
  readonly requests: Required<DateRange>[] = [];

  constructor(private readonly rows: readonly BenchmarkDailyPrice[]) {}

  async getBenchmarkDailyPrices(
    _providerSymbol: string,
    benchmarkId: string,
    range: DateRange,
  ): Promise<BenchmarkDailyPrice[]> {
    this.requests.push({ from: range.from as string, to: range.to as string });
    return this.rows
      .filter(
        (row) =>
          (!range.from || row.date >= range.from) &&
          (!range.to || row.date <= range.to),
      )
      .map((row) => ({ ...row, benchmarkId }));
  }
}

describeBenchmark("benchmark loading", () => {
  const suffix = randomUUID();
  const namespace = `benchmark:test:${suffix}`;
  const code = `TEST${suffix.slice(0, 8).toUpperCase()}`;
  const today = "2020-06-30";
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const store = new PrismaBenchmarkDataStore(prisma);
  const cache = new RedisBenchmarkDataCache(new IoredisCacheClient(redis), {
    namespace,
  });
  let benchmark: Benchmark;
  let rows: BenchmarkDailyPrice[];

  function serviceWith(provider: FmpBenchmarkProviderPort) {
    return new CanonicalBenchmarkDataService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      { now: () => new Date(`${today}T12:00:00.000Z`) },
    );
  }

  beforeAll(async () => {
    await redis.ping();
    const [persisted] = await store.reconcileBenchmarkCatalog([
      {
        code,
        name: "Test Benchmark",
        description: "Fixture",
        sourceKind: "FMP_SYMBOL",
        providerSymbol: "TESTSPY",
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        displayOrder: 99,
      },
    ]);
    benchmark = persisted as Benchmark;
    rows = series(benchmark.id, "2020-01-01", 120);
  });

  beforeEach(async () => {
    await redis.del(
      `${namespace}:benchmark:${benchmark.id}:manifest`,
      ...[2019, 2020].map(
        (year) => `${namespace}:benchmark:${benchmark.id}:daily-price:${year}`,
      ),
    );
  });

  afterAll(async () => {
    await redis.del(
      `${namespace}:benchmark:${benchmark.id}:manifest`,
      ...[2019, 2020].map(
        (year) => `${namespace}:benchmark:${benchmark.id}:daily-price:${year}`,
      ),
    );
    redis.disconnect();
    await prisma.benchmark.deleteMany({ where: { code } });
    await prisma.$disconnect();
  });

  it("registers the catalog idempotently and refuses an unknown code", async () => {
    const first = await store.reconcileBenchmarkCatalog([
      {
        code,
        name: "Test Benchmark",
        sourceKind: "FMP_SYMBOL",
        providerSymbol: "TESTSPY",
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        displayOrder: 99,
      },
    ]);
    const second = await store.reconcileBenchmarkCatalog([
      {
        code,
        name: "Renamed Benchmark",
        sourceKind: "FMP_SYMBOL",
        providerSymbol: "TESTSPY",
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        displayOrder: 99,
      },
    ]);

    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.name).toBe("Renamed Benchmark");
    await expect(
      serviceWith(new RecordingBenchmarkProvider([])).getBenchmark("NOPE-404"),
    ).rejects.toBeInstanceOf(BenchmarkNotFoundError);
  });

  it("hydrates the missing range once and persists rows, coverage and the Redis projection", async () => {
    const provider = new RecordingBenchmarkProvider(rows);
    const service = serviceWith(provider);
    const range = { from: "2020-02-03", to: "2020-03-31" };

    const loaded = await service.getBenchmarkDailyPrices(benchmark, range);

    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded[0]?.date).toBe("2020-02-03");
    expect(
      loaded.every((row) => row.date >= range.from && row.date <= range.to),
    ).toBe(true);
    expect(
      loaded.every(
        (row, index) =>
          index === 0 || row.date > (loaded[index - 1]?.date ?? ""),
      ),
    ).toBe(true);

    const persisted = await prisma.benchmarkDailyPrice.count({
      where: { benchmarkId: benchmark.id },
    });
    expect(persisted).toBeGreaterThan(0);

    const coverage = await store.getDatasetCoverage(
      benchmark.id,
      "DAILY_PRICE",
      BENCHMARK_DAILY_PRICE_VARIANT,
      { from: "2019-01-01", to: today },
    );
    expect(coverage.length).toBeGreaterThan(0);

    const manifest = await cache.getManifest(benchmark.id);
    expect(manifest?.priceDatasetVersion).toBe(BENCHMARK_PRICE_DATASET_VERSION);
    // The projection lives in its own namespace, not among the resident stocks.
    const chunk = await redis.get(
      `${namespace}:benchmark:${benchmark.id}:daily-price:2020`,
    );
    expect(chunk).not.toBeNull();
  });

  it("reuses the Redis projection without touching the provider again", async () => {
    const first = new RecordingBenchmarkProvider(rows);
    await serviceWith(first).getBenchmarkDailyPrices(benchmark, {
      from: "2020-02-03",
      to: "2020-03-31",
    });

    const second = new RecordingBenchmarkProvider(rows);
    const reread = await serviceWith(second).getBenchmarkDailyPrices(
      benchmark,
      {
        from: "2020-02-03",
        to: "2020-03-31",
      },
    );

    expect(second.requests).toHaveLength(0);
    expect(reread.length).toBeGreaterThan(0);
  });

  it("rebuilds from PostgreSQL coverage after a Redis flush without refetching the history", async () => {
    await serviceWith(
      new RecordingBenchmarkProvider(rows),
    ).getBenchmarkDailyPrices(benchmark, { from: "2020-01-02", to: today });

    // A Redis flush must cost one durable re-read, never a provider re-download of the history.
    await redis.del(
      `${namespace}:benchmark:${benchmark.id}:manifest`,
      `${namespace}:benchmark:${benchmark.id}:daily-price:2020`,
    );

    const provider = new RecordingBenchmarkProvider(rows);
    const reloaded = await serviceWith(provider).getBenchmarkDailyPrices(
      benchmark,
      {
        from: "2020-01-02",
        to: today,
      },
    );

    expect(reloaded.length).toBeGreaterThan(0);
    // Only the bounded recent tail may be asked for again; the covered history is not re-requested.
    for (const request of provider.requests) {
      const spanDays =
        (Date.parse(`${request.to}T00:00:00Z`) -
          Date.parse(`${request.from}T00:00:00Z`)) /
        86_400_000;
      expect(spanDays).toBeLessThanOrEqual(10);
    }
  });

  it("asks the provider for nothing while the durable freshness watermark is current", async () => {
    await serviceWith(
      new RecordingBenchmarkProvider(rows),
    ).getBenchmarkDailyPrices(benchmark, { from: "2020-01-02", to: today });
    // Everything Redis holds is gone, but PostgreSQL still records complete coverage and a current
    // tail watermark. That is what lets a seeded environment run a backtest with no provider at all.
    await redis.del(
      `${namespace}:benchmark:${benchmark.id}:manifest`,
      `${namespace}:benchmark:${benchmark.id}:daily-price:2020`,
    );

    const provider = new RecordingBenchmarkProvider(rows);
    const reloaded = await serviceWith(provider).getBenchmarkDailyPrices(
      benchmark,
      {
        from: "2020-01-02",
        to: today,
      },
    );

    expect(provider.requests).toHaveLength(0);
    expect(reloaded.length).toBeGreaterThan(0);
  });

  it("ships the V1 SP500 catalog entry backed by an FMP symbol", () => {
    const sp500 = BENCHMARK_CATALOG.find((entry) => entry.code === "SP500");
    expect(sp500).toBeDefined();
    expect(sp500?.name).toBe("S&P 500");
    expect(sp500?.sourceKind).toBe("FMP_SYMBOL");
    expect(sp500?.providerSymbol).toBe("SPY");
  });
});
