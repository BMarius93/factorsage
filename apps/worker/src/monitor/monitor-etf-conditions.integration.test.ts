import { randomUUID } from "node:crypto";
import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  LocalDate,
  Security,
} from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import type {
  BenchmarkHistory,
  BenchmarkRefreshState,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EtfContextLoader } from "../shared/etf-context.js";
import { MonitorCycle, type MonitorEtfContexts } from "./monitor-cycle.js";
import {
  FixtureCalendar,
  FixtureLoader,
  flatHistory,
} from "./monitor-fixtures.test-helper.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * ETF-sourced Conditions through a real Monitor cycle against real PostgreSQL: the strict
 * same-session rule (owner decision 1) — an ETF condition is NOT_EVALUABLE for the current session
 * until the ETF's end-of-day bar is finalized **and** synchronized, and nothing is carried forward
 * — plus source-specific latches, retry idempotence, and the stock-only level beside it staying
 * exactly as it was.
 */

const prisma = new PrismaClient();
const repository = new PrismaMonitorRepository(prisma);
const logger = createLogger({ service: "worker", level: "silent" });
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

const userIds: string[] = [];
const securityIds: string[] = [];
const createdMonitorIds: string[] = [];

/** Monday 2026-03-02, 10:00 New York: a regular session, after every fixture bar. */
const SESSION_INTRADAY = new Date("2026-03-02T15:00:00.000Z");
/**
 * The same Monday at 17:00 New York: past the 16:00 close plus the 30-minute publication delay
 * (21:30Z under EST), so the session's ETF bar can be final once a read confirms it.
 */
const SESSION_EVENING = new Date("2026-03-02T22:00:00.000Z");

function weekdaysBetween(from: string, to: string): LocalDate[] {
  const dates: LocalDate[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10) as LocalDate);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Strictly rising ETF closes: Wilder RSI is exactly 100 once fifteen closes exist. */
function etfBars(seriesId: string, dates: readonly LocalDate[]): BenchmarkDailyPrice[] {
  return dates.map((date, index) => ({
    seriesId,
    date,
    open: 200 + index,
    high: 201 + index,
    low: 199 + index,
    close: 200 + index,
    volume: 1_000_000,
  }));
}

/** A mutable ETF context fixture: tests extend the history and advance the sync watermark. */
class FixtureEtfContexts implements EtfContextLoader {
  readonly barsBySeries = new Map<string, BenchmarkDailyPrice[]>();
  lastTailSyncAt = "2026-02-27T22:00:00.000Z";

  async getSeries(seriesId: string): Promise<BenchmarkSeries> {
    return {
      id: seriesId,
      benchmarkId: `benchmark-${seriesId}`,
      version: 1,
      sourceKind: "FMP_SYMBOL",
      seriesType: "ETF_PROXY",
      providerSymbol: seriesId,
      currency: "USD",
      methodologyVersion: 1,
    };
  }

  async readFullBenchmarkHistory(series: BenchmarkSeries): Promise<BenchmarkHistory> {
    return {
      seriesId: series.id,
      basisGeneration: 0,
      rows: [...(this.barsBySeries.get(series.id) ?? [])],
      missing: [],
      source: "POSTGRESQL",
    };
  }

  async benchmarkRefreshState(series: BenchmarkSeries): Promise<BenchmarkRefreshState> {
    const bars = this.barsBySeries.get(series.id) ?? [];
    const latest = bars[bars.length - 1]?.date;
    return {
      coverageEnd: latest,
      latestBar: latest,
      lastTailSyncAt: this.lastTailSyncAt,
    };
  }

  async missingBenchmarkCoverage(): Promise<never[]> {
    return [];
  }
}

const etfLoader = new FixtureEtfContexts();
const etfContexts: MonitorEtfContexts = {
  loader: etfLoader,
  resolveSeriesId: async (code) => `series-${code.toLowerCase()}`,
  publicationDelayMs: 30 * 60 * 1000,
};

function cycleOf(loader: FixtureLoader, now: Date): MonitorCycle {
  return new MonitorCycle(
    repository,
    loader,
    new FixtureCalendar(),
    logger,
    {
      symbolConcurrency: 4,
      quoteMaxAgeMs: 4 * 24 * 60 * 60_000,
      now: () => now,
    },
    etfContexts,
  );
}

/** Two BUY levels: a stock-only control, and the mixed Stock + XLK level under test. */
function definitionOf(etfCode: string): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-stock",
        percentage: 25,
        signal: {
          conditions: [
            {
              id: "c-stock-only",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_20D" },
            },
          ],
        },
      },
      {
        id: "buy-mixed",
        percentage: 25,
        signal: {
          conditions: [
            {
              id: "c-stock-half",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_20D" },
            },
            {
              id: "c-etf-half",
              metric: {
                kind: "OSCILLATOR",
                seriesId: "RSI_14D",
                source: { kind: "ETF", code: etfCode as "ETF_XLK" },
              },
              operator: "IS_ABOVE",
              value: { kind: "NUMBER", value: 50 },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  };
}

const foreignEnabledMonitorIds: string[] = [];
const foreignSystemMonitorIds: string[] = [];

beforeAll(async () => {
  const foreign = await prisma.monitor.findMany({
    where: { ownership: "USER", enabled: true },
    select: { id: true },
  });
  foreignEnabledMonitorIds.push(...foreign.map((row) => row.id));
  if (foreignEnabledMonitorIds.length > 0) {
    await prisma.monitor.updateMany({
      where: { id: { in: foreignEnabledMonitorIds } },
      data: { enabled: false },
    });
  }
  const system = await prisma.monitor.findMany({
    where: { ownership: "SYSTEM", isGloballyEnabled: true },
    select: { id: true },
  });
  foreignSystemMonitorIds.push(...system.map((row) => row.id));
  if (foreignSystemMonitorIds.length > 0) {
    await prisma.monitor.updateMany({
      where: { id: { in: foreignSystemMonitorIds } },
      data: { isGloballyEnabled: false },
    });
  }
});

afterEach(async () => {
  await prisma.monitor.updateMany({
    where: { id: { in: createdMonitorIds } },
    data: { enabled: false },
  });
});

afterAll(async () => {
  if (foreignEnabledMonitorIds.length > 0) {
    await prisma.monitor.updateMany({
      where: { id: { in: foreignEnabledMonitorIds } },
      data: { enabled: true },
    });
  }
  if (foreignSystemMonitorIds.length > 0) {
    await prisma.monitor.updateMany({
      where: { id: { in: foreignSystemMonitorIds } },
      data: { isGloballyEnabled: true },
    });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
  await prisma.$disconnect();
});

async function createFixtureMonitor(): Promise<{
  monitorId: string;
  strategyId: string;
  security: Security;
  loader: FixtureLoader;
}> {
  const user = await prisma.user.create({
    data: { email: `etf-monitor-${randomUUID()}@example.test`, plan: "PRO" },
  });
  userIds.push(user.id);
  const unique = randomUUID().replaceAll("-", "").slice(0, 8);
  const row = await prisma.security.create({
    data: {
      providerSymbol: `ETFC.${suffix}.${unique}`,
      symbol: `ETFC${unique.slice(0, 4).toUpperCase()}`,
      name: "ETF Conditions Test",
      exchangeCode: "NASDAQ",
      currency: "USD",
      type: SecurityType.STOCK,
      isAdr: false,
      isActivelyTrading: true,
    },
  });
  securityIds.push(row.id);
  const security: Security = {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    exchangeCode: row.exchangeCode,
    currency: row.currency,
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
  };
  const strategy = await prisma.strategy.create({
    data: {
      userId: user.id,
      name: `ETF Strategy ${randomUUID().slice(0, 8)}`,
      versions: {
        create: {
          versionNumber: 1,
          definition: definitionOf("ETF_XLK") as never,
          definitionHash: randomUUID(),
        },
      },
    },
  });
  const stockList = await prisma.stockList.create({
    data: {
      userId: user.id,
      name: `ETF List ${randomUUID().slice(0, 8)}`,
      items: { create: [{ securityId: security.id }] },
    },
  });
  const monitor = await prisma.monitor.create({
    data: {
      userId: user.id,
      name: `ETF Monitor ${randomUUID().slice(0, 8)}`,
      strategyId: strategy.id,
      stockListId: stockList.id,
      enabled: true,
    },
  });
  createdMonitorIds.push(monitor.id);

  const loader = new FixtureLoader([security]);
  // Flat closed history at 100 with a live quote of 101: the stock's Price is above its SMA 20D
  // on the provisional observation and never historically, so activation is live, not replayed.
  loader.prices.set(security.id, flatHistory(security.id, 100));
  loader.currentPrice = 101;
  loader.historyFrames = true;
  return { monitorId: monitor.id, strategyId: strategy.id, security, loader };
}

async function signalsOf(monitorId: string) {
  return prisma.monitorSignal.findMany({
    where: { monitorId },
    orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
  });
}

describe("ETF-sourced Conditions in a Monitor cycle", () => {
  it(
    "holds the mixed level NOT_EVALUABLE intraday, activates it once the ETF bar is final and synchronized, " +
      "and never disturbs the stock-only level",
    async () => {
      // XLK's history ends on Friday the 27th, synchronized after Friday finalized.
      etfLoader.barsBySeries.set(
        "series-etf_xlk",
        etfBars("series-etf_xlk", weekdaysBetween("2026-01-05", "2026-02-27")),
      );
      etfLoader.lastTailSyncAt = "2026-02-27T22:00:00.000Z";

      const { monitorId, loader } = await createFixtureMonitor();

      // Intraday on Monday: the stock-only level activates against the live quote; the mixed
      // level's ETF half has no finalized Monday bar, so the whole level is undecidable — no
      // Signal, no state row, no yesterday's RSI standing in.
      let summary = await cycleOf(loader, SESSION_INTRADAY).run(1);
      expect(summary.monitors).toBe(1);
      let signals = await signalsOf(monitorId);
      expect(signals.map((signal) => signal.levelId)).toEqual(["buy-stock"]);
      const stockSignalId = signals[0]!.id;

      // The same Monday evening: the refresh landed Monday's bar and the watermark proves a read
      // after it finalized. XLK's RSI on a strictly rising history is exactly 100, so the mixed
      // level now decides TRUE live and opens its own occurrence.
      etfLoader.barsBySeries.set(
        "series-etf_xlk",
        etfBars("series-etf_xlk", weekdaysBetween("2026-01-05", "2026-03-02")),
      );
      etfLoader.lastTailSyncAt = "2026-03-02T21:45:00.000Z";

      summary = await cycleOf(loader, SESSION_EVENING).run(2);
      expect(summary.signalsEmitted).toBe(1);
      signals = await signalsOf(monitorId);
      expect(signals.map((signal) => signal.levelId).sort()).toEqual([
        "buy-mixed",
        "buy-stock",
      ]);
      const mixed = signals.find((signal) => signal.levelId === "buy-mixed")!;
      expect(mixed.observationDate.toISOString().slice(0, 10)).toBe(
        "2026-03-02",
      );
      expect(mixed.resolvedAt).toBeNull();
      // The stock-only occurrence is the same row, untouched by the ETF level's lifecycle.
      expect(
        signals.find((signal) => signal.levelId === "buy-stock")!.id,
      ).toBe(stockSignalId);

      // A retried evening cycle re-derives the same conclusions and writes nothing new.
      summary = await cycleOf(loader, SESSION_EVENING).run(3);
      expect(summary.signalsEmitted).toBe(0);
      expect(summary.signalsResolved).toBe(0);
      expect((await signalsOf(monitorId)).length).toBe(2);
    },
    30_000,
  );

  it("latches per source: changing the condition's ETF resets only the mixed level", async () => {
    etfLoader.barsBySeries.set(
      "series-etf_xlk",
      etfBars("series-etf_xlk", weekdaysBetween("2026-01-05", "2026-03-02")),
    );
    etfLoader.barsBySeries.set(
      "series-etf_xlf",
      etfBars("series-etf_xlf", weekdaysBetween("2026-01-05", "2026-03-02")),
    );
    etfLoader.lastTailSyncAt = "2026-03-02T21:45:00.000Z";

    const { monitorId, strategyId, loader } = await createFixtureMonitor();
    await cycleOf(loader, SESSION_EVENING).run(4);
    const before = await signalsOf(monitorId);
    expect(before.map((signal) => signal.levelId).sort()).toEqual([
      "buy-mixed",
      "buy-stock",
    ]);
    const stockSignalId = before.find((signal) => signal.levelId === "buy-stock")!.id;

    // The owner edits the mixed level's source from XLK to XLF: same identity, same threshold,
    // different ETF — a different condition, so only that level's latch moves.
    await prisma.strategyVersion.create({
      data: {
        strategyId,
        versionNumber: 2,
        definition: definitionOf("ETF_XLF") as never,
        definitionHash: randomUUID(),
      },
    });

    const summary = await cycleOf(loader, SESSION_EVENING).run(5);
    expect(summary.signalsResolved).toBe(1);
    expect(summary.signalsEmitted).toBe(1);
    const after = await signalsOf(monitorId);
    // The XLK occurrence closed on the logic change; a fresh XLF occurrence is live; the
    // stock-only occurrence never moved.
    const mixedSignals = after.filter((signal) => signal.levelId === "buy-mixed");
    expect(mixedSignals).toHaveLength(2);
    // Both cycles run on one injected clock, so `detectedAt` ties: the two occurrences are named
    // by what happened to them, not by a query order PostgreSQL is free to break.
    const resolved = mixedSignals.find((signal) => signal.resolvedAt !== null);
    const live = mixedSignals.find((signal) => signal.resolvedAt === null);
    expect(resolved?.resolutionReason).toBe("LOGIC_CHANGED");
    expect(live).toBeDefined();
    expect(
      after.find((signal) => signal.levelId === "buy-stock")!.id,
    ).toBe(stockSignalId);
  }, 30_000);
});
