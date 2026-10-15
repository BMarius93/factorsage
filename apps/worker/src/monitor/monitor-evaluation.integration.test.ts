import { randomUUID } from "node:crypto";
import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { DailyPrice, Security } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalStockDataService,
  EodFinalityPolicy,
  InMemoryLoadCoordinator,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  WEEKDAY_TRADING_CALENDAR,
  createStockDataRedisClient,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MonitorEodEvaluation,
  type MonitorEvaluationData,
} from "./monitor-evaluation.js";
import {
  PrismaMonitorRepository,
  type MonitorEvaluationRepository,
} from "./monitor-repository.js";
import { weekdaySessions } from "../shared/etf-context.test-helper.js";

/**
 * The Monitor EOD evaluation against PostgreSQL, through the real canonical stock service's
 * provider-free reads (`docs/decisions/monitor-eod-v2.md` §3).
 *
 * Bars are seeded as the stock EOD child would leave them — stored, with the recent-tail watermark
 * proving a read after the session became final, and derived rows materialized — so readiness, the
 * frame, the lifecycle and the atomic member write all run as in production. What these cases prove
 * is what only the real store can: one transaction per member, checkpoints that make a pass
 * idempotent and catch missed sessions up in order, honest waiting for data and dependencies, the
 * binding fence, and origins that never present a paused Monitor's gap as newly observed.
 */

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() ||
  process.env.REDIS_URL?.trim() ||
  "redis://localhost:6379";

const EMA = "EMA_50D";

/** After the close plus the publication delay of `date` (EDT). */
const after = (date: string) => new Date(`${date}T22:00:00.000Z`);

function signalAbove(id = "c1"): StrategySignal {
  return {
    conditions: [
      {
        id,
        metric: { kind: "PRICE" },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: EMA },
      },
    ],
  };
}

function signalCrosses(): StrategySignal {
  return {
    conditions: [],
    trigger: {
      id: "t1",
      metric: { kind: "PRICE" },
      operator: "CROSSES_ABOVE",
      value: { kind: "SERIES", seriesId: EMA },
    },
  };
}

function definitionOf(signal: StrategySignal): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "buy-1", percentage: 100, signal }],
    sellLevels: [],
  } as StrategyDefinition;
}

describe("the Monitor EOD evaluation on PostgreSQL", () => {
  const prisma = new PrismaClient();
  const store = new PrismaStockDataStore(prisma);
  const redis = createStockDataRedisClient(redisUrl);
  const namespace = `stock-data:v2:test:monitor-eod:${randomUUID()}`;
  const clock = { now: after("2026-10-14") };
  const service = new CanonicalStockDataService(
    store,
    {
      async getProfile() {
        throw new Error("The evaluation must never reach the provider");
      },
      async getDailyPrices() {
        throw new Error("The evaluation must never reach the provider");
      },
      async getFinancialStatements() {
        throw new Error("The evaluation must never reach the provider");
      },
    },
    new RedisStockDataCache(new IoredisCacheClient(redis), 10, namespace),
    new InMemoryLoadCoordinator(),
    { productHistoryYears: 30, now: () => clock.now },
  );
  const data: MonitorEvaluationData = {
    findSecurities: (ids) => service.findSecuritiesByIds(ids),
    stockRefreshState: (security) => service.stockRefreshState(security),
    readFinalizedEvaluationFrame: (security, range, operands) =>
      service.readFinalizedEvaluationFrame(security, range, operands),
    reconstructionHistoryStart: (security) =>
      service.evaluationHistoryStart(security),
  };
  const securityIds: string[] = [];
  const systemRows: {
    monitorId: string;
    strategyId: string;
    stockListId: string;
  }[] = [];
  /** Monitors this file treats as running; `owned` is every Monitor it ever created. */
  const created = new Set<string>();
  const owned = new Set<string>();
  const real = new PrismaMonitorRepository(prisma);

  /** The real repository, scoped to this file's Monitors: other suites share the database. */
  const repository: MonitorEvaluationRepository = {
    listActiveMonitors: async () =>
      (await real.listActiveMonitors()).filter((m) => created.has(m.monitorId)),
    loadSignalStates: (id) => real.loadSignalStates(id),
    loadCheckpoints: (id) => real.loadCheckpoints(id),
    resolveUnvisitedStates: (input) => real.resolveUnvisitedStates(input),
    pruneCheckpoints: (input) => real.pruneCheckpoints(input),
    markScanned: (monitors, now) => real.markScanned(monitors, now),
    applyMemberEvaluation: (write) => real.applyMemberEvaluation(write),
    fixReplayWindow: (input) => real.fixReplayWindow(input),
    async markWatching(running, now) {
      await prisma.monitor.updateMany({
        where: { id: { in: [...owned].filter((id) => !running.includes(id)) } },
        data: { watchingSince: null },
      });
      await prisma.monitor.updateMany({
        where: { id: { in: [...running] }, watchingSince: null },
        data: { watchingSince: now },
      });
      const rows = await prisma.monitor.findMany({
        where: { id: { in: [...running] } },
        select: { id: true, watchingSince: true },
      });
      return new Map(rows.map((row) => [row.id, row.watchingSince ?? now]));
    },
  };

  function evaluation(lateRecoveryMs = 24 * 60 * 60 * 1000) {
    return new MonitorEodEvaluation(
      repository,
      data,
      new EodFinalityPolicy({
        calendar: WEEKDAY_TRADING_CALENDAR,
        now: () => clock.now,
      }),
      createLogger({ service: "worker", level: "silent" }),
      { securityConcurrency: 2, lateRecoveryMs, now: () => clock.now },
    );
  }

  afterAll(async () => {
    for (const row of systemRows) {
      await prisma.monitor.deleteMany({ where: { id: row.monitorId } });
      await prisma.stockList.deleteMany({ where: { id: row.stockListId } });
      await prisma.strategy.deleteMany({ where: { id: row.strategyId } });
    }
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    const keys = await redis.keys(`${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await prisma.$disconnect();
    await redis.quit();
  });

  beforeEach(() => {
    created.clear();
    clock.now = after("2026-10-14");
  });

  async function createSecurity(listed = "2026-09-01"): Promise<Security> {
    const symbol = `MEV${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
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
        ipoDate: new Date(`${listed}T00:00:00.000Z`),
      },
    });
    securityIds.push(row.id);
    return (await service.findSecuritiesByIds([row.id]))[0]!;
  }

  /**
   * Stores bars as the stock EOD child leaves them: prices, coverage from the listing, derived rows
   * materialized with `ema50d = 100`, and a tail watermark read at `readAt` through `through`.
   */
  async function seed(
    security: Security,
    closes: Record<string, number>,
    readAt: Date,
    through: string,
    coverageFrom = "2026-09-01",
  ) {
    const dates = Object.keys(closes).sort();
    const prices: DailyPrice[] = dates.map((date) => ({
      securityId: security.id,
      date,
      open: closes[date]!,
      high: closes[date]!,
      low: closes[date]!,
      close: closes[date]!,
      volume: 1_000,
    }));
    await store.saveDailyPriceSync({
      securityId: security.id,
      prices,
      successfulCoverage: [{ from: coverageFrom, to: through }],
      syncedAt: readAt.toISOString(),
      tailDate: through,
      freshThrough: through,
    });
    await store.saveDailyDerivedState({
      securityId: security.id,
      rows: dates.map((date) => ({
        securityId: security.id,
        date,
        ema50d: 100,
      })),
      weeklyPrices: [],
      successfulCoverage: { from: coverageFrom, to: through },
      syncedAt: readAt.toISOString(),
    });
  }

  async function createMonitor(
    securities: readonly Security[],
    signal: StrategySignal,
    options: { replay?: boolean; listedAt?: Date } = {},
  ): Promise<string> {
    const key = randomUUID();
    const strategy = await prisma.strategy.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `test-strategy-${key}`,
        name: "EOD strategy",
        versions: {
          create: {
            versionNumber: 1,
            definition: definitionOf(signal) as never,
            definitionHash: randomUUID(),
          },
        },
      },
    });
    const stockList = await prisma.stockList.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `test-list-${key}`,
        name: "EOD list",
        items: {
          create: securities.map((security) => ({
            securityId: security.id,
            ...(options.listedAt ? { createdAt: options.listedAt } : {}),
          })),
        },
      },
    });
    const monitor = await prisma.monitor.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `test-monitor-${key}`,
        name: "EOD monitor",
        strategyId: strategy.id,
        stockListId: stockList.id,
        ...(options.replay ? { initialReplayRequested: true } : {}),
      },
    });
    systemRows.push({
      monitorId: monitor.id,
      strategyId: strategy.id,
      stockListId: stockList.id,
    });
    created.add(monitor.id);
    owned.add(monitor.id);
    return monitor.id;
  }

  async function signals(monitorId: string) {
    return prisma.monitorSignal.findMany({
      where: { monitorId },
      orderBy: [{ observationDate: "asc" }, { detectedAt: "asc" }],
    });
  }

  async function transitions(monitorId: string) {
    return prisma.monitorStateTransition.findMany({
      where: { monitorId },
      orderBy: { sequence: "asc" },
    });
  }

  async function checkpoint(monitorId: string, securityId: string) {
    return prisma.monitorEvaluationCheckpoint.findUnique({
      where: { monitorId_securityId: { monitorId, securityId } },
    });
  }

  const day = (value: Date | null | undefined) =>
    value?.toISOString().slice(0, 10);

  /** Rewrites one member's List membership, as an edit through the Lists API would leave it. */
  async function setMembership(
    monitorId: string,
    security: Security,
    windows: readonly { start: string; end: string | null }[] | "FULL",
  ) {
    const monitor = await prisma.monitor.findUniqueOrThrow({
      where: { id: monitorId },
      select: { stockListId: true },
    });
    const item = await prisma.stockListItem.findUniqueOrThrow({
      where: {
        stockListId_securityId: {
          stockListId: monitor.stockListId,
          securityId: security.id,
        },
      },
    });
    await prisma.stockListBuyWindow.deleteMany({
      where: { stockListItemId: item.id },
    });
    await prisma.stockListItem.update({
      where: { id: item.id },
      data: {
        buyWindowMode: windows === "FULL" ? "FULL" : "CUSTOM",
        ...(windows === "FULL"
          ? {}
          : {
              buyWindows: {
                create: windows.map((window) => ({
                  startDate: new Date(`${window.start}T00:00:00.000Z`),
                  endDate: window.end
                    ? new Date(`${window.end}T00:00:00.000Z`)
                    : null,
                })),
              },
            }),
      },
    });
  }

  it("reconstructs a new Monitor at the newest finalized session, on the EOD close, idempotently", async () => {
    const security = await createSecurity();
    await seed(
      security,
      {
        "2026-10-09": 90,
        "2026-10-12": 101,
        "2026-10-13": 102,
        "2026-10-14": 103,
      },
      after("2026-10-14"),
      "2026-10-14",
    );
    const monitorId = await createMonitor([security], signalAbove());

    const first = await evaluation().run(1);
    expect(first.expectedSession).toBe("2026-10-14");
    expect(first.levelsReconstructed).toBe(1);
    const opened = await signals(monitorId);
    expect(opened).toHaveLength(1);
    expect(day(opened[0]!.observationDate)).toBe("2026-10-12");
    expect(Number(opened[0]!.observationPrice)).toBe(101);
    expect(opened[0]!.observationBasis).toBe("EOD_CLOSE");
    expect(opened[0]!.reconstructed).toBe(true);
    expect(
      (await transitions(monitorId)).map((t) => [t.reason, t.origin]),
    ).toEqual([["RECONSTRUCTED", "HISTORY"]]);
    expect(
      day((await checkpoint(monitorId, security.id))?.evaluatedThrough),
    ).toBe("2026-10-14");

    // The same session again: nothing is written twice.
    const second = await evaluation().run(2);
    expect(second.sessionsEvaluated).toBe(0);
    expect(await signals(monitorId)).toHaveLength(1);
    expect(await transitions(monitorId)).toHaveLength(1);
  });

  it("catches missed sessions up in order after an outage, recording each change on its own session", async () => {
    const security = await createSecurity();
    await seed(
      security,
      { "2026-10-08": 90, "2026-10-09": 90 },
      after("2026-10-09"),
      "2026-10-09",
    );
    clock.now = after("2026-10-09");
    const monitorId = await createMonitor([security], signalCrosses());
    await evaluation().run(1);
    expect(await signals(monitorId)).toHaveLength(0);

    // The worker was down Monday to Wednesday. Tuesday's crossing must not be lost on the way.
    await seed(
      security,
      { "2026-10-12": 95, "2026-10-13": 105, "2026-10-14": 104 },
      after("2026-10-14"),
      "2026-10-14",
    );
    clock.now = after("2026-10-14");
    const summary = await evaluation().run(2);
    expect(summary.sessionsEvaluated).toBe(3);
    const rows = await transitions(monitorId);
    expect(
      rows.map((t) => [day(t.observationDate), t.reason, t.origin]),
    ).toEqual([
      ["2026-10-13", "TRIGGER_FIRED", "OBSERVED"],
      ["2026-10-14", "EVENT_SESSION_ENDED", "OBSERVED"],
    ]);
    const occurrence = (await signals(monitorId))[0]!;
    expect(day(occurrence.observationDate)).toBe("2026-10-13");
    expect(day(occurrence.resolvedObservationDate)).toBe("2026-10-14");
    expect(occurrence.resolutionReason).toBe("EVENT_SESSION_ENDED");
    // Each change records the version that decided it and what it read on its own session.
    expect(rows[0]!.strategyVersionId).toBe(occurrence.strategyVersionId);
    expect(rows[0]!.evidence).toEqual({
      v: 1,
      rules: [
        {
          ruleId: "buy-1",
          predicates: [
            {
              id: "t1",
              role: "TRIGGER",
              result: "TRUE",
              metric: 105,
              value: 100,
              previousMetric: 95,
              previousValue: 100,
            },
          ],
        },
      ],
    });
  });

  it("waits at its checkpoint while the newest bar is not proven final, and never resolves on missing data", async () => {
    const security = await createSecurity();
    await seed(
      security,
      { "2026-10-12": 101, "2026-10-13": 102 },
      after("2026-10-13"),
      "2026-10-13",
    );
    clock.now = after("2026-10-13");
    const monitorId = await createMonitor([security], signalAbove());
    await evaluation().run(1);
    expect((await signals(monitorId))[0]?.resolvedAt).toBeNull();

    // Wednesday is final by the clock, but no read since proves its bar: the member waits.
    clock.now = after("2026-10-14");
    const summary = await evaluation().run(2);
    expect(summary.membersCurrent).toBe(0);
    expect(
      day((await checkpoint(monitorId, security.id))?.evaluatedThrough),
    ).toBe("2026-10-13");
    expect((await signals(monitorId))[0]?.resolvedAt).toBeNull();
  });

  it("does not present a paused Monitor's gap as newly observed when it is switched back on", async () => {
    const security = await createSecurity();
    await seed(
      security,
      { "2026-10-08": 90 },
      after("2026-10-08"),
      "2026-10-08",
    );
    clock.now = after("2026-10-08");
    const monitorId = await createMonitor([security], signalAbove());
    await evaluation().run(1);

    // Paused: not running while three sessions finalize.
    created.delete(monitorId);
    clock.now = after("2026-10-12");
    await evaluation().run(2);
    expect(
      (await prisma.monitor.findUnique({ where: { id: monitorId } }))
        ?.watchingSince,
    ).toBeNull();
    await seed(
      security,
      { "2026-10-09": 101, "2026-10-12": 90, "2026-10-13": 102 },
      after("2026-10-13"),
      "2026-10-13",
    );

    // Back on Wednesday morning: Thursday-to-Tuesday is caught up as history, Wednesday is observed.
    created.add(monitorId);
    clock.now = new Date("2026-10-14T13:00:00.000Z");
    await evaluation().run(3);
    await seed(
      security,
      { "2026-10-14": 103 },
      after("2026-10-14"),
      "2026-10-14",
    );
    clock.now = after("2026-10-14");
    await evaluation().run(4);
    expect(
      (await transitions(monitorId)).map((t) => [
        day(t.observationDate),
        t.reason,
        t.origin,
      ]),
    ).toEqual([
      ["2026-10-09", "CONDITIONS_MET", "HISTORY"],
      ["2026-10-12", "CONDITIONS_ENDED", "HISTORY"],
      ["2026-10-13", "CONDITIONS_MET", "HISTORY"],
    ]);
  });

  it("writes nothing for a Monitor rebound while the pass evaluated it", async () => {
    const security = await createSecurity();
    await seed(
      security,
      { "2026-10-13": 90, "2026-10-14": 101 },
      after("2026-10-14"),
      "2026-10-14",
    );
    const monitorId = await createMonitor([security], signalAbove());
    const stale: MonitorEvaluationRepository = {
      ...repository,
      listActiveMonitors: async () => {
        const monitors = await repository.listActiveMonitors();
        await prisma.monitor.update({
          where: { id: monitorId },
          data: { configVersion: { increment: 1 } },
        });
        return monitors;
      },
    };
    const summary = await new MonitorEodEvaluation(
      stale,
      data,
      new EodFinalityPolicy({
        calendar: WEEKDAY_TRADING_CALENDAR,
        now: () => clock.now,
      }),
      createLogger({ service: "worker", level: "silent" }),
      {
        securityConcurrency: 2,
        lateRecoveryMs: 86_400_000,
        now: () => clock.now,
      },
    ).run(1);
    expect(summary.staleConfiguration).toBe(1);
    expect(await signals(monitorId)).toHaveLength(0);
    expect(await checkpoint(monitorId, security.id)).toBeNull();
  });

  it("decides each session once even when two passes overlap", async () => {
    const security = await createSecurity();
    await seed(
      security,
      { "2026-10-13": 90, "2026-10-14": 101 },
      after("2026-10-14"),
      "2026-10-14",
    );
    const monitorId = await createMonitor([security], signalAbove());
    const [left, right] = await Promise.all([
      evaluation().run(1),
      evaluation().run(2),
    ]);
    expect(left.contended + right.contended).toBeLessThanOrEqual(1);
    expect(await signals(monitorId)).toHaveLength(1);
    expect((await transitions(monitorId)).length).toBe(1);
  });

  it("closes a removed member's occurrence administratively and forgets its progress", async () => {
    const kept = await createSecurity();
    const removed = await createSecurity();
    for (const security of [kept, removed]) {
      await seed(
        security,
        { "2026-10-13": 90, "2026-10-14": 101 },
        after("2026-10-14"),
        "2026-10-14",
      );
    }
    const monitorId = await createMonitor([kept, removed], signalAbove());
    await evaluation().run(1);
    expect(await signals(monitorId)).toHaveLength(2);

    const monitor = await prisma.monitor.findUniqueOrThrow({
      where: { id: monitorId },
    });
    await prisma.stockListItem.deleteMany({
      where: { stockListId: monitor.stockListId, securityId: removed.id },
    });
    await evaluation().run(2);
    const closed = (await signals(monitorId)).find(
      (s) => s.securityId === removed.id,
    )!;
    expect(closed.resolutionReason).toBe("MEMBER_REMOVED");
    const last = (await transitions(monitorId)).at(-1)!;
    expect([last.reason, last.origin]).toEqual([
      "MEMBER_REMOVED",
      "ADMINISTRATIVE",
    ]);
    expect(await checkpoint(monitorId, removed.id)).toBeNull();
    expect(await checkpoint(monitorId, kept.id)).not.toBeNull();
  });

  it("evaluates a pre-EOD state from its newest session only, then catches up from there", async () => {
    const security = await createSecurity();
    await seed(
      security,
      { "2026-10-12": 101, "2026-10-13": 102, "2026-10-14": 90 },
      after("2026-10-14"),
      "2026-10-14",
    );
    const monitorId = await createMonitor([security], signalAbove());
    // A V1 occurrence opened on a live quote, with no checkpoint.
    const v1 = await prisma.monitorSignal.create({
      data: {
        monitorId,
        securityId: security.id,
        levelId: "buy-1",
        levelKind: "BUY",
        strategyVersionId: "v1",
        hasTrigger: false,
        observationDate: new Date("2026-10-13T00:00:00.000Z"),
        observationPrice: 101.7,
        observationBasis: "LIVE_QUOTE",
      },
    });
    const levels = (
      await prisma.strategyVersion.findFirstOrThrow({
        where: { strategy: { monitors: { some: { id: monitorId } } } },
      })
    ).definition;
    const { monitorStrategyLevels } = await import("@intrinsic/strategy");
    const fingerprint = monitorStrategyLevels(levels as StrategyDefinition)[0]!
      .fingerprint;
    await prisma.monitorSignalState.create({
      data: {
        monitorId,
        securityId: security.id,
        levelId: "buy-1",
        levelKind: "BUY",
        signalFingerprint: fingerprint,
        lastEvaluableResult: "MATCHED",
        lastEvaluableDate: new Date("2026-10-13T00:00:00.000Z"),
        lastEvaluableAt: new Date(),
        lastOutcome: "MATCHED",
        lastOutcomeAt: new Date(),
        activeSignalId: v1.id,
        lifecycleState: "ACTIVE",
        lifecycleSinceDate: new Date("2026-10-13T00:00:00.000Z"),
        ruleStates: {
          "buy-1": { state: "ACTIVE", since: "2026-10-13", triggerDate: null },
        },
      },
    });

    await evaluation().run(1);
    const rows = await signals(monitorId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observationBasis).toBe("LIVE_QUOTE");
    expect(Number(rows[0]!.observationPrice)).toBe(101.7);
    expect(rows[0]!.resolutionReason).toBe("CONDITIONS_ENDED");
    expect(day(rows[0]!.resolvedObservationDate)).toBe("2026-10-14");
  });

  describe("a rule that reads an ETF", () => {
    const etfThrough = { date: "2026-10-13" };
    const etfContexts = {
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
        readFullBenchmarkHistory: async () => {
          const rows = [];
          let index = 0;
          for (
            let cursor = new Date("2026-06-01T00:00:00.000Z");
            cursor.toISOString().slice(0, 10) <= etfThrough.date;
            cursor.setUTCDate(cursor.getUTCDate() + 1)
          ) {
            const weekday = cursor.getUTCDay();
            if (weekday === 0 || weekday === 6) continue;
            const close = 50 + index * 0.1;
            index += 1;
            rows.push({
              seriesId: "series-xlk",
              date: cursor.toISOString().slice(0, 10),
              open: close,
              high: close,
              low: close,
              close,
              volume: 1_000_000,
            });
          }
          return {
            seriesId: "series-xlk",
            basisGeneration: 0,
            rows,
            missing: [],
            source: "POSTGRESQL" as const,
          };
        },
        benchmarkRefreshState: async () => ({
          coverageEnd: etfThrough.date,
          latestBar: etfThrough.date,
          lastTailSyncAt: after(etfThrough.date).toISOString(),
        }),
        missingBenchmarkCoverage: async () => [],
      },
      resolveSeriesId: async () => "series-xlk",
      publicationDelayMs: 30 * 60_000,
      isScheduledSession: weekdaySessions,
    };
    const both: StrategySignal = {
      conditions: [
        signalAbove().conditions[0]!,
        {
          id: "c-xlk",
          metric: { kind: "PRICE", source: { kind: "ETF", code: "ETF_XLK" } },
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "SMA_20D" },
        },
      ],
    };

    it("waits for the ETF's own session, never carrying its older bar onto the stock's newest", async () => {
      const security = await createSecurity();
      await seed(
        security,
        { "2026-10-12": 101, "2026-10-13": 102, "2026-10-14": 103 },
        after("2026-10-14"),
        "2026-10-14",
      );
      const monitorId = await createMonitor([security], both);
      const run = (giveUpMs: number) =>
        new MonitorEodEvaluation(
          repository,
          data,
          new EodFinalityPolicy({
            calendar: WEEKDAY_TRADING_CALENDAR,
            now: () => clock.now,
          }),
          createLogger({ service: "worker", level: "silent" }),
          {
            securityConcurrency: 2,
            lateRecoveryMs: giveUpMs,
            now: () => clock.now,
          },
          etfContexts as never,
        ).run(1);

      // The stock is final through Wednesday; XLK only through Tuesday: decided through Tuesday.
      const waiting = await run(24 * 60 * 60_000);
      expect(waiting.membersAwaitingEtf).toBe(1);
      expect(
        day((await checkpoint(monitorId, security.id))?.evaluatedThrough),
      ).toBe("2026-10-13");
      const opened = await signals(monitorId);
      expect(opened).toHaveLength(1);
      expect(opened[0]!.resolvedAt).toBeNull();

      // Past the give-up bound Wednesday is decided without XLK: its rule is NOT_EVALUABLE, which
      // moves nothing — the occurrence stays open, it is not resolved by a missing input.
      const abandoned = await run(60 * 60_000);
      expect(abandoned.membersAwaitingEtf).toBe(0);
      expect(
        day((await checkpoint(monitorId, security.id))?.evaluatedThrough),
      ).toBe("2026-10-14");
      const after2 = await signals(monitorId);
      expect(after2).toHaveLength(1);
      expect(after2[0]!.resolvedAt).toBeNull();
    });
  });

  it("passes a session a halted security never prints only once a read past the late-recovery horizon proves it", async () => {
    const security = await createSecurity();
    const closes = { "2026-10-14": 90, "2026-10-15": 101 };
    // Thursday printed; Friday was asked for on Friday evening and not printed (yet).
    await seed(security, closes, after("2026-10-16"), "2026-10-16");
    clock.now = after("2026-10-15");
    const monitorId = await createMonitor([security], signalCrosses());
    await evaluation().run(1);
    expect(
      day((await checkpoint(monitorId, security.id))?.evaluatedThrough),
    ).toBe("2026-10-15");
    const event = (await signals(monitorId))[0]!;
    expect(event.resolvedAt).toBeNull();

    // Saturday evening, a day after Friday became final — but the only read is Friday evening's,
    // which proves nothing about a late publication: the member is not moved past Friday.
    clock.now = new Date("2026-10-17T21:00:00.000Z");
    await evaluation().run(2);
    expect(
      day((await checkpoint(monitorId, security.id))?.evaluatedThrough),
    ).toBe("2026-10-15");

    // A read issued more than the horizon after Friday's finalization still finds no Friday bar:
    // Friday was genuinely not printed, so the member moves to it — and the Thursday event is not
    // ended, only a real later session ends it.
    await seed(
      security,
      closes,
      new Date("2026-10-17T21:00:00.000Z"),
      "2026-10-16",
    );
    await evaluation().run(3);
    expect(
      day((await checkpoint(monitorId, security.id))?.evaluatedThrough),
    ).toBe("2026-10-16");
    expect((await signals(monitorId))[0]!.resolvedAt).toBeNull();
  });

  it("treats a checkpoint from another binding as no progress, and replaces it rather than stalling", async () => {
    const security = await createSecurity();
    await seed(
      security,
      { "2026-10-12": 90, "2026-10-13": 101, "2026-10-14": 102 },
      after("2026-10-14"),
      "2026-10-14",
    );
    const monitorId = await createMonitor([security], signalAbove());
    // A row the configuration boundary should have deleted: an older binding's progress.
    await prisma.monitorEvaluationCheckpoint.create({
      data: {
        monitorId,
        securityId: security.id,
        evaluatedThrough: new Date("2026-10-12T00:00:00.000Z"),
        configVersion: 41,
        basisGeneration: 0,
      },
    });

    const summary = await evaluation().run(1);
    expect(summary.contended).toBe(0);
    expect(summary.levelsReconstructed).toBe(1);
    const row = await checkpoint(monitorId, security.id);
    expect(day(row?.evaluatedThrough)).toBe("2026-10-14");
    expect(row?.configVersion).toBe(0);
    // Reconstructed at the newest session, not caught up from the foreign checkpoint.
    expect(
      (await transitions(monitorId)).map((t) => [t.reason, t.origin]),
    ).toEqual([["RECONSTRUCTED", "HISTORY"]]);
  });

  describe("ongoing List membership", () => {
    it("ends a member whose membership stopped being ongoing as a membership change, never a market one", async () => {
      const security = await createSecurity();
      await seed(
        security,
        { "2026-10-12": 90, "2026-10-13": 101, "2026-10-14": 102 },
        after("2026-10-14"),
        "2026-10-14",
      );
      const monitorId = await createMonitor([security], signalAbove());
      await evaluation().run(1);
      expect((await signals(monitorId))[0]!.resolvedAt).toBeNull();

      // Edited to a bounded period — even one ending in the future is not a current membership.
      await setMembership(monitorId, security, [
        { start: "2026-01-02", end: "2026-12-31" },
      ]);
      const summary = await evaluation().run(2);
      expect(summary.members).toBe(0);
      expect(summary.membersNotCurrent).toBe(1);
      const ended = (await signals(monitorId))[0]!;
      expect(ended.resolutionReason).toBe("MEMBERSHIP_CHANGED");
      expect(ended.resolvedObservationDate).toBeNull();
      expect(
        (await transitions(monitorId)).map((t) => [t.reason, t.origin]),
      ).toEqual([
        ["RECONSTRUCTED", "HISTORY"],
        ["MEMBERSHIP_CHANGED", "ADMINISTRATIVE"],
      ]);
      expect(
        await prisma.monitorSignalState.count({ where: { monitorId } }),
      ).toBe(0);
      expect(await checkpoint(monitorId, security.id)).toBeNull();

      // Not evaluated again while it is not a current member: nothing new is written.
      await evaluation().run(3);
      expect(await signals(monitorId)).toHaveLength(1);
      expect(await transitions(monitorId)).toHaveLength(2);
    });

    it("waits for an open-ended membership to begin, then rebuilds from its first session only", async () => {
      const security = await createSecurity();
      await seed(
        security,
        { "2026-10-12": 101, "2026-10-13": 101, "2026-10-14": 101 },
        after("2026-10-14"),
        "2026-10-14",
      );
      const monitorId = await createMonitor([security], signalAbove());
      await setMembership(monitorId, security, [
        { start: "2026-01-02", end: "2026-06-30" },
        { start: "2026-10-15", end: null },
      ]);

      // Wednesday evening: the membership begins Thursday. Not evaluated, nothing recorded.
      const before = await evaluation().run(1);
      expect(before.membersNotCurrent).toBe(1);
      expect(await signals(monitorId)).toHaveLength(0);
      expect(await checkpoint(monitorId, security.id)).toBeNull();

      // Thursday is final: the price has held above its average all week, but the occurrence
      // begins on the membership's first session — the closed period earlier in the year and the
      // sessions before Thursday play no part.
      await seed(
        security,
        { "2026-10-15": 101 },
        after("2026-10-15"),
        "2026-10-15",
      );
      clock.now = after("2026-10-15");
      const started = await evaluation().run(2);
      expect(started.members).toBe(1);
      const opened = await signals(monitorId);
      expect(opened).toHaveLength(1);
      expect(day(opened[0]!.observationDate)).toBe("2026-10-15");
      const row = await checkpoint(monitorId, security.id);
      expect(day(row?.membershipStart)).toBe("2026-10-15");
      expect(row?.membershipRecorded).toBe(true);
    });

    it("rebuilds a re-entered member from its new membership, ending the old one administratively", async () => {
      const security = await createSecurity();
      await seed(
        security,
        {
          "2026-10-08": 90,
          "2026-10-09": 101,
          "2026-10-12": 101,
          "2026-10-13": 101,
          "2026-10-14": 101,
        },
        after("2026-10-14"),
        "2026-10-14",
      );
      const monitorId = await createMonitor([security], signalAbove());
      await evaluation().run(1);
      const first = (await signals(monitorId))[0]!;
      expect(day(first.observationDate)).toBe("2026-10-09");
      const recorded = await checkpoint(monitorId, security.id);
      expect(recorded?.membershipRecorded).toBe(true);
      expect(recorded?.membershipStart).toBeNull();

      // Left the List's membership on Friday and re-entered on Tuesday.
      await setMembership(monitorId, security, [
        { start: "2026-01-02", end: "2026-10-09" },
        { start: "2026-10-13", end: null },
      ]);
      const summary = await evaluation().run(2);
      expect(summary.membershipResets).toBe(1);
      const rows = await signals(monitorId);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe(first.id);
      expect(rows[0]!.resolutionReason).toBe("MEMBERSHIP_CHANGED");
      expect(day(rows[1]!.observationDate)).toBe("2026-10-13");
      expect(rows[1]!.resolvedAt).toBeNull();
      expect(
        (await transitions(monitorId)).map((t) => [
          day(t.observationDate) ?? null,
          t.reason,
          t.origin,
        ]),
      ).toEqual([
        ["2026-10-09", "RECONSTRUCTED", "HISTORY"],
        [null, "MEMBERSHIP_CHANGED", "ADMINISTRATIVE"],
        ["2026-10-13", "RECONSTRUCTED", "HISTORY"],
      ]);
      expect(
        day((await checkpoint(monitorId, security.id))?.membershipStart),
      ).toBe("2026-10-13");

      // Idempotent: the new membership is now the recorded one.
      await evaluation().run(3);
      expect(await signals(monitorId)).toHaveLength(2);
    });

    it("adopts progress recorded before memberships were, without resetting it", async () => {
      const security = await createSecurity();
      await seed(
        security,
        { "2026-10-12": 90, "2026-10-13": 101 },
        after("2026-10-13"),
        "2026-10-13",
      );
      clock.now = after("2026-10-13");
      const monitorId = await createMonitor([security], signalAbove());
      await evaluation().run(1);
      // As a row written by step 3 would be: no membership recorded.
      await prisma.monitorEvaluationCheckpoint.update({
        where: {
          monitorId_securityId: { monitorId, securityId: security.id },
        },
        data: { membershipRecorded: false, membershipStart: null },
      });
      await setMembership(monitorId, security, [
        { start: "2026-10-01", end: null },
      ]);
      await seed(
        security,
        { "2026-10-14": 102 },
        after("2026-10-14"),
        "2026-10-14",
      );
      clock.now = after("2026-10-14");
      const summary = await evaluation().run(2);
      expect(summary.membershipResets).toBe(0);
      expect(summary.sessionsEvaluated).toBe(1);
      expect(await signals(monitorId)).toHaveLength(1);
      expect(
        day((await checkpoint(monitorId, security.id))?.membershipStart),
      ).toBe("2026-10-01");
    });
  });

  describe("a new Monitor's initial replay", () => {
    /** Weekday closes from `from` through `to`, each `price(date)`. */
    function weekdays(
      from: string,
      to: string,
      price: (date: string) => number,
    ): Record<string, number> {
      const closes: Record<string, number> = {};
      for (
        let cursor = new Date(`${from}T00:00:00.000Z`);
        cursor.toISOString().slice(0, 10) <= to;
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      ) {
        const weekday = cursor.getUTCDay();
        if (weekday !== 0 && weekday !== 6) {
          const date = cursor.toISOString().slice(0, 10);
          closes[date] = price(date);
        }
      }
      return closes;
    }
    const listedAt = new Date("2026-10-01T12:00:00.000Z");

    it("records every change of its 90-day window on its own session, from the exact state before it", async () => {
      // Above its average since listing in March, below from Aug 21, above again from Sep 15.
      const security = await createSecurity("2026-03-02");
      await seed(
        security,
        weekdays("2026-03-02", "2026-10-14", (date) =>
          date >= "2026-08-21" && date < "2026-09-15" ? 95 : 105,
        ),
        after("2026-10-14"),
        "2026-10-14",
        "2026-03-02",
      );
      const monitorId = await createMonitor([security], signalAbove(), {
        replay: true,
        listedAt,
      });

      const summary = await evaluation().run(1);
      expect(summary.membersReplayed).toBe(1);
      const monitor = await prisma.monitor.findUniqueOrThrow({
        where: { id: monitorId },
      });
      // 90 calendar days ending at the newest finalized session.
      expect(day(monitor.replayWindowStart)).toBe("2026-07-17");

      const rows = await transitions(monitorId);
      expect(
        rows.map((t) => [day(t.observationDate), t.reason, t.origin]),
      ).toEqual([
        // Active since March: the window's cutoff does not reset what was latched before it.
        ["2026-03-02", "RECONSTRUCTED", "HISTORY"],
        ["2026-08-21", "CONDITIONS_ENDED", "HISTORY"],
        ["2026-09-15", "CONDITIONS_MET", "HISTORY"],
      ]);
      const ended = rows[1]!;
      expect(ended.evidence).toEqual({
        v: 1,
        rules: [
          {
            ruleId: "buy-1",
            predicates: [
              {
                id: "c1",
                role: "CONDITION",
                result: "FALSE",
                metric: 95,
                value: 100,
              },
            ],
          },
        ],
      });
      const occurrences = await signals(monitorId);
      expect(
        occurrences.map((signal) => [
          day(signal.observationDate),
          day(signal.resolvedObservationDate) ?? null,
          signal.resolutionReason,
          signal.reconstructed,
        ]),
      ).toEqual([
        ["2026-03-02", "2026-08-21", "CONDITIONS_ENDED", true],
        ["2026-09-15", null, null, true],
      ]);
      expect(rows.every((t) => t.strategyVersionId !== null)).toBe(true);

      // Idempotent: the window is replayed once.
      const again = await evaluation().run(2);
      expect(again.membersReplayed).toBe(0);
      expect(await transitions(monitorId)).toHaveLength(3);
      expect(await signals(monitorId)).toHaveLength(2);
    });

    it("starts a member's window at its listing when the security is younger than the window", async () => {
      const security = await createSecurity("2026-09-01");
      await seed(
        security,
        weekdays("2026-09-01", "2026-10-14", (date) =>
          date >= "2026-09-21" && date < "2026-10-05" ? 95 : 105,
        ),
        after("2026-10-14"),
        "2026-10-14",
      );
      const monitorId = await createMonitor([security], signalAbove(), {
        replay: true,
        listedAt,
      });
      await evaluation().run(1);
      expect(
        (await transitions(monitorId)).map((t) => [
          day(t.observationDate),
          t.reason,
        ]),
      ).toEqual([
        ["2026-09-01", "CONDITIONS_MET"],
        ["2026-09-21", "CONDITIONS_ENDED"],
        ["2026-10-05", "CONDITIONS_MET"],
      ]);
    });

    it("reconstructs, never replays, a member listed after the window was fixed", async () => {
      const first = await createSecurity("2026-09-01");
      const later = await createSecurity("2026-09-01");
      const closes = weekdays("2026-09-01", "2026-10-14", (date) =>
        date >= "2026-09-21" && date < "2026-10-05" ? 95 : 105,
      );
      await seed(first, closes, after("2026-10-14"), "2026-10-14");
      await seed(later, closes, after("2026-10-14"), "2026-10-14");
      const monitorId = await createMonitor([first], signalAbove(), {
        replay: true,
        listedAt,
      });
      await evaluation().run(1);
      const monitor = await prisma.monitor.findUniqueOrThrow({
        where: { id: monitorId },
      });
      await prisma.stockListItem.create({
        data: {
          stockListId: monitor.stockListId,
          securityId: later.id,
          createdAt: new Date(monitor.replayWindowFixedAt!.getTime() + 60_000),
        },
      });
      await evaluation().run(2);
      const added = (await transitions(monitorId)).filter(
        (t) => t.securityId === later.id,
      );
      expect(added.map((t) => [day(t.observationDate), t.reason])).toEqual([
        ["2026-10-05", "RECONSTRUCTED"],
      ]);
    });

    it("never replays a Monitor that did not ask for it", async () => {
      const security = await createSecurity("2026-09-01");
      await seed(
        security,
        weekdays("2026-09-01", "2026-10-14", (date) =>
          date >= "2026-09-21" && date < "2026-10-05" ? 95 : 105,
        ),
        after("2026-10-14"),
        "2026-10-14",
      );
      const monitorId = await createMonitor([security], signalAbove(), {
        listedAt,
      });
      const summary = await evaluation().run(1);
      expect(summary.membersReplayed).toBe(0);
      expect(
        (await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } }))
          .replayWindowStart,
      ).toBeNull();
      expect(await transitions(monitorId)).toHaveLength(1);
    });
  });

  it("finishes the members a crashed pass did not reach, without repeating the ones it did", async () => {
    const first = await createSecurity();
    const second = await createSecurity();
    for (const security of [first, second]) {
      await seed(
        security,
        { "2026-10-13": 90, "2026-10-14": 101 },
        after("2026-10-14"),
        "2026-10-14",
      );
    }
    const monitorId = await createMonitor([first, second], signalAbove());
    let applied = 0;
    const crashing: MonitorEvaluationRepository = {
      ...repository,
      applyMemberEvaluation: async (write) => {
        applied += 1;
        if (applied === 2) {
          throw new Error("process killed mid-pass");
        }
        return repository.applyMemberEvaluation(write);
      },
    };
    const crashed = await new MonitorEodEvaluation(
      crashing,
      data,
      new EodFinalityPolicy({
        calendar: WEEKDAY_TRADING_CALENDAR,
        now: () => clock.now,
      }),
      createLogger({ service: "worker", level: "silent" }),
      {
        securityConcurrency: 1,
        lateRecoveryMs: 86_400_000,
        now: () => clock.now,
      },
    ).run(1);
    expect(crashed.securitiesFailed).toBe(1);
    expect(await signals(monitorId)).toHaveLength(1);

    await evaluation().run(2);
    const rows = await signals(monitorId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.securityId))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(await transitions(monitorId)).toHaveLength(2);
  });
});
