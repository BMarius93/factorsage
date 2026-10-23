import {
  getAlternativeDataConfig,
  getBacktestAdmissionConfig,
  getEodFinalityConfig,
  getBacktestDebugArchiveConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getRedisEvictionPolicyConfig,
  getStockDataConfig,
  getMarketDataWorkerConfig,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import { FmpClient } from "@intrinsic/fmp";
import {
  CanonicalAlternativeDataService,
  CanonicalBenchmarkDataService,
  CachedTradingCalendar,
  CanonicalStockDataService,
  PrismaAlternativeDataStore,
  IoredisCacheClient,
  PrismaBenchmarkDataStore,
  PrismaStockDataStore,
  RedisBenchmarkDataCache,
  RedisFmpRequestGate,
  RedisStockDataCache,
  STOCK_DATA_CACHE_NAMESPACE,
  DEFAULT_HYDRATION_TTL_MS,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  logBenchmarkCacheEvent,
  logPriceBasisEvent,
  logUnreadableBenchmarkChunk,
  EodFinalityPolicy,
  MARKET_DATA_CALENDAR_EXCHANGE,
  type ProviderRequestEvent,
  canonicalProtectedTierEligibility,
  inspectRedisEvictionPolicy,
  stockCachePayloadCodecs,
  stockCacheTierObserver,
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
  BacktestProcessorDependencies,
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
  /** The provider-free ETF condition reads; see the composition below. */
  etfContexts: BacktestProcessorDependencies["etfContexts"];
  /**
   * Present only when `BACKTEST_DEBUG_ARCHIVE` asked for it, so an unconfigured worker has no
   * archive object at all rather than a disabled one.
   */
  debugArchives?: BacktestDebugArchives;
  providerRequests?: () => ProviderRequestCounts;
  /** The stock cache's protected tier, which a point-in-time index run designates its securities to. */
  protectedTier: BacktestProcessorDependencies["protectedTier"];
  /**
   * Logs once how this Redis evicts (`docs/decisions/stock-cache-tiers-v1.md` §4): an `allkeys-*`
   * policy nobody accepted could evict the protected tier, and a worker reads it on every window.
   */
  reportRedisEvictionPolicy(): Promise<void>;
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
  const alternativeDataConfig = getAlternativeDataConfig();

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

  // The alternative-data loader, built from the **same gated provider**: an insider or congressional
  // ingest spends the same Redis-coordinated allowance as a price read, so it can never starve one.
  const alternativeData = new CanonicalAlternativeDataService(
    new PrismaAlternativeDataStore(prisma),
    provider,
    {
      freshnessMs: alternativeDataConfig.freshnessMs,
      maxPagesPerIngest: alternativeDataConfig.maxPagesPerIngest,
      onProviderRequest: (request) => {
        logger.debug({
          event: "alternative-data.provider.request",
          ...request,
        });
      },
    },
  );

  const coordinator = new RedlockLoadCoordinator(redis, {
    lockDurationMs: stockDataConfig.loadLockDurationMs,
    lockWaitMs: stockDataConfig.loadLockWaitMs,
  });

  // End-of-day finality, shared by both loaders below (`docs/decisions/eod-finality-v1.md`): a run
  // never reads a bar for a session that had not become final when it was read, and the execution
  // calendar and the stock frames agree on the newest final session.
  const eod = {
    ...getEodFinalityConfig(),
    calendar: new CachedTradingCalendar(provider),
  };
  // The same schedule, for the ETF contexts' week-completion rule.
  const etfSchedule = new EodFinalityPolicy(eod);

  // `stockDetailsHistoryYears` is deliberately not set here: it narrows what the Stock Details
  // surface may explore, and a backtest names its own period inside the product horizon.
  const stockCache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    stockDataConfig.lruMaxSecurities,
    STOCK_DATA_CACHE_NAMESPACE,
    DEFAULT_HYDRATION_TTL_MS,
    {
      // Repaired from PostgreSQL either way; this is what makes the repair visible.
      onUnreadableChunk: (chunk) => {
        logger.warn({ event: "stock-data.cache.chunk-unreadable", ...chunk });
      },
      // The read was served; only its LRU recency was lost (a Redis refusing writes).
      onTouchFailed: ({ securityId, error }) => {
        logger.warn({ event: "stock-data.cache.touch-failed", securityId, err: error });
      },
      ...stockCacheTierObserver(logger),
    },
    stockCachePayloadCodecs(),
    // The tier every admission routes to: the built-in universes from PostgreSQL.
    canonicalProtectedTierEligibility(prisma, logger),
  );
  const stockData = new CanonicalStockDataService(
    new PrismaStockDataStore(prisma),
    provider,
    stockCache,
    coordinator,
    {
      defaultHistoryDays: stockDataConfig.defaultHistoryDays,
      productHistoryYears: stockDataConfig.productHistoryYears,
      eod,
      fundamentalsFreshnessMs: stockDataConfig.fundamentalsFreshnessMs,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
      onProviderRequest,
      onPriceBasisEvent: logPriceBasisEvent(logger),
      alternativeData,
    },
  );

  const benchmarks = new CanonicalBenchmarkDataService(
    new PrismaBenchmarkDataStore(prisma),
    provider,
    new RedisBenchmarkDataCache(new IoredisCacheClient(redis), {
      observer: { onUnreadableChunk: logUnreadableBenchmarkChunk(logger) },
    }),
    coordinator,
    {
      // The product horizon, not the stock loader's raw-price retention. A benchmark carries no
      // stored derived series (`AGENTS.md` invariant 13), so as a comparison benchmark it has
      // nothing to warm up: its history is the run's execution calendar and the comparison line,
      // both of which live entirely inside the backtestable period. An ETF a Condition reads is a
      // different reader with its own, provider-free path (`etfContexts` below): it takes the whole
      // stored history, because an indicator's warm-up begins at the fund's first session.
      historyYears: stockDataConfig.productHistoryYears,
      eod,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
      onProviderRequest,
      onPriceBasisEvent: logPriceBasisEvent(logger),
      onCacheEvent: logBenchmarkCacheEvent(logger),
    },
  );

  return {
    // The deployment-wide execution cap is decided at the claim, in PostgreSQL, so it holds across
    // every worker process on every host (`ai/architecture/backtest-execution.md`, "Global admission").
    repository: new PrismaBacktestJobRepository(prisma, {
      globalMaxRunning: getBacktestAdmissionConfig().globalMaxRunning,
    }),
    securities: new PrismaBacktestSecurityCatalog(prisma),
    stockData,
    benchmarks,
    // ETF condition sources read through the same canonical service, but through the provider-free
    // reader slice only: the ETF condition path may never hydrate
    // (`docs/decisions/strategy-etf-conditions-v1.md` §5 — no FMP requests during evaluation). The
    // finalized-session convention shares the refresh child's own publication delay.
    etfContexts: {
      loader: {
        getSeries: (seriesId) => benchmarks.getSeries(seriesId),
        readFullBenchmarkHistory: (series, through) =>
          benchmarks.readFullBenchmarkHistory(series, through),
        benchmarkRefreshState: (series) =>
          benchmarks.benchmarkRefreshState(series),
        missingBenchmarkCoverage: (series, period) =>
          benchmarks.missingBenchmarkCoverage(series, period),
      },
      publicationDelayMs: getMarketDataWorkerConfig().publicationDelayMs,
      // The funds' venue schedule, through the same cached calendar the loaders' finality reads.
      isScheduledSession: (date) =>
        etfSchedule.isScheduledSession(MARKET_DATA_CALENDAR_EXCHANGE, date),
    },
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
    protectedTier: stockCache,
    async reportRedisEvictionPolicy(): Promise<void> {
      const assessment = await inspectRedisEvictionPolicy(
        redis,
        getRedisEvictionPolicyConfig(),
      );
      const entry = { event: "redis.eviction-policy", ...assessment };
      if (assessment.verdict === "UNSAFE") {
        logger.error(entry);
      } else if (assessment.verdict === "SAFE") {
        logger.info(entry);
      } else {
        logger.warn(entry);
      }
    },
    async close(): Promise<void> {
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}
