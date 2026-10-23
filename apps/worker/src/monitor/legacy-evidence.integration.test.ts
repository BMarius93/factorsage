import { randomUUID } from "node:crypto";
import {
  STRATEGY_SCHEMA_VERSION,
  normalizeStrategyDefinition,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { DailyPrice } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalStockDataService,
  InMemoryLoadCoordinator,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  createStockDataRedisClient,
} from "@intrinsic/stock-data";
import { monitorStrategyLevels } from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LegacyEvidenceBackfill } from "./legacy-evidence.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() ||
  process.env.REDIS_URL?.trim() ||
  "redis://localhost:6379";

/**
 * Legacy events without evidence (`docs/decisions/monitor-eod-v2.md` §12.6), against PostgreSQL:
 * reconstructed only when the stored data and the recorded logic reproduce the recorded change,
 * otherwise left out of the Dashboard — never invented, never re-dated.
 *
 * The newest finalized date is Wednesday 2026-10-14, so the window is Sep 15 – Oct 14.
 */
describe("legacy Monitor evidence", () => {
  const prisma = new PrismaClient();
  const store = new PrismaStockDataStore(prisma);
  const redis = createStockDataRedisClient(redisUrl);
  const namespace = `stock-data:v2:test:legacy-evidence:${randomUUID()}`;
  const now = new Date("2026-10-15T12:00:00.000Z");
  const service = new CanonicalStockDataService(
    store,
    {
      async getProfile() {
        throw new Error("The backfill must never reach the provider");
      },
      async getDailyPrices() {
        throw new Error("The backfill must never reach the provider");
      },
      async getFinancialStatements() {
        throw new Error("The backfill must never reach the provider");
      },
    },
    new RedisStockDataCache(new IoredisCacheClient(redis), 10, namespace),
    new InMemoryLoadCoordinator(),
    { productHistoryYears: 30, now: () => now },
  );
  const definition: StrategyDefinition = normalizeStrategyDefinition({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [
            {
              id: "c1",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "EMA_50D" },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  });
  const fingerprint = monitorStrategyLevels(definition)[0]!.fingerprint;
  const key = randomUUID();
  const ids = {
    security: "",
    strategy: "",
    version: "",
    list: "",
    monitor: "",
  };
  const transitionIds: Record<string, string> = {};

  const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
  // Below its average to Oct 6, above from Oct 7, below again from Oct 13.
  const closes: Record<string, number> = {
    "2026-09-08": 95,
    "2026-09-09": 105,
    "2026-10-05": 95,
    "2026-10-06": 95,
    "2026-10-07": 101,
    "2026-10-08": 102,
    "2026-10-09": 103,
    "2026-10-12": 104,
    "2026-10-13": 98,
    "2026-10-14": 97,
  };

  async function occurrence(input: {
    on: string;
    price: number;
    basis?: "LIVE_QUOTE" | "EOD_CLOSE";
  }) {
    return (
      await prisma.monitorSignal.create({
        data: {
          monitorId: ids.monitor,
          securityId: ids.security,
          levelId: "buy-1",
          levelKind: "BUY",
          strategyVersionId: ids.version,
          signalFingerprint: fingerprint,
          hasTrigger: false,
          observationDate: day(input.on),
          observationPrice: input.price,
          observationBasis: input.basis ?? "EOD_CLOSE",
          detectedAt: new Date(`${input.on}T22:00:00.000Z`),
        },
      })
    ).id;
  }

  async function legacy(input: {
    name: string;
    on: string;
    signalId: string;
    to: "ACTIVE" | "RESOLVED";
    fingerprint?: string;
    evidence?: unknown;
  }) {
    const row = await prisma.monitorStateTransition.create({
      data: {
        monitorId: ids.monitor,
        securityId: ids.security,
        levelId: "buy-1",
        levelKind: "BUY",
        signalFingerprint: input.fingerprint ?? fingerprint,
        fromState: input.to === "ACTIVE" ? "INACTIVE" : "ACTIVE",
        toState: input.to,
        reason: input.to === "ACTIVE" ? "CONDITIONS_MET" : "CONDITIONS_ENDED",
        origin: "OBSERVED",
        occurredAt: new Date(`${input.on}T22:00:00.000Z`),
        observationDate: day(input.on),
        signalId: input.signalId,
        ...(input.evidence ? { evidence: input.evidence as never } : {}),
      },
    });
    transitionIds[input.name] = row.id;
  }

  beforeAll(async () => {
    const symbol = `LEG${key.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
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
        ipoDate: day("2026-09-01"),
      },
    });
    ids.security = row.id;
    const dates = Object.keys(closes).sort();
    const prices: DailyPrice[] = dates.map((date) => ({
      securityId: row.id,
      date,
      open: closes[date]!,
      high: closes[date]!,
      low: closes[date]!,
      close: closes[date]!,
      volume: 1_000,
    }));
    await store.saveDailyPriceSync({
      securityId: row.id,
      prices,
      successfulCoverage: [{ from: "2026-09-01", to: "2026-10-14" }],
      syncedAt: "2026-10-14T23:00:00.000Z",
      tailDate: "2026-10-14",
      freshThrough: "2026-10-14",
    });
    await store.saveDailyDerivedState({
      securityId: row.id,
      rows: dates.map((date) => ({ securityId: row.id, date, ema50d: 100 })),
      weeklyPrices: [],
      successfulCoverage: { from: "2026-09-01", to: "2026-10-14" },
      syncedAt: "2026-10-14T23:00:00.000Z",
    });
    const strategy = await prisma.strategy.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `legacy-strategy-${key}`,
        name: "Legacy strategy",
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as never,
            definitionHash: randomUUID(),
          },
        },
      },
      include: { versions: true },
    });
    ids.strategy = strategy.id;
    ids.version = strategy.versions[0]!.id;
    const list = await prisma.stockList.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `legacy-list-${key}`,
        name: "Legacy list",
        items: { create: [{ securityId: row.id }] },
      },
    });
    ids.list = list.id;
    ids.monitor = (
      await prisma.monitor.create({
        data: {
          ownership: "SYSTEM",
          systemKey: `legacy-monitor-${key}`,
          name: "Legacy monitor",
          strategyId: strategy.id,
          stockListId: list.id,
        },
      })
    ).id;

    // Activated Oct 7 at its close, ended Oct 13: decided before evidence existed.
    const decided = await occurrence({ on: "2026-10-07", price: 101 });
    await legacy({
      name: "activation",
      on: "2026-10-07",
      signalId: decided,
      to: "ACTIVE",
    });
    await legacy({
      name: "ending",
      on: "2026-10-13",
      signalId: decided,
      to: "RESOLVED",
    });
    // The live-quote Monitor's occurrence: an intraday price, never given end-of-day values.
    const intraday = await occurrence({
      on: "2026-10-08",
      price: 101.73,
      basis: "LIVE_QUOTE",
    });
    await legacy({
      name: "intraday",
      on: "2026-10-08",
      signalId: intraday,
      to: "ACTIVE",
    });
    // Recorded at a price the stored close does not have: the data is not what decided it.
    const repriced = await occurrence({ on: "2026-10-09", price: 99.5 });
    await legacy({
      name: "repriced",
      on: "2026-10-09",
      signalId: repriced,
      to: "ACTIVE",
    });
    // Decided under logic this version does not hold.
    const edited = await occurrence({ on: "2026-10-12", price: 104 });
    await legacy({
      name: "edited",
      on: "2026-10-12",
      signalId: edited,
      to: "ACTIVE",
      fingerprint: "another-logic",
    });
    // An ending on a session whose Condition held: the data does not reproduce the change.
    await legacy({
      name: "contradicted",
      on: "2026-10-12",
      signalId: decided,
      to: "RESOLVED",
    });
    // Before the window, and one that already has its evidence: neither is a candidate.
    const old = await occurrence({ on: "2026-09-09", price: 105 });
    await legacy({
      name: "beforeWindow",
      on: "2026-09-09",
      signalId: old,
      to: "ACTIVE",
    });
    await legacy({
      name: "recorded",
      on: "2026-10-14",
      signalId: decided,
      to: "RESOLVED",
      evidence: { v: 1, rules: [] },
    });
  });

  afterAll(async () => {
    await prisma.monitor.deleteMany({ where: { id: ids.monitor } });
    await prisma.stockList.deleteMany({ where: { id: ids.list } });
    await prisma.strategy.deleteMany({ where: { id: ids.strategy } });
    await prisma.security.deleteMany({ where: { id: ids.security } });
    const keys = await redis.keys(`${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await prisma.$disconnect();
    await redis.quit();
  });

  const backfill = (apply: boolean) =>
    new LegacyEvidenceBackfill(
      prisma,
      {
        findSecurities: (securityIds) =>
          service.findSecuritiesByIds(securityIds),
        readFinalizedEvaluationFrame: (target, range, operands) =>
          service.readFinalizedEvaluationFrame(target, range, operands),
      },
      createLogger({ service: "worker", level: "silent" }),
      { latest: "2026-10-14", apply, now: () => now },
    );

  const evidenceOf = async (name: string) =>
    (
      await prisma.monitorStateTransition.findUniqueOrThrow({
        where: { id: transitionIds[name]! },
      })
    ).evidence;

  it("reports what is recoverable and what stays excluded, and writes nothing on a dry run", async () => {
    // Other suites share the database: count only this Monitor's candidates.
    const report = await backfill(false).run();
    expect(report.windowStart).toBe("2026-09-15");
    expect(report.written).toBe(0);
    expect(report.outcomes.RECONSTRUCTED).toBeGreaterThanOrEqual(2);
    expect(report.outcomes.EXCLUDED_LIVE_QUOTE).toBeGreaterThanOrEqual(1);
    expect(report.outcomes.EXCLUDED_PRICE_MISMATCH).toBeGreaterThanOrEqual(1);
    expect(report.outcomes.EXCLUDED_LOGIC_MISMATCH).toBeGreaterThanOrEqual(1);
    expect(report.outcomes.EXCLUDED_DECISION_MISMATCH).toBeGreaterThanOrEqual(
      1,
    );
    for (const name of [
      "activation",
      "ending",
      "intraday",
      "repriced",
      "edited",
      "contradicted",
    ]) {
      expect(await evidenceOf(name)).toBeNull();
    }
  });

  it("records verified evidence once, stamped as reconstructed, and nothing else", async () => {
    const before = await prisma.monitorStateTransition.findUniqueOrThrow({
      where: { id: transitionIds.activation! },
    });
    const first = await backfill(true).run();
    expect(first.written).toBeGreaterThanOrEqual(2);

    expect(await evidenceOf("activation")).toEqual({
      v: 1,
      rules: [
        {
          ruleId: "buy-1",
          predicates: [
            {
              id: "c1",
              role: "CONDITION",
              result: "TRUE",
              metric: 101,
              value: 100,
            },
          ],
        },
      ],
      reconstructed: {
        at: now.toISOString(),
        by: "monitors:backfill-evidence",
      },
    });
    expect(await evidenceOf("ending")).toMatchObject({
      rules: [
        {
          ruleId: "buy-1",
          predicates: [{ id: "c1", result: "FALSE", metric: 98, value: 100 }],
        },
      ],
    });
    // The session, the processing time, the origin and the version are what they were.
    const after = await prisma.monitorStateTransition.findUniqueOrThrow({
      where: { id: transitionIds.activation! },
    });
    expect(after).toMatchObject({
      observationDate: before.observationDate,
      occurredAt: before.occurredAt,
      origin: before.origin,
      strategyVersionId: before.strategyVersionId,
      reason: before.reason,
    });
    // Unverifiable events stay without evidence, so the Dashboard leaves them out.
    for (const name of [
      "intraday",
      "repriced",
      "edited",
      "contradicted",
      "beforeWindow",
    ]) {
      expect(await evidenceOf(name)).toBeNull();
    }
    expect(await evidenceOf("recorded")).toEqual({ v: 1, rules: [] });

    // Idempotent: a second run finds nothing left to write for these.
    const again = await backfill(true).run();
    expect(again.outcomes.RECONSTRUCTED).toBe(
      first.outcomes.RECONSTRUCTED - first.written,
    );
    expect(again.written).toBe(0);
  });
});
