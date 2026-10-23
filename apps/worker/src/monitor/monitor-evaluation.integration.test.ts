import { randomUUID } from "node:crypto";
import {
  monitorActivityWindowStart,
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
    loadLastRecordedSessions: (id) => real.loadLastRecordedSessions(id),
    resolveUnvisitedStates: (input) => real.resolveUnvisitedStates(input),
    pruneCheckpoints: (input) => real.pruneCheckpoints(input),
    markScanned: (monitors, now) => real.markScanned(monitors, now),
    applyMemberEvaluation: (write) => real.applyMemberEvaluation(write),
    // The schedule row is shared by every suite: this file's simulated clock never writes to it.
    recordExpectedSession: async () => {},
    loadMemberRecord: (monitorId, securityId) =>
      real.loadMemberRecord(monitorId, securityId),
    applyCoverageBackfill: (write) => real.applyCoverageBackfill(write),
    markCoverageBlocked: (input) => real.markCoverageBlocked(input),
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
            // Listed before every session the suite drives unless a case says otherwise: in
            // production a member is never listed after the clock its pass runs on.
            createdAt: options.listedAt ?? new Date("2000-01-03T00:00:00.000Z"),
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
        windowReplay: options.replay === true,
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
      // Passes share one fixed clock, so occurrences of one session can tie on `detectedAt`; an
      // occurrence resolved before another opened comes first, and `id` settles the rest — never
      // the rows' physical order, which an index or trigger on the table can change.
      orderBy: [
        { observationDate: "asc" },
        { detectedAt: "asc" },
        { resolvedAt: { sort: "asc", nulls: "last" } },
        { id: "asc" },
      ],
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

    /**
     * Pre-release audit 2026-10-16, finding MON-02 (`docs/audits/pre-release-audit-2026-10-16.md`).
     *
     * A snapshot that could not be **read** this pass is not an ETF that is behind: the bounded wait
     * applies only to a loaded snapshot whose newest session is older than the stock's. Treating a
     * failed read as "the fund did not print" steps every member older than the late-recovery horizon
     * — a new Monitor's replay, a resumed pause, an outage catch-up — through sessions decided with
     * the ETF rule NOT_EVALUABLE, and they are never decided again (failed on `bebf3dc7`). A member
     * reading an ETF that could not be read is now held, and replays once the ETF reads again —
     * exactly as a Monitor that never saw the failure.
     */
    it("MON-02: holds a replaying member while the ETF it reads cannot be loaded, then replays it as an uninterrupted Monitor does", async () => {
      const security = await createSecurity("2026-06-01");
      const closes: Record<string, number> = {};
      for (
        let cursor = new Date("2026-06-01T00:00:00.000Z");
        cursor.toISOString().slice(0, 10) <= "2026-10-14";
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      ) {
        const weekday = cursor.getUTCDay();
        if (weekday !== 0 && weekday !== 6) {
          closes[cursor.toISOString().slice(0, 10)] = 105;
        }
      }
      await seed(
        security,
        closes,
        after("2026-10-14"),
        "2026-10-14",
        "2026-06-01",
      );
      etfThrough.date = "2026-10-14";
      const monitorId = await createMonitor([security], both, {
        replay: true,
        listedAt: new Date("2026-10-01T12:00:00.000Z"),
      });
      const failing = {
        ...etfContexts,
        loader: {
          ...etfContexts.loader,
          readFullBenchmarkHistory: async () => {
            throw new Error("Redis timed out reading benchmark:v1:*");
          },
        },
      };
      const summary = await new MonitorEodEvaluation(
        repository,
        data,
        new EodFinalityPolicy({
          calendar: WEEKDAY_TRADING_CALENDAR,
          now: () => clock.now,
        }),
        createLogger({ service: "worker", level: "silent" }),
        {
          securityConcurrency: 2,
          lateRecoveryMs: 24 * 60 * 60_000,
          now: () => clock.now,
        },
        failing as never,
      ).run(1);
      // Nothing may be decided on a rule whose input could not be read.
      expect(summary.membersAwaitingEtf).toBe(1);
      expect(await checkpoint(monitorId, security.id)).toBeNull();
      expect(await transitions(monitorId)).toHaveLength(0);

      // Still unreadable a week later — far past the late-recovery horizon: still held.
      clock.now = after("2026-10-21");
      const later = await new MonitorEodEvaluation(
        repository,
        data,
        new EodFinalityPolicy({
          calendar: WEEKDAY_TRADING_CALENDAR,
          now: () => clock.now,
        }),
        createLogger({ service: "worker", level: "silent" }),
        {
          securityConcurrency: 2,
          lateRecoveryMs: 24 * 60 * 60_000,
          now: () => clock.now,
        },
        failing as never,
      ).run(2);
      expect(later.membersAwaitingEtf).toBe(1);
      expect(await transitions(monitorId)).toHaveLength(0);

      // The ETF reads again: the member replays its window once, as a control Monitor that never
      // saw the failure replays the same window on the same data.
      clock.now = after("2026-10-14");
      const working = () =>
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
            lateRecoveryMs: 24 * 60 * 60_000,
            now: () => clock.now,
          },
          etfContexts as never,
        );
      expect((await working().run(3)).membersReplayed).toBe(1);
      const control = await createMonitor([security], both, {
        replay: true,
        listedAt: new Date("2026-10-01T12:00:00.000Z"),
      });
      created.delete(monitorId);
      expect((await working().run(4)).membersReplayed).toBe(1);
      created.add(monitorId);
      const normalized = async (id: string) =>
        (await transitions(id)).map((t) =>
          [
            t.levelId,
            day(t.observationDate),
            t.fromState,
            t.toState,
            t.reason,
            t.origin,
          ].join("|"),
        );
      expect(await normalized(monitorId)).toEqual(await normalized(control));
      expect((await transitions(monitorId)).length).toBeGreaterThan(0);
      // And a further pass decides nothing twice.
      const settled = (await transitions(monitorId)).length;
      await working().run(5);
      expect(await transitions(monitorId)).toHaveLength(settled);
      etfThrough.date = "2026-10-13";
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

  describe("the rolling 30-day activity window (§12)", () => {
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
    /** Above its average since listing in March, below from Sep 21, above again from Oct 5. */
    const dipInWindow = (date: string) =>
      date >= "2026-09-21" && date < "2026-10-05" ? 95 : 105;

    function evaluationOn(
      calendar: {
        isTradingSession(exchange: string, date: string): Promise<boolean>;
      },
      lateRecoveryMs: number,
    ) {
      return new MonitorEodEvaluation(
        repository,
        data,
        new EodFinalityPolicy({ calendar, now: () => clock.now }),
        createLogger({ service: "worker", level: "silent" }),
        { securityConcurrency: 2, lateRecoveryMs, now: () => clock.now },
      );
    }

    it("records every change of its 30 calendar days on its own session, from the exact state before them", async () => {
      const security = await createSecurity("2026-03-02");
      await seed(
        security,
        weekdays("2026-03-02", "2026-10-14", dipInWindow),
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
      // 30 calendar days ending at the newest finalized session (Wed Oct 14): Sep 15 – Oct 14.
      expect(monitorActivityWindowStart(summary.expectedSession)).toBe(
        "2026-09-15",
      );

      const rows = await transitions(monitorId);
      expect(
        rows.map((t) => [day(t.observationDate), t.reason, t.origin]),
      ).toEqual([
        // Active since March: the window's cutoff does not reset what was latched before it.
        ["2026-03-02", "RECONSTRUCTED", "HISTORY"],
        ["2026-09-21", "CONDITIONS_ENDED", "HISTORY"],
        ["2026-10-05", "CONDITIONS_MET", "HISTORY"],
      ]);
      expect(rows[1]!.evidence).toEqual({
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
      // The observation is the session; the processing time is the pass that found it.
      expect(
        rows.every((t) => t.occurredAt.getTime() === clock.now.getTime()),
      ).toBe(true);
      expect(
        (await signals(monitorId)).map((signal) => [
          day(signal.observationDate),
          day(signal.resolvedObservationDate) ?? null,
          signal.resolutionReason,
          signal.reconstructed,
        ]),
      ).toEqual([
        ["2026-03-02", "2026-09-21", "CONDITIONS_ENDED", true],
        ["2026-10-05", null, null, true],
      ]);
      expect(rows.every((t) => t.strategyVersionId !== null)).toBe(true);
      const progress = await checkpoint(monitorId, security.id);
      expect(day(progress?.coverageStart)).toBe("2026-09-15");
      expect(day(progress?.evaluatedThrough)).toBe("2026-10-14");

      // Zero missing sessions: nothing is evaluated or written again.
      const again = await evaluation().run(2);
      expect(again.membersReplayed).toBe(0);
      expect(again.sessionsEvaluated).toBe(0);
      expect(await transitions(monitorId)).toHaveLength(3);
      expect(await signals(monitorId)).toHaveLength(2);
    });

    it("keeps a Trigger latched before the window active through it, never restarting the setup", async () => {
      const security = await createSecurity("2026-03-02");
      // Below its average until Aug 3, when it crosses above and stays there.
      await seed(
        security,
        weekdays("2026-03-02", "2026-10-14", (date) =>
          date >= "2026-08-03" ? 105 : 95,
        ),
        after("2026-10-14"),
        "2026-10-14",
        "2026-03-02",
      );
      const monitorId = await createMonitor(
        [security],
        {
          conditions: signalAbove().conditions,
          trigger: signalCrosses().trigger!,
        },
        { replay: true, listedAt },
      );
      await evaluation().run(1);
      expect(
        (await transitions(monitorId)).map((t) => [
          day(t.observationDate),
          t.toState,
          t.reason,
        ]),
      ).toEqual([["2026-08-03", "ACTIVE", "RECONSTRUCTED"]]);
      const state = await prisma.monitorSignalState.findFirstOrThrow({
        where: { monitorId },
      });
      expect(state.lifecycleState).toBe("ACTIVE");
      expect(day(state.lifecycleSinceDate)).toBe("2026-08-03");
    });

    it("starts a member's window at its listing when the security is younger than the window", async () => {
      const security = await createSecurity("2026-09-22");
      await seed(
        security,
        weekdays("2026-09-22", "2026-10-14", (date) =>
          date >= "2026-09-28" && date < "2026-10-05" ? 95 : 105,
        ),
        after("2026-10-14"),
        "2026-10-14",
        "2026-09-22",
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
        ["2026-09-22", "CONDITIONS_MET"],
        ["2026-09-28", "CONDITIONS_ENDED"],
        ["2026-10-05", "CONDITIONS_MET"],
      ]);
      // Covered from the window's start: nothing existed to evaluate before the listing.
      expect(
        day((await checkpoint(monitorId, security.id))?.coverageStart),
      ).toBe("2026-09-15");
    });

    it("evaluates a member added later over its window, as history found when it was added", async () => {
      const first = await createSecurity("2026-09-01");
      const later = await createSecurity("2026-09-01");
      const closes = weekdays("2026-09-01", "2026-10-15", (date) =>
        date >= "2026-09-21" && date < "2026-10-05" ? 95 : 105,
      );
      await seed(first, closes, after("2026-10-14"), "2026-10-14");
      const monitorId = await createMonitor([first], signalAbove(), {
        replay: true,
        listedAt,
      });
      await evaluation().run(1);

      // Added the next morning; Thursday's session is then the first it is watched for.
      const monitor = await prisma.monitor.findUniqueOrThrow({
        where: { id: monitorId },
      });
      await prisma.stockListItem.create({
        data: {
          stockListId: monitor.stockListId,
          securityId: later.id,
          createdAt: new Date("2026-10-15T13:00:00.000Z"),
        },
      });
      clock.now = after("2026-10-15");
      await seed(first, closes, after("2026-10-15"), "2026-10-15");
      await seed(later, closes, after("2026-10-15"), "2026-10-15");
      const second = await evaluation().run(2);
      expect(second.membersReplayed).toBe(1);
      const added = (await transitions(monitorId)).filter(
        (t) => t.securityId === later.id,
      );
      expect(
        added.map((t) => [day(t.observationDate), t.reason, t.origin]),
      ).toEqual([
        ["2026-09-01", "RECONSTRUCTED", "HISTORY"],
        ["2026-09-21", "CONDITIONS_ENDED", "HISTORY"],
        ["2026-10-05", "CONDITIONS_MET", "HISTORY"],
      ]);
      // Its window ends at the newest finalized session of the pass that found it: Sep 16 – Oct 15.
      expect(day((await checkpoint(monitorId, later.id))?.coverageStart)).toBe(
        "2026-09-16",
      );
      // The first member was only caught up by one session, its coverage kept.
      expect(day((await checkpoint(monitorId, first.id))?.coverageStart)).toBe(
        "2026-09-15",
      );
    });

    /**
     * Pre-release audit 2026-10-16, finding MON-01 (`docs/audits/pre-release-audit-2026-10-16.md`).
     *
     * A member whose ongoing membership ends is closed administratively and loses its state **and**
     * its checkpoint; restored, it again has neither. Replaying its whole window then decided every
     * session a second time and duplicated every Signal it had opened. The window replay starts
     * after the newest session this Monitor ever recorded a change on for the security, so no
     * recorded change is ever recorded again; what was ended administratively stays ended, and the
     * occurrence that still holds is reconstructed as one new occurrence on its true session (§4).
     */
    it("MON-01: never records a window session twice when a member's membership ends and is restored", async () => {
      const security = await createSecurity("2026-03-02");
      await seed(
        security,
        weekdays("2026-03-02", "2026-10-14", dipInWindow),
        after("2026-10-14"),
        "2026-10-14",
        "2026-03-02",
      );
      const monitorId = await createMonitor([security], signalAbove(), {
        replay: true,
        listedAt,
      });
      expect((await evaluation().run(1)).membersReplayed).toBe(1);
      expect(await signals(monitorId)).toHaveLength(2);

      // The owner bounds the membership (it stops being ongoing), the pass ends it…
      await setMembership(monitorId, security, [
        { start: "2026-03-02", end: "2026-10-09" },
      ]);
      await evaluation().run(2);
      expect(
        (await transitions(monitorId)).some(
          (t) => t.reason === "MEMBERSHIP_CHANGED",
        ),
      ).toBe(true);
      expect(await checkpoint(monitorId, security.id)).toBeNull();

      // …and restores it. Only the sessions after Oct 5 — the newest recorded — are evaluated again.
      await setMembership(monitorId, security, "FULL");
      const restored = await evaluation().run(3);
      expect(restored.membersReplayed).toBe(1);
      // The sessions before them are covered by what the first membership recorded under the same
      // logic: the back-fill verifies that and records nothing a second time (§12.2).
      expect(restored.membersBackfilled).toBe(1);
      expect(restored.membersBackfillBlocked).toBe(0);

      const decided = (await transitions(monitorId))
        .filter(
          (t) => t.origin !== "ADMINISTRATIVE" && t.reason !== "RECONSTRUCTED",
        )
        .map(
          (t) =>
            `${t.levelId}|${day(t.observationDate)}|${t.toState}|${t.reason}`,
        );
      expect(decided).toEqual([
        "buy-1|2026-09-21|RESOLVED|CONDITIONS_ENDED",
        "buy-1|2026-10-05|ACTIVE|CONDITIONS_MET",
      ]);
      expect(
        (await signals(monitorId)).map((signal) => [
          day(signal.observationDate),
          signal.resolutionReason,
        ]),
      ).toEqual([
        ["2026-03-02", "CONDITIONS_ENDED"],
        ["2026-10-05", "MEMBERSHIP_CHANGED"],
        ["2026-10-05", null],
      ]);
      // The whole window is covered: Sep 15 – Oct 14.
      expect(
        day((await checkpoint(monitorId, security.id))?.coverageStart),
      ).toBe("2026-09-15");
      // A further pass finds nothing missing and records nothing.
      const recorded = (await transitions(monitorId)).length;
      const settled = await evaluation().run(4);
      expect(settled.membersBackfilled).toBe(0);
      expect(await transitions(monitorId)).toHaveLength(recorded);
    });

    it("replays a member exactly once when the pass that replayed it crashed before committing", async () => {
      const security = await createSecurity("2026-03-02");
      await seed(
        security,
        weekdays("2026-03-02", "2026-10-14", dipInWindow),
        after("2026-10-14"),
        "2026-10-14",
        "2026-03-02",
      );
      const monitorId = await createMonitor([security], signalAbove(), {
        replay: true,
        listedAt,
      });
      const crashing: MonitorEvaluationRepository = {
        ...repository,
        applyMemberEvaluation: async () => {
          throw new Error("process killed before the replay committed");
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
      expect(await transitions(monitorId)).toEqual([]);

      // The retry replays the same window, once; a further pass adds nothing.
      expect((await evaluation().run(2)).membersReplayed).toBe(1);
      const afterRetry = await transitions(monitorId);
      expect(afterRetry.length).toBeGreaterThan(0);
      expect((await evaluation().run(3)).membersReplayed).toBe(0);
      expect(await transitions(monitorId)).toHaveLength(afterRetry.length);
      const opened = (await signals(monitorId)).map(
        (signal) => `${signal.levelId}|${day(signal.observationDate)}`,
      );
      expect(new Set(opened).size).toBe(opened.length);
    });

    it("lets one of two concurrent passes record a window, and the other none of it", async () => {
      const security = await createSecurity("2026-03-02");
      await seed(
        security,
        weekdays("2026-03-02", "2026-10-14", dipInWindow),
        after("2026-10-14"),
        "2026-10-14",
        "2026-03-02",
      );
      const monitorId = await createMonitor([security], signalAbove(), {
        replay: true,
        listedAt,
      });
      const [one, two] = await Promise.all([
        evaluation().run(1),
        evaluation().run(2),
      ]);
      expect(one.contended + two.contended).toBe(1);
      expect(await transitions(monitorId)).toHaveLength(3);
      expect(await signals(monitorId)).toHaveLength(2);
    });

    it("keeps a Monitor replayed under the retired 90-day rule, and evaluates only the sessions it missed while disabled", async () => {
      const security = await createSecurity("2026-03-02");
      const closes = weekdays("2026-03-02", "2026-10-21", (date) =>
        date >= "2026-10-19" ? 95 : dipInWindow(date),
      );
      await seed(
        security,
        closes,
        after("2026-10-14"),
        "2026-10-14",
        "2026-03-02",
      );
      const monitorId = await createMonitor([security], signalAbove(), {
        replay: true,
        listedAt,
      });
      await evaluation().run(1);
      // What the 90-day replay and its migration leave: the record of the old window, and a member
      // covered from its start.
      await prisma.monitor.update({
        where: { id: monitorId },
        data: {
          replayWindowStart: new Date("2026-07-17T00:00:00.000Z"),
          replayWindowFixedAt: after("2026-10-14"),
        },
      });
      await prisma.monitorEvaluationCheckpoint.update({
        where: { monitorId_securityId: { monitorId, securityId: security.id } },
        data: { coverageStart: new Date("2026-07-17T00:00:00.000Z") },
      });
      const recorded = await transitions(monitorId);

      // Disabled for a week: no pass evaluates it, and it stops being watched.
      created.delete(monitorId);
      clock.now = after("2026-10-16");
      await evaluation().run(2);
      expect(
        (await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } }))
          .watchingSince,
      ).toBeNull();

      // Re-enabled on Oct 21: only Oct 15 – 21 are evaluated, in order, as history.
      created.add(monitorId);
      clock.now = after("2026-10-21");
      await seed(
        security,
        closes,
        after("2026-10-21"),
        "2026-10-21",
        "2026-03-02",
      );
      const resumed = await evaluation().run(3);
      expect(resumed.membersReplayed).toBe(0);
      expect(resumed.sessionsEvaluated).toBe(5);
      const now = await transitions(monitorId);
      expect(now.slice(0, recorded.length).map((t) => t.id)).toEqual(
        recorded.map((t) => t.id),
      );
      expect(
        now
          .slice(recorded.length)
          .map((t) => [day(t.observationDate), t.reason, t.origin]),
      ).toEqual([["2026-10-19", "CONDITIONS_ENDED", "HISTORY"]]);
      const progress = await checkpoint(monitorId, security.id);
      expect(day(progress?.evaluatedThrough)).toBe("2026-10-21");
      expect(day(progress?.coverageStart)).toBe("2026-07-17");
    });

    it("never waits for, or counts as missing, a session the exchange was closed", async () => {
      const security = await createSecurity("2026-09-01");
      // Monday Oct 12 is a closure on this venue: no bar, and none is owed.
      const closes = weekdays("2026-09-01", "2026-10-14", dipInWindow);
      delete closes["2026-10-12"];
      await seed(security, closes, after("2026-10-14"), "2026-10-14");
      const holidays = {
        async isTradingSession(_exchange: string, date: string) {
          const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
          return weekday !== 0 && weekday !== 6 && date !== "2026-10-12";
        },
      };
      const fourDays = 4 * 24 * 60 * 60_000;
      const closed = await createMonitor([security], signalAbove(), {
        replay: true,
        listedAt,
      });
      const summary = await evaluationOn(holidays, fourDays).run(1);
      expect(summary.membersAwaitingLateSession).toBe(0);
      expect(
        day((await checkpoint(closed, security.id))?.evaluatedThrough),
      ).toBe("2026-10-14");

      // The same missing bar on a venue that was open is a late session, and is waited for.
      created.delete(closed);
      const open = await createMonitor([security], signalAbove(), {
        replay: true,
        listedAt,
      });
      const held = await evaluationOn(WEEKDAY_TRADING_CALENDAR, fourDays).run(
        2,
      );
      expect(held.membersAwaitingLateSession).toBe(1);
      expect(day((await checkpoint(open, security.id))?.evaluatedThrough)).toBe(
        "2026-10-09",
      );
    });

    it("reconstructs a member at its newest session when the Monitor does not replay windows", async () => {
      const security = await createSecurity("2026-09-01");
      await seed(
        security,
        weekdays("2026-09-01", "2026-10-14", dipInWindow),
        after("2026-10-14"),
        "2026-10-14",
      );
      const monitorId = await createMonitor([security], signalAbove(), {
        listedAt,
      });
      const summary = await evaluation().run(1);
      expect(summary.membersReplayed).toBe(0);
      expect(await transitions(monitorId)).toHaveLength(1);
      // Recorded from the newest session only: the window before it was never stepped.
      expect(
        day((await checkpoint(monitorId, security.id))?.coverageStart),
      ).toBe("2026-10-14");
    });

    it("records the session its canonical policy found for the Dashboard's window, never moving it back", async () => {
      const id = "GLOBAL";
      const original = await prisma.monitorScanSchedule.findUnique({
        where: { id },
      });
      await prisma.monitorScanSchedule.upsert({
        where: { id },
        create: { id },
        update: {},
      });
      try {
        await real.recordExpectedSession(
          { session: "2026-10-14", calendar: "EXCHANGE" },
          after("2026-10-14"),
        );
        // An older answer — a slow pass that asked earlier — never replaces a newer one.
        await real.recordExpectedSession(
          { session: "2026-10-13", calendar: "WEEKDAYS" },
          after("2026-10-13"),
        );
        const row = await prisma.monitorScanSchedule.findUniqueOrThrow({
          where: { id },
        });
        expect(day(row.latestSession)).toBe("2026-10-14");
        expect(row.latestSessionCalendar).toBe("EXCHANGE");
        expect(row.latestSessionAt?.toISOString()).toBe(
          after("2026-10-14").toISOString(),
        );
      } finally {
        await prisma.monitorScanSchedule.update({
          where: { id },
          data: {
            latestSession: original?.latestSession ?? null,
            latestSessionCalendar: original?.latestSessionCalendar ?? null,
            latestSessionAt: original?.latestSessionAt ?? null,
          },
        });
      }
    });

    /**
     * A member whose recorded evaluation began inside its window — a checkpoint written before
     * coverage was recorded, a rebound Monitor whose window replay began after the sessions its
     * previous binding recorded — has its missing sessions decided and recorded, append-only:
     * verified against what is recorded, nothing recorded twice, no occurrence duplicated.
     */
    describe("completing a window whose recorded evaluation began late (§12.2)", () => {
      const resting = (state: string) =>
        state === "RESOLVED" ? "INACTIVE" : state;
      /** A level's session-decided changes — what a window replay and a back-fill must agree on. */
      const decidedOf = async (monitorId: string) =>
        (await transitions(monitorId))
          .filter(
            (t) =>
              t.origin !== "ADMINISTRATIVE" && t.reason !== "RECONSTRUCTED",
          )
          .map((t) =>
            [
              t.levelId,
              day(t.observationDate),
              resting(t.fromState),
              t.toState,
              t.reason,
              t.origin,
            ].join("|"),
          )
          .sort();
      const occurrencesOf = async (monitorId: string) =>
        (await signals(monitorId)).map((signal) => [
          day(signal.observationDate),
          day(signal.resolvedObservationDate) ?? null,
          signal.resolutionReason,
        ]);

      async function createStrategy(signal: StrategySignal): Promise<string> {
        const strategy = await prisma.strategy.create({
          data: {
            ownership: "SYSTEM",
            systemKey: `test-strategy-${randomUUID()}`,
            name: "EOD strategy (rebound)",
            versions: {
              create: {
                versionNumber: 1,
                definition: definitionOf(signal) as never,
                definitionHash: randomUUID(),
              },
            },
          },
        });
        return strategy.id;
      }

      /** What the API's rebind does to a Monitor's durable state (`crossMonitorConfigurationBoundary`). */
      async function rebind(monitorId: string, strategyId: string) {
        const now = clock.now;
        await prisma.$transaction(async (tx) => {
          const current = await tx.monitorSignalState.findMany({
            where: {
              monitorId,
              lifecycleState: { in: ["ACTIVE", "PENDING_TRIGGER"] },
            },
          });
          if (current.length > 0) {
            await tx.monitorStateTransition.createMany({
              data: current.map((state) => ({
                monitorId,
                securityId: state.securityId,
                levelId: state.levelId,
                levelKind: state.levelKind,
                signalFingerprint: state.signalFingerprint,
                fromState: state.lifecycleState,
                toState:
                  state.lifecycleState === "ACTIVE"
                    ? ("RESOLVED" as const)
                    : ("INACTIVE" as const),
                reason: "MONITOR_REBOUND" as const,
                origin: "ADMINISTRATIVE" as const,
                occurredAt: now,
                signalId: state.activeSignalId,
              })),
            });
          }
          await tx.monitorSignal.updateMany({
            where: { monitorId, resolvedAt: null },
            data: { resolvedAt: now, resolutionReason: "MONITOR_REBOUND" },
          });
          await tx.monitorSignalState.deleteMany({ where: { monitorId } });
          await tx.monitorEvaluationCheckpoint.deleteMany({
            where: { monitorId },
          });
          await tx.monitor.update({
            where: { id: monitorId },
            data: {
              strategyId,
              configVersion: { increment: 1 },
              lastScanAt: null,
            },
          });
        });
        const row = await prisma.monitor.findUniqueOrThrow({
          where: { id: monitorId },
          select: { stockListId: true },
        });
        systemRows.push({
          monitorId,
          stockListId: row.stockListId,
          strategyId,
        });
      }

      /** A member a pass before coverage existed reconstructed at its newest session (Oct 14). */
      async function legacyMember() {
        const security = await createSecurity("2026-03-02");
        await seed(
          security,
          weekdays("2026-03-02", "2026-10-14", dipInWindow),
          after("2026-10-14"),
          "2026-10-14",
          "2026-03-02",
        );
        const monitorId = await createMonitor([security], signalAbove(), {
          listedAt,
        });
        await evaluation().run(1);
        // What migration `20261023120000` leaves such a member: replaying windows, covered only
        // from the session it has reached.
        await prisma.monitor.update({
          where: { id: monitorId },
          data: { windowReplay: true },
        });
        return { security, monitorId };
      }

      it("decides the missing sessions of a member reconstructed at its newest session, reusing its occurrence and recording nothing twice", async () => {
        const { security, monitorId } = await legacyMember();
        // Reconstructed on Oct 14: active since Oct 5, recorded as one RECONSTRUCTED change.
        expect(
          (await transitions(monitorId)).map((t) => [
            day(t.observationDate),
            t.reason,
          ]),
        ).toEqual([["2026-10-05", "RECONSTRUCTED"]]);
        const [active] = await signals(monitorId);
        const stateBefore = await prisma.monitorSignalState.findFirstOrThrow({
          where: { monitorId, securityId: security.id },
        });

        const summary = await evaluation().run(2);
        expect(summary.membersBackfilled).toBe(1);
        expect(summary.membersBackfillBlocked).toBe(0);
        // Sep 15 – Oct 13: the weekday sessions of the window the member had not recorded.
        expect(summary.sessionsBackfilled).toBe(21);
        expect(
          day((await checkpoint(monitorId, security.id))?.coverageStart),
        ).toBe("2026-09-15");

        // Exactly what a window replay of the same member records, change for change and
        // occurrence for occurrence.
        const control = await createMonitor([security], signalAbove(), {
          replay: true,
          listedAt,
        });
        created.delete(monitorId);
        await evaluation().run(3);
        created.add(monitorId);
        expect(await decidedOf(monitorId)).toEqual(await decidedOf(control));
        expect(await occurrencesOf(monitorId)).toEqual(
          await occurrencesOf(control),
        );

        // The occurrence a reconstruction recorded is the same one: the session that activated it
        // is recorded on it, with its evidence; the state and its version are untouched.
        const activation = (await transitions(monitorId)).find(
          (t) => t.reason === "CONDITIONS_MET",
        )!;
        expect(activation.signalId).toBe(active!.id);
        expect(day(activation.observationDate)).toBe("2026-10-05");
        expect(activation.origin).toBe("HISTORY");
        expect(activation.evidence).not.toBeNull();
        const stateAfter = await prisma.monitorSignalState.findFirstOrThrow({
          where: { monitorId, securityId: security.id },
        });
        expect(stateAfter.stateVersion).toBe(stateBefore.stateVersion);
        expect(stateAfter.activeSignalId).toBe(active!.id);
        // The reconstruction's own change is kept: append-only.
        expect(
          (await transitions(monitorId)).filter(
            (t) => t.reason === "RECONSTRUCTED",
          ),
        ).toHaveLength(2);

        // Nothing is decided again on later passes.
        const recorded = (await transitions(monitorId)).length;
        const again = await evaluation().run(4);
        expect(again.membersBackfilled).toBe(0);
        expect(await transitions(monitorId)).toHaveLength(recorded);
      });

      it("records nothing twice when a rebound Monitor keeps the same logic", async () => {
        const security = await createSecurity("2026-03-02");
        await seed(
          security,
          weekdays("2026-03-02", "2026-10-14", dipInWindow),
          after("2026-10-14"),
          "2026-10-14",
          "2026-03-02",
        );
        const monitorId = await createMonitor([security], signalAbove(), {
          replay: true,
          listedAt,
        });
        await evaluation().run(1);
        const before = await decidedOf(monitorId);

        // Rebound to another Strategy with the very same logic: the decisions are the same facts.
        await rebind(monitorId, await createStrategy(signalAbove()));
        const summary = await evaluation().run(2);
        expect(summary.membersReplayed).toBe(1);
        expect(summary.membersBackfilled).toBe(1);
        expect(await decidedOf(monitorId)).toEqual(before);
        expect(
          day((await checkpoint(monitorId, security.id))?.coverageStart),
        ).toBe("2026-09-15");
      });

      it("decides a rebound Monitor's whole window under its new logic", async () => {
        const security = await createSecurity("2026-03-02");
        await seed(
          security,
          weekdays("2026-03-02", "2026-10-14", dipInWindow),
          after("2026-10-14"),
          "2026-10-14",
          "2026-03-02",
        );
        const monitorId = await createMonitor([security], signalAbove(), {
          replay: true,
          listedAt,
        });
        await evaluation().run(1);
        await rebind(monitorId, await createStrategy(signalCrosses()));
        const summary = await evaluation().run(2);
        expect(summary.membersReplayed).toBe(1);
        expect(summary.membersBackfilled).toBe(1);
        expect(
          day((await checkpoint(monitorId, security.id))?.coverageStart),
        ).toBe("2026-09-15");

        const control = await createMonitor([security], signalCrosses(), {
          replay: true,
          listedAt,
        });
        created.delete(monitorId);
        await evaluation().run(3);
        created.add(monitorId);
        const fingerprint = (await transitions(control))[0]!.signalFingerprint;
        const underNewLogic = async (id: string) =>
          (await decidedOf(id)).filter((row) => row.startsWith("buy-1|"));
        const newLogic = (await transitions(monitorId))
          .filter((t) => t.signalFingerprint === fingerprint)
          .filter((t) => t.reason !== "RECONSTRUCTED")
          .map((t) => `${day(t.observationDate)}|${t.reason}`)
          // Appended after what was recorded: read models order by session, never by insertion.
          .sort();
        expect(newLogic).toEqual(
          (await transitions(control))
            .filter((t) => t.reason !== "RECONSTRUCTED")
            .map((t) => `${day(t.observationDate)}|${t.reason}`)
            .sort(),
        );
        expect(await underNewLogic(control)).toHaveLength(2);
        // One occurrence for the trigger day, not one per binding pass.
        expect(
          (await signals(monitorId)).filter(
            (signal) => signal.signalFingerprint === fingerprint,
          ),
        ).toHaveLength(1);
      });

      it("starts after recorded decisions that disagree, and says how far it got", async () => {
        const { security, monitorId } = await legacyMember();
        const level = await prisma.monitorSignalState.findFirstOrThrow({
          where: { monitorId, securityId: security.id },
        });
        // A decision recorded for Sep 28 under the same logic that the canonical history never
        // made — as an intraday Monitor might have.
        await prisma.monitorStateTransition.create({
          data: {
            monitorId,
            securityId: security.id,
            levelId: level.levelId,
            levelKind: level.levelKind,
            signalFingerprint: level.signalFingerprint,
            fromState: "INACTIVE",
            toState: "ACTIVE",
            reason: "CONDITIONS_MET",
            origin: "OBSERVED",
            observationDate: new Date("2026-09-28T00:00:00.000Z"),
            occurredAt: new Date("2026-09-28T20:00:00.000Z"),
          },
        });
        const summary = await evaluation().run(2);
        expect(summary.membersBackfilled).toBe(1);
        expect(summary.membersBackfillBlocked).toBe(1);
        const progress = await checkpoint(monitorId, security.id);
        // Recorded from the day after the disagreement; the window from Sep 15 is not complete.
        expect(day(progress?.coverageStart)).toBe("2026-09-29");
        expect(day(progress?.coverageBlockedFrom)).toBe("2026-09-15");
        // Only Oct 5 was missing after it; the disagreeing decision is left as it was.
        expect(
          (await transitions(monitorId)).map((t) => [
            day(t.observationDate),
            t.reason,
          ]),
        ).toEqual([
          ["2026-10-05", "RECONSTRUCTED"],
          ["2026-09-28", "CONDITIONS_MET"],
          ["2026-10-05", "CONDITIONS_MET"],
        ]);
      });

      it("writes nothing for a member whose state the canonical history does not reach, and tries again only when the window moves", async () => {
        const { security, monitorId } = await legacyMember();
        // The persisted state says active since Oct 6; every session says Oct 5.
        await prisma.monitorSignalState.updateMany({
          where: { monitorId, securityId: security.id },
          data: { lifecycleSinceDate: new Date("2026-10-06T00:00:00.000Z") },
        });
        const recorded = (await transitions(monitorId)).length;
        const summary = await evaluation().run(2);
        expect(summary.membersBackfilled).toBe(0);
        expect(summary.membersBackfillBlocked).toBe(1);
        expect(await transitions(monitorId)).toHaveLength(recorded);
        const progress = await checkpoint(monitorId, security.id);
        expect(day(progress?.coverageStart)).toBe("2026-10-14");
        expect(day(progress?.coverageBlockedFrom)).toBe("2026-09-15");

        // The same window is not decided again.
        expect((await evaluation().run(3)).membersBackfillBlocked).toBe(0);
        // A new session moves the window's start, and the member is looked at once more.
        await seed(
          security,
          weekdays("2026-03-02", "2026-10-15", dipInWindow),
          after("2026-10-15"),
          "2026-10-15",
          "2026-03-02",
        );
        clock.now = after("2026-10-15");
        const later = await evaluation().run(4);
        expect(later.membersBackfillBlocked).toBe(1);
        expect(
          day((await checkpoint(monitorId, security.id))?.coverageBlockedFrom),
        ).toBe("2026-09-16");
      });

      it("records a member's missing sessions once when two passes race for it", async () => {
        const { security, monitorId } = await legacyMember();
        const results = await Promise.all([
          evaluation().run(2),
          evaluation().run(3),
        ]);
        expect(
          results.reduce((sum, result) => sum + result.membersBackfilled, 0),
        ).toBe(1);
        const control = await createMonitor([security], signalAbove(), {
          replay: true,
          listedAt,
        });
        created.delete(monitorId);
        await evaluation().run(4);
        created.add(monitorId);
        expect(await decidedOf(monitorId)).toEqual(await decidedOf(control));
      });

      it("never decides a covered member again as the window advances: only each new session", async () => {
        const security = await createSecurity("2026-03-02");
        await seed(
          security,
          weekdays("2026-03-02", "2026-10-14", dipInWindow),
          after("2026-10-14"),
          "2026-10-14",
          "2026-03-02",
        );
        const monitorId = await createMonitor([security], signalAbove(), {
          replay: true,
          listedAt,
        });
        await evaluation().run(1);
        for (const [index, session] of [
          "2026-10-15",
          "2026-10-16",
          "2026-10-19",
        ].entries()) {
          await seed(
            security,
            weekdays("2026-03-02", session, dipInWindow),
            after(session),
            session,
            "2026-03-02",
          );
          clock.now = after(session);
          const summary = await evaluation().run(2 + index);
          // One new session, nothing back-filled: the window's start moved, the coverage did not
          // need to.
          expect(summary.sessionsEvaluated).toBe(1);
          expect(summary.membersBackfilled).toBe(0);
          expect(
            monitorActivityWindowStart(summary.expectedSession) > "2026-09-15",
          ).toBe(true);
          expect(
            day((await checkpoint(monitorId, security.id))?.coverageStart),
          ).toBe("2026-09-15");
        }
      });
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
