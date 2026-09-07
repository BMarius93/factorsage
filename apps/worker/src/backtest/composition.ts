import {
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { FmpClient } from "@intrinsic/fmp";
import {
  CanonicalBenchmarkDataService,
  CanonicalStockDataService,
  IoredisCacheClient,
  PrismaBenchmarkDataStore,
  PrismaStockDataStore,
  RedisBenchmarkDataCache,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
} from "@intrinsic/stock-data";
import type {
  BacktestBenchmarkLoader,
  BacktestFrameLoader,
} from "./backtest-processor.js";
import {
  PrismaBacktestJobRepository,
  type BacktestJobRepository,
} from "./job-repository.js";
import {
  PrismaBacktestSecurityCatalog,
  type BacktestSecurityCatalog,
} from "./securities.js";

export type BacktestRuntime = {
  repository: BacktestJobRepository;
  securities: BacktestSecurityCatalog;
  stockData: BacktestFrameLoader;
  benchmarks: BacktestBenchmarkLoader;
  close(): Promise<void>;
};

/**
 * The worker's composition root.
 *
 * It mirrors `apps/api/src/stocks/stocks.module.ts` deliberately: the same store, the same Redis
 * cache, the same shared FMP gate and the same load coordinator, built with the same configuration
 * values. The worker must never call the provider itself or keep a second implementation of Redis
 * lookup, coverage reconciliation or derived calculation — API and worker are different processes,
 * not different business implementations, and the hydration lock only serializes them because both
 * go through the same package.
 *
 * The process owns its own Prisma client and its own Redis connection, per the database rules.
 */
export function createBacktestRuntime(): BacktestRuntime {
  const stockDataConfig = getStockDataConfig();
  const fmpTraffic = getFmpTrafficConfig();

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url);

  const provider = new FmpClient(() => getFmpConfig(), fetch, {
    gate: new RedisFmpRequestGate(redis, {
      maxConcurrentRequests: fmpTraffic.maxConcurrentRequests,
      rateLimitPerWindow: fmpTraffic.rateLimitPerWindow,
      rateWindowMs: fmpTraffic.rateWindowMs,
      maxQueueDepth: fmpTraffic.maxQueueDepth,
      maxQueueWaitMs: fmpTraffic.maxQueueWaitMs,
      requestLeaseMs: fmpTraffic.timeoutMs * 2,
    }),
  });

  const coordinator = new RedlockLoadCoordinator(redis, {
    lockDurationMs: stockDataConfig.loadLockDurationMs,
    lockWaitMs: stockDataConfig.loadLockWaitMs,
  });

  // `stockDetailsHistoryYears` is deliberately not set here: it narrows what the Stock Details
  // surface may explore, and a backtest names its own period inside the retained horizon.
  const stockData = new CanonicalStockDataService(
    new PrismaStockDataStore(prisma),
    provider,
    new RedisStockDataCache(
      new IoredisCacheClient(redis),
      stockDataConfig.maxResidentStocks,
    ),
    coordinator,
    {
      defaultHistoryDays: stockDataConfig.defaultHistoryDays,
      historyYears: stockDataConfig.historyYears,
      recentPriceFreshnessMs: stockDataConfig.recentPriceFreshnessMs,
      fundamentalsFreshnessMs: stockDataConfig.fundamentalsFreshnessMs,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
    },
  );

  const benchmarks = new CanonicalBenchmarkDataService(
    new PrismaBenchmarkDataStore(prisma),
    provider,
    new RedisBenchmarkDataCache(new IoredisCacheClient(redis)),
    coordinator,
    {
      historyYears: stockDataConfig.historyYears,
      recentPriceFreshnessMs: stockDataConfig.recentPriceFreshnessMs,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
    },
  );

  return {
    repository: new PrismaBacktestJobRepository(prisma),
    securities: new PrismaBacktestSecurityCatalog(prisma),
    stockData,
    benchmarks,
    async close(): Promise<void> {
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}
