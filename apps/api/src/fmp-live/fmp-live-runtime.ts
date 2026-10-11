import { STOCK_DETAILS_MAX_HISTORY_YEARS } from "@intrinsic/contracts";
import {
  getAlternativeDataConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { FmpClient, FmpSecurityScope } from "@intrinsic/fmp";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  CanonicalAlternativeDataService,
  CanonicalStockDataService,
  createStockDataRedisClient,
  DEFAULT_HYDRATION_TTL_MS,
  IoredisCacheClient,
  logPriceBasisEvent,
  PrismaAlternativeDataStore,
  PrismaStockDataStore,
  RedisFmpRequestBudget,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  STOCK_DATA_CACHE_NAMESPACE,
} from "@intrinsic/stock-data";
import { LIVE_FMP_MAX_SECURITIES } from "./fmp-live-arguments";
import { LiveFmpRunGuard } from "./fmp-live-guard";

/**
 * The live run's composition root: the product's own loaders, wired the way the API wires them,
 * around one `FmpClient` that carries the run's guard.
 *
 * Nothing here is a loader. The store, the Redis cache, the hydration lock and both canonical
 * services are the classes `apps/api/src/stocks/stocks.module.ts` composes, built from the same
 * configuration, so what a run stores is what a page view would have stored. Three things differ,
 * and they are the whole of what makes a run "live" and bounded:
 *
 * - the client has a **guard** — the security scope and the request budget
 *   (`fmp-live-guard.ts`). Every other composition root in the repository passes none;
 * - the shared `RedisFmpRequestGate` is the same gate on the same Redis keys, so a run waits in
 *   the same queue and spends the same rate allowance as everything else. Its concurrency is the
 *   configured one, capped at {@link LIVE_FMP_MAX_CONCURRENT_REQUESTS}: a run may be slower than
 *   the application, never faster than its documented default;
 * - the client is pinned to the provider's own endpoint. `FMP_BASE_URL` is not read.
 *
 * It composes no benchmark service, no trading calendar, no Monitor or backtest runtime and no
 * catalog synchronization against the provider's screener. Those are the paths that widen the
 * symbol universe; the guard would refuse them, and they are not here to be refused.
 */

/**
 * In-flight provider requests a live run may have, at most: the application's own documented
 * default (`FMP_MAX_CONCURRENT_REQUESTS`), so a deployment configured for a larger plan does not
 * make a run more aggressive than the product is out of the box.
 *
 * Not lower, and the reason was measured rather than assumed. The fundamentals loader asks for its
 * six statement histories at once, and a request that finds the shared gate full sleeps until the
 * oldest holder's *lease* would expire — thirty seconds by default — not until a slot is released.
 * Against the real gate, six simultaneous 300 ms requests finished in about one second at
 * concurrency 4 and in thirty-one seconds at concurrency 2, every time, with the same six requests
 * sent either way. A lower cap would add half a minute of sleeping per cold security and spare the
 * provider nothing: the total is bounded by the budget and the rate by the gate's window, and
 * neither depends on this number. An operator who wants it lower still sets
 * `FMP_MAX_CONCURRENT_REQUESTS` for the run.
 */
export const LIVE_FMP_MAX_CONCURRENT_REQUESTS = 4;

/** The configured provider traffic, with the run's concurrency cap applied. */
export function liveFmpTraffic<
  T extends { readonly maxConcurrentRequests: number },
>(traffic: T): T {
  return {
    ...traffic,
    maxConcurrentRequests: Math.min(
      traffic.maxConcurrentRequests,
      LIVE_FMP_MAX_CONCURRENT_REQUESTS,
    ),
  };
}

export type LiveFmpRuntime = {
  readonly prisma: PrismaClient;
  readonly scope: FmpSecurityScope;
  readonly budget: RedisFmpRequestBudget;
  readonly guard: LiveFmpRunGuard;
  readonly provider: FmpClient;
  readonly store: PrismaStockDataStore;
  readonly cache: RedisStockDataCache;
  readonly stockData: CanonicalStockDataService;
  readonly alternativeData: CanonicalAlternativeDataService;
  readonly productHistoryYears: number;
  readonly alternativeDataMaxPages: number;
  readonly maxRetries: number;
  close(): Promise<void>;
};

export function createLiveFmpRuntime(input: {
  readonly symbols: readonly string[];
  readonly budget: number;
  readonly runId: string;
  readonly logger: StructuredLogger;
  /**
   * The far end of the wire and the Redis key prefix, for the offline suite alone: it drives this
   * exact composition against a provider that is a function, under keys of its own. A run passes
   * neither, and so talks to the provider and shares the application's keys.
   */
  readonly fetchImplementation?: typeof fetch;
  readonly redisNamespace?: string;
}): LiveFmpRuntime {
  const { logger } = input;
  const stockDataConfig = getStockDataConfig();
  const traffic = liveFmpTraffic(getFmpTrafficConfig());
  const alternativeDataConfig = getAlternativeDataConfig();

  // Before anything is opened: more than the permitted number of securities stops here, whoever
  // built the list.
  const scope = new FmpSecurityScope(input.symbols, {
    maxSecurities: LIVE_FMP_MAX_SECURITIES,
  });

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url, (err) => {
    logger.warn({ event: "stock-data.redis.error", err });
  });
  // The gate's own namespace: the budget counter sits beside the gate's keys.
  const gateNamespace =
    input.redisNamespace === undefined
      ? undefined
      : `${input.redisNamespace}:fmp`;
  const budget = new RedisFmpRequestBudget(redis, {
    runId: input.runId,
    limit: input.budget,
    ...(gateNamespace === undefined ? {} : { namespace: gateNamespace }),
  });
  const guard = new LiveFmpRunGuard(scope, budget);

  const provider = new FmpClient(
    () => {
      const config = getFmpConfig();
      // Field by field, so `baseUrl` is not carried over: the provider's own endpoint, always.
      return {
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        retryBaseDelayMs: config.retryBaseDelayMs,
        retryMaxDelayMs: config.retryMaxDelayMs,
        maxRetryWaitMs: config.maxRetryWaitMs,
      };
    },
    input.fetchImplementation ?? fetch,
    {
      gate: new RedisFmpRequestGate(redis, {
        maxConcurrentRequests: traffic.maxConcurrentRequests,
        rateLimitPerWindow: traffic.rateLimitPerWindow,
        rateWindowMs: traffic.rateWindowMs,
        maxQueueDepth: traffic.maxQueueDepth,
        maxQueueWaitMs: traffic.maxQueueWaitMs,
        requestLeaseMs: traffic.timeoutMs * 2,
        ...(gateNamespace === undefined ? {} : { namespace: gateNamespace }),
      }),
      guard,
    },
  );

  const store = new PrismaStockDataStore(prisma);
  const cache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    stockDataConfig.maxResidentStocks,
    input.redisNamespace ?? STOCK_DATA_CACHE_NAMESPACE,
    DEFAULT_HYDRATION_TTL_MS,
    {
      // Repaired from PostgreSQL either way; this is what makes the repair visible.
      onUnreadableChunk: (chunk) => {
        logger.warn({ event: "stock-data.cache.chunk-unreadable", ...chunk });
      },
    },
  );

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
      recentPriceFreshnessMs: stockDataConfig.recentPriceFreshnessMs,
      fundamentalsFreshnessMs: stockDataConfig.fundamentalsFreshnessMs,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
      onProviderRequest: (request) => {
        logger.debug({ event: "stock-data.provider.request", ...request });
      },
      onPriceBasisEvent: logPriceBasisEvent(logger),
      alternativeData,
    },
  );

  return {
    prisma,
    scope,
    budget,
    guard,
    provider,
    store,
    cache,
    stockData,
    alternativeData,
    productHistoryYears: stockDataConfig.productHistoryYears,
    alternativeDataMaxPages: alternativeDataConfig.maxPagesPerIngest,
    maxRetries: traffic.maxRetries,
    close: async () => {
      await budget.dispose().catch(() => {});
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}
