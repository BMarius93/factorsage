import {
  getEodFinalityConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getRedisEvictionPolicyConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { FmpClient } from "@intrinsic/fmp";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  CachedTradingCalendar,
  CanonicalBenchmarkDataService,
  IoredisCacheClient,
  PrismaBenchmarkDataStore,
  RedisBenchmarkDataCache,
  RedisFmpRequestGate,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  inspectRedisEvictionPolicy,
  logBenchmarkCacheEvent,
  logPriceBasisEvent,
  logUnreadableBenchmarkChunk,
  type RedisEvictionAssessment,
  type TradingCalendar,
} from "@intrinsic/stock-data";
import { PrismaMarketDataRefreshScheduleRepository } from "./schedule-repository.js";

export type MarketDataRuntime = {
  schedule: PrismaMarketDataRefreshScheduleRepository;
  benchmarks: CanonicalBenchmarkDataService;
  calendar: TradingCalendar;
  inspectEvictionPolicy(): Promise<RedisEvictionAssessment>;
  close(): Promise<void>;
};

/**
 * The market-data child's composition root.
 *
 * Built from exactly the pieces every other process uses — the same Prisma store, the same benchmark
 * Redis projection, the same `RedisFmpRequestGate` and the same Redlock coordinator, with the same
 * configuration — so the refresh serializes against a backtest or a page read hydrating the same
 * series, and spends the one provider budget rather than opening a lane of its own.
 */
export function createMarketDataRuntime(
  logger: StructuredLogger,
): MarketDataRuntime {
  const stockDataConfig = getStockDataConfig();
  const fmpTraffic = getFmpTrafficConfig();
  const redisConfig = getRedisConfig();

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(redisConfig.url, (err) => {
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
  // Process memory with a TTL, one schedule request per exchange and year, through the gate. The
  // run's expected session and the loader's tail freshness ask the same one.
  const calendar = new CachedTradingCalendar(provider);
  const benchmarks = new CanonicalBenchmarkDataService(
    new PrismaBenchmarkDataStore(prisma),
    provider,
    new RedisBenchmarkDataCache(new IoredisCacheClient(redis), {
      observer: { onUnreadableChunk: logUnreadableBenchmarkChunk(logger) },
    }),
    new RedlockLoadCoordinator(redis, {
      lockDurationMs: stockDataConfig.loadLockDurationMs,
      lockWaitMs: stockDataConfig.loadLockWaitMs,
    }),
    {
      eod: { ...getEodFinalityConfig(), calendar },
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
      onProviderRequest: (request) => {
        logger.debug({ event: "stock-data.provider.request", ...request });
      },
      onPriceBasisEvent: logPriceBasisEvent(logger),
      onCacheEvent: logBenchmarkCacheEvent(logger),
    },
  );

  return {
    schedule: new PrismaMarketDataRefreshScheduleRepository(prisma),
    benchmarks,
    calendar,
    inspectEvictionPolicy: () =>
      inspectRedisEvictionPolicy(redis, {
        ...getRedisEvictionPolicyConfig(),
      }),
    async close(): Promise<void> {
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}

/** Logs the Redis eviction policy once, at the level its verdict deserves. */
export async function logRedisEvictionPolicy(
  logger: StructuredLogger,
  inspect: () => Promise<RedisEvictionAssessment>,
): Promise<RedisEvictionAssessment> {
  const assessment = await inspect();
  const entry = { event: "redis.eviction-policy", ...assessment };
  if (assessment.verdict === "UNSAFE") {
    logger.error(entry);
  } else if (assessment.verdict === "SAFE") {
    logger.info(entry);
  } else {
    logger.warn(entry);
  }
  return assessment;
}
