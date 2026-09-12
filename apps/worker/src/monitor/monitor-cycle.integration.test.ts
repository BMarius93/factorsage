import { randomUUID } from "node:crypto";
import {
  normalizeStrategyDefinition,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { DailyPrice, Security, SecurityId } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  CachedTradingCalendar,
  monitorWindowObservations,
  projectMonitorEvaluationFrame,
  requiredDailySeries,
  type CurrentObservation,
  type MonitorEvaluationFrame,
  type TradingCalendar,
} from "@intrinsic/stock-data";
import { PRICE_OPERAND, seriesOperand, type OperandKey } from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonitorCycle, type MonitorDataLoader } from "./monitor-cycle.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * Monitor evaluation against real PostgreSQL.
 *
 * The durable behaviour is the whole reason the state is a table rather than a cache, so none of it
 * is faked: the repository, the transitions, the optimistic guard and the Signal rows are the real
 * ones. Only two boundaries are replaced — the market-data reads and the provider quote — because
 * this suite is about what a Monitor *decides*, and deterministic prices are what let it assert a
 * `false -> true -> true -> false` sequence exactly.
 *
 * The frames themselves are still built by the canonical `projectMonitorEvaluationFrame`, so the
 * provisional-observation semantics under test here are the production ones.
 */

const prisma = new PrismaClient();
const repository = new PrismaMonitorRepository(prisma);
const logger = createLogger({ service: "worker", level: "silent" });
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

const EMA_SERIES = "SMA_20D";
const userIds: string[] = [];
const securityIds: string[] = [];
/**
 * Every Monitor this file creates.
 *
 * A cycle is deliberately global — it evaluates every enabled Monitor there is — so each test
 * disables its own afterwards. Without that, a later test's cycle would also re-evaluate every
 * earlier test's Monitor and its summary counts would describe the whole file.
 */
const createdMonitorIds: string[] = [];

/**
 * A loader driven by a fixed price history and a settable current price.
 *
 * It counts what it was asked for, which is how the "several Monitors share one symbol snapshot"
 * expectation is asserted without reaching into the cycle's private state.
 */
class FixtureLoader implements MonitorDataLoader {
  prices = new Map<SecurityId, DailyPrice[]>();
  currentPrice: number | null = null;
  currentDataError: Error | null = null;
  quotedAt: string | undefined = undefined;

  prepareCalls: string[] = [];
  frameCalls: string[] = [];
  quoteCalls = 0;
  lastRequestedOperands = new Map<SecurityId, readonly OperandKey[]>();
  lastRequestedObservations = new Map<SecurityId, number>();

  constructor(private readonly securities: Security[]) {}

  resetCounters(): void {
    this.prepareCalls = [];
    this.frameCalls = [];
    this.quoteCalls = 0;
  }

  async findSecurities(ids: readonly SecurityId[]): Promise<Security[]> {
    return this.securities.filter((security) => ids.includes(security.id));
  }

  async getCurrentObservations(
    securities: readonly Security[],
  ): Promise<Map<SecurityId, CurrentObservation>> {
    this.quoteCalls += 1;
    if (this.currentDataError) {
      throw this.currentDataError;
    }
    const observations = new Map<SecurityId, CurrentObservation>();
    if (this.currentPrice === null) {
      return observations;
    }
    for (const security of securities) {
      observations.set(security.id, {
        price: this.currentPrice,
        ...(this.quotedAt === undefined ? {} : { quotedAt: this.quotedAt }),
      });
    }
    return observations;
  }

  async prepareMonitorEvaluationData(
    security: Security,
    observations: number,
    _asOf: string,
  ): Promise<void> {
    this.prepareCalls.push(security.id);
    this.lastRequestedObservations.set(security.id, observations);
  }

  async readMonitorEvaluationFrame(input: {
    security: Security;
    operands: readonly OperandKey[];
    observations: number;
    asOf: string;
    observation: CurrentObservation | null;
    observationDate: string;
  }): Promise<MonitorEvaluationFrame | null> {
    this.frameCalls.push(input.security.id);
    this.lastRequestedOperands.set(input.security.id, input.operands);
    const prices = this.prices.get(input.security.id) ?? [];
    // The date the cycle computed, not one the fixture picks. Substituting here would make the
    // session-dating half of production unobservable: deriving the observation date in UTC instead
    // of the exchange's own clock would not fail a single test in this file.
    return projectMonitorEvaluationFrame({
      security: input.security,
      prices,
      derived: [],
      operands: input.operands,
      observation: input.observation,
      observationDate: input.observationDate,
    });
  }

  monitorWindowObservations(operands: readonly OperandKey[]): number {
    return monitorWindowObservations(requiredDailySeries(operands));
  }
}

/** A plausible year of full closures, so the calendar's plausibility floor is satisfied. */
const FULL_YEAR_2026 = [
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
].map((date) => ({ date, fullClose: true }));

/**
 * A calendar the tests drive: every weekday is a session unless named as a full close.
 *
 * It counts its calls, which is how "one schedule per exchange, not per symbol" is asserted without
 * reaching into the production cache.
 */
class FixtureCalendar implements TradingCalendar {
  fullCloses = new Set<string>();
  failure: Error | null = null;
  calls: string[] = [];

  async isTradingSession(exchangeCode: string, date: string): Promise<boolean> {
    this.calls.push(`${exchangeCode} ${date}`);
    if (this.failure) {
      throw this.failure;
    }
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day === 0 || day === 6) {
      return false;
    }
    return !this.fullCloses.has(date);
  }
}

/** Twenty-five flat weekday closes, so a 20-bar SMA is warmed up and exactly equal to `close`. */
function flatHistory(securityId: string, close: number): DailyPrice[] {
  const prices: DailyPrice[] = [];
  const cursor = new Date("2026-01-26T00:00:00.000Z"); // a Monday
  for (let index = 0; index < 25; index += 1) {
    prices.push({
      securityId,
      date: cursor.toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000,
    });
    do {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  }
  return prices;
}

/**
 * Twenty-five rising weekday closes.
 *
 * The last closed day is already well above its own 20-bar average, so `previousMetric <=
 * previousValue` is false there — which is what makes "the price is on the post-cross side but did
 * not cross today" expressible. A flat history cannot express it: price equals the average exactly,
 * and `<=` holds on every bar.
 */
function risingHistory(securityId: string): DailyPrice[] {
  return flatHistory(securityId, 0).map((price, index) => {
    const close = 100 + index * 2;
    return { ...price, open: close, high: close, low: close, close };
  });
}

/** `Price is above SMA20D`, with a caller-supplied condition id: ids are unique document-wide. */
function priceAboveSmaSignal(conditionId: string): StrategySignal {
  return {
    conditions: [
      {
        id: conditionId,
        metric: { kind: "PRICE" },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: EMA_SERIES },
      },
    ],
  };
}

function priceAboveSmaDefinition(): StrategyDefinition {
  return {
    schemaVersion: 1,
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
              value: { kind: "SERIES", seriesId: EMA_SERIES },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  };
}

function priceCrossesAboveSmaDefinition(): StrategyDefinition {
  return {
    schemaVersion: 1,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [],
          trigger: {
            id: "t1",
            metric: { kind: "PRICE" },
            operator: "CROSSES_ABOVE",
            value: { kind: "SERIES", seriesId: EMA_SERIES },
          },
        },
      },
    ],
    sellLevels: [],
  };
}

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `monitor-${randomUUID()}@example.test` },
  });
  userIds.push(user.id);
  return user.id;
}

async function createSecurity(
  symbol: string,
  exchangeCode = "NASDAQ",
): Promise<Security> {
  const row = await prisma.security.create({
    data: {
      providerSymbol: `${symbol}.${suffix}`,
      symbol,
      name: `${symbol} Test`,
      exchangeCode,
      currency: "USD",
      type: SecurityType.STOCK,
      isAdr: false,
      isActivelyTrading: true,
    },
  });
  securityIds.push(row.id);
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    exchangeCode: row.exchangeCode,
    currency: row.currency,
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
  };
}

async function createMonitor(input: {
  userId: string;
  definition: StrategyDefinition;
  securities: readonly Security[];
  enabled?: boolean;
}): Promise<{ monitorId: string; strategyId: string }> {
  const strategy = await prisma.strategy.create({
    data: {
      userId: input.userId,
      name: `Strategy ${randomUUID().slice(0, 8)}`,
      versions: {
        create: {
          versionNumber: 1,
          definition: input.definition as never,
          definitionHash: randomUUID(),
        },
      },
    },
  });
  const stockList = await prisma.stockList.create({
    data: {
      userId: input.userId,
      name: `List ${randomUUID().slice(0, 8)}`,
      items: {
        create: input.securities.map((security) => ({
          securityId: security.id,
        })),
      },
    },
  });
  const monitor = await prisma.monitor.create({
    data: {
      userId: input.userId,
      name: `Monitor ${randomUUID().slice(0, 8)}`,
      strategyId: strategy.id,
      stockListId: stockList.id,
      enabled: input.enabled ?? true,
    },
  });
  createdMonitorIds.push(monitor.id);
  return { monitorId: monitor.id, strategyId: strategy.id };
}

/**
 * 10:00 New York on Monday 2026-03-02 — a regular session, after the last bar `flatHistory` writes.
 *
 * Every cycle runs on an injected clock rather than the wall clock, so a test names a session by
 * moving time and the cycle derives the observation date exactly as production does. Reading the
 * real clock instead would make the suite's behaviour depend on the day it is run — and on a
 * Saturday the weekend guard would refuse every provisional bar.
 */
const SESSION_ONE = new Date("2026-03-02T15:00:00.000Z");

function cycleOf(
  loader: MonitorDataLoader,
  now: Date = SESSION_ONE,
  calendar: TradingCalendar = new FixtureCalendar(),
): MonitorCycle {
  return new MonitorCycle(repository, loader, calendar, logger, {
    symbolConcurrency: 4,
    quoteMaxAgeMs: 4 * 24 * 60 * 60_000,
    now: () => now,
  });
}

/** The same clock time on a later day, for driving a session rollover. */
function sessionOn(date: string): Date {
  return new Date(`${date}T15:00:00.000Z`);
}

async function signalsOf(monitorId: string) {
  return prisma.monitorSignal.findMany({
    where: { monitorId },
    orderBy: { detectedAt: "asc" },
  });
}

let cycleSequence = 0;
function nextCycle(): number {
  cycleSequence += 1;
  return cycleSequence;
}

afterEach(async () => {
  await prisma.monitor.updateMany({
    where: { id: { in: createdMonitorIds } },
    data: { enabled: false },
  });
});

afterAll(async () => {
  await prisma.monitorSignalState.deleteMany({
    where: { securityId: { in: securityIds } },
  });
  await prisma.monitorSignal.deleteMany({
    where: { securityId: { in: securityIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
  await prisma.$disconnect();
});

describe("monitor evaluation cycle", () => {
  beforeEach(() => {
    cycleSequence = 0;
  });

  it("evaluates an enabled Monitor and ignores a disabled one", async () => {
    const userId = await createUser();
    const security = await createSecurity(`ENA${suffix.slice(0, 4)}`);
    const enabled = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });
    const disabled = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
      enabled: false,
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    const summary = await cycleOf(loader).run(nextCycle());

    expect(summary.monitors).toBe(1);
    expect(await signalsOf(enabled.monitorId)).toHaveLength(1);
    // A disabled Monitor is not evaluated at all: no Signal, and no state row to resume from.
    expect(await signalsOf(disabled.monitorId)).toHaveLength(0);
    expect(
      await prisma.monitorSignalState.count({
        where: { monitorId: disabled.monitorId },
      }),
    ).toBe(0);
  });

  it("re-enabling resumes from persisted state instead of re-emitting", async () => {
    const userId = await createUser();
    const security = await createSecurity(`RES${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    await cycleOf(loader).run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);

    await prisma.monitor.update({
      where: { id: monitorId },
      data: { enabled: false },
    });
    await cycleOf(loader).run(nextCycle());
    await prisma.monitor.update({
      where: { id: monitorId },
      data: { enabled: true },
    });
    await cycleOf(loader).run(nextCycle());

    // The match never stopped being true, so re-enabling continues it rather than starting a
    // second Signal for the same state.
    expect(await signalsOf(monitorId)).toHaveLength(1);
  });

  it("shares one symbol snapshot across Monitors watching it", async () => {
    const userId = await createUser();
    const security = await createSecurity(`SHR${suffix.slice(0, 4)}`);
    await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });
    await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });
    await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    const summary = await cycleOf(loader).run(nextCycle());

    expect(summary.monitors).toBe(3);
    expect(summary.symbols).toBe(1);
    // Three Monitors, one hydration, one projection, one batched quote request.
    expect(loader.prepareCalls).toEqual([security.id]);
    expect(loader.frameCalls).toEqual([security.id]);
    expect(loader.quoteCalls).toBe(1);
  });

  it("aggregates the union of required series and asks for nothing else", async () => {
    const userId = await createUser();
    const security = await createSecurity(`AGG${suffix.slice(0, 4)}`);
    await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });
    await createMonitor({
      userId,
      definition: {
        schemaVersion: 1,
        buyLevels: [
          {
            id: "buy-1",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "c1",
                  metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                  operator: "IS_BELOW",
                  value: { kind: "NUMBER", value: 30 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      },
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    await cycleOf(loader).run(nextCycle());

    const requested = loader.lastRequestedOperands.get(security.id) ?? [];
    expect(requested).toContain(PRICE_OPERAND);
    expect(requested).toContain(seriesOperand("SMA_20D"));
    expect(requested).toContain(seriesOperand("RSI_14D"));
    // No Monitor names EMA 200D, so it is neither requested nor computed.
    expect(requested).not.toContain(seriesOperand("EMA_200D"));
  });

  it("emits one Signal for a condition that stays true, and resolves it when it ends", async () => {
    const userId = await createUser();
    const security = await createSecurity(`CND${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    const cycle = cycleOf(loader);

    // false: price below the flat SMA.
    loader.currentPrice = 90;
    await cycle.run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(0);

    // false -> true: the match begins.
    loader.currentPrice = 150;
    await cycle.run(nextCycle());
    let signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();

    // true -> true: the same matched state continues; no duplicate on this scan or the next.
    loader.currentPrice = 160;
    await cycle.run(nextCycle());
    loader.currentPrice = 170;
    await cycle.run(nextCycle());
    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();

    // true -> false: the match is no longer active.
    loader.currentPrice = 80;
    await cycle.run(nextCycle());
    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).not.toBeNull();
  });

  it("emits a crossing once and not again while the price stays above", async () => {
    const userId = await createUser();
    const security = await createSecurity(`CRS${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    // Closed history sits at 100, so the previous closed row is below any price above 100 and the
    // SMA is flat at 100 until the provisional bar moves it.
    loader.prices.set(security.id, flatHistory(security.id, 100));
    const cycle = cycleOf(loader);

    loader.currentPrice = 95;
    await cycle.run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(0);

    // The crossing.
    loader.currentPrice = 150;
    await cycle.run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);

    // Still above on the next three scans. Remaining on the post-cross side is not another
    // crossing, and the Signal must not repeat.
    loader.currentPrice = 160;
    await cycle.run(nextCycle());
    loader.currentPrice = 170;
    await cycle.run(nextCycle());
    loader.currentPrice = 180;
    await cycle.run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);
  });

  it("does not repeat a crossing after a restart, because the state is durable", async () => {
    const userId = await createUser();
    const security = await createSecurity(`RSA${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    await cycleOf(loader).run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);

    // A restart: a brand-new repository and cycle, so every byte of process memory the first one
    // held is gone. Only PostgreSQL carries anything forward — which is the point.
    // Same session, so the only thing that could re-emit is forgotten state — which is the point.
    const restarted = new MonitorCycle(
      new PrismaMonitorRepository(prisma),
      loader,
      new FixtureCalendar(),
      logger,
      {
        symbolConcurrency: 4,
        quoteMaxAgeMs: 4 * 24 * 60 * 60_000,
        now: () => SESSION_ONE,
      },
    );
    loader.currentPrice = 160;
    await restarted.run(nextCycle());

    expect(await signalsOf(monitorId)).toHaveLength(1);
  });

  it("does not fabricate a crossing when the state is lost entirely", async () => {
    const userId = await createUser();
    const security = await createSecurity(`RST${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    // A rising history: the last CLOSED day is already above its own average, so nothing crossed
    // between it and now — whatever the Monitor does or does not remember.
    loader.prices.set(security.id, risingHistory(security.id));
    loader.currentPrice = 1_000;

    // Strictly worse than a restart or a flushed cache: the durable record itself is destroyed.
    await prisma.monitorSignalState.deleteMany({ where: { monitorId } });
    await cycleOf(loader).run(nextCycle());

    // A crossing is measured from persisted price history, never from a remembered previous scan.
    // With no memory at all there is still no crossing, because none happened.
    expect(await signalsOf(monitorId)).toHaveLength(0);
  });

  it("keeps a condition match after a state loss, because the condition is genuinely true", async () => {
    const userId = await createUser();
    const security = await createSecurity(`RSC${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    const cycle = cycleOf(loader);

    loader.currentPrice = 150;
    await cycle.run(nextCycle());
    await prisma.monitorSignalState.deleteMany({ where: { monitorId } });
    await prisma.monitorSignal.deleteMany({ where: { monitorId } });

    await cycle.run(nextCycle());

    // A Condition describes a state, not an event. With no memory the state is newly observed, so
    // one Signal is correct — and exactly one.
    expect(await signalsOf(monitorId)).toHaveLength(1);
  });

  it("fails the cycle when the current-data read fails, changing nothing", async () => {
    const userId = await createUser();
    const security = await createSecurity(`FMP${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    const cycle = cycleOf(loader);

    loader.currentPrice = 150;
    await cycle.run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);
    const scannedAt = (
      await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } })
    ).lastScanAt;

    // A failed current-data read is all-or-nothing: it must reach the worker's failure and retry
    // path rather than be absorbed into a cycle that then records itself as a successful scan
    // having evaluated nothing.
    loader.currentDataError = new Error("provider unavailable");
    await expect(cycle.run(nextCycle())).rejects.toThrow(
      "provider unavailable",
    );

    // And it changed nothing: the live match is untouched and no scan was recorded.
    const signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();
    expect(
      (await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } }))
        .lastScanAt?.toISOString(),
    ).toBe(scannedAt?.toISOString());
  });

  it("is NOT_EVALUABLE for a symbol the provider returned no quote for", async () => {
    const userId = await createUser();
    const security = await createSecurity(`NOQ${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = null;

    const summary = await cycleOf(loader).run(nextCycle());

    expect(summary.symbolsWithoutCurrentData).toBe(1);
    expect(summary.notEvaluable).toBe(1);
    expect(await signalsOf(monitorId)).toHaveLength(0);
  });

  it("ignores a quote too stale to be current", async () => {
    const userId = await createUser();
    const security = await createSecurity(`STL${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;
    loader.quotedAt = "2020-01-01T00:00:00.000Z";

    const summary = await new MonitorCycle(
      repository,
      loader,
      new FixtureCalendar(),
      logger,
      {
        symbolConcurrency: 4,
        quoteMaxAgeMs: 60_000,
        now: () => SESSION_ONE,
      },
    ).run(nextCycle());

    // A stale quote as "today's" observation would be a fabricated bar.
    expect(summary.symbolsWithoutCurrentData).toBe(1);
    expect(await signalsOf(monitorId)).toHaveLength(0);
  });

  it("reports NOT_EVALUABLE and never matches while a required series is warming up", async () => {
    const userId = await createUser();
    const security = await createSecurity(`WRM${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    // Three closes cannot produce a 20-bar average.
    loader.prices.set(security.id, flatHistory(security.id, 100).slice(0, 3));
    loader.currentPrice = 1_000;

    const summary = await cycleOf(loader).run(nextCycle());

    expect(summary.notEvaluable).toBe(1);
    expect(await signalsOf(monitorId)).toHaveLength(0);
    // NOT_EVALUABLE on a state that was never decided writes nothing at all.
    expect(
      await prisma.monitorSignalState.count({ where: { monitorId } }),
    ).toBe(0);
  });

  it("never matches a security with no persisted history", async () => {
    const userId = await createUser();
    const security = await createSecurity(`NOH${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, []);
    loader.currentPrice = 150;

    const summary = await cycleOf(loader).run(nextCycle());

    expect(summary.symbolsWithoutSnapshot).toBe(1);
    expect(summary.notEvaluable).toBe(1);
    expect(await signalsOf(monitorId)).toHaveLength(0);
  });

  it("records the provisional observation the Signal was decided on", async () => {
    const userId = await createUser();
    const security = await createSecurity(`OBS${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    await cycleOf(loader).run(nextCycle());

    const [signal] = await signalsOf(monitorId);
    expect(Number(signal?.observationPrice)).toBe(150);
    // The session the cycle derived from its own clock, in the exchange's timezone.
    expect(signal?.observationDate.toISOString().slice(0, 10)).toBe(
      "2026-03-02",
    );
    // Both remain Signals; `hasTrigger` only explains why this one exists.
    expect(signal?.hasTrigger).toBe(false);
    expect(signal?.levelKind).toBe("BUY");
  });

  it("marks every evaluated Monitor as scanned", async () => {
    const userId = await createUser();
    const security = await createSecurity(`SCN${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 90;

    await cycleOf(loader).run(nextCycle());

    const row = await prisma.monitor.findUniqueOrThrow({
      where: { id: monitorId },
    });
    expect(row.lastScanAt).not.toBeNull();
  });

  it("honours a CUSTOM buy window that does not admit the observation date", async () => {
    const userId = await createUser();
    const security = await createSecurity(`BWN${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    // The list says this member is only buyable in 2020. The BUY level is what the window gates,
    // exactly as the backtest engine gates it.
    const item = await prisma.stockListItem.findFirstOrThrow({
      where: { securityId: security.id },
    });
    await prisma.stockListItem.update({
      where: { id: item.id },
      data: {
        buyWindowMode: "CUSTOM",
        buyWindows: {
          create: {
            startDate: new Date("2020-01-01T00:00:00.000Z"),
            endDate: new Date("2020-12-31T00:00:00.000Z"),
          },
        },
      },
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    await cycleOf(loader).run(nextCycle());

    expect(await signalsOf(monitorId)).toHaveLength(0);
  });

  it("emits one Signal for a crossing that whipsaws within the same day", async () => {
    const userId = await createUser();
    const security = await createSecurity(`WHP${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    const cycle = cycleOf(loader);

    // The crossing.
    loader.currentPrice = 150;
    await cycle.run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);

    // Back below, then above again — all on the SAME observation date, whose `t - 1` is still
    // yesterday's close. The canonical predicate is satisfied a second time, but the canonical
    // daily series has this crossing TRUE on exactly one date, so it is one event and one Signal.
    loader.currentPrice = 90;
    await cycle.run(nextCycle());
    let signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    // And the fired event does not vanish from the user's list because the price ticked back: a
    // Trigger is an event, so the condition lifecycle does not apply to it.
    expect(signals[0]?.resolvedAt).toBeNull();

    loader.currentPrice = 160;
    await cycle.run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();
  });

  it("closes a trigger Signal when a later session is observed", async () => {
    const userId = await createUser();
    const security = await createSecurity(`SES${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    const cycle = cycleOf(loader);

    loader.currentPrice = 150;
    await cycle.run(nextCycle());
    let signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();

    // The next session, with no crossing on it. An event's Signal is active for the session it
    // fired in, so a later observed session closes it rather than leaving every crossing ever fired
    // on the active list.
    loader.currentPrice = 90;
    await cycleOf(loader, sessionOn("2026-03-03")).run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).not.toBeNull();
  });

  it("emits again for a condition that genuinely ends and begins again the same day", async () => {
    const userId = await createUser();
    const security = await createSecurity(`WHC${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    const cycle = cycleOf(loader);

    loader.currentPrice = 150;
    await cycle.run(nextCycle());
    loader.currentPrice = 80;
    await cycle.run(nextCycle());
    loader.currentPrice = 150;
    await cycle.run(nextCycle());

    // A Condition describes a state, not an event. Unlike a Trigger it is deliberately not
    // suppressed within a day: the state really did end and begin again.
    const signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.resolvedAt).not.toBeNull();
    expect(signals[1]?.resolvedAt).toBeNull();
  });

  it("resolves a Signal whose security left the monitored list", async () => {
    const userId = await createUser();
    const security = await createSecurity(`ORP${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    await cycleOf(loader).run(nextCycle());
    let signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();

    // The user removes the security from the list. Only an evaluation ever resolves a Signal, so
    // without the sweep this match would stay active forever against a holding nobody watches.
    await prisma.stockListItem.deleteMany({ where: { securityId: security.id } });
    await cycleOf(loader).run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).not.toBeNull();
  });

  it("stops cleanly when the cycle is aborted, and the next one finishes the work", async () => {
    const userId = await createUser();
    const first = await createSecurity(`AB1${suffix.slice(0, 4)}`);
    const second = await createSecurity(`AB2${suffix.slice(0, 4)}`);
    const monitorA = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [first],
    });
    const monitorB = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [second],
    });

    const loader = new FixtureLoader([first, second]);
    loader.prices.set(first.id, flatHistory(first.id, 100));
    loader.prices.set(second.id, flatHistory(second.id, 100));
    loader.currentPrice = 150;

    // Abort immediately: no Monitor is evaluated at all.
    const aborted = await cycleOf(loader).run(nextCycle(), () => true);
    expect(aborted.aborted).toBe(true);
    expect(await signalsOf(monitorA.monitorId)).toHaveLength(0);
    expect(await signalsOf(monitorB.monitorId)).toHaveLength(0);

    // Stopping mid-cycle is safe because every transition is decided from durable state and
    // persisted history: the next cycle reaches the same conclusions.
    const completed = await cycleOf(loader).run(nextCycle());
    expect(completed.aborted).toBe(false);
    expect(await signalsOf(monitorA.monitorId)).toHaveLength(1);
    expect(await signalsOf(monitorB.monitorId)).toHaveLength(1);
  });

  it("gates only BUY levels by the buy window, never SELL or FINAL EXIT", async () => {
    const userId = await createUser();
    const security = await createSecurity(`BWS${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: {
        schemaVersion: 1,
        buyLevels: [
          { id: "buy-1", percentage: 100, signal: priceAboveSmaSignal("c-buy") },
        ],
        sellLevels: [
          { id: "sell-1", percentage: 50, signal: priceAboveSmaSignal("c-sell") },
        ],
        finalExit: { id: "exit-1", signal: priceAboveSmaSignal("c-exit") },
      },
      securities: [security],
    });

    // The list says this member is only buyable in 2020. BUY eligibility is a *buy* window: it
    // gates entries, and an exit rule must still be able to tell the user what it sees.
    const item = await prisma.stockListItem.findFirstOrThrow({
      where: { securityId: security.id },
    });
    await prisma.stockListItem.update({
      where: { id: item.id },
      data: {
        buyWindowMode: "CUSTOM",
        buyWindows: {
          create: {
            startDate: new Date("2020-01-01T00:00:00.000Z"),
            endDate: new Date("2020-12-31T00:00:00.000Z"),
          },
        },
      },
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    await cycleOf(loader).run(nextCycle());

    const signals = await signalsOf(monitorId);
    expect(signals.map((signal) => signal.levelKind).sort()).toEqual([
      "FINAL_EXIT",
      "SELL",
    ]);
  });

  it("signals a position-independent SELL rule, and never one that needs a position", async () => {
    const userId = await createUser();
    const security = await createSecurity(`POS${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: {
        schemaVersion: 1,
        buyLevels: [
          {
            id: "buy-1",
            percentage: 100,
            signal: {
              conditions: [],
              trigger: {
                id: "t-never",
                metric: { kind: "PRICE" },
                operator: "CROSSES_BELOW",
                value: { kind: "SERIES", seriesId: EMA_SERIES },
              },
            },
          },
        ],
        sellLevels: [
          {
            // Market-derived: decidable without a portfolio, so it may signal.
            id: "sell-market",
            percentage: 50,
            signal: priceAboveSmaSignal("c-sell-market"),
          },
          {
            // Position-dependent: a Monitor has no average cost, so Gain is NOT_EVALUABLE and this
            // level can never match. Monitor is not a portfolio tracker.
            id: "sell-gain",
            percentage: 25,
            signal: {
              conditions: [
                {
                  id: "c-gain",
                  metric: { kind: "GAIN" },
                  operator: "IS_ABOVE",
                  value: { kind: "PERCENT", value: 1 },
                },
              ],
            },
          },
        ],
      },
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    await cycleOf(loader).run(nextCycle());

    expect((await signalsOf(monitorId)).map((signal) => signal.levelId)).toEqual(
      ["sell-market"],
    );
  });

  it("still emits a crossing on the session after one it could not evaluate", async () => {
    const userId = await createUser();
    const security = await createSecurity(`OUT${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    const cycle = cycleOf(loader);

    // Session one: a genuine crossing.
    loader.currentPrice = 150;
    await cycle.run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);

    // Session two: the provider returns no quote for this symbol, so nothing is decidable.
    // NOT_EVALUABLE must not move the latch — and must not leave behind a state that swallows the
    // next crossing.
    loader.currentPrice = null;
    await cycleOf(loader, sessionOn("2026-03-03")).run(nextCycle());

    // Session three: a genuine, canonical crossing on a new observation date. It must produce a
    // Signal whatever the quiet session left behind.
    loader.currentPrice = 150;
    await cycleOf(loader, sessionOn("2026-03-04")).run(nextCycle());

    const signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.resolvedAt).not.toBeNull();
    expect(signals[1]?.resolvedAt).toBeNull();
  });

  it("signals again for a security removed from the list and added back", async () => {
    const userId = await createUser();
    const security = await createSecurity(`RDD${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;
    const cycle = cycleOf(loader);

    await cycle.run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);

    // Removed while still matching: the sweep closes the Signal and must leave the row coherent.
    const listId = (
      await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } })
    ).stockListId;
    await prisma.stockListItem.deleteMany({
      where: { securityId: security.id },
    });
    await cycle.run(nextCycle());
    let signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).not.toBeNull();

    // Added back, still matching. The match is newly observed, so it signals again — a row whose
    // latch and recorded outcome disagreed would skip the write forever and never emit.
    await prisma.stockListItem.create({
      data: { stockListId: listId, securityId: security.id },
    });
    await cycle.run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.resolvedAt).toBeNull();
  });

  it("records the scan without touching the Monitor's user-facing updatedAt", async () => {
    const userId = await createUser();
    const security = await createSecurity(`UPD${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });
    const before = await prisma.monitor.findUniqueOrThrow({
      where: { id: monitorId },
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 90;
    await cycleOf(loader).run(nextCycle());

    const after = await prisma.monitor.findUniqueOrThrow({
      where: { id: monitorId },
    });
    // A scan is not a user edit. `updatedAt` orders the user's collection newest-changed-first, so
    // bumping it every cycle would make every enabled Monitor read "updated just now".
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.lastScanAt).not.toBeNull();
  });

  it("leaves a Trigger Signal alone on a day no session was observed", async () => {
    const userId = await createUser();
    const security = await createSecurity(`WKD${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));

    // Friday: a crossing fires.
    loader.currentPrice = 150;
    await cycleOf(loader, sessionOn("2026-03-06")).run(nextCycle());
    let signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();

    // Saturday, and again on Sunday: the market never opened, so there is no quote and no session.
    // A cycle that observed nothing must not end Friday's crossing — the wall clock is not a
    // session, and treating it as one would close a Signal nothing superseded.
    loader.currentPrice = null;
    await cycleOf(loader, sessionOn("2026-03-07")).run(nextCycle());
    await cycleOf(loader, sessionOn("2026-03-08")).run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();

    // Monday: a real later session is observed, and only now is Friday's crossing closed.
    loader.currentPrice = 90;
    await cycleOf(loader, sessionOn("2026-03-09")).run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).not.toBeNull();
  });

  it("does not let a quote from a later session than the cycle's own be used", async () => {
    const userId = await createUser();
    const security = await createSecurity(`FUT${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;
    // A provider clock that is wrong, or a timestamp in the wrong unit. A negative age passes a
    // bare `now - quotedAt <= maxAge` test, and the session it names has not happened.
    loader.quotedAt = sessionOn("2026-04-15").toISOString();

    const summary = await cycleOf(loader).run(nextCycle());

    expect(summary.symbolsWithoutCurrentData).toBe(1);
    expect(await signalsOf(monitorId)).toHaveLength(0);
  });

  it("keeps a Trigger Signal when an older session is observed, and does not re-emit it", async () => {
    const userId = await createUser();
    const security = await createSecurity(`OLD${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    const prices = flatHistory(security.id, 100);
    loader.prices.set(security.id, prices);
    loader.currentPrice = 150;

    // Monday: the provider has no trade for this symbol yet, so no timestamp. The cycle dates the
    // observation to its own session and the crossing fires.
    await cycleOf(loader).run(nextCycle());
    let signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();
    const firedId = signals[0]?.id;

    // Minutes later the provider populates the timestamp from the symbol's last trade — the
    // previous session's close. That is well inside the staleness window, so it is accepted and
    // dates the observation to the EARLIER session. It is not a later session, so it must neither
    // close the crossing nor let the next cycle raise it again as a second Signal.
    const lastClosed = prices[prices.length - 1]!.date;
    loader.quotedAt = `${lastClosed}T21:00:00.000Z`;
    await cycleOf(loader).run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.id).toBe(firedId);
    expect(signals[0]?.resolvedAt).toBeNull();

    // And back to no timestamp: still one Signal, still the original.
    loader.quotedAt = undefined;
    await cycleOf(loader).run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.id).toBe(firedId);
    expect(signals[0]?.resolvedAt).toBeNull();
  });

  it("dates an observation by the exchange session, not the UTC day", async () => {
    const userId = await createUser();
    const security = await createSecurity(`TZN${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;
    // 19:30 New York on Monday 2026-03-02 — already Tuesday in UTC. The session is Monday's, and
    // dating the observation in UTC would name a session that has not started.
    loader.quotedAt = "2026-03-03T00:30:00.000Z";
    expect(loader.quotedAt.slice(0, 10)).toBe("2026-03-03");

    await cycleOf(loader, new Date("2026-03-03T00:35:00.000Z")).run(
      nextCycle(),
    );

    const [signal] = await signalsOf(monitorId);
    expect(signal?.observationDate.toISOString().slice(0, 10)).toBe(
      "2026-03-02",
    );
  });

  it("keeps a Friday Trigger active through a Monday exchange holiday", async () => {
    const userId = await createUser();
    const security = await createSecurity(`HOL${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    const calendar = new FixtureCalendar();
    calendar.fullCloses.add("2026-03-09");

    // Friday: a crossing fires.
    loader.currentPrice = 150;
    await cycleOf(loader, sessionOn("2026-03-06"), calendar).run(nextCycle());
    let signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();

    // Monday is a full exchange closure. The venue held no session, so nothing was observed — and
    // a day the market never opened must not end a crossing that fired on a real one.
    loader.currentPrice = 160;
    await cycleOf(loader, sessionOn("2026-03-09"), calendar).run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();

    // Tuesday is a genuine session, and it closes Friday's crossing normally.
    loader.currentPrice = 90;
    await cycleOf(loader, sessionOn("2026-03-10"), calendar).run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).not.toBeNull();
  });

  it("appends no provisional row on a full exchange closure", async () => {
    const userId = await createUser();
    const security = await createSecurity(`HNB${suffix.slice(0, 4)}`);
    await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;
    const calendar = new FixtureCalendar();
    calendar.fullCloses.add("2026-03-09");

    const summary = await cycleOf(
      loader,
      sessionOn("2026-03-09"),
      calendar,
    ).run(nextCycle());

    // No frame was built at all, so there is no bar to lengthen a rolling window with.
    expect(summary.symbolsOutsideTradingSession).toBe(1);
    expect(loader.frameCalls).toEqual([]);
    expect(summary.notEvaluable).toBeGreaterThan(0);
  });

  it("cannot manufacture a crossing on a full exchange closure", async () => {
    const userId = await createUser();
    const security = await createSecurity(`HXC${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceCrossesAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    // A price that would cross decisively above the average if it were allowed to become a bar.
    loader.currentPrice = 10_000;
    const calendar = new FixtureCalendar();
    calendar.fullCloses.add("2026-03-09");

    await cycleOf(loader, sessionOn("2026-03-09"), calendar).run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(0);

    // The same price on the next real session does produce one, so the fixture is not simply inert.
    await cycleOf(loader, sessionOn("2026-03-10"), calendar).run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);
  });

  it("treats an early-close day as an ordinary trading session", async () => {
    const userId = await createUser();
    const security = await createSecurity(`ERL${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    // The real calendar over a provider schedule that lists 2026-03-09 as an EARLY close. The
    // venue opened and closed sooner, so the day's bar is ordinary — driving this through
    // `CachedTradingCalendar` is what makes the test about the early-close rule rather than about
    // a fixture that simply returns true.
    const calendar = new CachedTradingCalendar({
      getExchangeHolidays: async () => [
        ...FULL_YEAR_2026,
        { date: "2026-03-09", name: "Half Day", fullClose: false },
      ],
    });

    await cycleOf(loader, sessionOn("2026-03-09"), calendar).run(nextCycle());
    expect(await signalsOf(monitorId)).toHaveLength(1);
  });

  it("refuses the same day when the schedule calls it a full closure", async () => {
    const userId = await createUser();
    const security = await createSecurity(`FCL${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;

    // The control for the test above: the only difference is `fullClose`, and it decides.
    const calendar = new CachedTradingCalendar({
      getExchangeHolidays: async () => [
        ...FULL_YEAR_2026,
        { date: "2026-03-09", name: "Closed", fullClose: true },
      ],
    });

    const summary = await cycleOf(
      loader,
      sessionOn("2026-03-09"),
      calendar,
    ).run(nextCycle());

    expect(summary.symbolsOutsideTradingSession).toBe(1);
    expect(await signalsOf(monitorId)).toHaveLength(0);
  });

  it("fails the cycle when the trading calendar cannot be resolved", async () => {
    const userId = await createUser();
    const security = await createSecurity(`CAL${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const loader = new FixtureLoader([security]);
    loader.prices.set(security.id, flatHistory(security.id, 100));
    loader.currentPrice = 150;
    const calendar = new FixtureCalendar();
    calendar.failure = new Error("calendar unavailable");

    // Not knowing whether the exchange opened is not the same as knowing it did. The cycle fails
    // rather than assuming a session and fabricating a bar on a day that may not have had one.
    await expect(
      cycleOf(loader, SESSION_ONE, calendar).run(nextCycle()),
    ).rejects.toThrow("calendar unavailable");

    expect(await signalsOf(monitorId)).toHaveLength(0);
    expect(loader.frameCalls).toEqual([]);
    // The cycle failed, so it recorded no scan: it goes to the worker's retry path rather than
    // counting as a cycle that ran.
    expect(
      (await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } }))
        .lastScanAt,
    ).toBeNull();
  });

  it("asks the calendar once per exchange session, not once per symbol", async () => {
    const userId = await createUser();
    const first = await createSecurity(`CS1${suffix.slice(0, 4)}`);
    const second = await createSecurity(`CS2${suffix.slice(0, 4)}`);
    const third = await createSecurity(`CS3${suffix.slice(0, 4)}`);
    await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [first, second, third],
    });

    const loader = new FixtureLoader([first, second, third]);
    for (const security of [first, second, third]) {
      loader.prices.set(security.id, flatHistory(security.id, 100));
    }
    loader.currentPrice = 150;
    const calendar = new FixtureCalendar();

    await cycleOf(loader, SESSION_ONE, calendar).run(nextCycle());

    // Three symbols on one venue observing one session is one question, not three.
    expect(calendar.calls).toEqual(["NASDAQ 2026-03-02"]);
  });

  it("asks each venue separately when a Monitor spans exchanges", async () => {
    const userId = await createUser();
    const nasdaq = await createSecurity(`XN1${suffix.slice(0, 4)}`, "NASDAQ");
    const nyse = await createSecurity(`XY1${suffix.slice(0, 4)}`, "NYSE");
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [nasdaq, nyse],
    });

    const loader = new FixtureLoader([nasdaq, nyse]);
    loader.prices.set(nasdaq.id, flatHistory(nasdaq.id, 100));
    loader.prices.set(nyse.id, flatHistory(nyse.id, 100));
    loader.currentPrice = 150;
    const calendar = new FixtureCalendar();
    // The venues keep separate schedules, so one closure must not silence the other.
    calendar.fullCloses.add("2026-03-02");

    const summary = await cycleOf(loader, SESSION_ONE, calendar).run(
      nextCycle(),
    );

    expect([...calendar.calls].sort()).toEqual([
      "NASDAQ 2026-03-02",
      "NYSE 2026-03-02",
    ]);
    // Both venues are closed that day in this fixture, so neither produces an observation.
    expect(summary.symbolsOutsideTradingSession).toBe(2);
    expect(await signalsOf(monitorId)).toHaveLength(0);
  });

  it("does not double-emit when the same transition is applied twice", async () => {
    const userId = await createUser();
    const security = await createSecurity(`CNC${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const write = {
      monitorId,
      configVersion: 0,
      securityId: security.id,
      levelId: "buy-1",
      levelKind: "BUY" as const,
      strategyVersionId: "version-1",
      signalFingerprint: "fingerprint-a",
      hasTrigger: false,
      outcome: "MATCHED" as const,
      observation: { date: "2026-03-02", price: 150 },
      now: new Date(),
      previous: null,
    };

    // Two processes whose leases briefly overlap both read "no state" and both try to create it.
    const [first, second] = await Promise.all([
      repository.applyTransition(write),
      repository.applyTransition(write),
    ]);

    const applied = [first, second].filter((result) => result.applied);
    expect(applied).toHaveLength(1);
    expect(await signalsOf(monitorId)).toHaveLength(1);
  });

  /**
   * `Gain` and `Loss` are outside Monitor evaluation.
   *
   * A Monitor holds no position, no entry price and no cost basis, so those metrics are not part of
   * what it evaluates — which is a different statement from "a Monitor metric that happens to be
   * undecidable". A level depending on one is skipped: no Signal, and no transition state written as
   * though an evaluation had been attempted. The Strategy is never rejected, and its other levels
   * evaluate normally.
   *
   * Where they can appear is already fixed by the canonical grammar: `Gain` and `Loss` are refused
   * in a BUY level because they depend on an open position, so they reach a Monitor only through
   * SELL levels and FINAL EXIT. Every one of these fixtures goes through
   * `normalizeStrategyDefinition`, so none of them can drift from what the product actually accepts.
   */
  describe("position-dependent levels", () => {
    const gainAbove20 = {
      id: "g1",
      metric: { kind: "GAIN" as const },
      operator: "IS_ABOVE" as const,
      value: { kind: "PERCENT" as const, value: 20 },
    };
    const lossAbove10 = {
      id: "l1",
      metric: { kind: "LOSS" as const },
      operator: "IS_ABOVE" as const,
      value: { kind: "PERCENT" as const, value: 10 },
    };
    /** True for the fixtures below: current price 150 against a flat-100 history. */
    const priceAboveEma = (id: string) => ({
      id,
      metric: { kind: "PRICE" as const },
      operator: "IS_ABOVE" as const,
      value: { kind: "SERIES" as const, seriesId: EMA_SERIES },
    });
    /** False for the same fixtures, so a BUY level can be kept quiet on purpose. */
    const priceBelowEma = (id: string) => ({
      id,
      metric: { kind: "PRICE" as const },
      operator: "IS_BELOW" as const,
      value: { kind: "SERIES" as const, seriesId: EMA_SERIES },
    });

    /**
     * A Strategy whose BUY level never fires and whose single SELL level is whatever is passed.
     *
     * The BUY level exists because the grammar requires one and refuses a position-dependent
     * condition there; keeping it false leaves exactly one level able to emit, which is what makes
     * the assertions below unambiguous.
     */
    function exitDefinition(
      conditions: readonly object[],
    ): StrategyDefinition {
      return normalizeStrategyDefinition({
        schemaVersion: 1,
        buyLevels: [
          {
            id: "buy-1",
            percentage: 100,
            signal: { conditions: [priceBelowEma("c1")] },
          },
        ],
        sellLevels: [
          { id: "sell-1", percentage: 25, signal: { conditions: [...conditions] } },
        ],
      } as never);
    }

    /** Edits the live Strategy by appending the next version, as the API does. */
    async function appendVersion(
      strategyId: string,
      definition: StrategyDefinition,
    ): Promise<void> {
      const latest = await prisma.strategyVersion.findFirstOrThrow({
        where: { strategyId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      await prisma.strategyVersion.create({
        data: {
          strategyId,
          versionNumber: latest.versionNumber + 1,
          definition: definition as never,
          definitionHash: randomUUID(),
        },
      });
    }

    /** A loader whose price makes `Price IS_ABOVE EMA` unambiguously true. */
    function matchingLoader(security: Security): FixtureLoader {
      const loader = new FixtureLoader([security]);
      loader.prices.set(security.id, flatHistory(security.id, 100));
      loader.currentPrice = 150;
      return loader;
    }

    it("writes neither a Signal nor state for a Gain level", async () => {
      const userId = await createUser();
      const security = await createSecurity(`GNA${suffix.slice(0, 4)}`);
      const { monitorId } = await createMonitor({
        userId,
        definition: exitDefinition([gainAbove20]),
        securities: [security],
      });

      await cycleOf(matchingLoader(security)).run(nextCycle());

      expect(await signalsOf(monitorId)).toHaveLength(0);
      // Not even a NOT_EVALUABLE row: the level was never attempted.
      expect(
        await prisma.monitorSignalState.count({
          where: { monitorId, levelId: "sell-1" },
        }),
      ).toBe(0);
    });

    it("writes neither a Signal nor state for a Loss level", async () => {
      const userId = await createUser();
      const security = await createSecurity(`LSA${suffix.slice(0, 4)}`);
      const { monitorId } = await createMonitor({
        userId,
        definition: exitDefinition([lossAbove10]),
        securities: [security],
      });

      await cycleOf(matchingLoader(security)).run(nextCycle());

      expect(await signalsOf(monitorId)).toHaveLength(0);
      expect(
        await prisma.monitorSignalState.count({
          where: { monitorId, levelId: "sell-1" },
        }),
      ).toBe(0);
    });

    /**
     * The whole level is excluded, not just the Gain condition.
     *
     * The fixture is chosen so the market half is unambiguously TRUE: if the level were partially
     * evaluated, this would emit a Signal for `Price IS_ABOVE EMA` — a rule the user never wrote.
     */
    it("skips the whole level when Gain is ANDed with a matching price condition", async () => {
      const userId = await createUser();
      const security = await createSecurity(`MIX${suffix.slice(0, 4)}`);
      const { monitorId } = await createMonitor({
        userId,
        definition: exitDefinition([priceAboveEma("c2"), gainAbove20]),
        securities: [security],
      });

      await cycleOf(matchingLoader(security)).run(nextCycle());

      expect(await signalsOf(monitorId)).toHaveLength(0);
      expect(
        await prisma.monitorSignalState.count({
          where: { monitorId, levelId: "sell-1" },
        }),
      ).toBe(0);
    });

    it("skips a level whose Trigger is position-dependent", async () => {
      const userId = await createUser();
      const security = await createSecurity(`TRG${suffix.slice(0, 4)}`);
      const { monitorId } = await createMonitor({
        userId,
        definition: normalizeStrategyDefinition({
          schemaVersion: 1,
          buyLevels: [
            {
              id: "buy-1",
              percentage: 100,
              signal: { conditions: [priceBelowEma("c1")] },
            },
          ],
          sellLevels: [
            {
              id: "sell-1",
              percentage: 25,
              signal: {
                conditions: [priceAboveEma("c2")],
                trigger: {
                  id: "t1",
                  metric: { kind: "GAIN" },
                  operator: "CROSSES_ABOVE",
                  value: { kind: "PERCENT", value: 20 },
                },
              },
            },
          ],
        } as never),
        securities: [security],
      });

      await cycleOf(matchingLoader(security)).run(nextCycle());

      expect(await signalsOf(monitorId)).toHaveLength(0);
    });

    it("evaluates the supported level of a mixed Strategy and skips the position one", async () => {
      const userId = await createUser();
      const security = await createSecurity(`MXD${suffix.slice(0, 4)}`);
      const { monitorId } = await createMonitor({
        userId,
        definition: normalizeStrategyDefinition({
          schemaVersion: 1,
          buyLevels: [
            {
              id: "buy-1",
              percentage: 100,
              // True for this fixture, so the supported level does emit.
              signal: { conditions: [priceAboveEma("c1")] },
            },
          ],
          sellLevels: [
            { id: "sell-1", percentage: 25, signal: { conditions: [gainAbove20] } },
          ],
        } as never),
        securities: [security],
      });

      await cycleOf(matchingLoader(security)).run(nextCycle());

      // Exactly one Signal, from the level a Monitor can actually decide.
      const signals = await signalsOf(monitorId);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.levelId).toBe("buy-1");
      expect(signals[0]?.levelKind).toBe("BUY");
      // And exactly one state row: the SELL level left none behind.
      const states = await prisma.monitorSignalState.findMany({
        where: { monitorId },
        select: { levelId: true },
      });
      expect(states.map((state) => state.levelId)).toEqual(["buy-1"]);
    });

    it("closes the active Signal when an edit makes a monitored level Gain-dependent", async () => {
      const userId = await createUser();
      const security = await createSecurity(`GDP${suffix.slice(0, 4)}`);
      const { monitorId, strategyId } = await createMonitor({
        userId,
        definition: exitDefinition([priceAboveEma("c2")]),
        securities: [security],
      });

      await cycleOf(matchingLoader(security)).run(nextCycle());
      const emitted = await signalsOf(monitorId);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.levelId).toBe("sell-1");
      expect(emitted[0]?.resolvedAt).toBeNull();

      // The user replaces that exit rule with a Gain one, keeping the level.
      await appendVersion(strategyId, exitDefinition([gainAbove20]));
      await cycleOf(matchingLoader(security)).run(nextCycle());

      // The level is no longer part of what the Monitor walks, so it is reconciled exactly like a
      // level removed from the Strategy: its Signal is closed rather than left active forever.
      const afterEdit = await signalsOf(monitorId);
      expect(afterEdit).toHaveLength(1);
      expect(afterEdit[0]?.resolvedAt).not.toBeNull();
      const state = await prisma.monitorSignalState.findFirstOrThrow({
        where: { monitorId, levelId: "sell-1" },
      });
      expect(state.activeSignalId).toBeNull();
    });

    it("evaluates the level again once the edit is reversed", async () => {
      const userId = await createUser();
      const security = await createSecurity(`RVS${suffix.slice(0, 4)}`);
      const { monitorId, strategyId } = await createMonitor({
        userId,
        definition: exitDefinition([priceAboveEma("c2")]),
        securities: [security],
      });

      await cycleOf(matchingLoader(security)).run(nextCycle());
      await appendVersion(strategyId, exitDefinition([gainAbove20]));
      await cycleOf(matchingLoader(security)).run(nextCycle());

      // Back to logic a Monitor can decide.
      await appendVersion(strategyId, exitDefinition([priceAboveEma("c2")]));
      await cycleOf(matchingLoader(security)).run(nextCycle());

      // The match is live again. It is a second Signal, not the first one reopened: the run of
      // matched evaluations was genuinely broken when the level stopped being monitored.
      const signals = await signalsOf(monitorId);
      expect(signals).toHaveLength(2);
      expect(
        signals.filter((signal) => signal.resolvedAt === null),
      ).toHaveLength(1);
    });
  });

  /**
   * The rebind fence, from the worker's side.
   *
   * A cycle reads a Monitor's binding at its start and can commit a transition seconds later. In
   * between, the user may point the Monitor at a different Strategy or Stock List — which resolves
   * its active Signals and discards its transition state. Everything below asserts that an
   * evaluation carrying the replaced binding writes nothing at all, and that the ordinary path
   * still works when the binding has not moved.
   */
  describe("rebind fence", () => {
    async function rebind(monitorId: string): Promise<void> {
      // What `MonitorsService.rebindMonitor` does to the binding, without the API in the way.
      await prisma.monitor.update({
        where: { id: monitorId },
        data: { configVersion: { increment: 1 }, lastScanAt: null },
      });
    }

    it("discards a transition decided under a replaced binding", async () => {
      const userId = await createUser();
      const security = await createSecurity(`RBA${suffix.slice(0, 4)}`);
      const { monitorId } = await createMonitor({
        userId,
        definition: priceAboveSmaDefinition(),
        securities: [security],
      });

      const write = {
        monitorId,
        configVersion: 0,
        securityId: security.id,
        levelId: "buy-1",
        levelKind: "BUY" as const,
        strategyVersionId: "version-1",
        signalFingerprint: "fingerprint-a",
        hasTrigger: false,
        outcome: "MATCHED" as const,
        observation: { date: "2026-03-02", price: 150 },
        now: new Date(),
        previous: null,
      };

      // The user rebinds after the cycle read the Monitor but before it commits.
      await rebind(monitorId);
      const result = await repository.applyTransition(write);

      expect(result.applied).toBe(false);
      expect(result.staleConfiguration).toBe(true);
      // This is the case `stateVersion` alone cannot catch: there was no state row to contend on,
      // so without the fence the create path would have inserted one and emitted a Signal.
      expect(await signalsOf(monitorId)).toHaveLength(0);
      expect(
        await prisma.monitorSignalState.count({ where: { monitorId } }),
      ).toBe(0);
    });

    it("applies the same transition when the binding has not moved", async () => {
      const userId = await createUser();
      const security = await createSecurity(`RBB${suffix.slice(0, 4)}`);
      const { monitorId } = await createMonitor({
        userId,
        definition: priceAboveSmaDefinition(),
        securities: [security],
      });

      const result = await repository.applyTransition({
        monitorId,
        configVersion: 0,
        securityId: security.id,
        levelId: "buy-1",
        levelKind: "BUY" as const,
        strategyVersionId: "version-1",
        signalFingerprint: "fingerprint-a",
        hasTrigger: false,
        outcome: "MATCHED" as const,
        observation: { date: "2026-03-02", price: 150 },
        now: new Date(),
        previous: null,
      });

      expect(result.applied).toBe(true);
      expect(result.staleConfiguration).toBeUndefined();
      expect(await signalsOf(monitorId)).toHaveLength(1);
    });

    it("does not stamp lastScanAt for a Monitor rebound mid-cycle", async () => {
      const userId = await createUser();
      const security = await createSecurity(`RBC${suffix.slice(0, 4)}`);
      const stale = await createMonitor({
        userId,
        definition: priceAboveSmaDefinition(),
        securities: [security],
      });
      const current = await createMonitor({
        userId,
        definition: priceAboveSmaDefinition(),
        securities: [security],
      });

      await rebind(stale.monitorId);
      const now = new Date();
      await repository.markScanned(
        [
          { monitorId: stale.monitorId, configVersion: 0 },
          { monitorId: current.monitorId, configVersion: 0 },
        ],
        now,
      );

      // The rebound Monitor keeps the null its rebind set: its new configuration has not been
      // checked, and the cycle that just finished was not checking it.
      expect(
        (
          await prisma.monitor.findUniqueOrThrow({
            where: { id: stale.monitorId },
          })
        ).lastScanAt,
      ).toBeNull();
      // The untouched Monitor in the same batch is stamped normally.
      expect(
        (
          await prisma.monitor.findUniqueOrThrow({
            where: { id: current.monitorId },
          })
        ).lastScanAt,
      ).not.toBeNull();
    });

    it("does not sweep unvisited Signals using a replaced binding's universe", async () => {
      const userId = await createUser();
      const security = await createSecurity(`RBD${suffix.slice(0, 4)}`);
      const { monitorId } = await createMonitor({
        userId,
        definition: priceAboveSmaDefinition(),
        securities: [security],
      });

      // A match exists under the old configuration.
      await repository.applyTransition({
        monitorId,
        configVersion: 0,
        securityId: security.id,
        levelId: "buy-1",
        levelKind: "BUY" as const,
        strategyVersionId: "version-1",
        signalFingerprint: "fingerprint-a",
        hasTrigger: false,
        outcome: "MATCHED" as const,
        observation: { date: "2026-03-02", price: 150 },
        now: new Date(),
        previous: null,
      });
      await rebind(monitorId);

      // The old cycle finishes and reconciles with the universe it loaded. It must not act: the
      // rebind owns closing those Signals, and it already did.
      const resolved = await repository.resolveUnvisitedSignals({
        monitorId,
        configVersion: 0,
        securityIds: [],
        levelIds: [],
        now: new Date(),
      });
      expect(resolved).toBe(0);
    });
  });

  it("resets state recorded under different level logic", async () => {
    const userId = await createUser();
    const security = await createSecurity(`VER${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const base = {
      monitorId,
      configVersion: 0,
      securityId: security.id,
      levelId: "buy-1",
      levelKind: "BUY" as const,
      hasTrigger: false,
      observation: { date: "2026-03-02", price: 150 },
    };

    const first = await repository.applyTransition({
      ...base,
      strategyVersionId: "version-1",
      signalFingerprint: "fingerprint-a",
      outcome: "MATCHED",
      now: new Date(),
      previous: null,
    });
    expect(first.emittedSignalId).not.toBeNull();

    const states = await repository.loadSignalStates(monitorId);
    const previous = states.get(`${security.id} buy-1`) ?? null;

    // The user edited THIS level. State latched under the old logic cannot decide the new logic,
    // so the still-matching signal is a NEW match and the old one is closed.
    const second = await repository.applyTransition({
      ...base,
      strategyVersionId: "version-2",
      signalFingerprint: "fingerprint-b",
      outcome: "MATCHED",
      now: new Date(),
      previous,
    });

    expect(second.applied).toBe(true);
    expect(second.emittedSignalId).not.toBeNull();
    expect(second.resolvedSignalIds).toEqual([first.emittedSignalId]);

    const signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.resolvedAt).not.toBeNull();
    expect(signals[1]?.resolvedAt).toBeNull();
  });

  it("keeps an unchanged level's match when another level of the Strategy is edited", async () => {
    const userId = await createUser();
    const security = await createSecurity(`EDT${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId,
      definition: priceAboveSmaDefinition(),
      securities: [security],
    });

    const base = {
      monitorId,
      configVersion: 0,
      securityId: security.id,
      levelId: "buy-1",
      levelKind: "BUY" as const,
      signalFingerprint: "unchanged-level",
      hasTrigger: false,
      observation: { date: "2026-03-02", price: 150 },
    };

    const first = await repository.applyTransition({
      ...base,
      strategyVersionId: "version-1",
      outcome: "MATCHED",
      now: new Date(),
      previous: null,
    });
    expect(first.emittedSignalId).not.toBeNull();

    const states = await repository.loadSignalStates(monitorId);
    // A different level changed, so the Strategy has a new version — but THIS level's logic did
    // not, and its latched match must survive rather than re-emitting as a fresh Signal.
    const second = await repository.applyTransition({
      ...base,
      strategyVersionId: "version-2",
      outcome: "MATCHED",
      now: new Date(),
      previous: states.get(`${security.id} buy-1`) ?? null,
    });

    expect(second.emittedSignalId).toBeNull();
    expect(second.resolvedSignalIds).toEqual([]);
    expect(await signalsOf(monitorId)).toHaveLength(1);
  });
});
