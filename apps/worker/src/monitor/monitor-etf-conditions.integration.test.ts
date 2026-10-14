import { randomUUID } from "node:crypto";
import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategyMetricSource,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  LocalDate,
  Security,
} from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  buildBenchmarkTechnicalContext,
  projectEvaluationFrame,
  withEtfOperandColumns,
  type BenchmarkHistory,
  type BenchmarkRefreshState,
} from "@intrinsic/stock-data";
import {
  collectEtfOperands,
  collectOperands,
  collectSectorOperands,
  Evaluability,
  evaluateMarketSignal,
} from "@intrinsic/strategy";
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
  return definitionWithSource({ kind: "ETF", code: etfCode as "ETF_XLK" });
}

/** The same two levels with the mixed level's second half read from any source. */
function definitionWithSource(source: StrategyMetricSource): StrategyDefinition {
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
                source,
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
    "holds the mixed level NOT_EVALUABLE intraday and while the bar is unconfirmed, activates it once the ETF bar is final and synchronized, " +
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

      // Monday evening, past the close and the publication delay, with a Monday bar already
      // stored — but the watermark still says Friday: no read has confirmed that bar since the
      // session finalized, so it may be the provisional mid-session reading. The clock alone is
      // not evidence, and the mixed level stays undecidable.
      etfLoader.barsBySeries.set(
        "series-etf_xlk",
        etfBars("series-etf_xlk", weekdaysBetween("2026-01-05", "2026-03-02")),
      );
      summary = await cycleOf(loader, SESSION_EVENING).run(2);
      expect(summary.signalsEmitted).toBe(0);
      expect(
        (await signalsOf(monitorId)).map((signal) => signal.levelId),
      ).toEqual(["buy-stock"]);

      // The refresh then reads the tail after Monday finalized, and the watermark proves it.
      // XLK's RSI on a strictly rising history is exactly 100, so the mixed level now decides
      // TRUE live and opens its own occurrence.
      etfLoader.lastTailSyncAt = "2026-03-02T21:45:00.000Z";

      summary = await cycleOf(loader, SESSION_EVENING).run(3);
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
      summary = await cycleOf(loader, SESSION_EVENING).run(4);
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
    await cycleOf(loader, SESSION_EVENING).run(5);
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

    const summary = await cycleOf(loader, SESSION_EVENING).run(6);
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

  it(
    "reconstructs a mixed level's activation on the completed session a backtest evaluation first holds",
    async () => {
      const { monitorId, security, loader } = await createFixtureMonitor();

      // The stock: flat at 100 for twenty sessions, then rising by one a session. Its Price is
      // equal to its SMA 20D — not above it — through Friday the 20th, and above it from Monday
      // the 23rd: the first rising close lifts the price by 1 and the average by a twentieth.
      const stock = flatHistory(security.id, 100).map((price, index) => {
        const close = index < 20 ? 100 : 100 + (index - 19);
        return { ...price, open: close, high: close, low: close, close };
      });
      expect(stock[19]!.date).toBe("2026-02-20");
      expect(stock[stock.length - 1]!.date).toBe("2026-02-27");
      loader.prices.set(security.id, stock);
      loader.currentPrice = 106;

      // XLK: lists on Thursday the 5th of February and only rises, so its RSI 14D first exists —
      // at exactly 100 — on its fifteenth session, Wednesday the 25th.
      const xlkSessions = weekdaysBetween("2026-02-05", "2026-03-02");
      expect(xlkSessions[14]).toBe("2026-02-25");
      etfLoader.barsBySeries.set(
        "series-etf_xlk",
        etfBars("series-etf_xlk", xlkSessions),
      );
      etfLoader.lastTailSyncAt = "2026-03-02T21:45:00.000Z";

      // One evening cycle on a Monitor with no state: both levels already match, so each is
      // reconstructed back to the session its occurrence began on.
      const summary = await cycleOf(loader, SESSION_EVENING).run(7);
      expect(summary.levelsReconstructed).toBe(2);
      const signals = await signalsOf(monitorId);
      const activation = (levelId: string) => {
        const signal = signals.find((row) => row.levelId === levelId)!;
        return {
          since: signal.observationDate.toISOString().slice(0, 10),
          reconstructed: signal.reconstructed,
          open: signal.resolvedAt === null,
        };
      };
      // The stock-only level began the session the stock rule first held …
      expect(activation("buy-stock")).toEqual({
        since: "2026-02-23",
        reconstructed: true,
        open: true,
      });
      // … and the mixed level two sessions later, when XLK's RSI first existed: the 23rd and the
      // 24th were undecidable for it, never matched on the stock half alone.
      expect(activation("buy-mixed")).toEqual({
        since: "2026-02-25",
        reconstructed: true,
        open: true,
      });

      // The backtest's own evaluation of the same completed sessions: the canonical backtest frame
      // over the same stock closes, the same ETF context joined by the same exact-date rule, and
      // the one market evaluator both engines call. It first holds on the very session the Monitor
      // recorded.
      const definition = definitionOf("ETF_XLK");
      const context = buildBenchmarkTechnicalContext({
        seriesId: "series-etf_xlk",
        history: await etfLoader.readFullBenchmarkHistory(
          await etfLoader.getSeries("series-etf_xlk"),
        ),
        refreshState: await etfLoader.benchmarkRefreshState(
          await etfLoader.getSeries("series-etf_xlk"),
        ),
        missingFromFloor: [],
        now: SESSION_EVENING,
        publicationDelayMs: etfContexts.publicationDelayMs,
      });
      expect(context.status).toBe("READY");
      if (context.status !== "READY") {
        return;
      }
      const closes = stock.map((price) => price.close);
      const backtestFrame = withEtfOperandColumns(
        projectEvaluationFrame({
          security,
          prices: stock,
          // The stock's SMA 20D as its materialized column holds it: the mean of twenty closes.
          derived: stock.map((price, index) => ({
            securityId: security.id,
            date: price.date,
            ...(index >= 19
              ? {
                  sma20d:
                    closes
                      .slice(index - 19, index + 1)
                      .reduce((sum, close) => sum + close, 0) / 20,
                }
              : {}),
          })),
          operands: collectOperands(definition),
          periodStart: stock[0]!.date,
        }).frame,
        [...(collectEtfOperands(definition).get("ETF_XLK") ?? [])],
        new Map([["ETF_XLK" as const, context.snapshot]]),
      );
      const firstHeld = (levelId: string) => {
        const signal = definition.buyLevels.find(
          (level) => level.id === levelId,
        )!.signal;
        return backtestFrame.dates.find(
          (_, index) =>
            evaluateMarketSignal(signal, backtestFrame, index) ===
            Evaluability.TRUE,
        );
      };
      expect(firstHeld("buy-stock")).toBe(activation("buy-stock").since);
      expect(firstHeld("buy-mixed")).toBe(activation("buy-mixed").since);
      // And between the two dates the mixed level is undecidable in the backtest frame as well —
      // not false, and not true on the stock half alone.
      const mixed = definition.buyLevels[1]!.signal;
      for (const date of ["2026-02-23", "2026-02-24"]) {
        expect(
          evaluateMarketSignal(
            mixed,
            backtestFrame,
            backtestFrame.dates.indexOf(date),
          ),
        ).toBe(Evaluability.NOT_EVALUABLE);
      }
    },
    30_000,
  );
});

/** Strictly falling ETF closes: Wilder RSI is exactly 0 once fifteen closes exist. */
function fallingEtfBars(seriesId: string, dates: readonly LocalDate[]): BenchmarkDailyPrice[] {
  return dates.map((date, index) => ({
    seriesId,
    date,
    open: 500 - index,
    high: 501 - index,
    low: 499 - index,
    close: 500 - index,
    volume: 1_000_000,
  }));
}

const STOCK_SECTOR_SOURCE: StrategyMetricSource = { kind: "STOCK_SECTOR" };

/**
 * One Monitor over several stocks, each stored with its own FMP sector (or none), reading the
 * definition given. The loader serves the same `Security` objects, so a test can reclassify a
 * stock between cycles exactly as a catalog synchronization would.
 */
async function createSectorMonitor(
  sectors: readonly (string | undefined)[],
  definition: StrategyDefinition,
): Promise<{
  monitorId: string;
  strategyId: string;
  securities: Security[];
  loader: FixtureLoader;
}> {
  const user = await prisma.user.create({
    data: { email: `sector-monitor-${randomUUID()}@example.test`, plan: "PRO" },
  });
  userIds.push(user.id);
  const securities: Security[] = [];
  for (const sector of sectors) {
    const unique = randomUUID().replaceAll("-", "").slice(0, 8);
    const row = await prisma.security.create({
      data: {
        providerSymbol: `SECT.${suffix}.${unique}`,
        symbol: `SECT${unique.slice(0, 4).toUpperCase()}`,
        name: "Stock's Sector Test",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
        ...(sector === undefined ? {} : { sector }),
      },
    });
    securityIds.push(row.id);
    securities.push({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      exchangeCode: row.exchangeCode,
      currency: row.currency,
      type: "STOCK",
      isAdr: false,
      isActivelyTrading: true,
      ...(sector === undefined ? {} : { sector }),
    });
  }
  const strategy = await prisma.strategy.create({
    data: {
      userId: user.id,
      name: `Sector Strategy ${randomUUID().slice(0, 8)}`,
      versions: {
        create: {
          versionNumber: 1,
          definition: definition as never,
          definitionHash: randomUUID(),
        },
      },
    },
  });
  const stockList = await prisma.stockList.create({
    data: {
      userId: user.id,
      name: `Sector List ${randomUUID().slice(0, 8)}`,
      items: { create: securities.map((security) => ({ securityId: security.id })) },
    },
  });
  const monitor = await prisma.monitor.create({
    data: {
      userId: user.id,
      name: `Sector Monitor ${randomUUID().slice(0, 8)}`,
      strategyId: strategy.id,
      stockListId: stockList.id,
      enabled: true,
    },
  });
  createdMonitorIds.push(monitor.id);

  const loader = new FixtureLoader(securities);
  for (const security of securities) {
    loader.prices.set(security.id, flatHistory(security.id, 100));
  }
  loader.currentPrice = 101;
  loader.historyFrames = true;
  return { monitorId: monitor.id, strategyId: strategy.id, securities, loader };
}

/** `levelId` of each open occurrence for one security, sorted. */
async function openLevels(monitorId: string, securityId: string): Promise<string[]> {
  return (await signalsOf(monitorId))
    .filter((signal) => signal.securityId === securityId && signal.resolvedAt === null)
    .map((signal) => signal.levelId)
    .sort();
}

describe("Stock's Sector conditions in a Monitor cycle", () => {
  function seedSectorFunds(): void {
    const sessions = weekdaysBetween("2026-01-05", "2026-03-02");
    // XLK rises (RSI 100), XLF falls (RSI 0); both carry Monday's bar.
    etfLoader.barsBySeries.set("series-etf_xlk", etfBars("series-etf_xlk", sessions));
    etfLoader.barsBySeries.set("series-etf_xlf", fallingEtfBars("series-etf_xlf", sessions));
  }

  it(
    "reads each stock's own sector ETF under the strict same-session rule, and nothing for a stock without one",
    async () => {
      seedSectorFunds();
      // Watermark still on Friday: Monday's ETF bars are stored but not proven final.
      etfLoader.lastTailSyncAt = "2026-02-27T22:00:00.000Z";
      const { monitorId, securities, loader } = await createSectorMonitor(
        ["Technology", "Financial Services", undefined, "Conglomerates"],
        definitionWithSource(STOCK_SECTOR_SOURCE),
      );
      const [tech, financial, unclassified, unsupported] = securities;

      // Intraday Monday: only the stock-only level, for every stock. The sector half of the mixed
      // level is undecidable everywhere — no finalized Monday bar of any fund yet.
      let summary = await cycleOf(loader, SESSION_INTRADAY).run(101);
      for (const security of securities) {
        expect(await openLevels(monitorId, security.id)).toEqual(["buy-stock"]);
      }

      // Evening, but still unconfirmed: nothing changes.
      summary = await cycleOf(loader, SESSION_EVENING).run(102);
      expect(summary.signalsEmitted).toBe(0);

      // The tail read confirms Monday. The Technology stock reads XLK (RSI 100): its mixed level
      // opens on Monday. The Financial Services stock reads XLF (RSI 0): its mixed level decides
      // FALSE on the very same session under the very same rule. The unclassified and the
      // unsupported stock read no fund: undecidable, never another ETF's reading.
      etfLoader.lastTailSyncAt = "2026-03-02T21:45:00.000Z";
      summary = await cycleOf(loader, SESSION_EVENING).run(103);
      expect(summary.signalsEmitted).toBe(1);
      expect(await openLevels(monitorId, tech!.id)).toEqual(["buy-mixed", "buy-stock"]);
      expect(await openLevels(monitorId, financial!.id)).toEqual(["buy-stock"]);
      expect(await openLevels(monitorId, unclassified!.id)).toEqual(["buy-stock"]);
      expect(await openLevels(monitorId, unsupported!.id)).toEqual(["buy-stock"]);
      const techMixed = (await signalsOf(monitorId)).find(
        (signal) => signal.securityId === tech!.id && signal.levelId === "buy-mixed",
      )!;
      expect(techMixed.observationDate.toISOString().slice(0, 10)).toBe("2026-03-02");

      // The states say what was decided: not matched for XLF, undecidable for the other two.
      const states = await prisma.monitorSignalState.findMany({
        where: { monitorId, levelId: "buy-mixed" },
      });
      const outcomeOf = (securityId: string) =>
        states.find((state) => state.securityId === securityId)?.lastOutcome ?? null;
      expect(outcomeOf(tech!.id)).toBe("MATCHED");
      expect(outcomeOf(financial!.id)).toBe("NOT_MATCHED");
      expect([null, "NOT_EVALUABLE"]).toContain(outcomeOf(unclassified!.id));
      expect([null, "NOT_EVALUABLE"]).toContain(outcomeOf(unsupported!.id));

      // A retried evening cycle re-derives the same conclusions and writes nothing new.
      const before = (await signalsOf(monitorId)).length;
      summary = await cycleOf(loader, SESSION_EVENING).run(104);
      expect(summary.signalsEmitted).toBe(0);
      expect(summary.signalsResolved).toBe(0);
      expect((await signalsOf(monitorId)).length).toBe(before);
    },
    30_000,
  );

  it(
    "applies a sector reclassified between two scans on the next scan, deterministically, and holds an undecidable one",
    async () => {
      seedSectorFunds();
      etfLoader.lastTailSyncAt = "2026-03-02T21:45:00.000Z";
      const { monitorId, securities, loader } = await createSectorMonitor(
        ["Technology"],
        definitionWithSource(STOCK_SECTOR_SOURCE),
      );
      const stock = securities[0]!;

      await cycleOf(loader, SESSION_EVENING).run(111);
      expect(await openLevels(monitorId, stock.id)).toEqual(["buy-mixed", "buy-stock"]);

      // Reclassified as Financial Services between scans. The next scan reads XLF, whose RSI is 0:
      // the mixed level's conditions end, by the normal lifecycle — the definition did not change,
      // so this is an ordinary data change, not a logic change.
      // (The loader serves this object as the cycle's catalog read.)
      stock.sector = "Financial Services";
      let summary = await cycleOf(loader, SESSION_EVENING).run(112);
      expect(summary.signalsResolved).toBe(1);
      expect(await openLevels(monitorId, stock.id)).toEqual(["buy-stock"]);
      const ended = (await signalsOf(monitorId)).find(
        (signal) => signal.levelId === "buy-mixed" && signal.resolvedAt !== null,
      )!;
      expect(ended.resolutionReason).toBe("CONDITIONS_ENDED");

      // The same scan retried decides the same: nothing more is written.
      summary = await cycleOf(loader, SESSION_EVENING).run(113);
      expect(summary.signalsEmitted).toBe(0);
      expect(summary.signalsResolved).toBe(0);

      // Back to Technology: a fresh occurrence opens, read from XLK again.
      stock.sector = "Technology";
      summary = await cycleOf(loader, SESSION_EVENING).run(114);
      expect(summary.signalsEmitted).toBe(1);
      expect(await openLevels(monitorId, stock.id)).toEqual(["buy-mixed", "buy-stock"]);

      // The sector then disappears: the rule is undecidable, which advances nothing — the open
      // occurrence is neither closed nor confirmed by a fund the stock no longer maps to.
      delete stock.sector;
      summary = await cycleOf(loader, SESSION_EVENING).run(115);
      expect(summary.signalsEmitted).toBe(0);
      expect(summary.signalsResolved).toBe(0);
      expect(await openLevels(monitorId, stock.id)).toEqual(["buy-mixed", "buy-stock"]);
      const state = await prisma.monitorSignalState.findFirst({
        where: { monitorId, securityId: stock.id, levelId: "buy-mixed" },
      });
      expect(state?.lastOutcome).toBe("NOT_EVALUABLE");
    },
    30_000,
  );

  it("latches per source: a named XLK rule switched to Stock's Sector is a logic change, even for a Technology stock", async () => {
    seedSectorFunds();
    etfLoader.lastTailSyncAt = "2026-03-02T21:45:00.000Z";
    const { monitorId, strategyId, securities, loader } = await createSectorMonitor(
      ["Technology"],
      definitionOf("ETF_XLK"),
    );
    const stock = securities[0]!;
    await cycleOf(loader, SESSION_EVENING).run(121);
    const stockSignalId = (await signalsOf(monitorId)).find(
      (signal) => signal.levelId === "buy-stock",
    )!.id;
    expect(await openLevels(monitorId, stock.id)).toEqual(["buy-mixed", "buy-stock"]);

    // Stock's Sector resolves to XLK for this stock — the same readings — but it is a different
    // rule (it would read XLF for a bank), so the fingerprint moves and only that level resets.
    await prisma.strategyVersion.create({
      data: {
        strategyId,
        versionNumber: 2,
        definition: definitionWithSource(STOCK_SECTOR_SOURCE) as never,
        definitionHash: randomUUID(),
      },
    });
    const summary = await cycleOf(loader, SESSION_EVENING).run(122);
    expect(summary.signalsResolved).toBe(1);
    expect(summary.signalsEmitted).toBe(1);
    const mixed = (await signalsOf(monitorId)).filter(
      (signal) => signal.levelId === "buy-mixed",
    );
    expect(mixed.find((signal) => signal.resolvedAt !== null)?.resolutionReason).toBe(
      "LOGIC_CHANGED",
    );
    expect(mixed.filter((signal) => signal.resolvedAt === null)).toHaveLength(1);
    expect(
      (await signalsOf(monitorId)).find((signal) => signal.levelId === "buy-stock")!.id,
    ).toBe(stockSignalId);
  });

  it(
    "reconstructs a Stock's Sector activation on the completed session a backtest evaluation first holds",
    async () => {
      const definition = definitionWithSource(STOCK_SECTOR_SOURCE);
      const { monitorId, securities, loader } = await createSectorMonitor(
        ["Technology"],
        definition,
      );
      const security = securities[0]!;
      // The stock rises from Monday the 23rd (as in the named-ETF reconstruction case above).
      const stock = flatHistory(security.id, 100).map((price, index) => {
        const close = index < 20 ? 100 : 100 + (index - 19);
        return { ...price, open: close, high: close, low: close, close };
      });
      loader.prices.set(security.id, stock);
      loader.currentPrice = 106;
      // XLK lists on the 5th of February: RSI 14D first exists on the 25th.
      const xlkSessions = weekdaysBetween("2026-02-05", "2026-03-02");
      etfLoader.barsBySeries.set("series-etf_xlk", etfBars("series-etf_xlk", xlkSessions));
      etfLoader.lastTailSyncAt = "2026-03-02T21:45:00.000Z";

      const summary = await cycleOf(loader, SESSION_EVENING).run(131);
      expect(summary.levelsReconstructed).toBe(2);
      const since = (levelId: string) =>
        signalsOf(monitorId).then((rows) =>
          rows
            .find((row) => row.levelId === levelId)!
            .observationDate.toISOString()
            .slice(0, 10),
        );
      expect(await since("buy-stock")).toBe("2026-02-23");
      expect(await since("buy-mixed")).toBe("2026-02-25");

      // The backtest's evaluation of the same sessions: the same frame, the Stock's Sector columns
      // joined from the stock's sector ETF by the same exact-date rule.
      const context = buildBenchmarkTechnicalContext({
        seriesId: "series-etf_xlk",
        history: await etfLoader.readFullBenchmarkHistory(
          await etfLoader.getSeries("series-etf_xlk"),
        ),
        refreshState: await etfLoader.benchmarkRefreshState(
          await etfLoader.getSeries("series-etf_xlk"),
        ),
        missingFromFloor: [],
        now: SESSION_EVENING,
        publicationDelayMs: etfContexts.publicationDelayMs,
      });
      if (context.status !== "READY") {
        throw new Error(`fixture not ready: ${context.status}`);
      }
      const closes = stock.map((price) => price.close);
      const backtestFrame = withEtfOperandColumns(
        projectEvaluationFrame({
          security,
          prices: stock,
          derived: stock.map((price, index) => ({
            securityId: security.id,
            date: price.date,
            ...(index >= 19
              ? {
                  sma20d:
                    closes
                      .slice(index - 19, index + 1)
                      .reduce((sum, close) => sum + close, 0) / 20,
                }
              : {}),
          })),
          operands: collectOperands(definition),
          periodStart: stock[0]!.date,
        }).frame,
        collectSectorOperands(definition),
        new Map([["ETF_XLK" as const, context.snapshot]]),
        "ETF_XLK",
      );
      const firstHeld = (levelId: string) => {
        const signal = definition.buyLevels.find((level) => level.id === levelId)!.signal;
        return backtestFrame.dates.find(
          (_, index) =>
            evaluateMarketSignal(signal, backtestFrame, index) === Evaluability.TRUE,
        );
      };
      expect(firstHeld("buy-stock")).toBe("2026-02-23");
      expect(firstHeld("buy-mixed")).toBe("2026-02-25");
    },
    30_000,
  );
});
