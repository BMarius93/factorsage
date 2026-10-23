import { randomUUID } from "node:crypto";
import {
  normalizeStrategyDefinition,
  STRATEGY_SCHEMA_VERSION,
  type StrategyCondition,
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
import {
  FmpRateLimitError,
  type FmpStockProviderPort,
  type MappedFmpProfile,
} from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalStockDataService,
  EodFinalityPolicy,
  IoredisCacheClient,
  PriceBasisChangedError,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  type TradingCalendar,
} from "@intrinsic/stock-data";
import {
  collectOperands,
  explainMonitorLevel,
  INITIAL_MONITOR_LEVEL_LIFECYCLE,
  monitorStrategyLevels,
  observeMonitorLevel,
  stepMonitorLevel,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekdaySessions } from "../shared/etf-context.test-helper.js";
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
import {
  PrismaMonitorRepository,
  type MonitorEvaluationRepository,
} from "./monitor-repository.js";

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
 * Late end-of-day publication, end to end (`docs/decisions/monitor-eod-v2.md` §10): the real stock
 * EOD child storing bars through the canonical loader into PostgreSQL and Redis, and the real
 * Monitor EOD evaluation deciding from them — only the provider and the clock are simulated.
 *
 * Each case publishes a week whose decisive move is on **Tuesday**, delays or breaks what it
 * must, and walks the clock evening by evening. At every step a Monitor may never stand past a
 * session whose bar has not been published yet (it would skip it forever); at the end every
 * recorded change must be exactly the one a backtest over the finished history records — same
 * level, same session, same reason, once — with the evidence that session's values give.
 */

const WEEK = {
  monday: "2026-09-14",
  tuesday: "2026-09-15",
  wednesday: "2026-09-16",
  thursday: "2026-09-17",
  friday: "2026-09-18",
} as const;
const LAST_SESSION: LocalDate = "2026-09-25";
const HISTORY_FROM: LocalDate = "2024-09-02";
const DELAY_MS = 30 * 60_000;
const HOUR = 60 * 60_000;
const LATE_RECOVERY_MS = 4 * 24 * HOUR;

/** The closes from Monday on: flat history at 100, a break above every average on Tuesday. */
const MOVE: Record<LocalDate, number> = {
  "2026-09-14": 100,
  "2026-09-15": 110,
  "2026-09-16": 111,
  "2026-09-17": 112,
  "2026-09-18": 95,
  "2026-09-21": 96,
  "2026-09-22": 97,
  "2026-09-23": 98,
  "2026-09-24": 99,
  "2026-09-25": 99.5,
};

function isWeekday(date: LocalDate): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekdaysBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (isWeekday(date)) {
      dates.push(date);
    }
  }
  return dates;
}

const finalizedAt = (date: LocalDate): Date =>
  eodSessionFinalizedAt(date, DELAY_MS);

/** The venue: every weekday. */
const calendar: TradingCalendar = {
  isTradingSession: async (_exchange, date) => isWeekday(date),
};

type Publication = { close: number; publishAt: Date | null };

/**
 * The provider's EOD feed for every security in this file: a bar is returned once the clock has
 * reached its publication instant (`null`: never — the security did not trade it). One-shot
 * failures are queued per symbol.
 */
class PublishingProvider implements FmpStockProviderPort {
  readonly bars = new Map<string, Map<LocalDate, Publication>>();
  readonly failures = new Map<string, ("RATE_LIMITED" | "EMPTY")[]>();
  readonly priceReads = new Map<string, number>();

  constructor(private readonly clock: { now: Date }) {}

  publish(symbol: string, schedule: Map<LocalDate, Publication>): void {
    this.bars.set(symbol, schedule);
  }

  async getProfile(symbol: string): Promise<MappedFmpProfile | null> {
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
      },
      profile: { description: "Late-publication fixture" },
    };
  }

  async getDailyPrices(
    symbol: string,
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]> {
    this.priceReads.set(symbol, (this.priceReads.get(symbol) ?? 0) + 1);
    const failure = this.failures.get(symbol)?.shift();
    if (failure === "RATE_LIMITED") {
      throw new FmpRateLimitError(1_000);
    }
    if (failure === "EMPTY") {
      return [];
    }
    const rows: DailyPrice[] = [];
    for (const [date, bar] of this.bars.get(symbol) ?? []) {
      if (
        bar.publishAt === null ||
        bar.publishAt.getTime() > this.clock.now.getTime() ||
        (range.from !== undefined && date < range.from) ||
        (range.to !== undefined && date > range.to)
      ) {
        continue;
      }
      rows.push({
        securityId,
        date,
        open: bar.close,
        high: bar.close,
        low: bar.close,
        close: bar.close,
        volume: 1_000_000,
      });
    }
    return rows.sort((left, right) => left.date.localeCompare(right.date));
  }

  async getFinancialStatements(): Promise<FinancialStatementDraft[]> {
    return [];
  }
}

const crossesAbove = (seriesId: "SMA_20D" | "EMA_20D"): StrategyTrigger => ({
  id: `t-${seriesId.toLowerCase()}`,
  metric: { kind: "PRICE" },
  operator: "CROSSES_ABOVE",
  value: { kind: "SERIES", seriesId },
});
const above = (seriesId: "SMA_20D" | "SMA_50D"): StrategyCondition => ({
  id: `c-${seriesId.toLowerCase()}`,
  metric: { kind: "PRICE" },
  operator: "IS_ABOVE",
  value: { kind: "SERIES", seriesId },
});

function buy(signal: StrategyDefinition["buyLevels"][number]["signal"]) {
  return normalizeStrategyDefinition({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "buy-1", percentage: 100, signal }],
    sellLevels: [],
  });
}

const STRATEGIES = {
  triggerOnly: buy({ conditions: [], trigger: crossesAbove("SMA_20D") }),
  conditionsOnly: buy({ conditions: [above("SMA_20D")] }),
  conditionsAndTrigger: buy({
    conditions: [above("SMA_50D")],
    trigger: crossesAbove("EMA_20D"),
  }),
  finalExitAlternatives: normalizeStrategyDefinition({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: { conditions: [above("SMA_20D")] },
      },
    ],
    sellLevels: [],
    finalExit: {
      id: "exit",
      rules: [
        {
          id: "exit-trigger",
          signal: { conditions: [], trigger: crossesAbove("SMA_20D") },
        },
        { id: "exit-condition", signal: { conditions: [above("SMA_50D")] } },
      ],
    },
  }),
} satisfies Record<string, StrategyDefinition>;

type Scenario = {
  strategy: StrategyDefinition;
  /** When each session of the move is published, relative to its finalization; null: never. */
  lateness?: Partial<Record<LocalDate, number | null>>;
  /** One-shot provider failures, consumed by the next price reads. */
  failures?: ("RATE_LIMITED" | "EMPTY")[];
  /** Runs at one step, before the stock EOD child and the Monitor pass. */
  beforeStep?: (context: StepContext) => Promise<void> | void;
  /** Replaces the Monitor pass at one step (to overlap two of them, or crash one). */
  evaluate?: (context: StepContext) => Promise<void>;
};

type StepContext = {
  at: Date;
  security: Security;
  monitorId: string;
  evaluation: () => MonitorEodEvaluation;
  stored: () => Promise<LocalDate[]>;
};

describeInfrastructure(
  "late end-of-day publication never loses a decision",
  () => {
    const prisma = new PrismaClient();
    const clock = { now: new Date(`${WEEK.monday}T12:00:00.000Z`) };
    const provider = new PublishingProvider(clock);
    const namespace = `stock-data:v2:late-recovery:${randomUUID().slice(0, 8)}`;
    const logger = createLogger({ service: "worker", level: "silent" });
    const running = new Set<string>();
    const real = new PrismaMonitorRepository(prisma);
    const repository = scopedRepository(real, () => running);
    const policy = new EodFinalityPolicy({
      calendar,
      publicationDelayMs: DELAY_MS,
      sessionRetryMs: 30 * 60_000,
      sessionGiveUpMs: 24 * HOUR,
      now: () => clock.now,
    });
    let redis: ReturnType<typeof createStockDataRedisClient>;
    let store: PrismaStockDataStore;
    let stockData: CanonicalStockDataService;
    let data: MonitorEvaluationData & {
      failNextFrame?: () => boolean;
    };
    let userId: string;
    const securityIds: string[] = [];
    let cycle = 0;

    function evaluation(
      etfContexts?: MonitorEtfContexts,
      monitors: MonitorEvaluationRepository = repository,
    ) {
      return new MonitorEodEvaluation(
        monitors,
        data,
        policy,
        logger,
        {
          securityConcurrency: 2,
          lateRecoveryMs: LATE_RECOVERY_MS,
          now: () => clock.now,
        },
        etfContexts,
      );
    }

    beforeAll(async () => {
      redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
      store = new PrismaStockDataStore(prisma);
      stockData = new CanonicalStockDataService(
        store,
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
      const frameFailures = { count: 0 };
      data = {
        findSecurities: (ids) => stockData.findSecuritiesByIds(ids),
        stockRefreshState: (security) => stockData.stockRefreshState(security),
        readFinalizedEvaluationFrame: async (security, range, operands) => {
          if (frameFailures.count > 0) {
            frameFailures.count -= 1;
            throw new PriceBasisChangedError(
              security.id,
              security.symbol,
              1,
              2,
            );
          }
          return stockData.readFinalizedEvaluationFrame(
            security,
            range,
            operands,
          );
        },
        reconstructionHistoryStart: (security) =>
          stockData.evaluationHistoryStart(security),
        failNextFrame: () => {
          frameFailures.count += 1;
          return true;
        },
      };
      const user = await prisma.user.create({
        data: {
          email: `late-recovery-${randomUUID()}@example.test`,
          plan: "PRO",
        },
      });
      userId = user.id;
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

    async function createSecurity(): Promise<Security> {
      const symbol = `LTR${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
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
          ipoDate: new Date(`${HISTORY_FROM}T00:00:00.000Z`),
        },
      });
      securityIds.push(row.id);
      return (await stockData.findSecuritiesByIds([row.id]))[0]!;
    }

    async function createMonitor(
      security: Security,
      definition: StrategyDefinition,
    ): Promise<string> {
      const strategy = await prisma.strategy.create({
        data: {
          userId,
          name: `Late recovery ${randomUUID().slice(0, 8)}`,
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
          name: `Late recovery ${randomUUID().slice(0, 8)}`,
          items: { create: [{ securityId: security.id, createdAt: LISTED_BEFORE_EVERY_SESSION }] },
        },
      });
      const monitor = await prisma.monitor.create({
        data: {
          // Reconstructed at the newest session: this suite is not about the window replay.
          windowReplay: false,
          userId,
          name: `Late recovery ${randomUUID().slice(0, 8)}`,
          strategyId: strategy.id,
          stockListId: list.id,
          enabled: true,
        },
      });
      return monitor.id;
    }

    async function stored(security: Security): Promise<LocalDate[]> {
      const rows = await prisma.dailyPrice.findMany({
        where: {
          securityId: security.id,
          date: { gte: new Date(`${WEEK.monday}T00:00:00.000Z`) },
        },
        select: { date: true },
        orderBy: { date: "asc" },
      });
      return rows.map((row) => row.date.toISOString().slice(0, 10));
    }

    async function prepare(): Promise<void> {
      const run = new StockEodRefreshRun(
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
      );
      try {
        await run.run((cycle += 1), () => false);
      } catch (err) {
        // Every attempted security failed: the run itself fails and is retried at the next step.
        if (!(err instanceof StockEodRefreshFailedError)) {
          throw err;
        }
      }
    }

    async function checkpointOf(monitorId: string, securityId: string) {
      const row = await prisma.monitorEvaluationCheckpoint.findUnique({
        where: { monitorId_securityId: { monitorId, securityId } },
      });
      return row?.evaluatedThrough.toISOString().slice(0, 10);
    }

    /**
     * Publishes the history and the move, walks the clock over every evening (and every late
     * publication) from Monday to `LAST_SESSION`, and checks after each pass that the Monitor never
     * stands past a session that is still to be published.
     */
    async function play(scenario: Scenario, etfContexts?: MonitorEtfContexts) {
      const security = await createSecurity();
      const schedule = new Map<LocalDate, Publication>();
      for (const date of weekdaysBetween(
        HISTORY_FROM,
        addDays(WEEK.monday, -1),
      )) {
        schedule.set(date, { close: 100, publishAt: new Date(0) });
      }
      for (const date of weekdaysBetween(WEEK.monday, LAST_SESSION)) {
        const lateness = scenario.lateness?.[date];
        schedule.set(date, {
          close: MOVE[date]!,
          publishAt:
            lateness === null
              ? null
              : new Date(finalizedAt(date).getTime() + (lateness ?? 0)),
        });
      }
      provider.publish(security.symbol, schedule);
      if (scenario.failures) {
        provider.failures.set(security.symbol, [...scenario.failures]);
      }
      const monitorId = await createMonitor(security, scenario.strategy);
      // One running Monitor per case: the owner's plan admits ten, and earlier cases' Monitors would
      // otherwise take the slots.
      await prisma.monitor.updateMany({
        where: { userId, id: { not: monitorId } },
        data: { enabled: false },
      });
      running.clear();
      running.add(monitorId);

      const instants = new Set<number>();
      for (const date of weekdaysBetween(
        WEEK.monday,
        addDays(LAST_SESSION, 3),
      )) {
        instants.add(Date.parse(`${date}T20:45:00.000Z`));
        instants.add(Date.parse(`${date}T23:30:00.000Z`));
      }
      for (const bar of schedule.values()) {
        if (
          bar.publishAt &&
          bar.publishAt.getTime() > Date.parse(`${WEEK.monday}T20:00:00.000Z`)
        ) {
          instants.add(bar.publishAt.getTime() + 5 * 60_000);
        }
      }
      const context = (at: Date): StepContext => ({
        at,
        security,
        monitorId,
        evaluation: () => evaluation(etfContexts),
        stored: () => stored(security),
      });
      for (const instant of [...instants].sort((left, right) => left - right)) {
        clock.now = new Date(instant);
        await scenario.beforeStep?.(context(clock.now));
        await prepare();
        if (scenario.evaluate) {
          await scenario.evaluate(context(clock.now));
        } else {
          await evaluation(etfContexts).run((cycle += 1));
        }
        // Never past a session the provider will publish but has not yet: that bar would be lost.
        const through = await checkpointOf(monitorId, security.id);
        for (const [date, bar] of schedule) {
          if (
            date >= WEEK.monday &&
            bar.publishAt !== null &&
            bar.publishAt.getTime() > clock.now.getTime() &&
            through !== undefined
          ) {
            expect(
              through < date,
              `${clock.now.toISOString()}: ${through} ≥ ${date}`,
            ).toBe(true);
          }
        }
      }
      return { security, monitorId };
    }

    /** What a backtest over the finished history records for every level, from Monday on. */
    async function backtestChanges(
      security: Security,
      definition: StrategyDefinition,
    ) {
      const frame = await stockData.readDailyEvaluationFrame(
        security,
        { from: WEEK.monday, to: LAST_SESSION },
        collectOperands(definition),
      );
      const changes: string[] = [];
      for (const level of monitorStrategyLevels(definition)) {
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
          if (date > WEEK.monday) {
            for (const transition of result.transitions) {
              changes.push(
                `${level.id} ${date} ${transition.from}->${transition.to} ${transition.reason}`,
              );
            }
          }
          lifecycle = result.next;
        }
      }
      return { frame, changes: changes.sort() };
    }

    /**
     * Exactly the backtest's changes, once each, OBSERVED on their own sessions, with the evidence
     * the finished history gives on that session — and one Signal per activation.
     */
    async function expectExactlyTheBacktest(
      security: Security,
      monitorId: string,
      definition: StrategyDefinition,
    ) {
      const { frame, changes } = await backtestChanges(security, definition);
      expect(changes.length).toBeGreaterThan(0);
      const transitions = await prisma.monitorStateTransition.findMany({
        where: { monitorId },
        orderBy: { sequence: "asc" },
      });
      const recorded = transitions
        .filter(
          (row) => row.observationDate !== null && row.origin === "OBSERVED",
        )
        .map(
          (row) =>
            `${row.levelId} ${row.observationDate!.toISOString().slice(0, 10)} ${row.fromState}->${row.toState} ${row.reason}`,
        )
        .sort();
      expect(recorded).toEqual(changes);
      // Nothing else was recorded: no administrative noise, no duplicates, no reconstruction.
      expect(transitions.length).toBe(recorded.length);
      const levels = new Map(
        monitorStrategyLevels(definition).map((level) => [level.id, level]),
      );
      for (const row of transitions) {
        const date = row.observationDate!.toISOString().slice(0, 10);
        const index = frame.dates.indexOf(date);
        expect(index, date).toBeGreaterThanOrEqual(0);
        expect(row.evidence, `${row.levelId} ${date}`).toEqual(
          JSON.parse(
            JSON.stringify(
              explainMonitorLevel(
                levels.get(row.levelId)!,
                frame,
                index,
                row.exitRuleId,
              ),
            ),
          ),
        );
      }
      const signals = await prisma.monitorSignal.findMany({
        where: { monitorId },
      });
      const activations = transitions.filter((row) => row.toState === "ACTIVE");
      expect(signals).toHaveLength(activations.length);
      expect(
        signals
          .map((row) => row.observationDate.toISOString().slice(0, 10))
          .sort(),
      ).toEqual(
        activations
          .map((row) => row.observationDate!.toISOString().slice(0, 10))
          .sort(),
      );
      return transitions;
    }

    const activatedOnTuesday = (
      transitions: { toState: string; observationDate: Date | null }[],
    ) =>
      expect(
        transitions
          .find((row) => row.toState === "ACTIVE")
          ?.observationDate?.toISOString()
          .slice(0, 10),
      ).toBe(WEEK.tuesday);

    describe.each([
      ["30 minutes", 30 * 60_000],
      ["6 hours", 6 * HOUR],
      ["25 hours", 25 * HOUR],
      ["36 hours", 36 * HOUR],
      ["72 hours", 72 * HOUR],
    ])("Tuesday's bar published %s late", (_label, lateness) => {
      it("is decided on Tuesday, in order, exactly once", async () => {
        const { security, monitorId } = await play({
          strategy: STRATEGIES.triggerOnly,
          lateness: { [WEEK.tuesday]: lateness },
        });
        const transitions = await expectExactlyTheBacktest(
          security,
          monitorId,
          STRATEGIES.triggerOnly,
        );
        activatedOnTuesday(transitions);
      }, 120_000);
    });

    it("decides several consecutive missing sessions once they appear, in order", async () => {
      const { security, monitorId } = await play({
        strategy: STRATEGIES.conditionsOnly,
        lateness: { [WEEK.tuesday]: 52 * HOUR, [WEEK.wednesday]: 28 * HOUR },
      });
      activatedOnTuesday(
        await expectExactlyTheBacktest(
          security,
          monitorId,
          STRATEGIES.conditionsOnly,
        ),
      );
    }, 120_000);

    it("waits for Tuesday when Wednesday is published first", async () => {
      let sawWednesdayWithoutTuesday = false;
      const { security, monitorId } = await play({
        strategy: STRATEGIES.triggerOnly,
        lateness: { [WEEK.tuesday]: 40 * HOUR },
        beforeStep: async ({ stored: read }) => {
          const dates = await read();
          if (dates.includes(WEEK.wednesday) && !dates.includes(WEEK.tuesday)) {
            sawWednesdayWithoutTuesday = true;
          }
        },
      });
      expect(sawWednesdayWithoutTuesday).toBe(true);
      activatedOnTuesday(
        await expectExactlyTheBacktest(
          security,
          monitorId,
          STRATEGIES.triggerOnly,
        ),
      );
    }, 120_000);

    it("survives an empty provider answer, then decides the session when it is answered", async () => {
      const { security, monitorId } = await play({
        strategy: STRATEGIES.triggerOnly,
        beforeStep: ({ at, security }) => {
          // The first post-final read of Tuesday comes back empty.
          if (at.toISOString() === `${WEEK.tuesday}T20:45:00.000Z`) {
            provider.failures.set(security.symbol, ["EMPTY"]);
          }
        },
      });
      activatedOnTuesday(
        await expectExactlyTheBacktest(
          security,
          monitorId,
          STRATEGIES.triggerOnly,
        ),
      );
    }, 120_000);

    it("survives a rate-limited provider, then decides the session when it recovers", async () => {
      const { security, monitorId } = await play({
        strategy: STRATEGIES.triggerOnly,
        beforeStep: ({ at, security }) => {
          if (at.toISOString() === `${WEEK.tuesday}T20:45:00.000Z`) {
            provider.failures.set(security.symbol, [
              "RATE_LIMITED",
              "RATE_LIMITED",
            ]);
          }
        },
      });
      activatedOnTuesday(
        await expectExactlyTheBacktest(
          security,
          monitorId,
          STRATEGIES.triggerOnly,
        ),
      );
    }, 120_000);

    it("survives a crash after the provider answered but before anything was stored", async () => {
      const original = store.saveDailyPriceSync.bind(store);
      let crashes = 0;
      try {
        const { security, monitorId } = await play({
          strategy: STRATEGIES.triggerOnly,
          lateness: { [WEEK.tuesday]: 30 * HOUR },
          beforeStep: ({ security }) => {
            store.saveDailyPriceSync = async (input) => {
              if (
                crashes === 0 &&
                input.securityId === security.id &&
                input.prices.some((price) => price.date === WEEK.tuesday)
              ) {
                crashes += 1;
                throw new Error(
                  "process killed after the read, before the write",
                );
              }
              return original(input);
            };
          },
        });
        expect(crashes).toBe(1);
        activatedOnTuesday(
          await expectExactlyTheBacktest(
            security,
            monitorId,
            STRATEGIES.triggerOnly,
          ),
        );
      } finally {
        store.saveDailyPriceSync = original;
      }
    }, 120_000);

    it("never decides twice after a crash between the member's commit and the pass's acknowledgement", async () => {
      let crashed = false;
      const { security, monitorId } = await play({
        strategy: STRATEGIES.triggerOnly,
        lateness: { [WEEK.tuesday]: 30 * HOUR },
        evaluate: async ({ at }) => {
          const crashing: MonitorEvaluationRepository = {
            ...repository,
            applyMemberEvaluation: async (write) => {
              const result = await repository.applyMemberEvaluation(write);
              if (
                !crashed &&
                write.levels.some((level) => level.changes.length > 0)
              ) {
                crashed = true;
                throw new Error(
                  `process killed after the commit, at ${at.toISOString()}`,
                );
              }
              return result;
            },
          };
          await evaluation(undefined, crashing).run((cycle += 1));
        },
      });
      expect(crashed).toBe(true);
      activatedOnTuesday(
        await expectExactlyTheBacktest(
          security,
          monitorId,
          STRATEGIES.triggerOnly,
        ),
      );
    }, 120_000);

    it("decides once when two passes recover the same sessions at the same time", async () => {
      const { security, monitorId } = await play({
        strategy: STRATEGIES.conditionsAndTrigger,
        lateness: { [WEEK.tuesday]: 36 * HOUR },
        evaluate: async () => {
          await Promise.all([
            evaluation().run((cycle += 1)),
            evaluation().run((cycle += 1)),
          ]);
        },
      });
      activatedOnTuesday(
        await expectExactlyTheBacktest(
          security,
          monitorId,
          STRATEGIES.conditionsAndTrigger,
        ),
      );
    }, 120_000);

    it("is unaffected by Redis losing every key while the late bar is recovered", async () => {
      const { security, monitorId } = await play({
        strategy: STRATEGIES.triggerOnly,
        lateness: { [WEEK.tuesday]: 30 * HOUR },
        beforeStep: async ({ at }) => {
          if (at.getTime() > finalizedAt(WEEK.tuesday).getTime() + 30 * HOUR) {
            const keys = await redis.keys(`${namespace}*`);
            if (keys.length > 0) {
              await redis.del(...keys);
            }
          }
        },
      });
      activatedOnTuesday(
        await expectExactlyTheBacktest(
          security,
          monitorId,
          STRATEGIES.triggerOnly,
        ),
      );
    }, 120_000);

    it("skips a pass whose read meets a re-based history, and decides the sessions on the next", async () => {
      let refused = false;
      const { security, monitorId } = await play({
        strategy: STRATEGIES.triggerOnly,
        lateness: { [WEEK.tuesday]: 30 * HOUR },
        beforeStep: async ({ at, stored: read }) => {
          const dates = await read();
          if (
            !refused &&
            dates.includes(WEEK.tuesday) &&
            at.getUTCHours() === 20
          ) {
            refused = data.failNextFrame!();
          }
        },
      });
      expect(refused).toBe(true);
      activatedOnTuesday(
        await expectExactlyTheBacktest(
          security,
          monitorId,
          STRATEGIES.triggerOnly,
        ),
      );
    }, 120_000);

    it("passes a session the security genuinely never printed only after the horizon, and decides the rest in order", async () => {
      const holds: number[] = [];
      const { security, monitorId } = await play({
        strategy: STRATEGIES.conditionsOnly,
        lateness: { [WEEK.tuesday]: null },
        evaluate: async () => {
          const summary = await evaluation().run((cycle += 1));
          holds.push(summary.membersAwaitingLateSession);
        },
      });
      // It was held while Tuesday might still have come …
      expect(holds.some((count) => count > 0)).toBe(true);
      // … and then every printed session was decided, exactly as a backtest without Tuesday.
      const transitions = await expectExactlyTheBacktest(
        security,
        monitorId,
        STRATEGIES.conditionsOnly,
      );
      expect(
        transitions
          .find((row) => row.toState === "ACTIVE")
          ?.observationDate?.toISOString()
          .slice(0, 10),
      ).toBe(WEEK.wednesday);
      expect(await checkpointOf(monitorId, security.id)).toBe(LAST_SESSION);
    }, 180_000);

    describe.each([
      ["Conditions only, activation and resolution", STRATEGIES.conditionsOnly],
      ["Trigger only", STRATEGIES.triggerOnly],
      ["Conditions + Trigger", STRATEGIES.conditionsAndTrigger],
      ["FINAL EXIT with alternative rules", STRATEGIES.finalExitAlternatives],
    ])("%s, with Tuesday 36 hours late", (_label, strategy) => {
      it("records every change on its own session, once, with that session's evidence", async () => {
        const { security, monitorId } = await play({
          strategy,
          lateness: { [WEEK.tuesday]: 36 * HOUR },
        });
        activatedOnTuesday(
          await expectExactlyTheBacktest(security, monitorId, strategy),
        );
      }, 120_000);
    });

    it("waits for a late ETF session the stock already printed, and decides it on its own session", async () => {
      // XLK, flat at 50, breaks above its average on Tuesday — a Tuesday it publishes 40 hours late.
      const etfTuesdayAt = new Date(
        finalizedAt(WEEK.tuesday).getTime() + 40 * HOUR,
      );
      const etfRows: { bar: BenchmarkDailyPrice; publishAt: Date }[] = [];
      for (const date of weekdaysBetween(HISTORY_FROM, LAST_SESSION)) {
        const close =
          date < WEEK.tuesday ? 50 : 60 + (date > WEEK.thursday ? -15 : 0);
        etfRows.push({
          bar: {
            seriesId: "series-xlk",
            date,
            open: close,
            high: close,
            low: close,
            close,
            volume: 1_000_000,
          },
          publishAt: date === WEEK.tuesday ? etfTuesdayAt : finalizedAt(date),
        });
      }
      const published = () =>
        etfRows
          .filter((row) => row.publishAt.getTime() <= clock.now.getTime())
          .map((row) => row.bar);
      const etfContexts: MonitorEtfContexts = {
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
        isScheduledSession: weekdaySessions,
      };
      const strategy = buy({
        conditions: [
          above("SMA_20D"),
          {
            id: "c-xlk",
            metric: { kind: "PRICE", source: { kind: "ETF", code: "ETF_XLK" } },
            operator: "IS_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_20D" },
          },
        ],
      });
      const holds: number[] = [];
      const { monitorId } = await play(
        {
          strategy,
          evaluate: async () => {
            const summary = await evaluation(etfContexts).run((cycle += 1));
            holds.push(summary.membersAwaitingLateSession);
          },
        },
        etfContexts,
      );
      expect(holds.some((count) => count > 0)).toBe(true);
      const transitions = await prisma.monitorStateTransition.findMany({
        where: { monitorId },
        orderBy: { sequence: "asc" },
      });
      expect(
        transitions.map(
          (row) =>
            `${row.observationDate?.toISOString().slice(0, 10)} ${row.fromState}->${row.toState} ${row.reason} ${row.origin}`,
        ),
      ).toEqual([
        `${WEEK.tuesday} INACTIVE->ACTIVE CONDITIONS_MET OBSERVED`,
        `${WEEK.friday} ACTIVE->RESOLVED CONDITIONS_ENDED OBSERVED`,
      ]);
      expect(await prisma.monitorSignal.count({ where: { monitorId } })).toBe(
        1,
      );
    }, 120_000);
  },
);
