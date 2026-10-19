import {
  getAlternativeDataConfig,
  getEodFinalityConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { FmpClient } from "@intrinsic/fmp";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  CachedTradingCalendar,
  CanonicalAlternativeDataService,
  CanonicalStockDataService,
  DEFAULT_HYDRATION_TTL_MS,
  EodFinalityPolicy,
  IoredisCacheClient,
  PrismaAlternativeDataStore,
  PrismaStockDataStore,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  STOCK_DATA_CACHE_NAMESPACE,
  createStockDataRedisClient,
  logPriceBasisEvent,
  type ProviderRequestEvent,
  canonicalProtectedTierEligibility,
  stockCachePayloadCodecs,
  stockCacheTierObserver,
} from "@intrinsic/stock-data";
import {
  PrismaMarketDataRefreshScheduleRepository,
  STOCK_EOD_REFRESH_SCHEDULE_ID,
} from "../market-data/schedule-repository.js";
import { PrismaMonitorRepository } from "../monitor/monitor-repository.js";

export type StockEodRuntime = {
  schedule: PrismaMarketDataRefreshScheduleRepository;
  monitors: PrismaMonitorRepository;
  stockData: CanonicalStockDataService;
  policy: EodFinalityPolicy;
  /** Provider requests this process has made, every page and retry counted. */
  providerRequests: () => number;
  close(): Promise<void>;
};

/**
 * The stock EOD child's composition root (`docs/decisions/monitor-eod-v2-proposal.md` §3.3).
 *
 * Built from exactly the pieces every other process uses — the same Prisma store, the same Redis
 * stock cache and LRU, the same `RedisFmpRequestGate`, the same Redlock coordinator and the same
 * finality configuration and venue calendar — so its preparation serializes against a backtest or a
 * page read hydrating the same stock, spends the one provider budget, and agrees with every reader on
 * which session is the newest final one. It owns no second cache and no second loader.
 */
export function createStockEodRuntime(logger: StructuredLogger): StockEodRuntime {
  const stockDataConfig = getStockDataConfig();
  const fmpTraffic = getFmpTrafficConfig();
  const alternativeDataConfig = getAlternativeDataConfig();
  let providerRequests = 0;
  const onProviderRequest = (request: ProviderRequestEvent): void => {
    providerRequests += 1;
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

  // The same gated provider for disclosures, so an ingest spends the allowance a price read does.
  const alternativeData = new CanonicalAlternativeDataService(
    new PrismaAlternativeDataStore(prisma),
    provider,
    {
      freshnessMs: alternativeDataConfig.freshnessMs,
      maxPagesPerIngest: alternativeDataConfig.maxPagesPerIngest,
      onProviderRequest: (request) => {
        providerRequests += 1;
        logger.debug({ event: "alternative-data.provider.request", ...request });
      },
    },
  );

  // One venue schedule for the run's expected session and the loader's freshness decisions alike.
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
    ),
    new RedlockLoadCoordinator(redis, {
      lockDurationMs: stockDataConfig.loadLockDurationMs,
      lockWaitMs: stockDataConfig.loadLockWaitMs,
    }),
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

  return {
    schedule: new PrismaMarketDataRefreshScheduleRepository(
      prisma,
      STOCK_EOD_REFRESH_SCHEDULE_ID,
    ),
    monitors: new PrismaMonitorRepository(prisma),
    stockData,
    policy: new EodFinalityPolicy(eod),
    providerRequests: () => providerRequests,
    async close(): Promise<void> {
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}
