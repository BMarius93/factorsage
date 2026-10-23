import { randomUUID } from "node:crypto";
import {
  normalizeStrategyDefinition,
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategyTrigger,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  DailyPrice,
  DateRange,
  FinancialStatementDraft,
  LocalDate,
  Security,
} from "@intrinsic/domain";
import { eodSessionFinalizedAt } from "@intrinsic/domain";
import type { FmpStockProviderPort, MappedFmpProfile } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalStockDataService,
  EodFinalityPolicy,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  withEtfOperandColumns,
  type TradingCalendar,
} from "@intrinsic/stock-data";
import {
  collectEtfOperands,
  collectOperands,
  collectSectorOperands,
  explainMonitorLevel,
  INITIAL_MONITOR_LEVEL_LIFECYCLE,
  monitorStrategyLevels,
  observeMonitorLevel,
  stepMonitorLevel,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEtfTechnicalSnapshots } from "../shared/etf-context.js";
import {
  StockEodRefreshFailedError,
  StockEodRefreshRun,
} from "../stock-eod/refresh-run.js";
import {
  MonitorEodEvaluation,
  type MonitorEtfContexts,
  type MonitorEvaluationData,
} from "./monitor-evaluation.js";
import { scopedRepository } from "./monitor-evaluation.test-helper.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";

/**
 * When the fixtures' securities joined their Lists: before every session these suites drive, so a
 * session is observed or history by the Monitor's watching stamp alone, as in production, where a
 * member is never listed after the clock the pass runs on.
 */
const LISTED_BEFORE_EVERY_SESSION = new Date("2000-01-03T00:00:00.000Z");

// Before any PrismaClient in this file is constructed.
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * Weekly indicators in a Monitor and in a backtest are one value (`docs/decisions/monitor-eod-v2.md`
 * §9): the real stock EOD child materializes each evening, the real Monitor EOD evaluation decides
 * it, and at the end every recorded change must be exactly what a backtest over the finished
 * history records, with the same evidence. The history is built so a 20-week average falls under
 * the price **only because the week completes**: the crossing exists on the week's last session and
 * nowhere else, so deciding that session on the previous week's average — what a Monitor did when a
 * week only became visible once the next week began — loses it.
 */

const DELAY_MS = 30 * 60_000;
const HOUR = 60 * 60_000;
/** NYSE full closures in the span the cases use. */
const HOLIDAYS = new Set<LocalDate>([
  "2025-01-01",
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
]);

function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isSession(date: LocalDate): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6 && !HOLIDAYS.has(date);
}

const calendar: TradingCalendar = {
  isTradingSession: async (_exchange, date) => isSession(date),
};
const isScheduledSession = async (date: LocalDate) => isSession(date);

function sessionsBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (isSession(date)) {
      dates.push(date);
    }
  }
  return dates;
}

/**
 * Daily closes for a weekly-crossing history around the week starting `testWeek`: every session of
 * a week closes at that week's close — 100, except 130 exactly twenty weeks before the test week —
 * and the test week and the next close at 101. The 20-week average is 101.5 until the test week
 * completes and 100.05 from then on, so price 101 crosses above it on the test week's last session.
 */
function weeklyCrossingCloses(testWeek: LocalDate): Map<LocalDate, number> {
  const spikeWeek = addDays(testWeek, -20 * 7);
  const closes = new Map<LocalDate, number>();
  for (const date of sessionsBetween(
    addDays(testWeek, -60 * 7),
    addDays(testWeek, 8),
  )) {
    const weekStart = addDays(
      date,
      -((new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7),
    );
    closes.set(
      date,
      weekStart === spikeWeek ? 130 : weekStart >= testWeek ? 101 : 100,
    );
  }
  return closes;
}

class OnTimeProvider implements FmpStockProviderPort {
  readonly closes = new Map<string, Map<LocalDate, number>>();
  readonly sectors = new Map<string, string>();

  constructor(private readonly clock: { now: Date }) {}

  async getProfile(symbol: string): Promise<MappedFmpProfile | null> {
    const sector = this.sectors.get(symbol);
    return {
      providerSymbol: symbol,
      security: {
        symbol,
        name: `${symbol} Corp`,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
        ...(sector ? { sector } : {}),
      },
      profile: { description: "Weekly parity fixture" },
    };
  }

  async getDailyPrices(
    symbol: string,
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]> {
    const rows: DailyPrice[] = [];
    for (const [date, close] of this.closes.get(symbol) ?? []) {
      if (
        eodSessionFinalizedAt(date, DELAY_MS).getTime() >
          this.clock.now.getTime() ||
        (range.from !== undefined && date < range.from) ||
        (range.to !== undefined && date > range.to)
      ) {
        continue;
      }
      rows.push({
        securityId,
        date,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1_000_000,
      });
    }
    return rows.sort((left, right) => left.date.localeCompare(right.date));
  }

  async getFinancialStatements(): Promise<FinancialStatementDraft[]> {
    return [];
  }
}

const crossesAboveWeekly = (): StrategyTrigger => ({
  id: "t-sma20w",
  metric: { kind: "PRICE" },
  operator: "CROSSES_ABOVE",
  value: { kind: "SERIES", seriesId: "SMA_20W" },
});

function buyOn(trigger: StrategyTrigger): StrategyDefinition {
  return normalizeStrategyDefinition({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      { id: "buy-1", percentage: 100, signal: { conditions: [], trigger } },
    ],
    sellLevels: [],
  });
}

/** An ETF-sourced metric is a Condition only: the fund's price above its own 20-week average. */
function buyWhileAboveWeekly(
  source: { kind: "ETF"; code: "ETF_XLK" } | { kind: "STOCK_SECTOR" },
) {
  return normalizeStrategyDefinition({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [
            {
              id: "c-etf-sma20w",
              metric: { kind: "PRICE", source },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_20W" },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  } as never);
}

describeInfrastructure(
  "weekly indicators: a Monitor decides the week's last session as a backtest does",
  () => {
    const prisma = new PrismaClient();
    const clock = { now: new Date("2026-01-05T12:00:00.000Z") };
    const provider = new OnTimeProvider(clock);
    const namespace = `stock-data:v2:weekly-parity:${randomUUID().slice(0, 8)}`;
    const logger = createLogger({ service: "worker", level: "silent" });
    const running = new Set<string>();
    const repository = scopedRepository(
      new PrismaMonitorRepository(prisma),
      () => running,
    );
    const policy = new EodFinalityPolicy({
      calendar,
      publicationDelayMs: DELAY_MS,
      sessionRetryMs: 30 * 60_000,
      sessionGiveUpMs: 24 * HOUR,
      now: () => clock.now,
    });
    let redis: ReturnType<typeof createStockDataRedisClient>;
    let stockData: CanonicalStockDataService;
    let data: MonitorEvaluationData;
    let userId: string;
    const securityIds: string[] = [];
    let cycle = 0;

    beforeAll(async () => {
      redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
      stockData = new CanonicalStockDataService(
        new PrismaStockDataStore(prisma),
        provider,
        new RedisStockDataCache(new IoredisCacheClient(redis), 50, namespace),
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 30_000,
          lockWaitMs: 30_000,
        }),
        {
          productHistoryYears: 1,
          eod: {
            calendar,
            publicationDelayMs: DELAY_MS,
            sessionRetryMs: 30 * 60_000,
            sessionGiveUpMs: 24 * HOUR,
          },
          now: () => clock.now,
        },
      );
      data = {
        findSecurities: (ids) => stockData.findSecuritiesByIds(ids),
        stockRefreshState: (security) => stockData.stockRefreshState(security),
        readFinalizedEvaluationFrame: (security, range, operands) =>
          stockData.readFinalizedEvaluationFrame(security, range, operands),
        reconstructionHistoryStart: (security) =>
          stockData.evaluationHistoryStart(security),
      };
      userId = (
        await prisma.user.create({
          data: {
            email: `weekly-parity-${randomUUID()}@example.test`,
            plan: "PRO",
          },
        })
      ).id;
    }, 60_000);

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      redis.disconnect();
      await prisma.$disconnect();
    });

    async function createSecurity(
      closes: Map<LocalDate, number>,
      sector?: string,
    ): Promise<Security> {
      const symbol = `WKP${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
      provider.closes.set(symbol, closes);
      if (sector) {
        provider.sectors.set(symbol, sector);
      }
      const row = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: `${symbol} Corp`,
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
          ...(sector ? { sector } : {}),
          ipoDate: new Date(`${[...closes.keys()][0]}T00:00:00.000Z`),
        },
      });
      securityIds.push(row.id);
      return (await stockData.findSecuritiesByIds([row.id]))[0]!;
    }

    async function createMonitor(
      security: Security,
      definition: StrategyDefinition,
    ) {
      const strategy = await prisma.strategy.create({
        data: {
          userId,
          name: `Weekly parity ${randomUUID().slice(0, 8)}`,
          versions: {
            create: {
              versionNumber: 1,
              definition: definition as never,
              definitionHash: randomUUID(),
            },
          },
        },
      });
      const list = await prisma.stockList.create({
        data: {
          userId,
          name: `Weekly parity ${randomUUID().slice(0, 8)}`,
          items: {
            create: [
              {
                securityId: security.id,
                createdAt: LISTED_BEFORE_EVERY_SESSION,
              },
            ],
          },
        },
      });
      const monitor = await prisma.monitor.create({
        data: {
          // Reconstructed at the newest session: this suite is not about the window replay.
          windowReplay: false,
          userId,
          name: `Weekly parity ${randomUUID().slice(0, 8)}`,
          strategyId: strategy.id,
          stockListId: list.id,
          enabled: true,
        },
      });
      await prisma.monitor.updateMany({
        where: { userId, id: { not: monitor.id } },
        data: { enabled: false },
      });
      running.clear();
      running.add(monitor.id);
      return monitor.id;
    }

    /** An ETF context over in-memory XLK bars, each read once its session is final. */
    function etfContextsOver(
      closes: Map<LocalDate, number>,
    ): MonitorEtfContexts {
      const published = (): BenchmarkDailyPrice[] =>
        [...closes]
          .filter(
            ([date]) =>
              eodSessionFinalizedAt(date, DELAY_MS).getTime() <=
              clock.now.getTime(),
          )
          .map(([date, close]) => ({
            seriesId: "series-xlk",
            date,
            open: close,
            high: close,
            low: close,
            close,
            volume: 1_000_000,
          }));
      return {
        loader: {
          getSeries: async () =>
            ({
              id: "series-xlk",
              benchmarkId: "ETF_XLK",
              version: 1,
              sourceKind: "FMP_SYMBOL",
              seriesType: "ETF_PROXY",
              providerSymbol: "XLK",
              currency: "USD",
              methodologyVersion: 1,
            }) as never,
          readFullBenchmarkHistory: async () => ({
            seriesId: "series-xlk",
            basisGeneration: 0,
            rows: published(),
            missing: [],
            source: "POSTGRESQL" as const,
          }),
          benchmarkRefreshState: async () => ({
            coverageEnd: published().at(-1)?.date,
            latestBar: published().at(-1)?.date,
            lastTailSyncAt: clock.now.toISOString(),
          }),
          missingBenchmarkCoverage: async () => [],
        },
        resolveSeriesId: async () => "series-xlk",
        publicationDelayMs: DELAY_MS,
        isScheduledSession,
      };
    }

    async function prepare() {
      try {
        await new StockEodRefreshRun(
          stockData,
          { listActiveMonitors: () => repository.listActiveMonitors() },
          logger,
          {
            policy,
            runBudgetMs: 60_000,
            securityConcurrency: 2,
            followUpMs: 30_000,
            providerRequests: () => 0,
            now: () => clock.now,
          },
        ).run((cycle += 1), () => false);
      } catch (err) {
        if (!(err instanceof StockEodRefreshFailedError)) {
          throw err;
        }
      }
    }

    /** Every evening from `from` to `to`, the stock EOD child then the Monitor. */
    async function play(
      from: LocalDate,
      to: LocalDate,
      etfContexts?: MonitorEtfContexts,
      onEvening?: (session: LocalDate) => Promise<void>,
    ) {
      for (let date = from; date <= to; date = addDays(date, 1)) {
        clock.now = new Date(`${date}T23:00:00.000Z`);
        await prepare();
        await new MonitorEodEvaluation(
          repository,
          data,
          policy,
          logger,
          {
            securityConcurrency: 2,
            lateRecoveryMs: 4 * 24 * HOUR,
            now: () => clock.now,
          },
          etfContexts,
        ).run((cycle += 1));
        if (isSession(date)) {
          await onEvening?.(date);
        }
      }
    }

    /**
     * The backtest's record over the finished history, from the first evening on — the stock frame,
     * joined with the ETF columns the final context gives when the Strategy reads one.
     */
    async function backtest(
      security: Security,
      definition: StrategyDefinition,
      start: LocalDate,
      end: LocalDate,
      etfContexts?: MonitorEtfContexts,
    ) {
      let frame = await stockData.readDailyEvaluationFrame(
        security,
        { from: start, to: end },
        collectOperands(definition),
      );
      const etfOperands = [
        ...[...collectEtfOperands(definition).values()].flat(),
        ...collectSectorOperands(definition),
      ];
      if (etfContexts && etfOperands.length > 0) {
        const { snapshots } = await loadEtfTechnicalSnapshots({
          series: [{ code: "ETF_XLK", seriesId: "series-xlk" }],
          loader: etfContexts.loader,
          now: clock.now,
          publicationDelayMs: DELAY_MS,
          isScheduledSession,
          logger,
        });
        frame = withEtfOperandColumns(
          frame,
          etfOperands,
          snapshots,
          collectSectorOperands(definition).length > 0 ? "ETF_XLK" : null,
        );
      }
      const changes: string[] = [];
      const levels = monitorStrategyLevels(definition);
      for (const level of levels) {
        let lifecycle = INITIAL_MONITOR_LEVEL_LIFECYCLE;
        for (
          let index = frame.periodStartIndex;
          index < frame.dates.length;
          index += 1
        ) {
          const date = frame.dates[index]!;
          const result = stepMonitorLevel(lifecycle, {
            date,
            eligible: true,
            rules: observeMonitorLevel(level, frame, index),
          });
          if (date > start) {
            changes.push(
              ...result.transitions.map(
                (transition) =>
                  `${level.id} ${date} ${transition.from}->${transition.to} ${transition.reason}`,
              ),
            );
          }
          lifecycle = result.next;
        }
      }
      return { frame, levels, changes };
    }

    async function expectBacktestParity(
      security: Security,
      monitorId: string,
      definition: StrategyDefinition,
      start: LocalDate,
      end: LocalDate,
      activation: string,
      etfContexts?: MonitorEtfContexts,
    ) {
      const { frame, levels, changes } = await backtest(
        security,
        definition,
        start,
        end,
        etfContexts,
      );
      expect(changes).toContain(activation);
      const transitions = await prisma.monitorStateTransition.findMany({
        where: { monitorId },
        orderBy: { sequence: "asc" },
      });
      const observed = transitions.filter((row) => row.origin === "OBSERVED");
      expect(
        observed.map(
          (row) =>
            `${row.levelId} ${row.observationDate!.toISOString().slice(0, 10)} ${row.fromState}->${row.toState} ${row.reason}`,
        ),
      ).toEqual(changes);
      const level = levels[0]!;
      for (const row of observed) {
        const date = row.observationDate!.toISOString().slice(0, 10);
        expect(row.evidence, date).toEqual(
          JSON.parse(
            JSON.stringify(
              explainMonitorLevel(level, frame, frame.dates.indexOf(date)),
            ),
          ),
        );
      }
    }

    it("decides a weekly crossing on Friday evening, as every later backtest records it", async () => {
      const testWeek = "2026-09-14";
      const security = await createSecurity(weeklyCrossingCloses(testWeek));
      const definition = buyOn(crossesAboveWeekly());
      const monitorId = await createMonitor(security, definition);
      // Friday's row as materialized on Friday evening, against the same row at the end.
      let fridayEvening: unknown;
      await play(
        addDays(testWeek, -7),
        addDays(testWeek, 8),
        undefined,
        async (session) => {
          if (session === "2026-09-18") {
            fridayEvening = await prisma.dailyDerivedState.findUnique({
              where: {
                securityId_date: {
                  securityId: security.id,
                  date: new Date("2026-09-18T00:00:00.000Z"),
                },
              },
            });
          }
        },
      );
      expect(fridayEvening).toEqual(
        await prisma.dailyDerivedState.findUnique({
          where: {
            securityId_date: {
              securityId: security.id,
              date: new Date("2026-09-18T00:00:00.000Z"),
            },
          },
        }),
      );
      await expectBacktestParity(
        security,
        monitorId,
        definition,
        addDays(testWeek, -7),
        addDays(testWeek, 8),
        "buy-1 2026-09-18 INACTIVE->ACTIVE TRIGGER_FIRED",
      );
    }, 120_000);

    it("decides a Good Friday week's crossing on Thursday evening", async () => {
      const testWeek = "2026-03-30";
      const security = await createSecurity(weeklyCrossingCloses(testWeek));
      const definition = buyOn(crossesAboveWeekly());
      const monitorId = await createMonitor(security, definition);
      await play(addDays(testWeek, -7), addDays(testWeek, 8));
      await expectBacktestParity(
        security,
        monitorId,
        definition,
        addDays(testWeek, -7),
        addDays(testWeek, 8),
        "buy-1 2026-04-02 INACTIVE->ACTIVE TRIGGER_FIRED",
      );
    }, 120_000);

    it("activates on an ETF's weekly crossing on the fund's Friday, as a backtest does", async () => {
      const testWeek = "2026-06-08";
      const flat = new Map(
        [...weeklyCrossingCloses(testWeek).keys()].map((date) => [date, 100]),
      );
      const security = await createSecurity(flat);
      const etfContexts = etfContextsOver(weeklyCrossingCloses(testWeek));
      const definition = buyWhileAboveWeekly({ kind: "ETF", code: "ETF_XLK" });
      const monitorId = await createMonitor(security, definition);
      await play(addDays(testWeek, -7), addDays(testWeek, 8), etfContexts);
      await expectBacktestParity(
        security,
        monitorId,
        definition,
        addDays(testWeek, -7),
        addDays(testWeek, 8),
        "buy-1 2026-06-12 INACTIVE->ACTIVE CONDITIONS_MET",
        etfContexts,
      );
    }, 120_000);

    it("activates on a Stock's Sector weekly crossing on the fund's Friday, as a backtest does", async () => {
      const testWeek = "2026-08-17";
      const flat = new Map(
        [...weeklyCrossingCloses(testWeek).keys()].map((date) => [date, 100]),
      );
      const security = await createSecurity(flat, "Technology");
      const etfContexts = etfContextsOver(weeklyCrossingCloses(testWeek));
      const definition = buyWhileAboveWeekly({ kind: "STOCK_SECTOR" });
      const monitorId = await createMonitor(security, definition);
      await play(addDays(testWeek, -7), addDays(testWeek, 8), etfContexts);
      await expectBacktestParity(
        security,
        monitorId,
        definition,
        addDays(testWeek, -7),
        addDays(testWeek, 8),
        "buy-1 2026-08-21 INACTIVE->ACTIVE CONDITIONS_MET",
        etfContexts,
      );
    }, 120_000);
  },
);
