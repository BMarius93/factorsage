import { randomUUID } from "node:crypto";
import type { StrategyDefinition } from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { DailyPrice, Security, SecurityId } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  monitorWindowObservations,
  projectMonitorEvaluationFrame,
  requiredDailySeries,
  type CurrentObservation,
  type MonitorEvaluationFrame,
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
  observationDate = "2026-03-02";

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
    return projectMonitorEvaluationFrame({
      security: input.security,
      prices,
      derived: [],
      operands: input.operands,
      observation: input.observation,
      observationDate: this.observationDate,
    });
  }

  monitorWindowObservations(operands: readonly OperandKey[]): number {
    return monitorWindowObservations(requiredDailySeries(operands));
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

async function createSecurity(symbol: string): Promise<Security> {
  const row = await prisma.security.create({
    data: {
      providerSymbol: `${symbol}.${suffix}`,
      symbol,
      name: `${symbol} Test`,
      exchangeCode: "NASDAQ",
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

function cycleOf(loader: MonitorDataLoader): MonitorCycle {
  return new MonitorCycle(repository, loader, logger, {
    symbolConcurrency: 4,
    quoteMaxAgeMs: 4 * 24 * 60 * 60_000,
  });
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
    const restarted = new MonitorCycle(
      new PrismaMonitorRepository(prisma),
      loader,
      logger,
      { symbolConcurrency: 4, quoteMaxAgeMs: 4 * 24 * 60 * 60_000 },
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

  it("treats a provider failure as NOT_EVALUABLE without ending or repeating a match", async () => {
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

    // The provider is down. The cycle has no current observation, so it cannot decide the
    // evaluation a Monitor is defined to make — and must not decide a different one instead.
    loader.currentDataError = new Error("provider unavailable");
    const failed = await cycle.run(nextCycle());
    expect(failed.currentDataFailed).toBe(true);
    expect(failed.notEvaluable).toBe(1);

    // The live match is still active: an outage neither ended it nor re-emitted it on recovery.
    let signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();

    loader.currentDataError = null;
    loader.currentPrice = 150;
    await cycle.run(nextCycle());

    signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.resolvedAt).toBeNull();
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

    const summary = await new MonitorCycle(repository, loader, logger, {
      symbolConcurrency: 4,
      quoteMaxAgeMs: 60_000,
    }).run(nextCycle());

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
    expect(signal?.observationDate.toISOString().slice(0, 10)).toBe(
      loader.observationDate,
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

    // The next session. An event's Signal is active for the session it fired in; a new observation
    // date closes it rather than leaving every crossing ever fired on the active list.
    loader.observationDate = "2026-03-03";
    loader.currentPrice = 150;
    await cycle.run(nextCycle());

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
      securityId: security.id,
      levelId: "buy-1",
      levelKind: "BUY" as const,
      strategyVersionId: "version-1",
      signalFingerprint: "fingerprint-a",
      hasTrigger: false,
      outcome: "MATCHED" as const,
      observationDate: "2026-03-02",
      observationPrice: 150,
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
      securityId: security.id,
      levelId: "buy-1",
      levelKind: "BUY" as const,
      hasTrigger: false,
      observationDate: "2026-03-02",
      observationPrice: 150,
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
      securityId: security.id,
      levelId: "buy-1",
      levelKind: "BUY" as const,
      signalFingerprint: "unchanged-level",
      hasTrigger: false,
      observationDate: "2026-03-02",
      observationPrice: 150,
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
