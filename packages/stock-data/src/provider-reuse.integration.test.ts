import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type {
  BenchmarkWithSeries,
  BenchmarkDailyPrice,
  DailyPrice,
  DateRange,
  Security,
} from "@intrinsic/domain";
import type {
  FmpBenchmarkProviderPort,
  FmpStockProviderPort,
} from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RedisBenchmarkDataCache } from "./benchmark-cache.js";
import { PrismaBenchmarkDataStore } from "./benchmark-prisma-store.js";
import { CanonicalBenchmarkDataService } from "./benchmark-service.js";
import { RedisStockDataCache } from "./cache.js";
import { InMemoryLoadCoordinator } from "./coordination.js";
import { DAILY_PRICE_VARIANT } from "./ports.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import { PRICE_OPERAND, seriesOperand } from "@intrinsic/strategy";
import { CanonicalStockDataService } from "./service.js";
import { subtractYears } from "./dates.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Provider-reuse tests require TEST_REDIS_URL or REDIS_URL. They are the only coverage " +
      "proving a repeated backtest reads PostgreSQL and Redis instead of the provider.",
  );
}
const describeReuse = redisUrl ? describe : describe.skip;

/** Every provider request, with the reason the loader had for making it. */
type Request = { symbol: string; from: string; to: string };

class CountingStockProvider implements FmpStockProviderPort {
  readonly priceRequests: Request[] = [];
  readonly profileRequests: string[] = [];
  readonly statementRequests: string[] = [];

  constructor(private readonly rows: Map<string, DailyPrice[]>) {}

  async getProfile(symbol: string) {
    this.profileRequests.push(symbol);
    return null;
  }

  async getDailyPrices(symbol: string, securityId: string, range: DateRange) {
    if (!range.from || !range.to) {
      throw new Error("The loader must always ask for a bounded range");
    }
    this.priceRequests.push({ symbol, from: range.from, to: range.to });
    return (this.rows.get(symbol) ?? [])
      .filter((row) => row.date >= range.from! && row.date <= range.to!)
      .map((row) => ({ ...row, securityId }));
  }

  async getFinancialStatements(symbol: string) {
    this.statementRequests.push(symbol);
    return [];
  }
}

class CountingBenchmarkProvider implements FmpBenchmarkProviderPort {
  readonly requests: Request[] = [];

  constructor(private readonly rows: BenchmarkDailyPrice[]) {}

  async getBenchmarkDailyPrices(
    providerSymbol: string,
    seriesId: string,
    range: DateRange,
  ) {
    this.requests.push({
      symbol: providerSymbol,
      from: range.from as string,
      to: range.to as string,
    });
    return this.rows
      .filter((row) => row.date >= range.from! && row.date <= range.to!)
      .map((row) => ({ ...row, seriesId }));
  }
}

function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * A repeated backtest must read what it already has.
 *
 * `FMP -> PostgreSQL -> Redis -> backtest` on the first run, and `PostgreSQL and/or Redis ->
 * backtest` on every identical one after it. These cases count provider requests directly, so a
 * regression shows up as a number rather than as a slow run someone happens to notice.
 */
describeReuse("provider reuse across repeated reads", () => {
  const suffix = randomUUID();
  const namespace = `stock-data:v2:reuse:${suffix}`;
  const benchmarkNamespace = `benchmark:reuse:${suffix}`;
  const today = "2020-06-30";
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const store = new PrismaStockDataStore(prisma);
  const cache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    50,
    namespace,
  );
  const benchmarkStore = new PrismaBenchmarkDataStore(prisma);
  const benchmarkCache = new RedisBenchmarkDataCache(
    new IoredisCacheClient(redis),
    { namespace: benchmarkNamespace },
  );

  // The loader normalizes a symbol to upper case before resolving it, so the catalog row must be
  // stored in exactly that form.
  const stem = suffix.slice(0, 4).toUpperCase();
  // The third symbol belongs to case G alone: PostgreSQL coverage survives between cases here (only
  // Redis is cleared), so a security another case has already warmed could never show a cold read.
  const symbols = [`RUSEA${stem}`, `RUSEB${stem}`, `RUSEG${stem}`];
  const securities: Security[] = [];
  let benchmark: BenchmarkWithSeries;
  const priceRows = new Map<string, DailyPrice[]>();
  let benchmarkRows: BenchmarkDailyPrice[] = [];

  function stockService(provider: CountingStockProvider) {
    return new CanonicalStockDataService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      { historyYears: 30, now: () => new Date(`${today}T12:00:00.000Z`) },
    );
  }

  function benchmarkService(provider: CountingBenchmarkProvider) {
    return new CanonicalBenchmarkDataService(
      benchmarkStore,
      provider,
      benchmarkCache,
      new InMemoryLoadCoordinator(),
      { historyYears: 30, now: () => new Date(`${today}T12:00:00.000Z`) },
    );
  }

  async function clearRedis() {
    const keys = await redis.keys(`${namespace}*`);
    const benchmarkKeys = await redis.keys(`${benchmarkNamespace}*`);
    if (keys.length + benchmarkKeys.length > 0) {
      await redis.del(...keys, ...benchmarkKeys);
    }
  }

  beforeAll(async () => {
    await redis.ping();
    for (const symbol of symbols) {
      const row = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: `${symbol} Corp`,
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securities.push({
        id: row.id,
        symbol: row.symbol,
        name: row.name,
        exchangeCode: row.exchangeCode,
        currency: row.currency,
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      });
      priceRows.set(
        symbol,
        weekdays("2017-01-02", today).map((date, index) => ({
          securityId: row.id,
          date,
          open: 100 + index * 0.1,
          high: 101 + index * 0.1,
          low: 99 + index * 0.1,
          close: 100 + index * 0.1,
          volume: 1_000,
        })),
      );
    }
    const [persisted] = await benchmarkStore.reconcileBenchmarkCatalog([
      {
        code: `REUSE${suffix.slice(0, 6).toUpperCase()}`,
        name: "Reuse Benchmark",
        sourceKind: "FMP_SYMBOL",
        providerSymbol: "REUSE",
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        displayOrder: 90,
      },
    ]);
    benchmark = persisted as BenchmarkWithSeries;
    benchmarkRows = weekdays("2017-01-02", today).map((date, index) => ({
      seriesId: benchmark.series.id,
      date,
      open: 400 + index * 0.2,
      high: 401 + index * 0.2,
      low: 399 + index * 0.2,
      close: 400 + index * 0.2,
      volume: 5_000,
    }));
  });

  afterAll(async () => {
    await clearRedis();
    redis.disconnect();
    // The product row, not its series: deleting by the series id matched nothing and left a
    // fixture benchmark behind on every run.
    await prisma.benchmark.deleteMany({ where: { id: benchmark.id } });
    await prisma.security.deleteMany({
      where: { id: { in: securities.map((security) => security.id) } },
    });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await clearRedis();
  });

  const range = { from: "2018-01-02", to: today };
  /** Cases A-F share these; case G owns the third symbol so it can prove a genuinely cold read. */
  const comparisonSecurities = () => securities.slice(0, 2);

  it("A: fetches and persists the missing history on a cold first read", async () => {
    const provider = new CountingStockProvider(priceRows);
    const service = stockService(provider);

    for (const security of comparisonSecurities()) {
      const prices = await service.getDailyPrices(security.symbol, range);
      expect(prices.length).toBeGreaterThan(0);
    }

    expect(provider.priceRequests.length).toBeGreaterThan(0);
    for (const security of comparisonSecurities()) {
      const persisted = await prisma.dailyPrice.count({
        where: { securityId: security.id },
      });
      expect(persisted).toBeGreaterThan(0);
    }
  });

  it("B: asks the provider for nothing on an immediate identical second read", async () => {
    // Warm every security the second read will touch, exactly as a first backtest over the whole
    // list would.
    const warmUp = stockService(new CountingStockProvider(priceRows));
    for (const security of comparisonSecurities()) {
      await warmUp.getDailyPrices(security.symbol, range);
    }

    const provider = new CountingStockProvider(priceRows);
    const service = stockService(provider);
    for (const security of comparisonSecurities()) {
      await service.getDailyPrices(security.symbol, range);
      await service.getDailyDerivedState(security.symbol, range);
    }

    expect(provider.priceRequests).toEqual([]);
    expect(provider.profileRequests).toEqual([]);
    expect(provider.statementRequests).toEqual([]);
  });

  it("C: rebuilds the Redis projection from PostgreSQL without a provider call", async () => {
    await stockService(new CountingStockProvider(priceRows)).getDailyPrices(
      securities[0]!.symbol,
      range,
    );
    // Everything Redis held is gone; PostgreSQL keeps the rows and the coverage.
    await clearRedis();

    const provider = new CountingStockProvider(priceRows);
    const prices = await stockService(provider).getDailyPrices(
      securities[0]!.symbol,
      range,
    );

    expect(prices.length).toBeGreaterThan(0);
    expect(provider.priceRequests).toEqual([]);
  });

  it("D: refreshes only the bounded recent tail when freshness expires", async () => {
    await stockService(new CountingStockProvider(priceRows)).getDailyPrices(
      securities[0]!.symbol,
      range,
    );
    await clearRedis();

    const provider = new CountingStockProvider(priceRows);
    // A day later, the tail is stale but the decades behind it are not.
    const stale = new CanonicalStockDataService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      {
        historyYears: 30,
        recentTailCalendarDays: 10,
        now: () => new Date("2020-07-01T12:00:00.000Z"),
      },
    );
    await stale.getDailyPrices(securities[0]!.symbol, {
      from: "2018-01-02",
      to: "2020-07-01",
    });

    // Whatever it asked for, it asked only about the tail — never the covered history.
    for (const request of provider.priceRequests) {
      expect(request.from >= "2020-06-01").toBe(true);
    }
  });

  it("E: fetches only the missing prefix when the period is widened backwards", async () => {
    const security = securities[0]!;
    await stockService(new CountingStockProvider(priceRows)).getDailyPrices(
      security.symbol,
      range,
    );

    // The boundary is read from the durable ledger, not assumed from the request.
    //
    // A read is widened backwards by `DERIVED_SERIES_WARMUP_DAYS` — today about four years — so a
    // second request that merely started a year earlier would land *inside* what the first already
    // materialized, and this case would pass while exercising nothing. Asking the store where
    // coverage actually begins is what keeps the case honest as the warm-up changes.
    const covered = await store.getDatasetCoverage(
      security.id,
      "DAILY_PRICE",
      DAILY_PRICE_VARIANT,
      { from: "1990-01-01", to: today },
    );
    const coveredFrom = covered
      .map((interval) => interval.from)
      .sort()[0] as string;
    expect(coveredFrom < "2018-01-02").toBe(true);

    // Genuinely outside it, by a year, so the second read has a real prefix to fetch.
    const widenedFrom = subtractYears(coveredFrom, 1);
    const provider = new CountingStockProvider(priceRows);
    await stockService(provider).getDailyPrices(security.symbol, {
      from: widenedFrom,
      to: today,
    });

    expect(provider.priceRequests.length).toBeGreaterThan(0);
    // Every ask lies strictly before the materialized boundary: the prefix is fetched, and not one
    // day of the history already on disk is asked for again.
    for (const request of provider.priceRequests) {
      expect(request.to < coveredFrom).toBe(true);
      expect(request.from >= subtractYears(widenedFrom, 5)).toBe(true);
    }

    // And the ledger now reaches back at least as far as the widened read asked for.
    const after = await store.getDatasetCoverage(
      security.id,
      "DAILY_PRICE",
      DAILY_PRICE_VARIANT,
      { from: "1990-01-01", to: today },
    );
    expect((after.map((i) => i.from).sort()[0] as string) < coveredFrom).toBe(
      true,
    );
  });

  /**
   * One stock-data system, two consumers.
   *
   * Stock Details reads through `getDailyPrices`/`getDailyDerivedState`; a backtest reads through
   * `getDailyEvaluationFrame`. They are different call shapes on the *same* service, over the same
   * PostgreSQL coverage, the same Redis namespace, the same hydration lock and the same provider
   * gate — and the invariant worth pinning is that neither can be made to re-fetch history the
   * other already materialized. A worker-specific retrieval path would break every assertion here.
   */
  describe("Stock Details and a backtest are two consumers of one loader", () => {
    // The canonical keys the strategy package produces, not hand-written strings.
    const OPERANDS = [PRICE_OPERAND, seriesOperand("SMA_50D")];

    it("G: a backtest frame reuses what a Stock Details read already loaded, then a repeat and a Redis flush cost nothing", async () => {
      const security = securities[2]!;
      const detailRange = { from: "2019-06-03", to: today };

      // A. Stock Details hydrates a narrow window.
      const detailProvider = new CountingStockProvider(priceRows);
      const detailRows = await stockService(detailProvider).getDailyPrices(
        security.symbol,
        detailRange,
      );
      expect(detailRows.length).toBeGreaterThan(0);
      expect(detailProvider.priceRequests.length).toBeGreaterThan(0);

      const coveredFrom = (
        await store.getDatasetCoverage(
          security.id,
          "DAILY_PRICE",
          DAILY_PRICE_VARIANT,
          { from: "1990-01-01", to: today },
        )
      )
        .map((interval) => interval.from)
        .sort()[0] as string;

      // B. The backtest asks for a wider period: only the genuinely missing prefix is fetched.
      const wideFrom = subtractYears(coveredFrom, 1);
      const frameProvider = new CountingStockProvider(priceRows);
      const frame = await stockService(frameProvider).getDailyEvaluationFrame(
        security,
        { from: wideFrom, to: today },
        [...OPERANDS],
      );
      expect(frame.dates.length).toBeGreaterThan(0);
      expect(frameProvider.priceRequests.length).toBeGreaterThan(0);
      for (const request of frameProvider.priceRequests) {
        expect(request.to < coveredFrom).toBe(true);
      }

      // C. The identical frame read again asks the provider for nothing at all.
      const repeatProvider = new CountingStockProvider(priceRows);
      const repeat = await stockService(repeatProvider).getDailyEvaluationFrame(
        security,
        { from: wideFrom, to: today },
        [...OPERANDS],
      );
      expect(repeat.dates).toEqual(frame.dates);
      expect(repeatProvider.priceRequests).toEqual([]);
      expect(repeatProvider.statementRequests).toEqual([]);
      expect(repeatProvider.profileRequests).toEqual([]);

      // D + E. Redis is disposable: flushed, the same read rebuilds from PostgreSQL, still without
      // a provider call.
      await clearRedis();
      const rebuiltProvider = new CountingStockProvider(priceRows);
      const rebuilt = await stockService(
        rebuiltProvider,
      ).getDailyEvaluationFrame(security, { from: wideFrom, to: today }, [
        ...OPERANDS,
      ]);
      expect(rebuilt.dates).toEqual(frame.dates);
      expect(rebuiltProvider.priceRequests).toEqual([]);

      // F. And the other direction: Stock Details now reads the history the backtest widened into,
      // still without reaching the provider.
      const backProvider = new CountingStockProvider(priceRows);
      const backRows = await stockService(backProvider).getDailyPrices(
        security.symbol,
        { from: wideFrom, to: today },
      );
      expect(backRows.length).toBeGreaterThan(detailRows.length);
      expect(backProvider.priceRequests).toEqual([]);
    });
  });

  it("F: reuses benchmark coverage and its Redis projection exactly the same way", async () => {
    const first = new CountingBenchmarkProvider(benchmarkRows);
    await benchmarkService(first).getBenchmarkDailyPrices(
      benchmark.series,
      range,
    );
    expect(first.requests.length).toBeGreaterThan(0);

    const warm = new CountingBenchmarkProvider(benchmarkRows);
    await benchmarkService(warm).getBenchmarkDailyPrices(
      benchmark.series,
      range,
    );
    expect(warm.requests).toEqual([]);

    await clearRedis();
    const afterFlush = new CountingBenchmarkProvider(benchmarkRows);
    const rows = await benchmarkService(afterFlush).getBenchmarkDailyPrices(
      benchmark.series,
      range,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(afterFlush.requests).toEqual([]);
  });
});
