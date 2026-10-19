import {
  getAlternativeDataConfig,
  getEodFinalityConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getMarketDataWorkerConfig,
  getRedisConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { FmpClient } from "@intrinsic/fmp";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  CachedTradingCalendar,
  CanonicalAlternativeDataService,
  CanonicalBenchmarkDataService,
  canonicalProtectedTierEligibility,
  CanonicalStockDataService,
  createStockDataRedisClient,
  DEFAULT_HYDRATION_TTL_MS,
  EodFinalityPolicy,
  IoredisCacheClient,
  logBenchmarkCacheEvent,
  logPriceBasisEvent,
  logUnreadableBenchmarkChunk,
  MARKET_DATA_CALENDAR_EXCHANGE,
  PrismaAlternativeDataStore,
  PrismaBenchmarkDataStore,
  PrismaStockDataStore,
  type ProviderRequestEvent,
  RedisBenchmarkDataCache,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  STOCK_DATA_CACHE_NAMESPACE,
  stockCachePayloadCodecs,
  stockCacheTierObserver,
  type TradingCalendar,
} from "@intrinsic/stock-data";
import type {
  MonitorEtfContexts,
  MonitorEvaluationData,
} from "./monitor-evaluation.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";
import { PrismaMonitorScanRepository } from "./scan-repository.js";

export type MonitorRuntime = {
  scans: PrismaMonitorScanRepository;
  monitors: PrismaMonitorRepository;
  /** Provider-free reads of finalized sessions: the EOD evaluation reaches no provider. */
  data: MonitorEvaluationData;
  /** The finality policy — the same delay and calendar every loader and the stock EOD child use. */
  policy: EodFinalityPolicy;
  calendar: TradingCalendar;
  /** The ETF histories behind ETF-sourced conditions: the provider-free reader slice only. */
  etfContexts: MonitorEtfContexts;
  close(): Promise<void>;
};

/**
 * The monitor worker's composition root.
 *
 * It mirrors `../backtest/composition.ts` deliberately: the same store, the same Redis cache, the
 * same shared FMP gate and the same load coordinator, built from the same configuration, and no
 * second implementation of any of them (`AGENTS.md` invariant 6).
 *
 * The EOD evaluation it serves reaches **no** price provider (`docs/decisions/monitor-eod-v2.md`
 * §3): `data` exposes only provider-free reads of finalized sessions — the readiness answer and the
 * PostgreSQL frame — and the ETF histories are read through the provider-free benchmark reader. The
 * stock EOD child owns every price read. The gated provider here serves the venue holiday schedule
 * alone, throttled with everyone else's traffic.
 */
export function createMonitorRuntime(logger: StructuredLogger): MonitorRuntime {
  const stockDataConfig = getStockDataConfig();
  const fmpTraffic = getFmpTrafficConfig();
  const alternativeDataConfig = getAlternativeDataConfig();

  const onProviderRequest = (request: ProviderRequestEvent): void => {
    logger.debug({ event: "stock-data.provider.request", ...request });
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

  // One process-memory venue schedule for the whole child: the cycle's session checks and both
  // loaders' end-of-day finality ask the same one (`docs/decisions/eod-finality-v1.md`).
  const calendar = new CachedTradingCalendar(provider);
  const eod = { ...getEodFinalityConfig(), calendar };

  const stockData = new CanonicalStockDataService(
    new PrismaStockDataStore(prisma),
    provider,
    new RedisStockDataCache(
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
          logger.warn({
            event: "stock-data.cache.touch-failed",
            securityId,
            err: error,
          });
        },
        ...stockCacheTierObserver(logger),
      },
      stockCachePayloadCodecs(),
      // The tier every admission routes to: the built-in universes from PostgreSQL.
      canonicalProtectedTierEligibility(prisma, logger),
    ),
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

  // The canonical benchmark service, for the ETF condition sources alone — and only its
  // provider-free reader slice is handed out, so a Monitor cycle can never hydrate an ETF
  // (`docs/decisions/strategy-etf-conditions-v1.md` §5). The bootstrap and the market-data child
  // own provider reads; a series they have not maintained is simply unavailable here.
  const benchmarks = new CanonicalBenchmarkDataService(
    new PrismaBenchmarkDataStore(prisma),
    provider,
    new RedisBenchmarkDataCache(new IoredisCacheClient(redis), {
      observer: { onUnreadableChunk: logUnreadableBenchmarkChunk(logger) },
    }),
    coordinator,
    {
      historyYears: stockDataConfig.productHistoryYears,
      eod,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
      onProviderRequest,
      onPriceBasisEvent: logPriceBasisEvent(logger),
      onCacheEvent: logBenchmarkCacheEvent(logger),
    },
  );

  const policy = new EodFinalityPolicy(eod);
  const etfSchedule = policy;
  const etfContexts: MonitorEtfContexts = {
    loader: {
      getSeries: (seriesId) => benchmarks.getSeries(seriesId),
      readFullBenchmarkHistory: (series, through) =>
        benchmarks.readFullBenchmarkHistory(series, through),
      benchmarkRefreshState: (series) =>
        benchmarks.benchmarkRefreshState(series),
      missingBenchmarkCoverage: (series, period) =>
        benchmarks.missingBenchmarkCoverage(series, period),
    },
    resolveSeriesId: async (code) => {
      const benchmark = await benchmarks.getBenchmark(code);
      return benchmark.series.id;
    },
    publicationDelayMs: getMarketDataWorkerConfig().publicationDelayMs,
    // The funds trade on the market-data venue's schedule, read through the same cached calendar.
    isScheduledSession: (date) =>
      etfSchedule.isScheduledSession(MARKET_DATA_CALENDAR_EXCHANGE, date),
  };

  return {
    scans: new PrismaMonitorScanRepository(prisma),
    monitors: new PrismaMonitorRepository(prisma),
    data: {
      findSecurities: (ids) => stockData.findSecuritiesByIds(ids),
      stockRefreshState: (security) => stockData.stockRefreshState(security),
      readFinalizedEvaluationFrame: (security, range, operands) =>
        stockData.readFinalizedEvaluationFrame(security, range, operands),
      reconstructionHistoryStart: (security) =>
        stockData.evaluationHistoryStart(security),
    },
    policy,
    etfContexts,
    // Built from the same gated provider as everything else, so a schedule fetch is throttled with
    // the rest of the cycle's traffic. Its cache is process memory by design — see
    // `CachedTradingCalendar`; nothing about it belongs in Redis.
    calendar,
    async close(): Promise<void> {
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}
