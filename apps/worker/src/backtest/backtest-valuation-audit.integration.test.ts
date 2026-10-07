import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  BACKTEST_SNAPSHOT_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DateRange,
  FinancialStatementCadence,
  FinancialStatementType,
  Security,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  BACKTEST_DATA_REVISIONS,
  CanonicalStockDataService,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
} from "@intrinsic/stock-data";
import { BACKTEST_METHODOLOGY, type BacktestResult } from "@intrinsic/strategy";
import {
  VALUATION_AUDIT_BACKTESTS,
  VALUATION_AUDIT_EXPECTED_TRADES,
  VALUATION_AUDIT_FIRST_SESSION,
  VALUATION_AUDIT_LAST_SESSION,
  useTestDatabase,
  valuationAuditSessions,
  type ValuationAuditBacktest,
} from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BacktestProcessor,
  type BacktestBenchmarkLoader,
} from "./backtest-processor.js";
import { seedValuationAuditSecurity } from "../valuation-audit.test-helper.js";
import type { BacktestJobLease } from "./job-lease.js";
import type {
  BacktestFailureWrite,
  BacktestJobRepository,
  BacktestResultWrite,
  ClaimedBacktestJob,
  StaleJobRecovery,
} from "./job-repository.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * Valuation Strategies on the real backtest path, over the valuation audit's anchor
 * (`docs/valuation-ratios-audit/REPORT.md`, Backtest).
 *
 * The anchor's stored rows — statements with their availability and observation instants, the
 * verified price basis, a measured re-base and the provider's split list — are written straight into
 * PostgreSQL, so the product reads exactly the rows the API audit's clean-room oracle read. The
 * worker's real `BacktestProcessor` then prepares and reads every frame from the real
 * `CanonicalStockDataService` over PostgreSQL and Redis. Every expected trade is
 * `VALUATION_AUDIT_EXPECTED_TRADES`, which the API audit pins to the oracle and the reference
 * backtester: the product trades exactly where the oracle predicts, never on a withheld session.
 */
describeInfrastructure(
  "Valuation Strategies through the real backtest path",
  () => {
    const logger = createLogger({ service: "worker", level: "silent" });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const symbol = `VA${suffix}`;
    const namespace = `stock-data:v2:test:valuation-backtest:${suffix}`;
    const sessions = valuationAuditSessions();

    class CountingProvider implements FmpStockProviderPort {
      readonly calls: string[] = [];
      async getProfile(requested: string) {
        this.calls.push(`profile:${requested}`);
        return null;
      }
      async getDailyPrices(
        _symbol: string,
        _securityId: string,
        range: DateRange,
      ) {
        this.calls.push(`prices:${range.from}:${range.to}`);
        return [];
      }
      async getFinancialStatements(
        _symbol: string,
        _securityId: string,
        type: FinancialStatementType,
        cadence: FinancialStatementCadence,
      ) {
        this.calls.push(`statements:${type}:${cadence}`);
        return [];
      }
      async getStockSplits() {
        this.calls.push("splits");
        return [];
      }
    }

    class CalendarBenchmarks implements BacktestBenchmarkLoader {
      async getSeries(seriesId: string): Promise<BenchmarkSeries> {
        return {
          id: seriesId,
          benchmarkId: "benchmark-1",
          version: 1,
          sourceKind: "FMP_SYMBOL",
          seriesType: "ETF_PROXY",
          providerSymbol: "SPY",
          currency: "USD",
          methodologyVersion: 1,
        };
      }
      async getBenchmarkDailyPrices(
        series: BenchmarkSeries,
        range: Required<DateRange>,
      ): Promise<BenchmarkDailyPrice[]> {
        return sessions
          .filter(({ date }) => date >= range.from && date <= range.to)
          .map(({ date }, index) => ({
            seriesId: series.id,
            date,
            open: 400 + index * 0.2,
            high: 401 + index * 0.2,
            low: 399 + index * 0.2,
            close: 400 + index * 0.2,
            volume: 5_000,
          }));
      }
      async missingBenchmarkCoverage(): Promise<Required<DateRange>[]> {
        return [];
      }
    }

    class RecordingRepository implements BacktestJobRepository {
      readonly failures: BacktestFailureWrite[] = [];
      readonly results: BacktestResultWrite[] = [];
      async claimNextJob(): Promise<ClaimedBacktestJob | null> {
        return null;
      }
      async heartbeat(): Promise<boolean> {
        return true;
      }
      async recoverStaleJobs(): Promise<StaleJobRecovery> {
        return { requeued: 0, abandoned: 0 };
      }
      async updateProgress(): Promise<boolean> {
        return true;
      }
      async persistResult(write: BacktestResultWrite): Promise<boolean> {
        this.results.push(write);
        return true;
      }
      async failJob(write: BacktestFailureWrite): Promise<boolean> {
        this.failures.push(write);
        return true;
      }
      async releaseJob(): Promise<boolean> {
        return true;
      }
    }

    const provider = new CountingProvider();
    let prisma: PrismaClient;
    let redis: ReturnType<typeof createStockDataRedisClient>;
    let store: PrismaStockDataStore;
    let cache: RedisStockDataCache;
    let service: CanonicalStockDataService;
    let security: Security;

    beforeAll(async () => {
      prisma = new PrismaClient();
      redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
      store = new PrismaStockDataStore(prisma);
      cache = new RedisStockDataCache(
        new IoredisCacheClient(redis),
        10,
        namespace,
      );
      ({ security } = await seedValuationAuditSecurity(prisma, store, {
        symbol,
      }));
      service = new CanonicalStockDataService(
        store,
        provider,
        cache,
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 30_000,
          lockWaitMs: 30_000,
        }),
        { productHistoryYears: 30 },
      );
    }, 120_000);

    afterAll(async () => {
      if (cache && security) {
        await cache.evict(security.id);
      }
      if (redis) {
        let cursor = "0";
        const keys: string[] = [];
        do {
          const [next, batch] = await redis.scan(
            cursor,
            "MATCH",
            `${namespace}:*`,
            "COUNT",
            500,
          );
          cursor = next;
          keys.push(...batch);
        } while (cursor !== "0");
        if (keys.length > 0) {
          await redis.del(...keys);
        }
        redis.disconnect();
      }
      if (prisma && security) {
        await prisma.security.deleteMany({ where: { id: security.id } });
      }
      await prisma?.$disconnect();
    });

    async function execute(
      backtest: ValuationAuditBacktest,
      options: {
        stockData?: CanonicalStockDataService;
        dataRevisions?: Record<string, number>;
      } = {},
    ): Promise<RecordingRepository> {
      const repository = new RecordingRepository();
      const processor = new BacktestProcessor(
        {
          repository,
          securities: {
            findByIds: async () => new Map([[security.id, security]]),
          },
          stockData: options.stockData ?? service,
          benchmarks: new CalendarBenchmarks(),
          logger,
        },
        {
          frameConcurrency: 1,
          checkpointEveryDays: 50,
          checkpointMinIntervalMs: 0,
          leaseMs: 60_000,
          workerId: "valuation-audit",
        },
      );
      await processor.process(
        {
          jobId: randomUUID(),
          runId: randomUUID(),
          attempt: 1,
          actorUserId: "audit",
          snapshot: {
            snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
            submittedAt: "2026-01-01T00:00:00.000Z",
            strategy: {
              strategyId: "s",
              name: `Valuation audit ${backtest.id}`,
              versionId: "v",
              versionNumber: 1,
              definitionHash: "h",
              definition: backtest.definition as unknown as StrategyDefinition,
            },
            stockList: { stockListId: "l", name: "Audit list" },
            securities: [
              {
                securityId: security.id,
                symbol: security.symbol,
                name: security.name,
                exchangeCode: security.exchangeCode,
                currency: security.currency,
                buyWindowMode:
                  backtest.buyWindows.length > 0 ? "CUSTOM" : "FULL",
                buyWindows: [...backtest.buyWindows],
              },
            ],
            period: {
              startDate: VALUATION_AUDIT_FIRST_SESSION,
              endDate: VALUATION_AUDIT_LAST_SESSION,
            },
            capital: { initialCapital: 100_000, monthlyContribution: 0 },
            allocation: { maximumPositions: 1, fullPositionFraction: 1 },
            benchmark: {
              benchmarkId: "benchmark-1",
              seriesId: "series-comparison",
              seriesVersion: 1,
              code: "SP500",
              name: "S&P 500",
              sourceKind: "FMP_SYMBOL",
              seriesType: "ETF_PROXY",
              providerSymbol: "SPY",
              methodologyVersion: 1,
              currency: "USD",
            },
            executionCalendar: {
              referenceCode: "SP500",
              seriesId: "series-calendar",
              seriesVersion: 1,
            },
            methodology: { ...BACKTEST_METHODOLOGY },
            dataRevisions: {
              ...BACKTEST_DATA_REVISIONS,
              ...options.dataRevisions,
            } as typeof BACKTEST_DATA_REVISIONS,
          },
        },
        {
          interruption: () => null,
          markLost: () => {},
        } as unknown as BacktestJobLease,
      );
      return repository;
    }

    const strategyTrades = (result: BacktestResult) =>
      result.trades
        .filter((trade) => trade.source === "STRATEGY")
        .map((trade) => [
          trade.date,
          trade.action,
          trade.levelId ?? trade.exitRuleId ?? "",
        ]);

    async function succeeded(backtest: ValuationAuditBacktest) {
      const repository = await execute(backtest);
      expect(repository.failures).toEqual([]);
      expect(repository.results).toHaveLength(1);
      return repository.results[0]!.result;
    }

    for (const backtest of VALUATION_AUDIT_BACKTESTS) {
      it(`${backtest.id}: ${backtest.title} — trades exactly where the oracle predicts`, async () => {
        const result = await succeeded(backtest);
        expect(strategyTrades(result)).toEqual(
          VALUATION_AUDIT_EXPECTED_TRADES[backtest.id]?.map((trade) => [
            ...trade,
          ]),
        );
      }, 120_000);
    }

    it("reads no provider: the split list is fresh and every input is stored", () => {
      expect(provider.calls).toEqual([]);
    });

    it("is deterministic: a rerun reproduces every trade and every equity row", async () => {
      const backtest = VALUATION_AUDIT_BACKTESTS.find(
        (entry) => entry.id === "V12",
      )!;
      const first = await succeeded(backtest);
      const second = await succeeded(backtest);
      expect(second.trades).toEqual(first.trades);
      expect(second.equity).toEqual(first.equity);
      expect(second.summary).toEqual(first.summary);
    }, 240_000);

    it("records the valuation revision it ran under, and refuses a run queued under another", async () => {
      expect(BACKTEST_DATA_REVISIONS.valuationRatioRevision).toBe(4);
      const backtest = VALUATION_AUDIT_BACKTESTS[0]!;
      // Queued under revision 3, before the owner's rulings on the second review.
      const stale = await execute(backtest, {
        dataRevisions: { valuationRatioRevision: 3 },
      });
      expect(stale.results).toEqual([]);
      expect(stale.failures).toHaveLength(1);
      expect(stale.failures[0]!.code).toBe("ENGINE_VERSION_MISMATCH");
    }, 120_000);

    it("fails, rather than mixing two bases, when the price history is re-based while the run reads it", async () => {
      // The generation moves after the first window read, as a replacement committed mid-run would.
      let reads = 0;
      const racing = new Proxy(service, {
        get(target, property, receiver) {
          if (property === "readDailyEvaluationFrame") {
            return async (...args: unknown[]) => {
              reads += 1;
              if (reads === 2) {
                await prisma.securityPriceBasis.update({
                  where: { securityId: security.id },
                  data: { generation: { increment: 1 } },
                });
              }
              return (
                target.readDailyEvaluationFrame as (
                  ...rest: unknown[]
                ) => unknown
              ).apply(target, args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        const repository = await execute(VALUATION_AUDIT_BACKTESTS[0]!, {
          stockData: racing,
        });
        expect(repository.results).toEqual([]);
        expect(repository.failures).toHaveLength(1);
        expect(repository.failures[0]!.code).toBe("EXECUTION_FAILED");
        expect(repository.failures[0]!.message).toContain(
          "updated the price history",
        );
        expect(repository.failures[0]!.phase).toBe("RUNNING");
        expect(repository.failures[0]!.detail).toMatchObject({
          reason: "PRICE_BASIS_CHANGED",
          expectedGeneration: 1,
          actualGeneration: 2,
        });
      } finally {
        await prisma.securityPriceBasis.update({
          where: { securityId: security.id },
          data: { generation: 1 },
        });
      }
    }, 120_000);
  },
);
