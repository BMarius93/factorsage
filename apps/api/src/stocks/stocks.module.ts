import {
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import type { StockDataService } from "@intrinsic/domain";
import { FmpClient, type FmpStockProviderPort } from "@intrinsic/fmp";
import {
  CanonicalStockDataService,
  createStockDataRedisClient,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  type LoadCoordinator,
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
import {
  STOCK_DATA_CACHE,
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
  STOCK_DATA_REDIS,
  STOCK_DATA_SERVICE,
  STOCK_DATA_STORE,
} from "./stock-data.tokens";
import { StocksController } from "./stocks.controller";

type StockDataRedisClient = ReturnType<typeof createStockDataRedisClient>;

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
      provide: STOCK_DATA_STORE,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): StockDataStore =>
        new PrismaStockDataStore(prisma),
    },
    {
      provide: STOCK_DATA_PROVIDER,
      inject: [STOCK_DATA_REDIS],
      useFactory: (redis: StockDataRedisClient): FmpStockProviderPort => {
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
      useFactory: (): StockDataRedisClient =>
        createStockDataRedisClient(getRedisConfig().url),
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
      useFactory: (redis: StockDataRedisClient): LoadCoordinator =>
        new RedlockLoadCoordinator(
          redis,
          getStockDataConfig().loadLockDurationMs,
        ),
    },
    {
      provide: STOCK_DATA_SERVICE,
      inject: [
        STOCK_DATA_STORE,
        STOCK_DATA_PROVIDER,
        STOCK_DATA_CACHE,
        STOCK_DATA_COORDINATOR,
      ],
      useFactory: (
        store: StockDataStore,
        provider: FmpStockProviderPort,
        cache: StockDataCache,
        coordinator: LoadCoordinator,
      ): StockDataService =>
        new CanonicalStockDataService(store, provider, cache, coordinator, {
          defaultHistoryDays: getStockDataConfig().defaultHistoryDays,
          historyYears: getStockDataConfig().historyYears,
          recentPriceFreshnessMs: getStockDataConfig().recentPriceFreshnessMs,
          recentTailCalendarDays: getStockDataConfig().recentTailCalendarDays,
        }),
    },
    StockDataRedisLifecycle,
  ],
  exports: [STOCK_DATA_SERVICE],
})
export class StocksModule {}
