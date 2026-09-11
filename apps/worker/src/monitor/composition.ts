import {
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type { Security, SecurityId } from "@intrinsic/domain";
import { FmpClient } from "@intrinsic/fmp";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  CachedTradingCalendar,
  CanonicalStockDataService,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisFmpRequestGate,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  monitorWindowObservations,
  requiredDailySeries,
  type ProviderRequestEvent,
  type TradingCalendar,
} from "@intrinsic/stock-data";
import type { OperandKey } from "@intrinsic/strategy";
import type { MonitorDataLoader } from "./monitor-cycle.js";
import {
  PrismaMonitorRepository,
  type MonitorRepository,
} from "./monitor-repository.js";
import {
  PrismaMonitorScanRepository,
  type MonitorScanRepository,
} from "./scan-repository.js";

export type MonitorRuntime = {
  scans: MonitorScanRepository;
  monitors: MonitorRepository;
  data: MonitorDataLoader;
  calendar: TradingCalendar;
  close(): Promise<void>;
};

/**
 * The monitor worker's composition root.
 *
 * It mirrors `../backtest/composition.ts` deliberately: the same store, the same Redis cache, the
 * same shared FMP gate and the same load coordinator, built from the same configuration. A Monitor
 * cycle must never call the provider itself or keep a second implementation of Redis lookup,
 * coverage reconciliation or derived calculation — `AGENTS.md` invariant 6 makes API and worker
 * different processes, not different business implementations, and a monitor child is one more
 * process of the same kind.
 *
 * Sharing the gate matters here more than anywhere else: a Monitor cycle touching the whole
 * monitored universe would otherwise be able to exhaust the provider budget Stock Details depends
 * on. It goes through `RedisFmpRequestGate` like everything else and is throttled with it.
 */
export function createMonitorRuntime(logger: StructuredLogger): MonitorRuntime {
  const stockDataConfig = getStockDataConfig();
  const fmpTraffic = getFmpTrafficConfig();

  const onProviderRequest = (request: ProviderRequestEvent): void => {
    logger.debug({ event: "stock-data.provider.request", ...request });
  };

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url);

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

  const stockData = new CanonicalStockDataService(
    new PrismaStockDataStore(prisma),
    provider,
    new RedisStockDataCache(
      new IoredisCacheClient(redis),
      stockDataConfig.maxResidentStocks,
    ),
    new RedlockLoadCoordinator(redis, {
      lockDurationMs: stockDataConfig.loadLockDurationMs,
      lockWaitMs: stockDataConfig.loadLockWaitMs,
    }),
    {
      defaultHistoryDays: stockDataConfig.defaultHistoryDays,
      productHistoryYears: stockDataConfig.productHistoryYears,
      recentPriceFreshnessMs: stockDataConfig.recentPriceFreshnessMs,
      fundamentalsFreshnessMs: stockDataConfig.fundamentalsFreshnessMs,
      recentTailCalendarDays: stockDataConfig.recentTailCalendarDays,
      onProviderRequest,
    },
  );

  return {
    scans: new PrismaMonitorScanRepository(prisma),
    monitors: new PrismaMonitorRepository(prisma),
    data: new PrismaMonitorDataLoader(stockData),
    // Built from the same gated provider as everything else, so a schedule fetch is throttled with
    // the rest of the cycle's traffic. Its cache is process memory by design — see
    // `CachedTradingCalendar`; nothing about it belongs in Redis.
    calendar: new CachedTradingCalendar(provider),
    async close(): Promise<void> {
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}

/**
 * The cycle's view of the data layer.
 *
 * Securities are read by id rather than by symbol: a Monitor's universe comes from `StockListItem`,
 * which already references the canonical catalog, and re-resolving a symbol would reintroduce the
 * ticker as an identity the product does not use it as.
 */
class PrismaMonitorDataLoader implements MonitorDataLoader {
  constructor(private readonly stockData: CanonicalStockDataService) {}

  async findSecurities(securityIds: readonly SecurityId[]): Promise<Security[]> {
    return this.stockData.findSecuritiesByIds(securityIds);
  }

  async getCurrentObservations(securities: readonly Security[]) {
    return this.stockData.getCurrentObservations(securities);
  }

  async prepareMonitorEvaluationData(
    security: Security,
    observations: number,
    asOf: string,
  ): Promise<void> {
    await this.stockData.prepareMonitorEvaluationData(
      security,
      observations,
      asOf,
    );
  }

  async readMonitorEvaluationFrame(
    input: Parameters<MonitorDataLoader["readMonitorEvaluationFrame"]>[0],
  ) {
    return this.stockData.readMonitorEvaluationFrame(input);
  }

  monitorWindowObservations(operands: readonly OperandKey[]): number {
    return monitorWindowObservations(requiredDailySeries(operands));
  }
}
