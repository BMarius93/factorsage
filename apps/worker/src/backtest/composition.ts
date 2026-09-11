import {
  getBacktestDebugArchiveConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
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
  type ProviderRequestEvent,
} from "@intrinsic/stock-data";
import type { ProviderRequestCounts } from "./debug/backtest-debug-archive.js";
import {
  FilesystemBacktestDebugArchives,
  ProviderRequestMeter,
  type BacktestDebugArchives,
} from "./debug/debug-archives.js";
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
  /**
   * Present only when `BACKTEST_DEBUG_ARCHIVE` asked for it, so an unconfigured worker has no
   * archive object at all rather than a disabled one.
   */
  debugArchives?: BacktestDebugArchives;
  providerRequests?: () => ProviderRequestCounts;
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
 *
 * The logger is passed in so every provider request can say why it happened: a repeated backtest
 * that still reaches FMP should be explainable from this process's own log.
 */
export function createBacktestRuntime(
  logger: StructuredLogger,
): BacktestRuntime {
  const stockDataConfig = getStockDataConfig();
  const fmpTraffic = getFmpTrafficConfig();
  const debugArchiveConfig = getBacktestDebugArchiveConfig();

  // Counting provider requests is only meaningful while something reads the count, and a worker
  // child executes at most one backtest at a time — which is what makes a phase's delta that run's
  // traffic rather than a guess. It observes the callback `@intrinsic/stock-data` already exposes;
  // it is not a second gate and never bypasses the shared FMP budget.
  const providerMeter = debugArchiveConfig.enabled
    ? new ProviderRequestMeter()
    : null;
  // Every historical provider request explains itself, so "why did an identical second run still
  // call FMP?" is answerable from the worker's own log rather than from a packet trace. The meter
  // is a second, silent reader of the same events.
  const onProviderRequest = (request: ProviderRequestEvent): void => {
    logger.debug({ event: "stock-data.provider.request", ...request });
    providerMeter?.observe(request);
  };

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url, (err) => {
    logger.warn({ event: "stock-data.redis.error", err });
  });

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
  // surface may explore, and a backtest names its own period inside the product horizon.
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
      productHistoryYears: stockDataConfig.productHistoryYears,
      recentPriceFreshnessMs: stockDataConfig.recentPriceFreshnessMs,
      fundamentalsFreshnessMs: stockDataConfig.fundamentalsFreshnessMs,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
      onProviderRequest,
    },
  );

  const benchmarks = new CanonicalBenchmarkDataService(
    new PrismaBenchmarkDataStore(prisma),
    provider,
    new RedisBenchmarkDataCache(new IoredisCacheClient(redis)),
    coordinator,
    {
      // The product horizon, not the stock loader's raw-price retention. A benchmark carries no
      // derived series (`AGENTS.md` invariant 13), so it has nothing to warm up: its history is
      // the run's execution calendar and the comparison line, both of which live entirely inside
      // the backtestable period.
      historyYears: stockDataConfig.productHistoryYears,
      recentPriceFreshnessMs: stockDataConfig.recentPriceFreshnessMs,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
      onProviderRequest,
    },
  );

  return {
    repository: new PrismaBacktestJobRepository(prisma),
    securities: new PrismaBacktestSecurityCatalog(prisma),
    stockData,
    benchmarks,
    ...(debugArchiveConfig.enabled
      ? {
          debugArchives: new FilesystemBacktestDebugArchives({
            directory: debugArchiveConfig.directory,
            mode: debugArchiveConfig.mode,
            logger,
          }),
        }
      : {}),
    ...(providerMeter
      ? { providerRequests: () => providerMeter.counts() }
      : {}),
    async close(): Promise<void> {
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}
