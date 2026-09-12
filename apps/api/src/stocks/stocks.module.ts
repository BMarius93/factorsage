import { STOCK_DETAILS_MAX_HISTORY_YEARS } from "@intrinsic/contracts";
import {
  getApiConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import type { StockDataService } from "@intrinsic/domain";
import { FmpClient } from "@intrinsic/fmp";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import {
  CanonicalSecurityCatalogService,
  CanonicalStockDataService,
  createStockDataRedisClient,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  type LoadCoordinator,
  type SecurityCatalogService,
  type StockDataCache,
  type StockDataStore,
} from "@intrinsic/stock-data";
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { LoggedSecurityCatalogService } from "./logged-security-catalog.service";
import { LoggedStockDataService } from "./logged-stock-data.service";
import {
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
      inject: [STOCK_DATA_REDIS],
      useFactory: (redis: StockDataRedisClient): StockDataCache =>
        new RedisStockDataCache(
          new IoredisCacheClient(redis),
          getStockDataConfig().maxResidentStocks,
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
      provide: STOCK_DATA_SERVICE,
      inject: [
        STOCK_DATA_STORE,
        STOCK_DATA_PROVIDER,
        STOCK_DATA_CACHE,
        STOCK_DATA_COORDINATOR,
        STOCK_DATA_LOGGER,
      ],
      useFactory: (
        store: StockDataStore,
        provider: FmpClient,
        cache: StockDataCache,
        coordinator: LoadCoordinator,
        logger: StructuredLogger,
      ): StockDataService => {
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
            recentPriceFreshnessMs: getStockDataConfig().recentPriceFreshnessMs,
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
    StockDataRedisLifecycle,
  ],
  // The Redis client is exported for the readiness probe only; no feature module reads it.
  exports: [STOCK_DATA_SERVICE, SECURITY_CATALOG_SERVICE, STOCK_DATA_REDIS],
})
export class StocksModule {}
