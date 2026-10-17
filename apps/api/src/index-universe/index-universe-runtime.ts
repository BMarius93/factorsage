import { STOCK_DETAILS_MAX_HISTORY_YEARS } from "@intrinsic/contracts";
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
import type { StructuredLogger as Logger } from "@intrinsic/observability";
import {
  CachedTradingCalendar,
  CanonicalAlternativeDataService,
  CanonicalStockDataService,
  createStockDataRedisClient,
  DEFAULT_HYDRATION_TTL_MS,
  IndexMembershipSyncService,
  IoredisCacheClient,
  logPriceBasisEvent,
  PrismaAlternativeDataStore,
  PrismaIndexMembershipStore,
  PrismaStockDataStore,
  RedisFmpRequestBudget,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  STOCK_DATA_CACHE_NAMESPACE,
} from "@intrinsic/stock-data";
import { IndexUniverseRequestGuard } from "./index-universe-guard.js";

/**
 * Everything one index-universe command needs, built once (`docs/decisions/sp500-historical-pit-v1.md`).
 *
 * The loaders are the canonical ones every product read uses — the same store, cache, hydration
 * lock, provider gate and calendar — so a security this command hydrates is indistinguishable from
 * one a page read materialized. What is different is the client's guard: a fixed symbol scope read
 * from the canonical membership, and a request budget.
 *
 * The key is read through `getFmpConfig()` like every other composition. In a Claude cloud session
 * it is mapped onto `FMP_API_KEY` for this one command by `scripts/cloud/fmp-index-universe.sh`.
 */
export type IndexUniverseRuntime = {
  readonly prisma: PrismaClient;
  readonly redis: ReturnType<typeof createStockDataRedisClient>;
  readonly provider: FmpClient;
  readonly guard: IndexUniverseRequestGuard;
  readonly budget: RedisFmpRequestBudget;
  readonly store: PrismaStockDataStore;
  readonly cache: RedisStockDataCache;
  readonly stockData: CanonicalStockDataService;
  readonly alternativeData: CanonicalAlternativeDataService;
  readonly membershipStore: PrismaIndexMembershipStore;
  readonly membership: IndexMembershipSyncService;
  readonly productHistoryYears: number;
  /** Requests the loaders announced, per symbol. */
  readonly providerRequests: Map<string, number>;
  close(): Promise<void>;
};

export async function createIndexUniverseRuntime(input: {
  readonly logger: Logger;
  readonly runId: string;
  /** The symbols the guard admits for per-security requests. */
  readonly scopeSymbols: readonly string[];
  readonly budget: number;
  /** When false, nothing may reach the provider: the guard admits no request. */
  readonly provider: boolean;
  /** Overrides the loaders' alternative-data page bound for this run. */
  readonly alternativeDataMaxPages?: number;
}): Promise<IndexUniverseRuntime> {
  const { logger } = input;
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url, (err) => {
    logger.warn({ event: "stock-data.redis.error", err });
  });
  const traffic = getFmpTrafficConfig();
  const stockDataConfig = getStockDataConfig();
  const alternativeDataConfig = getAlternativeDataConfig();

  const budget = new RedisFmpRequestBudget(redis, {
    runId: input.runId,
    limit: Math.max(1, input.budget),
  });
  const guard = new IndexUniverseRequestGuard(
    input.provider ? input.scopeSymbols : [],
    budget,
  );
  const provider = new FmpClient(
    () => {
      if (!input.provider) {
        throw new Error(
          "This index-universe command does not reach the provider",
        );
      }
      return getFmpConfig();
    },
    fetch,
    {
      gate: new RedisFmpRequestGate(redis, {
        maxConcurrentRequests: traffic.maxConcurrentRequests,
        rateLimitPerWindow: traffic.rateLimitPerWindow,
        rateWindowMs: traffic.rateWindowMs,
        maxQueueDepth: traffic.maxQueueDepth,
        maxQueueWaitMs: traffic.maxQueueWaitMs,
        requestLeaseMs: traffic.timeoutMs * 2,
      }),
      guard,
    },
  );

  const store = new PrismaStockDataStore(prisma);
  const cache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    stockDataConfig.maxResidentStocks,
    STOCK_DATA_CACHE_NAMESPACE,
    DEFAULT_HYDRATION_TTL_MS,
    {
      onUnreadableChunk: (chunk) => {
        logger.warn({ event: "stock-data.cache.chunk-unreadable", ...chunk });
      },
    },
  );

  const providerRequests = new Map<string, number>();
  const countRequest = (symbol: string) => {
    providerRequests.set(symbol, (providerRequests.get(symbol) ?? 0) + 1);
  };

  const alternativeData = new CanonicalAlternativeDataService(
    new PrismaAlternativeDataStore(prisma),
    provider,
    {
      freshnessMs: alternativeDataConfig.freshnessMs,
      maxPagesPerIngest:
        input.alternativeDataMaxPages ?? alternativeDataConfig.maxPagesPerIngest,
      onProviderRequest: (request) => {
        countRequest(request.symbol);
        logger.debug({ event: "alternative-data.provider.request", ...request });
      },
      onForeignRows: (event) => {
        logger.warn({ event: "alternative-data.foreign-rows", ...event });
      },
    },
  );

  const stockData = new CanonicalStockDataService(
    store,
    provider,
    cache,
    new RedlockLoadCoordinator(redis, {
      lockDurationMs: stockDataConfig.loadLockDurationMs,
      lockWaitMs: stockDataConfig.loadLockWaitMs,
    }),
    {
      defaultHistoryDays: stockDataConfig.defaultHistoryDays,
      productHistoryYears: stockDataConfig.productHistoryYears,
      stockDetailsHistoryYears: STOCK_DETAILS_MAX_HISTORY_YEARS,
      eod: { ...getEodFinalityConfig(), calendar: new CachedTradingCalendar(provider) },
      fundamentalsFreshnessMs: stockDataConfig.fundamentalsFreshnessMs,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
      onProviderRequest: (request) => {
        countRequest(request.symbol);
        logger.debug({ event: "stock-data.provider.request", ...request });
      },
      onPriceBasisEvent: logPriceBasisEvent(logger),
      alternativeData,
    },
  );

  const membershipStore = new PrismaIndexMembershipStore(prisma);
  const membership = new IndexMembershipSyncService(membershipStore, provider, {
    probeConcurrency: Math.max(1, traffic.maxConcurrentRequests),
    onEvent: (event) => logger.info(event),
  });

  return {
    prisma,
    redis,
    provider,
    guard,
    budget,
    store,
    cache,
    stockData,
    alternativeData,
    membershipStore,
    membership,
    productHistoryYears: stockDataConfig.productHistoryYears,
    providerRequests,
    close: async () => {
      await budget.dispose().catch(() => {});
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}
