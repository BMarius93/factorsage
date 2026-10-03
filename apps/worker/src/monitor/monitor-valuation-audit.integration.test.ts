import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import type {
  DateRange,
  FinancialStatementCadence,
  FinancialStatementType,
  Security,
  SecurityId,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalStockDataService,
  IoredisCacheClient,
  PriceBasisChangedError,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  monitorWindowObservations,
  requiredDailySeries,
  type CurrentObservation,
} from "@intrinsic/stock-data";
import {
  requiredAlternativeDataLeadingSessions,
  valuationRatioOperand,
  type OperandKey,
} from "@intrinsic/strategy";
import { useTestDatabase, valuationAuditSessions } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedValuationAuditSecurity } from "../valuation-audit.test-helper.js";
import { MonitorCycle, type MonitorDataLoader } from "./monitor-cycle.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * A valuation Condition through the real Monitor cycle (`docs/valuation-ratios-audit/REPORT.md`,
 * Monitor), over the valuation audit's anchor: the real repository, transitions and Signal rows, and
 * the real `CanonicalStockDataService` reading the anchor's stored rows. Only the quote and the
 * exchange calendar are supplied.
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
 * And provisionally, at a quote on a new session with the newest closed session's statements:
 * 2024-11-11 at 55.78 with 2024-11-08's, withheld (rule 5); 2024-11-12 at 56.45 with 2024-11-11's,
 * 11.4969.
 *
 * A quote equal to the session's stored close reprices that closed day, so the frame reads the
 * session's own statements — the reading a backtest makes. The provisional case uses a security
 * whose stored history ends the session before, so the quote is a new session that carries the
 * previous session's statements.
 */
describeInfrastructure(
  "Valuation Conditions through the real Monitor cycle",
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

    /** The production loader's delegation, with the quote supplied. */
    class AuditLoader implements MonitorDataLoader {
      quote: number | null = null;
      quotedAt: string | undefined;
      constructor(private readonly stockData: CanonicalStockDataService) {}
      findSecurities(ids: readonly SecurityId[]) {
        return this.stockData.findSecuritiesByIds(ids);
      }
      async getCurrentObservations(securities: readonly Security[]) {
        const observations = new Map<SecurityId, CurrentObservation>();
        if (this.quote !== null) {
          for (const security of securities) {
            observations.set(security.id, {
              price: this.quote,
              ...(this.quotedAt ? { quotedAt: this.quotedAt } : {}),
            });
          }
        }
        return observations;
      }
      prepareMonitorEvaluationData(
        security: Security,
        observations: number,
        asOf: string,
        operands: readonly OperandKey[] = [],
      ) {
        return this.stockData.prepareMonitorEvaluationData(
          security,
          observations,
          asOf,
          operands,
        );
      }
      readMonitorEvaluationFrame(
        input: Parameters<MonitorDataLoader["readMonitorEvaluationFrame"]>[0],
      ) {
        return this.stockData.readMonitorEvaluationFrame(input);
      }
      monitorWindowObservations(operands: readonly OperandKey[]) {
        return monitorWindowObservations(
          requiredDailySeries(operands),
          requiredAlternativeDataLeadingSessions(operands),
        );
      }
      async prepareReconstructionData(
        security: Security,
        range: { from: string; to: string },
        operands: readonly OperandKey[] = [],
      ) {
        await this.stockData.prepareDailyEvaluationData(
          security,
          range,
          operands,
        );
      }
      readReconstructionFrame(
        security: Security,
        range: { from: string; to: string },
        operands: readonly OperandKey[],
      ) {
        return this.stockData.readDailyEvaluationFrame(
          security,
          range,
          operands,
        );
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

    const provider = new CountingProvider();
    let redis: ReturnType<typeof createStockDataRedisClient>;
    let store: PrismaStockDataStore;
    let loader: AuditLoader;
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

    async function createMonitor(security: Security): Promise<string> {
      const strategy = await prisma.strategy.create({
        data: {
          userId,
          name: `Valuation audit ${randomUUID().slice(0, 8)}`,
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
          name: `Valuation audit ${randomUUID().slice(0, 8)}`,
          items: { create: [{ securityId: security.id }] },
        },
      });
      const monitor = await prisma.monitor.create({
        data: {
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

    /** One cycle at 10:00 New York on `session`, with `quote` as the live price. */
    async function cycleOn(session: string, quote: number) {
      loader.quote = quote;
      loader.quotedAt = `${session}T14:55:00.000Z`;
      cycles += 1;
      const summary = await new MonitorCycle(
        repository,
        loader,
        calendar,
        logger,
        {
          symbolConcurrency: 1,
          quoteMaxAgeMs: 4 * 24 * 60 * 60_000,
          now: () => new Date(`${session}T15:00:00.000Z`),
        },
      ).run(cycles);
      return summary;
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
      const service = new CanonicalStockDataService(
        store,
        provider,
        new RedisStockDataCache(new IoredisCacheClient(redis), 10, namespace),
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 30_000,
          lockWaitMs: 30_000,
        }),
        { productHistoryYears: 30 },
      );
      loader = new AuditLoader(service);
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
      const summary = await cycleOn("2021-06-15", closes.get("2021-06-15")!);
      expect(summary).toMatchObject({
        evaluations: 1,
        notEvaluable: 1,
        signalsEmitted: 0,
      });
      // Nothing decided, so nothing written: a not-evaluable observation never becomes a state.
      expect(await levelOf(monitorId)).toBeNull();
      expect(await signalsOf(monitorId)).toEqual([]);
    }, 120_000);

    it("opens on the first session P/E is below 9, holds through withheld sessions and a split-sized quote, and resolves above it", async () => {
      const monitorId = await createMonitor(full);
      await only(monitorId);

      // 2024-03-14: 8.93 < 9, after 9.08 the session before (the reconstruction's last session).
      await cycleOn("2024-03-14", closes.get("2024-03-14")!);
      let level = await levelOf(monitorId);
      expect(level?.lastOutcome).toBe("MATCHED");
      expect(level?.lifecycleState).toBe("ACTIVE");
      let signals = await signalsOf(monitorId);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.resolvedAt).toBeNull();
      expect(signals[0]?.observationDate.toISOString().slice(0, 10)).toBe(
        "2024-03-14",
      );

      // A split-sized quote the next session: not evaluable, the Signal held.
      await cycleOn("2024-03-15", closes.get("2024-03-14")! * 0.5);
      level = await levelOf(monitorId);
      expect(level?.lastOutcome).toBe("NOT_EVALUABLE");
      expect(level?.lifecycleState).toBe("ACTIVE");

      // 2024-09-16 (the measured split's date) and 2024-11-08 (a count still settling): withheld.
      for (const session of ["2024-09-16", "2024-11-08"]) {
        await cycleOn(session, closes.get(session)!);
        level = await levelOf(monitorId);
        expect(level?.lastOutcome, session).toBe("NOT_EVALUABLE");
        expect(level?.lifecycleState, session).toBe("ACTIVE");
      }
      signals = await signalsOf(monitorId);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.resolvedAt).toBeNull();

      // 2024-11-19: 12.10, no longer below 9 — the one occurrence ends.
      await cycleOn("2024-11-19", closes.get("2024-11-19")!);
      level = await levelOf(monitorId);
      expect(level?.lastOutcome).toBe("NOT_MATCHED");
      expect(level?.lifecycleState).toBe("RESOLVED");
      signals = await signalsOf(monitorId);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.resolvedAt).not.toBeNull();
    }, 240_000);

    it("reads the newest closed session's statements on a new session, and agrees with the backtest from the next observation", async () => {
      // Stored history ends 2024-11-08, inside the withheld stretch. On 2024-11-11 2024Q3's statements
      // become public, but the provisional observation reads 2024-11-08's: still withheld (rule 5),
      // although the closed 2024-11-11 reading is 11.36 — never the future statement.
      const monitorId = await createMonitor(truncated);
      await only(monitorId);
      const summary = await cycleOn("2024-11-11", closes.get("2024-11-11")!);
      expect(summary).toMatchObject({
        evaluations: 1,
        notEvaluable: 1,
        signalsEmitted: 0,
      });
      expect(await levelOf(monitorId)).toBeNull();
      expect(await signalsOf(monitorId)).toEqual([]);

      // With the history stored through 2024-11-11, the next session's provisional observation reads
      // 2024-11-11's statements: 11.50 at 56.45, decided — and, at 11 and above, not below 9.
      const nextMonitorId = await createMonitor(refreshed);
      await only(nextMonitorId);
      await cycleOn("2024-11-12", closes.get("2024-11-12")!);
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
      await service.prepareMonitorEvaluationData(
        full,
        300,
        "2024-03-14",
        operands,
      );
      await service.prepareDailyEvaluationData(full, range, operands);
      try {
        racing = true;
        expect(
          await service.readMonitorEvaluationFrame({
            security: full,
            operands,
            observations: 300,
            asOf: "2024-03-14",
            observation: { price: closes.get("2024-03-14")! },
            observationDate: "2024-03-14",
          }),
        ).toBeNull();
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
