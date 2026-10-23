import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  normalizeStrategyDefinition,
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import type {
  DateRange,
  FinancialStatementCadence,
  FinancialStatementType,
  Security,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
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
  type StockRefreshState,
} from "@intrinsic/stock-data";
import {
  INITIAL_MONITOR_LEVEL_LIFECYCLE,
  monitorStrategyLevels,
  observeMonitorLevel,
  stepMonitorLevel,
  valuationRatioOperand,
} from "@intrinsic/strategy";
import { useTestDatabase, valuationAuditSessions } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedValuationAuditSecurity } from "../valuation-audit.test-helper.js";
import {
  MonitorEodEvaluation,
  type MonitorEvaluationData,
} from "./monitor-evaluation.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";

/**
 * When the fixtures' securities joined their Lists: before every session these suites drive, so a
 * session is observed or history by the Monitor's watching stamp alone, as in production, where a
 * member is never listed after the clock the pass runs on.
 */
const LISTED_BEFORE_EVERY_SESSION = new Date("2000-01-03T00:00:00.000Z");

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * A valuation Condition through the real Monitor EOD evaluation (`docs/valuation-ratios-audit/REPORT.md`,
 * Monitor; `docs/decisions/monitor-eod-v2.md` §3), over the valuation audit's anchor: the real
 * repository, transitions and Signal rows, and the real `CanonicalStockDataService` reading the
 * anchor's stored rows through `readFinalizedEvaluationFrame` — the same projection, valuation
 * timeline and basis bracket a backtest reads. Only the readiness of each session and the exchange
 * calendar are supplied.
 *
 * The level is `P/E is below 9`. Every expected outcome below is the API audit oracle's reading of
 * the anchor on that session (`apps/api/src/data-correctness-audit/valuation`), written out here:
 *
 * | session    | close | P/E (oracle)                 |
 * | ---------- | ----- | ---------------------------- |
 * | 2021-06-15 | 37.70 | withheld (rules 4.1 and 4.2) |
 * | 2024-03-13 | 43.29 | 9.0850                       |
 * | 2024-03-14 | 42.56 | 8.9318                       |
 * | 2024-09-16 | 45.39 | withheld (rule 6)            |
 * | 2024-11-08 | 55.08 | withheld (rule 5)            |
 * | 2024-11-11 | 55.78 | 11.3605                      |
 * | 2024-11-19 | 59.42 | 12.1018                      |
 *
 * Every session is a stored, finalized close read on its own statements — the reading a backtest
 * makes; there is no provisional observation.
 */
describeInfrastructure(
  "Valuation Conditions through the real Monitor EOD evaluation",
  () => {
    const prisma = new PrismaClient();
    const repository = new PrismaMonitorRepository(prisma);
    const logger = createLogger({ service: "worker", level: "silent" });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    const namespace = `stock-data:v2:test:valuation-monitor:${suffix}`;
    const closes = new Map(
      valuationAuditSessions().map((session) => [
        session.date,
        Number(session.close),
      ]),
    );

    class CountingProvider implements FmpStockProviderPort {
      readonly calls: string[] = [];
      async getProfile(requested: string) {
        this.calls.push(`profile:${requested}`);
        return null;
      }
      async getDailyPrices(_symbol: string, _id: string, range: DateRange) {
        this.calls.push(`prices:${range.from}:${range.to}`);
        return [];
      }
      async getFinancialStatements(
        _symbol: string,
        _id: string,
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

    /**
     * The production data slice over the real service, with each security's readiness capped at
     * the session a case drives: the frame is the real PostgreSQL read.
     */
    class AuditData implements MonitorEvaluationData {
      readonly readyThrough = new Map<string, string>();
      constructor(private readonly stockData: CanonicalStockDataService) {}
      findSecurities(ids: readonly string[]) {
        return this.stockData.findSecuritiesByIds(ids);
      }
      async stockRefreshState(security: Security): Promise<StockRefreshState> {
        const state = await this.stockData.stockRefreshState(security);
        const ready = this.readyThrough.get(security.id);
        if (!ready) {
          return state;
        }
        const latest =
          state.latestBar && state.latestBar < ready ? state.latestBar : ready;
        return {
          ...state,
          latestVerifiedBar: latest,
          verifiedThrough: latest,
          derivedThrough: latest,
        };
      }
      readFinalizedEvaluationFrame(
        ...args: Parameters<
          MonitorEvaluationData["readFinalizedEvaluationFrame"]
        >
      ) {
        return this.stockData.readFinalizedEvaluationFrame(...args);
      }
      reconstructionHistoryStart(security: Security) {
        return this.stockData.evaluationHistoryStart(security);
      }
    }

    const calendar = {
      async isTradingSession(_exchange: string, date: string) {
        return closes.has(date) || date > "2025-12-31";
      },
    };
    let stockData: CanonicalStockDataService;

    const provider = new CountingProvider();
    let redis: ReturnType<typeof createStockDataRedisClient>;
    let store: PrismaStockDataStore;
    let data: AuditData;
    let full: Security;
    let truncated: Security;
    let refreshed: Security;
    let userId: string;
    const monitorIds: string[] = [];
    const foreignEnabled: string[] = [];
    const foreignSystem: string[] = [];
    let cycles = 0;

    const definition: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "pe",
                metric: {
                  kind: "VALUATION_RATIO",
                  ratioId: "PRICE_TO_EARNINGS_TTM",
                },
                operator: "IS_BELOW",
                value: { kind: "MULTIPLE", value: 9 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    } as unknown as StrategyDefinition;

    /** `definition` with the `P/E is below` threshold at `threshold`. */
    function belowDefinition(threshold: number): StrategyDefinition {
      const copy = structuredClone(definition) as unknown as {
        buyLevels: [{ signal: { conditions: [{ value: { value: number } }] } }];
      };
      copy.buyLevels[0].signal.conditions[0].value.value = threshold;
      return copy as unknown as StrategyDefinition;
    }

    async function createMonitor(
      security: Security,
      strategyDefinition: StrategyDefinition = definition,
    ): Promise<string> {
      const strategy = await prisma.strategy.create({
        data: {
          userId,
          name: `Valuation audit ${randomUUID().slice(0, 8)}`,
          versions: {
            create: {
              versionNumber: 1,
              definition: strategyDefinition as never,
              definitionHash: randomUUID(),
            },
          },
        },
      });
      const list = await prisma.stockList.create({
        data: {
          userId,
          name: `Valuation audit ${randomUUID().slice(0, 8)}`,
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
          name: `Valuation audit ${randomUUID().slice(0, 8)}`,
          strategyId: strategy.id,
          stockListId: list.id,
          enabled: true,
        },
      });
      monitorIds.push(monitor.id);
      return monitor.id;
    }

    /** One evaluation in the evening of `session`, with `security` ready through it. */
    async function cycleOn(session: string, security: Security) {
      data.readyThrough.set(security.id, session);
      cycles += 1;
      const now = new Date(`${session}T23:00:00.000Z`);
      return new MonitorEodEvaluation(
        repository,
        data,
        new EodFinalityPolicy({ calendar, now: () => now }),
        logger,
        {
          securityConcurrency: 1,
          lateRecoveryMs: 24 * 60 * 60_000,
          now: () => now,
        },
      ).run(cycles);
    }

    async function levelOf(monitorId: string) {
      return prisma.monitorSignalState.findFirst({ where: { monitorId } });
    }

    async function signalsOf(monitorId: string) {
      return prisma.monitorSignal.findMany({
        where: { monitorId },
        orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
      });
    }

    /** Only `monitorId` is enabled for its cycles. */
    async function only(monitorId: string): Promise<void> {
      await prisma.monitor.updateMany({
        where: { id: { in: monitorIds } },
        data: { enabled: false },
      });
      await prisma.monitor.update({
        where: { id: monitorId },
        data: { enabled: true },
      });
    }

    beforeAll(async () => {
      redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
      store = new PrismaStockDataStore(prisma);
      stockData = new CanonicalStockDataService(
        store,
        provider,
        new RedisStockDataCache(new IoredisCacheClient(redis), 10, namespace),
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 30_000,
          lockWaitMs: 30_000,
        }),
        { productHistoryYears: 30 },
      );
      data = new AuditData(stockData);
      ({ security: full } = await seedValuationAuditSecurity(prisma, store, {
        symbol: `VM${suffix}`,
      }));
      ({ security: truncated } = await seedValuationAuditSecurity(
        prisma,
        store,
        {
          symbol: `VT${suffix}`,
          lastSession: "2024-11-08",
        },
      ));
      ({ security: refreshed } = await seedValuationAuditSecurity(
        prisma,
        store,
        {
          symbol: `VR${suffix}`,
          lastSession: "2024-11-11",
        },
      ));
      const user = await prisma.user.create({
        data: {
          email: `valuation-monitor-${randomUUID()}@example.test`,
          plan: "PRO",
        },
      });
      userId = user.id;
      // A cycle evaluates every enabled Monitor there is: pause the database's own while this runs.
      const foreign = await prisma.monitor.findMany({
        where: { ownership: "USER", enabled: true },
        select: { id: true },
      });
      foreignEnabled.push(...foreign.map((row) => row.id));
      await prisma.monitor.updateMany({
        where: { id: { in: foreignEnabled } },
        data: { enabled: false },
      });
      const system = await prisma.monitor.findMany({
        where: { ownership: "SYSTEM", isGloballyEnabled: true },
        select: { id: true },
      });
      foreignSystem.push(...system.map((row) => row.id));
      await prisma.monitor.updateMany({
        where: { id: { in: foreignSystem } },
        data: { isGloballyEnabled: false },
      });
    }, 120_000);

    afterAll(async () => {
      await prisma.monitor.updateMany({
        where: { id: { in: foreignEnabled } },
        data: { enabled: true },
      });
      await prisma.monitor.updateMany({
        where: { id: { in: foreignSystem } },
        data: { isGloballyEnabled: true },
      });
      const securityIds = [full?.id, truncated?.id, refreshed?.id].filter(
        Boolean,
      ) as string[];
      await prisma.monitorStateTransition.deleteMany({
        where: { securityId: { in: securityIds } },
      });
      await prisma.monitorSignalState.deleteMany({
        where: { securityId: { in: securityIds } },
      });
      await prisma.monitorSignal.deleteMany({
        where: { securityId: { in: securityIds } },
      });
      await prisma.monitor.deleteMany({ where: { id: { in: monitorIds } } });
      if (userId) {
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${namespace}:*`,
          "COUNT",
          500,
        );
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== "0");
      redis.disconnect();
      await prisma.$disconnect();
    });

    it("never opens a Signal on a withheld ratio, though zero would match `is below 9`", async () => {
      const monitorId = await createMonitor(full);
      await only(monitorId);
      const summary = await cycleOn("2021-06-15", full);
      expect(summary).toMatchObject({ members: 1, signalsOpened: 0 });
      // Nothing decided, so nothing written: a not-evaluable session never becomes a state.
      expect(await levelOf(monitorId)).toBeNull();
      expect(await signalsOf(monitorId)).toEqual([]);
    }, 120_000);

    it("decides every session from Mar 13 to Nov 19, 2024 in order, exactly as the backtest frame reads it", async () => {
      const monitorId = await createMonitor(full);
      await only(monitorId);

      // 2024-03-13: 9.09, not below 9 — the Monitor starts there, decided and inactive.
      await cycleOn("2024-03-13", full);
      let level = await levelOf(monitorId);
      expect(level?.lastOutcome).toBe("NOT_MATCHED");
      expect(await signalsOf(monitorId)).toEqual([]);

      // Every later session through 2024-11-19 caught up in one pass, in order.
      await cycleOn("2024-11-19", full);
      level = await levelOf(monitorId);
      // 12.10 on 2024-11-19: not below 9, and decided.
      expect(level?.lastOutcome).toBe("NOT_MATCHED");

      // The lifecycle the backtest frame's own readings produce, through the same reducer.
      const operands = [valuationRatioOperand("PRICE_TO_EARNINGS_TTM")];
      const frame = await stockData.readDailyEvaluationFrame(
        full,
        { from: "2024-03-13", to: "2024-11-19" },
        operands,
      );
      const [buy] = monitorStrategyLevels(
        normalizeStrategyDefinition(definition),
      );
      let lifecycle = INITIAL_MONITOR_LEVEL_LIFECYCLE;
      const expected: string[] = [];
      for (
        let index = frame.periodStartIndex;
        index < frame.dates.length;
        index += 1
      ) {
        const date = frame.dates[index]!;
        const result = stepMonitorLevel(lifecycle, {
          date,
          eligible: true,
          rules: observeMonitorLevel(buy!, frame, index),
        });
        if (date > "2024-03-13") {
          for (const transition of result.transitions) {
            expected.push(
              `${date} ${transition.from}->${transition.to} ${transition.reason}`,
            );
          }
        }
        lifecycle = result.next;
      }
      const recorded = (
        await prisma.monitorStateTransition.findMany({
          where: { monitorId },
          orderBy: { sequence: "asc" },
        })
      ).map(
        (row) =>
          `${row.observationDate?.toISOString().slice(0, 10)} ${row.fromState}->${row.toState} ${row.reason}`,
      );
      // Opened on the first session P/E was below 9 and ended on the first session it was not,
      // before either withheld session — every session decided, none skipped.
      expect(expected).toEqual([
        "2024-03-14 INACTIVE->ACTIVE CONDITIONS_MET",
        "2024-08-21 ACTIVE->RESOLVED CONDITIONS_ENDED",
      ]);
      expect(recorded).toEqual(expected);
      // It opened on 2024-03-14, the first session P/E was below 9 (8.93).
      const signals = await signalsOf(monitorId);
      expect(signals[0]?.observationDate.toISOString().slice(0, 10)).toBe(
        "2024-03-14",
      );
      // And no occurrence ever opened on a withheld session.
      for (const signal of signals) {
        const date = signal.observationDate.toISOString().slice(0, 10);
        expect(["2024-09-16", "2024-11-08"]).not.toContain(date);
      }
    }, 240_000);

    it("holds an open Signal through withheld sessions and resolves on the first evaluable session above the threshold", async () => {
      // `P/E is below 12`: below it since 2024-02-16, withheld on 2024-09-16 and 2024-11-08,
      // 11.36 on 2024-11-11 and 12.10 on 2024-11-19.
      const monitorId = await createMonitor(full, belowDefinition(12));
      await only(monitorId);
      await cycleOn("2024-03-13", full);
      expect((await levelOf(monitorId))?.lifecycleState).toBe("ACTIVE");
      const opened = await signalsOf(monitorId);
      expect(opened).toHaveLength(1);

      for (const withheld of ["2024-09-16", "2024-11-08"]) {
        await cycleOn(withheld, full);
        const level = await levelOf(monitorId);
        expect(level?.lifecycleState, withheld).toBe("ACTIVE");
        expect(level?.lastOutcome, withheld).toBe("NOT_EVALUABLE");
        expect(level?.activeSignalId, withheld).toBe(opened[0]!.id);
      }
      await cycleOn("2024-11-11", full);
      expect((await levelOf(monitorId))?.lifecycleState).toBe("ACTIVE");

      await cycleOn("2024-11-19", full);
      const level = await levelOf(monitorId);
      expect(level?.lifecycleState).toBe("RESOLVED");
      expect(level?.activeSignalId).toBeNull();
      const transitions = await prisma.monitorStateTransition.findMany({
        where: { monitorId },
        orderBy: { sequence: "asc" },
      });
      // Nothing changed on a withheld session; the one ending is Nov 19's.
      expect(
        transitions.filter((row) =>
          ["2024-09-16", "2024-11-08"].includes(
            row.observationDate?.toISOString().slice(0, 10) ?? "",
          ),
        ),
      ).toEqual([]);
      expect(transitions.at(-1)).toMatchObject({
        fromState: "ACTIVE",
        toState: "RESOLVED",
        reason: "CONDITIONS_ENDED",
      });
      expect(
        transitions.at(-1)?.observationDate?.toISOString().slice(0, 10),
      ).toBe("2024-11-19");
      expect(await signalsOf(monitorId)).toHaveLength(1);
    }, 240_000);

    it("decides a session on its own statements once its bar is stored, and nothing on a withheld newest bar", async () => {
      // Stored history ends 2024-11-08, inside the withheld stretch: nothing is decided, and no
      // later statement is read early.
      const monitorId = await createMonitor(truncated);
      await only(monitorId);
      await cycleOn("2024-11-11", truncated);
      expect(await levelOf(monitorId)).toBeNull();
      expect(await signalsOf(monitorId)).toEqual([]);

      // With the history stored through 2024-11-11, that session reads its own statements: 11.36 —
      // decided, and not below 9.
      const nextMonitorId = await createMonitor(refreshed);
      await only(nextMonitorId);
      await cycleOn("2024-11-11", refreshed);
      const level = await levelOf(nextMonitorId);
      expect(level?.lastOutcome).toBe("NOT_MATCHED");
      expect(await signalsOf(nextMonitorId)).toEqual([]);
    }, 120_000);

    it("refuses every valuation read whose price-basis generation moves during it, never mixing two bases", async () => {
      // A replacement committing while the valuation inputs are read: the store moves the generation
      // as the measured re-bases are read, inside each read's generation bracket.
      let racing = false;
      const racingStore = new Proxy(store, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === "getPriceBasisEvents") {
            return async (securityId: string) => {
              if (racing) {
                await prisma.securityPriceBasis.update({
                  where: { securityId },
                  data: { generation: { increment: 1 } },
                });
              }
              return target.getPriceBasisEvents(securityId);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const service = new CanonicalStockDataService(
        racingStore,
        provider,
        new RedisStockDataCache(
          new IoredisCacheClient(redis),
          10,
          `${namespace}:race`,
        ),
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 30_000,
          lockWaitMs: 30_000,
        }),
        { productHistoryYears: 30 },
      );
      const operands = [valuationRatioOperand("PRICE_TO_EARNINGS_TTM")];
      const range = { from: "2024-01-02", to: "2024-06-28" };
      await service.prepareStockOperands(full, operands);
      await service.prepareDailyEvaluationData(full, range, operands);
      try {
        racing = true;
        await expect(
          service.readFinalizedEvaluationFrame(full, range, operands),
        ).rejects.toBeInstanceOf(PriceBasisChangedError);
        await expect(
          service.readDailyEvaluationFrame(full, range, operands),
        ).rejects.toBeInstanceOf(PriceBasisChangedError);
        await expect(
          service.getDailyValuationRatio(
            full.symbol,
            "PRICE_TO_EARNINGS_TTM",
            range,
          ),
        ).rejects.toBeInstanceOf(PriceBasisChangedError);
      } finally {
        racing = false;
        await prisma.securityPriceBasis.update({
          where: { securityId: full.id },
          data: { generation: 1 },
        });
      }
    }, 120_000);

    it("reaches no provider", () => {
      expect(provider.calls).toEqual([]);
    });
  },
);
