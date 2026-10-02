import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  BACKTEST_SNAPSHOT_VERSION,
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DateRange,
  FinancialStatementCadence,
  FinancialStatementDraft,
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
  fundamentalsDatasetOperations,
  priceRetentionYears,
  subtractYears,
} from "@intrinsic/stock-data";
import { BACKTEST_METHODOLOGY, type BacktestResult } from "@intrinsic/strategy";
import {
  FUNDAMENTAL_AUDIT_ANCHOR_FIRST_SESSION,
  FUNDAMENTAL_AUDIT_ANCHOR_LAST_SESSION,
  FUNDAMENTAL_AUDIT_ANCHOR_SYNCS,
  FUNDAMENTAL_AUDIT_METRICS,
  fundamentalAuditAnchorExpected,
  fundamentalAuditAnchorSessions,
  useTestDatabase,
} from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BacktestProcessor,
  type BacktestBenchmarkLoader,
} from "./backtest-processor.js";
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
 * Fundamental Strategies on the real backtest path, over the audit's anchor history (audit section
 * 20).
 *
 * The anchor's statement syncs go through the real `PrismaStockDataStore`; the worker's real
 * `BacktestProcessor` then prepares and reads its frames from the real `CanonicalStockDataService`
 * over PostgreSQL and Redis — the same object a deployed worker composes — so nothing between the
 * statements and the trade is a fixture except the job repository and the benchmark prices. Every
 * expected trade date below is read off `FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED` by hand: the first
 * session a rule holds on the persisted value is the session it trades, never earlier.
 */
describeInfrastructure(
  "Fundamental Strategies through the real backtest path",
  () => {
    const logger = createLogger({ service: "worker", level: "silent" });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const symbol = `FB${suffix}`;
    const namespace = `stock-data:v2:test:fundamental-backtest:${suffix}`;
    const sessions = fundamentalAuditAnchorSessions();
    const START = FUNDAMENTAL_AUDIT_ANCHOR_FIRST_SESSION;
    const END = FUNDAMENTAL_AUDIT_ANCHOR_LAST_SESSION;
    const closes = sessions.map(
      (_date, index) => 50 + (index % 23) * 0.37 + index * 0.01,
    );

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
          .filter((date) => date >= range.from && date <= range.to)
          .map((date, index) => ({
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
    let coordinator: RedlockLoadCoordinator;
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
      const row = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Fundamental Backtest Audit Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      const today = new Date().toISOString().slice(0, 10);
      const syncedAt = new Date().toISOString();
      await store.saveDailyPriceSync({
        securityId: row.id,
        prices: sessions.map((date, index) => ({
          securityId: row.id,
          date,
          open: closes[index]!,
          high: closes[index]!,
          low: closes[index]!,
          close: closes[index]!,
          volume: 1_000,
        })),
        successfulCoverage: [
          { from: subtractYears(today, priceRetentionYears(30)), to: today },
        ],
        syncedAt,
        tailDate: today,
        freshThrough: today,
      });
      // Verified under the current loader, so no first verification re-reads the history.
      await store.createPriceBasis({
        securityId: row.id,
        verifiedAt: syncedAt,
      });
      for (const sync of FUNDAMENTAL_AUDIT_ANCHOR_SYNCS) {
        await store.saveFinancialStatements({
          securityId: row.id,
          statements: sync.statements.map(
            (draft) =>
              ({ ...draft, securityId: row.id }) as FinancialStatementDraft,
          ),
          syncedAt: sync.observedAt,
        });
      }
      for (const operation of fundamentalsDatasetOperations(30)) {
        await store.upsertDatasetState({
          securityId: row.id,
          dataset: operation.dataset,
          variant: operation.variant,
          syncedAt,
        });
      }
      await store.upsertDatasetState({
        securityId: row.id,
        dataset: "SECURITY_PROFILE",
        variant: "",
        syncedAt,
      });
      [security] = (await store.findSecuritiesByIds([row.id])) as [Security];
      coordinator = new RedlockLoadCoordinator(redis, {
        lockDurationMs: 30_000,
        lockWaitMs: 30_000,
      });
      service = new CanonicalStockDataService(
        store,
        provider,
        cache,
        coordinator,
        {
          productHistoryYears: 30,
        },
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

    const fundamental = (metricId: string) =>
      ({ kind: "FUNDAMENTAL", metricId }) as never;
    const when = (
      id: string,
      metric: unknown,
      operator: string,
      value: unknown,
    ) => ({ id, metric, operator, value }) as never;
    const signal = (...conditions: unknown[]): StrategySignal => ({
      conditions: conditions as never,
    });

    function strategy(
      extra: Partial<StrategyDefinition> & { buy: StrategySignal },
    ): StrategyDefinition {
      const { buy, ...rest } = extra;
      return {
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [{ id: "b1", percentage: 100, signal: buy }],
        sellLevels: [],
        ...rest,
      };
    }

    async function execute(
      definition: StrategyDefinition,
      buyWindows: { startDate: string; endDate: string | null }[] = [],
      stockData: CanonicalStockDataService = service,
    ): Promise<BacktestResult> {
      const repository = new RecordingRepository();
      const processor = new BacktestProcessor(
        {
          repository,
          securities: {
            findByIds: async () => new Map([[security.id, security]]),
          },
          stockData,
          benchmarks: new CalendarBenchmarks(),
          logger,
        },
        {
          frameConcurrency: 1,
          checkpointEveryDays: 50,
          checkpointMinIntervalMs: 0,
          leaseMs: 60_000,
          workerId: "fundamental-audit",
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
              name: "Fundamental audit",
              versionId: "v",
              versionNumber: 1,
              definitionHash: "h",
              definition,
            },
            stockList: { stockListId: "l", name: "Audit list" },
            securities: [
              {
                securityId: security.id,
                symbol: security.symbol,
                name: security.name,
                exchangeCode: security.exchangeCode,
                currency: security.currency,
                buyWindowMode: buyWindows.length > 0 ? "CUSTOM" : "FULL",
                buyWindows,
              },
            ],
            period: { startDate: START, endDate: END },
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
            dataRevisions: { ...BACKTEST_DATA_REVISIONS },
          },
        },
        {
          interruption: () => null,
          markLost: () => {},
        } as unknown as BacktestJobLease,
      );
      expect(repository.failures).toEqual([]);
      expect(repository.results).toHaveLength(1);
      return repository.results[0]!.result;
    }

    const trades = (result: BacktestResult) =>
      result.trades
        .filter((trade) => trade.source === "STRATEGY")
        .map((trade) => [trade.date, trade.action]);

    it("ROIC in percentage points: buys on 2024-08-02 (18 > 15) and exits on 2025-08-15 (12 < 13), never on the gap", async () => {
      // Anchor: ROIC 12 until 2024-08-01, 18 from 08-02, unavailable 08-20 … 09-13, then 16, 27.18…,
      // 16, and 12 from 2025-08-15. A zero read into the gap would have exited on 2024-08-20.
      expect(fundamentalAuditAnchorExpected("ROIC_TTM", "2024-08-01")).toBe(
        "12.00000000",
      );
      const result = await execute(
        strategy({
          buy: signal(
            when("roic", fundamental("ROIC_TTM"), "IS_ABOVE", {
              kind: "PERCENT",
              value: 15,
            }),
          ),
          finalExit: {
            id: "x",
            rules: [
              {
                id: "x",
                signal: signal(
                  when("roic-low", fundamental("ROIC_TTM"), "IS_BELOW", {
                    kind: "PERCENT",
                    value: 13,
                  }),
                ),
              },
            ],
          },
        }),
      );
      expect(trades(result)).toEqual([
        ["2024-08-02", "BUY"],
        ["2025-08-15", "FINAL_EXIT"],
      ]);
    }, 120_000);

    it("Debt / Equity as a raw multiple: buys on 2024-10-15 (0.6 < 0.7); an unavailable Current Ratio never exits", async () => {
      const result = await execute(
        strategy({
          buy: signal(
            when("de", fundamental("DEBT_TO_EQUITY"), "IS_BELOW", {
              kind: "MULTIPLE",
              value: 0.7,
            }),
          ),
          // Current Ratio is 3 from 2024-10-15 and unavailable (beyond the storage range) from
          // 2025-05-09 to 2025-08-14. Read as zero, that gap would satisfy `is below 2.5x`.
          finalExit: {
            id: "x",
            rules: [
              {
                id: "x",
                signal: signal(
                  when("cr", fundamental("CURRENT_RATIO"), "IS_BELOW", {
                    kind: "MULTIPLE",
                    value: 2.5,
                  }),
                ),
              },
            ],
          },
        }),
      );
      expect(trades(result)).toEqual([["2024-10-15", "BUY"]]);
    }, 120_000);

    it("two Fundamentals ANDed buy on the first session both hold: 2024-10-15", async () => {
      const result = await execute(
        strategy({
          buy: signal(
            when("roic", fundamental("ROIC_TTM"), "IS_ABOVE", {
              kind: "PERCENT",
              value: 15,
            }),
            when("de", fundamental("DEBT_TO_EQUITY"), "IS_BELOW", {
              kind: "MULTIPLE",
              value: 0.7,
            }),
          ),
        }),
      );
      expect(trades(result)).toEqual([["2024-10-15", "BUY"]]);
    }, 120_000);

    it("a Fundamental ANDed with a technical buys where both hold, by an independent moving average", async () => {
      // Revenue Growth is 10% on [2023-02-13, 2024-02-08]; the close is a sawtooth. The expected date
      // is the first session in that stretch whose close exceeds the mean of its last twenty closes,
      // computed here by plain arithmetic.
      let expected: string | undefined;
      sessions.forEach((date, index) => {
        if (
          expected ||
          index < 19 ||
          date < "2023-02-13" ||
          date > "2024-02-08"
        ) {
          return;
        }
        const window = closes.slice(index - 19, index + 1);
        const mean = window.reduce((sum, close) => sum + close, 0) / 20;
        if (closes[index]! > mean + 1e-9) {
          expected = date;
        }
      });
      expect(expected).toBeDefined();
      const result = await execute(
        strategy({
          buy: signal(
            when("growth", fundamental("REVENUE_GROWTH_TTM_YOY"), "IS_ABOVE", {
              kind: "PERCENT",
              value: 5,
            }),
            when("trend", { kind: "PRICE" }, "IS_ABOVE", {
              kind: "SERIES",
              seriesId: "SMA_20D",
            }),
          ),
        }),
      );
      expect(trades(result)[0]).toEqual([expected, "BUY"]);
    }, 120_000);

    it("equality never satisfies a strict comparison: Revenue Growth of exactly 0% is not above 0", async () => {
      const result = await execute(
        strategy({
          buy: signal(
            when("growth", fundamental("REVENUE_GROWTH_TTM_YOY"), "IS_ABOVE", {
              kind: "PERCENT",
              value: 0,
            }),
          ),
        }),
      );
      // 0 on 2023-01-03 … 2023-02-10, 10 from 2023-02-13.
      expect(trades(result)).toEqual([["2023-02-13", "BUY"]]);
    }, 120_000);

    it("BUY and SELL timing on a signed multiple: net cash from 2023-07-05, exactly zero net debt on 2024-10-15", async () => {
      const result = await execute(
        strategy({
          buy: signal(
            when("nd", fundamental("NET_DEBT_TO_EBITDA_TTM"), "IS_BELOW", {
              kind: "MULTIPLE",
              value: 0,
            }),
          ),
          sellLevels: [
            {
              id: "s1",
              percentage: 50,
              signal: signal(
                when(
                  "nd-up",
                  fundamental("NET_DEBT_TO_EBITDA_TTM"),
                  "IS_ABOVE",
                  { kind: "MULTIPLE", value: -0.2 },
                ),
              ),
            },
          ],
        }),
      );
      // -0.333… from 2023-07-05; -0.25 until the gap; 0 from 2024-10-15, which is above -0.2.
      expect(trades(result).slice(0, 2)).toEqual([
        ["2023-07-05", "BUY"],
        ["2024-10-15", "SELL"],
      ]);
    }, 120_000);

    it("an unavailable reading is never zero: ROE is below 1% on no session, so nothing ever trades", async () => {
      // ROE is 13.33… or 29.09…, and unavailable from 2024-08-20 to 2024-09-13.
      const result = await execute(
        strategy({
          buy: signal(
            when("roe", fundamental("ROE_TTM"), "IS_BELOW", {
              kind: "PERCENT",
              value: 1,
            }),
          ),
        }),
      );
      expect(trades(result)).toEqual([]);
    }, 120_000);

    it("respects a buy window: ROIC is above 15% from 2024-08-02, but the window opens on 2024-09-01 into the gap", async () => {
      const result = await execute(
        strategy({
          buy: signal(
            when("roic", fundamental("ROIC_TTM"), "IS_ABOVE", {
              kind: "PERCENT",
              value: 15,
            }),
          ),
        }),
        [{ startDate: "2024-09-01", endDate: "2024-12-31" }],
      );
      // 2024-09-03 … 09-13 are unavailable; 16 from 2024-09-16.
      expect(trades(result)).toEqual([["2024-09-16", "BUY"]]);
    }, 120_000);

    it("is deterministic: the same inputs give byte-identical results, and no provider is ever asked", async () => {
      const definition = strategy({
        buy: signal(
          when("roic", fundamental("ROIC_TTM"), "IS_ABOVE", {
            kind: "PERCENT",
            value: 15,
          }),
        ),
        finalExit: {
          id: "x",
          rules: [
            {
              id: "x",
              signal: signal(
                when("roic-low", fundamental("ROIC_TTM"), "IS_BELOW", {
                  kind: "PERCENT",
                  value: 13,
                }),
              ),
            },
          ],
        },
      });
      const first = await execute(definition);
      const second = await execute(definition);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(provider.calls).toEqual([]);
    }, 120_000);

    it("reads nothing per day: no statement, no rebuild, one derived read per calendar-year window (audit section 31)", async () => {
      // Every Fundamental in one Strategy, over the prepared history, each at the floor of its own
      // threshold domain (-100% or 0x). SQL is counted from Prisma's own query events on a store only
      // this run uses; Redis from the commands reaching the client.
      const everyMetric = strategy({
        buy: signal(
          ...FUNDAMENTAL_AUDIT_METRICS.map((metric) =>
            when(metric.id, fundamental(metric.id), "IS_ABOVE", {
              kind: metric.unit,
              value: metric.unit === "PERCENT" ? -100 : 0,
            }),
          ),
        ),
      });
      await execute(everyMetric);
      const logging = new PrismaClient({
        log: [{ emit: "event", level: "query" }],
      });
      const sql: string[] = [];
      logging.$on("query", (event) => sql.push(event.query));
      const counted = new CanonicalStockDataService(
        new PrismaStockDataStore(logging),
        provider,
        cache,
        coordinator,
        { productHistoryYears: 30 },
      );
      const rebuilds = vi.spyOn(
        CanonicalStockDataService.prototype as unknown as {
          rebuildDailyDerivedState: () => Promise<unknown>;
        },
        "rebuildDailyDerivedState",
      );
      const mget = vi.spyOn(redis, "mget");
      const get = vi.spyOn(redis, "get");
      try {
        const result = await execute(everyMetric, [], counted);
        await new Promise((resolve) => setImmediate(resolve));
        const keysRead = [...mget.mock.calls, ...get.mock.calls].map((call) =>
          call.flat().map(String),
        );
        const derivedReads = keysRead.filter((keys) =>
          keys.some((key) => key.includes(":daily-state:")),
        );
        const counters = {
          sql: sql.length,
          statementSql: sql.filter((query) =>
            /"FinancialStatement"/.test(query),
          ).length,
          derivedSql: sql.filter((query) => /"DailyDerivedState"/.test(query))
            .length,
          priceBasisSql: sql.filter((query) =>
            /"SecurityPriceBasis"/.test(query),
          ).length,
          rebuilds: rebuilds.mock.calls.length,
          redisReads: keysRead.length,
          derivedChunkReads: derivedReads.length,
        };
        // The whole period was simulated from those reads.
        expect(result.equity.at(-1)?.date).toBe(END);
        expect(counters.statementSql).toBe(0);
        expect(counters.derivedSql).toBe(0);
        expect(counters.rebuilds).toBe(0);
        // 2023, 2024 and 2025: one multi-key read of the yearly chunks per execution window.
        expect(counters.derivedChunkReads).toBe(3);
        // Far fewer Redis reads than sessions, and SQL only per run and per window: the period's
        // price bounds and its price-basis generation, read once while preparing, and the
        // generation again after each window's reads (`historical-price-basis-v1.md`, §9).
        expect(counters.redisReads).toBeLessThan(50);
        expect(counters.priceBasisSql).toBe(1 + 3);
        expect(counters.sql).toBe(1 + counters.priceBasisSql);
        expect(provider.calls).toEqual([]);
      } finally {
        rebuilds.mockRestore();
        mget.mockRestore();
        get.mockRestore();
        await logging.$disconnect();
      }
    }, 120_000);
  },
);
