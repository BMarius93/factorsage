import { randomUUID } from "node:crypto";
import { STOCK_DETAILS_MAX_HISTORY_YEARS } from "@intrinsic/contracts";
import {
  getAlternativeDataConfig,
  getApiConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getRedisEvictionPolicyConfig,
  getEodFinalityConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import { FmpClient } from "@intrinsic/fmp";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import {
  type AlternativeDataStore,
  CachedTradingCalendar,
  CanonicalAlternativeDataService,
  CanonicalCongressMemberCatalogService,
  canonicalProtectedTierEligibility,
  CanonicalSecurityCatalogService,
  CanonicalStockDataService,
  type CongressMemberCatalogService,
  createStockDataRedisClient,
  DEFAULT_HYDRATION_TTL_MS,
  inspectRedisEvictionPolicy,
  IoredisCacheClient,
  type LoadCoordinator,
  logPriceBasisEvent,
  PrismaAlternativeDataStore,
  PrismaCongressMemberCatalogStore,
  PrismaStockDataStore,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  type SecurityCatalogService,
  STOCK_DATA_CACHE_NAMESPACE,
  stockCachePayloadCodecs,
  stockCacheTierObserver,
  type StockDataCache,
  type StockDataStore,
  type StockDetailsDataService,
} from "@intrinsic/stock-data";
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { LoggedCongressMemberCatalogService } from "./logged-congress-member-catalog.service";
import { LoggedSecurityCatalogService } from "./logged-security-catalog.service";
import { LoggedStockDataService } from "./logged-stock-data.service";
import {
  ALTERNATIVE_DATA_SERVICE,
  ALTERNATIVE_DATA_STORE,
  CONGRESS_MEMBER_CATALOG_SERVICE,
  REDIS_ACCEPTED_EVICTION_POLICY,
  SECURITY_CATALOG_SERVICE,
  STOCK_DATA_CACHE,
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
  STOCK_DATA_REDIS,
  STOCK_DATA_SERVICE,
  STOCK_DATA_STORE,
  STOCK_DETAILS_RETENTION_YEARS,
} from "./stock-data.tokens";
import { StocksController } from "./stocks.controller";

type StockDataRedisClient = ReturnType<typeof createStockDataRedisClient>;
const STOCK_DATA_LOGGER = Symbol("STOCK_DATA_LOGGER");

@Injectable()
class StockDataRedisLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(STOCK_DATA_REDIS)
    private readonly redis: StockDataRedisClient,
  ) {}

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

/**
 * Says once, at startup, how this Redis evicts (`docs/decisions/etf-market-data-v1.md`).
 *
 * Readiness repeats the check on every probe; this line is what an operator searching the boot log
 * finds. It never fails the boot: a Redis that refuses `INFO` reads as `UNKNOWN`.
 */
@Injectable()
class RedisEvictionPolicyReporter implements OnApplicationBootstrap {
  constructor(
    @Inject(STOCK_DATA_REDIS)
    private readonly redis: StockDataRedisClient,
    @Inject(STOCK_DATA_LOGGER) private readonly logger: StructuredLogger,
    @Inject(REDIS_ACCEPTED_EVICTION_POLICY)
    private readonly acceptedPolicy: string | null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const assessment = await inspectRedisEvictionPolicy(this.redis, {
      ...(this.acceptedPolicy ? { acceptedPolicy: this.acceptedPolicy } : {}),
    });
    const entry = { event: "redis.eviction-policy", ...assessment };
    if (assessment.verdict === "UNSAFE") {
      this.logger.error(entry);
    } else if (assessment.verdict === "SAFE") {
      this.logger.info(entry);
    } else {
      this.logger.warn(entry);
    }
  }
}

@Module({
  controllers: [StocksController],
  providers: [
    {
      provide: STOCK_DATA_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "stock-data" },
        });
      },
    },
    {
      provide: STOCK_DATA_STORE,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): StockDataStore =>
        new PrismaStockDataStore(prisma),
    },
    {
      provide: STOCK_DATA_PROVIDER,
      inject: [STOCK_DATA_REDIS],
      // Typed as the concrete client because it satisfies both the per-stock read port and the
      // bulk catalog port, and both are injected from this single instance.
      useFactory: (redis: StockDataRedisClient): FmpClient => {
        const config = getFmpTrafficConfig();
        return new FmpClient(() => getFmpConfig(), fetch, {
          gate: new RedisFmpRequestGate(redis, {
            maxConcurrentRequests: config.maxConcurrentRequests,
            rateLimitPerWindow: config.rateLimitPerWindow,
            rateWindowMs: config.rateWindowMs,
            maxQueueDepth: config.maxQueueDepth,
            maxQueueWaitMs: config.maxQueueWaitMs,
            requestLeaseMs: config.timeoutMs * 2,
          }),
        });
      },
    },
    {
      provide: STOCK_DATA_REDIS,
      inject: [STOCK_DATA_LOGGER],
      useFactory: (logger: StructuredLogger): StockDataRedisClient =>
        createStockDataRedisClient(getRedisConfig().url, (err) => {
          logger.warn({ event: "stock-data.redis.error", err });
        }),
    },
    {
      provide: STOCK_DATA_CACHE,
      inject: [STOCK_DATA_REDIS, STOCK_DATA_LOGGER, PrismaService],
      useFactory: (
        redis: StockDataRedisClient,
        logger: StructuredLogger,
        prisma: PrismaService,
      ): StockDataCache =>
        new RedisStockDataCache(
          new IoredisCacheClient(redis),
          getStockDataConfig().lruMaxSecurities,
          STOCK_DATA_CACHE_NAMESPACE,
          DEFAULT_HYDRATION_TTL_MS,
          {
            // Repaired from PostgreSQL either way; this is what makes the repair visible.
            onUnreadableChunk: (chunk) => {
              logger.warn({
                event: "stock-data.cache.chunk-unreadable",
                ...chunk,
              });
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
    },
    {
      provide: STOCK_DATA_COORDINATOR,
      inject: [STOCK_DATA_REDIS],
      useFactory: (redis: StockDataRedisClient): LoadCoordinator => {
        const config = getStockDataConfig();
        return new RedlockLoadCoordinator(redis, {
          lockDurationMs: config.loadLockDurationMs,
          lockWaitMs: config.loadLockWaitMs,
        });
      },
    },
    {
      provide: ALTERNATIVE_DATA_STORE,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): AlternativeDataStore =>
        new PrismaAlternativeDataStore(prisma),
    },
    {
      provide: ALTERNATIVE_DATA_SERVICE,
      inject: [ALTERNATIVE_DATA_STORE, STOCK_DATA_PROVIDER, STOCK_DATA_LOGGER],
      // Built from the same gated `FmpClient` as every other read, so an insider or congressional
      // ingest spends the shared provider allowance rather than opening a private lane beside it.
      useFactory: (
        store: AlternativeDataStore,
        provider: FmpClient,
        logger: StructuredLogger,
      ): CanonicalAlternativeDataService => {
        const config = getAlternativeDataConfig();
        return new CanonicalAlternativeDataService(store, provider, {
          freshnessMs: config.freshnessMs,
          maxPagesPerIngest: config.maxPagesPerIngest,
          onProviderRequest: (request) => {
            logger.debug({
              event: "alternative-data.provider.request",
              ...request,
            });
          },
        });
      },
    },
    {
      provide: STOCK_DATA_SERVICE,
      inject: [
        STOCK_DATA_STORE,
        STOCK_DATA_PROVIDER,
        STOCK_DATA_CACHE,
        STOCK_DATA_COORDINATOR,
        STOCK_DATA_LOGGER,
        ALTERNATIVE_DATA_SERVICE,
      ],
      useFactory: (
        store: StockDataStore,
        provider: FmpClient,
        cache: StockDataCache,
        coordinator: LoadCoordinator,
        logger: StructuredLogger,
        alternativeData: CanonicalAlternativeDataService,
      ): StockDetailsDataService => {
        const service = new CanonicalStockDataService(
          store,
          provider,
          cache,
          coordinator,
          {
            defaultHistoryDays: getStockDataConfig().defaultHistoryDays,
            productHistoryYears: getStockDataConfig().productHistoryYears,
            // The Stock Details product limit, from the one place it is defined. It only ever
            // narrows what that surface reports and reads; the product horizon above is what a
            // backtest still reaches for, and the loader's own raw-price retention reaches
            // further back again without any surface seeing it.
            stockDetailsHistoryYears: STOCK_DETAILS_MAX_HISTORY_YEARS,
            // End-of-day finality (`docs/decisions/eod-finality-v1.md`): every read ends at the
            // newest final session, and a tail is re-read only once a newer session is final. The
            // venue schedule comes through the same gated provider as everything else.
            eod: {
              ...getEodFinalityConfig(),
              calendar: new CachedTradingCalendar(provider),
            },
            fundamentalsFreshnessMs:
              getStockDataConfig().fundamentalsFreshnessMs,
            recentTailCalendarDays: getStockDataConfig().recentTailCalendarDays,
            // Every historical provider request explains itself. `debug`, because a warm read
            // makes none at all and a cold one makes a bounded burst — useful for diagnosing
            // "why is it calling FMP again?", never for production noise.
            onProviderRequest: (request) => {
              logger.debug({
                event: "stock-data.provider.request",
                ...request,
              });
            },
            // Every re-base decision (`historical-price-basis-v1.md`, §7–§9): rare, and each one
            // replaces or holds a security's history, so it is worth an `info` line.
            onPriceBasisEvent: logPriceBasisEvent(logger),
            alternativeData,
          },
        );
        return new LoggedStockDataService(service, logger);
      },
    },
    {
      provide: STOCK_DETAILS_RETENTION_YEARS,
      // The product horizon, deliberately: this token bounds what Stock Details may expose, and
      // the loader's wider raw-price retention is internal warm-up that no surface reports.
      useFactory: (): number => getStockDataConfig().productHistoryYears,
    },
    {
      provide: SECURITY_CATALOG_SERVICE,
      inject: [
        STOCK_DATA_STORE,
        STOCK_DATA_PROVIDER,
        STOCK_DATA_LOGGER,
        STOCK_DATA_CACHE,
      ],
      useFactory: (
        store: StockDataStore,
        provider: FmpClient,
        logger: StructuredLogger,
        cache: StockDataCache,
      ): SecurityCatalogService =>
        new LoggedSecurityCatalogService(
          // The cache is the one Stock Details reads a symbol's identity row from; the sync writes
          // an updated row through so a rename or deactivation is visible before eviction.
          new CanonicalSecurityCatalogService(
            store,
            provider,
            undefined,
            cache,
          ),
          logger.child({ component: "security-catalog" }),
        ),
    },
    {
      provide: CONGRESS_MEMBER_CATALOG_SERVICE,
      inject: [PrismaService, STOCK_DATA_PROVIDER, STOCK_DATA_LOGGER],
      // The same gated `FmpClient` as every other read, and its own small store: it writes actor
      // labels and its state row, never a disclosure, so it shares nothing with the loader above
      // but the provider allowance.
      useFactory: (
        prisma: PrismaService,
        provider: FmpClient,
        logger: StructuredLogger,
      ): CongressMemberCatalogService =>
        new LoggedCongressMemberCatalogService(
          new CanonicalCongressMemberCatalogService(
            new PrismaCongressMemberCatalogStore(prisma),
            provider,
            // Names this process's claim on the singleton state row, so a second API instance —
            // or the operator command — cannot run beside it.
            { owner: `api-${process.pid}-${randomUUID()}` },
          ),
          logger.child({ component: "congress-member-catalog" }),
        ),
    },
    {
      provide: REDIS_ACCEPTED_EVICTION_POLICY,
      useFactory: (): string | null =>
        getRedisEvictionPolicyConfig().acceptedPolicy ?? null,
    },
    RedisEvictionPolicyReporter,
    StockDataRedisLifecycle,
  ],
  // The Redis client is exported for the readiness probe only; no feature module reads it.
  //
  // The provider and the coordinator are exported so the benchmark loader is built from the *same*
  // FMP gate and the *same* Redlock instance this module already owns. A second gate would spend a
  // second rate-limit budget against one provider account, and a second coordinator would make the
  // hydration lock stop serializing the two loaders it exists to serialize.
  exports: [
    STOCK_DATA_SERVICE,
    SECURITY_CATALOG_SERVICE,
    CONGRESS_MEMBER_CATALOG_SERVICE,
    STOCK_DATA_REDIS,
    REDIS_ACCEPTED_EVICTION_POLICY,
    STOCK_DATA_PROVIDER,
    STOCK_DATA_COORDINATOR,
    ALTERNATIVE_DATA_STORE,
    ALTERNATIVE_DATA_SERVICE,
  ],
})
export class StocksModule {}
