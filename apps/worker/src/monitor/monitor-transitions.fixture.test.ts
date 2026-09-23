import { randomUUID } from "node:crypto";
import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { DailyPrice, Security } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MonitorCycle } from "./monitor-cycle.js";
import {
  FixtureCalendar,
  FixtureLoader,
  longHistory,
} from "./monitor-fixtures.test-helper.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * The Monitor lifecycle as a table of named sessions and the transitions each one must produce.
 *
 * `monitor-cycle.integration.test.ts` proves a wide surface one behaviour at a time. This suite is
 * the narrow complement the data-correctness audit asked for: every expectation below is **written
 * out** — the state, how many Signals exist, which one is open, the session the state began on —
 * rather than read back from whatever the implementation did. A defect that changed the lifecycle's
 * meaning could satisfy a test that derives its expectation from the code; it cannot satisfy a
 * table someone wrote from `ai/product/monitors.md`.
 *
 * It is deterministic and fixture-driven: fixed closes, a fixed quote per session, an injected
 * clock. Only the market-data and calendar boundaries are replaced; the repository, the transitions
 * and the Signal rows are the production ones against real PostgreSQL.
 */

const prisma = new PrismaClient();
const repository = new PrismaMonitorRepository(prisma);
const logger = createLogger({ service: "worker", level: "silent" });
const suffix = randomUUID().replaceAll("-", "").slice(0, 6);

const SMA = "SMA_20D";

/** `Price is above SMA 20D` — true at 150 and false at 80 against a flat-100 history. */
const priceAboveSma = (id: string) =>
  ({
    id,
    metric: { kind: "PRICE" as const },
    operator: "IS_ABOVE" as const,
    value: { kind: "SERIES" as const, seriesId: SMA },
  }) as const;

/** `Price is below SMA 20D` — false for every quote below, so a level can be kept quiet. */
const priceBelowSma = (id: string) =>
  ({
    id,
    metric: { kind: "PRICE" as const },
    operator: "IS_BELOW" as const,
    value: { kind: "SERIES" as const, seriesId: SMA },
  }) as const;

/** A BUY level that never matches these fixtures. A Strategy always has at least one. */
const quietBuyLevel = (conditionId: string) => ({
  id: "buy-1",
  percentage: 100 as const,
  signal: { conditions: [priceBelowSma(conditionId)] },
});

const priceCrossesAboveSma = (id: string) =>
  ({
    id,
    metric: { kind: "PRICE" as const },
    operator: "CROSSES_ABOVE" as const,
    value: { kind: "SERIES" as const, seriesId: SMA },
  }) as const;

function buyDefinition(): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: { conditions: [priceAboveSma("c-buy")] },
      },
    ],
    sellLevels: [],
  };
}

function sellDefinition(): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [quietBuyLevel("c-quiet-sell")],
    sellLevels: [
      {
        id: "sell-1",
        percentage: 25,
        signal: { conditions: [priceAboveSma("c-sell")] },
      },
    ],
  };
}

function finalExitDefinition(): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [quietBuyLevel("c-quiet-exit")],
    sellLevels: [],
    finalExit: {
      id: "exit-1",
      rules: [
        {
          id: "exit-rule-1",
          signal: { conditions: [priceAboveSma("c-exit")] },
        },
      ],
    },
  };
}

/** Conditions plus a Trigger: the setup can hold while the crossing has not happened. */
function triggerDefinition(): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [priceAboveSma("c-buy")],
          trigger: priceCrossesAboveSma("t-buy"),
        },
      },
    ],
    sellLevels: [],
  };
}

/** Thirty flat closes at 100, ending on Friday 2026-02-27, so a 20-bar SMA is warm and equals 100. */
const FLAT_HISTORY = Array.from({ length: 30 }, () => 100);

/**
 * Thirty flat closes, then a crossing and four sessions above it.
 *
 * The crossing is the 31st bar, 2026-02-23 under `longHistory`'s backwards dating, which is what
 * the reconstruction scenario expects its Signal to be dated to.
 */
const CROSSED_HISTORY = [...FLAT_HISTORY, 110, 112, 114, 116];
const CROSSING_INDEX = FLAT_HISTORY.length;

type Expectation = {
  /** The durable lifecycle state of the level, or `NONE` when no state row exists. */
  readonly state:
    "ACTIVE" | "PENDING_TRIGGER" | "RESOLVED" | "INACTIVE" | "NONE";
  /** Signal rows for the level, resolved and unresolved. */
  readonly signals: number;
  /** Signal rows for the level with no `resolvedAt`. */
  readonly open: number;
  /** `lifecycleSinceDate`: the session the state was entered on. */
  readonly since?: string;
  /** The open Signal's `observationDate`. */
  readonly observed?: string;
  /** The open Signal's `reconstructed` flag. */
  readonly reconstructed?: boolean;
  /** The newest resolved Signal's reason. */
  readonly resolution?: string;
};

type Step = {
  /** The session the cycle runs on. */
  readonly session: string;
  /** The quote the loader reports, or null for "no current data". */
  readonly price: number | null;
  /** Membership changes applied before the cycle runs. */
  readonly membership?: "remove" | "add";
  readonly expected: Expectation;
};

type Scenario = {
  readonly name: string;
  readonly levelId: string;
  readonly definition: StrategyDefinition;
  readonly closes: readonly number[];
  /** True when reconstruction can see the history's indicator columns. */
  readonly history?: boolean;
  readonly steps: readonly Step[];
};

/**
 * The scenarios, in the order the product document describes the lifecycle.
 *
 * Each `expected` is the whole state of the level after that session, so a step that should change
 * nothing says so by repeating the previous numbers.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    name: "no match, then a match, emits one Signal",
    levelId: "buy-1",
    definition: buyDefinition(),
    closes: FLAT_HISTORY,
    steps: [
      {
        session: "2026-03-02",
        price: 80,
        expected: { state: "INACTIVE", signals: 0, open: 0 },
      },
      {
        session: "2026-03-03",
        price: 150,
        expected: {
          state: "ACTIVE",
          signals: 1,
          open: 1,
          since: "2026-03-03",
          observed: "2026-03-03",
          reconstructed: false,
        },
      },
    ],
  },
  {
    name: "a match that continues emits no second Signal",
    levelId: "buy-1",
    definition: buyDefinition(),
    closes: FLAT_HISTORY,
    steps: [
      {
        session: "2026-03-02",
        price: 150,
        expected: { state: "ACTIVE", signals: 1, open: 1, since: "2026-03-02" },
      },
      {
        session: "2026-03-03",
        price: 160,
        // A new session, a higher price, the same condition: the occurrence is the same one, and
        // "since" stays on the session it began.
        expected: {
          state: "ACTIVE",
          signals: 1,
          open: 1,
          since: "2026-03-02",
          observed: "2026-03-02",
        },
      },
      {
        session: "2026-03-04",
        price: 170,
        expected: { state: "ACTIVE", signals: 1, open: 1, since: "2026-03-02" },
      },
    ],
  },
  {
    name: "a match that ends resolves its Signal",
    levelId: "buy-1",
    definition: buyDefinition(),
    closes: FLAT_HISTORY,
    steps: [
      {
        session: "2026-03-02",
        price: 150,
        expected: { state: "ACTIVE", signals: 1, open: 1 },
      },
      {
        session: "2026-03-03",
        price: 80,
        expected: {
          state: "RESOLVED",
          signals: 1,
          open: 0,
          since: "2026-03-03",
          resolution: "CONDITIONS_ENDED",
        },
      },
    ],
  },
  {
    name: "a resolved level that matches again emits a second Signal",
    levelId: "buy-1",
    definition: buyDefinition(),
    closes: FLAT_HISTORY,
    steps: [
      {
        session: "2026-03-02",
        price: 150,
        expected: { state: "ACTIVE", signals: 1, open: 1 },
      },
      {
        session: "2026-03-03",
        price: 80,
        expected: { state: "RESOLVED", signals: 1, open: 0 },
      },
      {
        session: "2026-03-04",
        price: 155,
        // A second occurrence, not a reopening of the first: the log is append-only.
        expected: {
          state: "ACTIVE",
          signals: 2,
          open: 1,
          since: "2026-03-04",
          observed: "2026-03-04",
        },
      },
    ],
  },
  {
    name: "a security removed from the list closes its Signal",
    levelId: "buy-1",
    definition: buyDefinition(),
    closes: FLAT_HISTORY,
    steps: [
      {
        session: "2026-03-02",
        price: 150,
        expected: { state: "ACTIVE", signals: 1, open: 1 },
      },
      {
        session: "2026-03-03",
        price: 150,
        membership: "remove",
        // No state row survives: the Monitor no longer watches this security at all.
        expected: {
          state: "NONE",
          signals: 1,
          open: 0,
          resolution: "MEMBER_REMOVED",
        },
      },
    ],
  },
  {
    name: "a security added back is evaluated fresh",
    levelId: "buy-1",
    definition: buyDefinition(),
    closes: FLAT_HISTORY,
    steps: [
      {
        session: "2026-03-02",
        price: 150,
        expected: { state: "ACTIVE", signals: 1, open: 1 },
      },
      {
        session: "2026-03-03",
        price: 150,
        membership: "remove",
        expected: { state: "NONE", signals: 1, open: 0 },
      },
      {
        session: "2026-03-04",
        price: 150,
        membership: "add",
        // The forgotten state cannot be resumed, so the match is a new occurrence dated to the
        // session that observed it.
        expected: {
          state: "ACTIVE",
          signals: 2,
          open: 1,
          since: "2026-03-04",
          observed: "2026-03-04",
        },
      },
    ],
  },
  {
    name: "a BUY level records its own kind",
    levelId: "buy-1",
    definition: buyDefinition(),
    closes: FLAT_HISTORY,
    steps: [
      {
        session: "2026-03-02",
        price: 150,
        expected: { state: "ACTIVE", signals: 1, open: 1, since: "2026-03-02" },
      },
    ],
  },
  {
    name: "a SELL level records its own kind",
    levelId: "sell-1",
    definition: sellDefinition(),
    closes: FLAT_HISTORY,
    steps: [
      {
        session: "2026-03-02",
        price: 150,
        expected: { state: "ACTIVE", signals: 1, open: 1, since: "2026-03-02" },
      },
    ],
  },
  {
    name: "a FINAL EXIT level records its own kind",
    levelId: "exit-1",
    definition: finalExitDefinition(),
    closes: FLAT_HISTORY,
    steps: [
      {
        session: "2026-03-02",
        price: 150,
        expected: { state: "ACTIVE", signals: 1, open: 1, since: "2026-03-02" },
      },
      {
        session: "2026-03-03",
        price: 80,
        expected: { state: "RESOLVED", signals: 1, open: 0 },
      },
    ],
  },
  {
    name: "a setup waiting for its trigger is PENDING_TRIGGER with no Signal",
    levelId: "buy-1",
    definition: triggerDefinition(),
    closes: [...FLAT_HISTORY, 110, 112],
    steps: [
      {
        session: "2026-03-02",
        // Above the average, and it was already above it yesterday: the conditions hold and
        // nothing crossed today.
        price: 114,
        expected: {
          state: "PENDING_TRIGGER",
          signals: 0,
          open: 0,
          since: "2026-03-02",
        },
      },
    ],
  },
  {
    name: "reconstruction dates a Signal to the session it happened on",
    levelId: "buy-1",
    definition: triggerDefinition(),
    closes: CROSSED_HISTORY,
    history: true,
    steps: [
      {
        session: "2026-03-02",
        price: 118,
        // The crossing is in the history, before this Monitor existed. The Signal belongs to that
        // session, and `lifecycleSince` — the write — stays the scan's own clock; the Dashboard
        // projects the two into "Since" (`monitorStateSince` in the API).
        expected: {
          state: "ACTIVE",
          signals: 1,
          open: 1,
          reconstructed: true,
        },
      },
    ],
  },
];

let cycleSequence = 0;
const userIds: string[] = [];
const securityIds: string[] = [];

async function createSecurity(symbol: string): Promise<Security> {
  const row = await prisma.security.create({
    data: {
      providerSymbol: `${symbol}.${suffix}`,
      symbol,
      name: `${symbol} Fixture`,
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
  security: Security;
}): Promise<{ monitorId: string; stockListId: string }> {
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
      items: { create: [{ securityId: input.security.id }] },
    },
  });
  const monitor = await prisma.monitor.create({
    data: {
      userId: input.userId,
      name: `Monitor ${randomUUID().slice(0, 8)}`,
      strategyId: strategy.id,
      stockListId: stockList.id,
      enabled: true,
    },
  });
  return { monitorId: monitor.id, stockListId: stockList.id };
}

async function observedState(monitorId: string, levelId: string) {
  const [state, signals] = await Promise.all([
    prisma.monitorSignalState.findFirst({ where: { monitorId, levelId } }),
    prisma.monitorSignal.findMany({
      where: { monitorId, levelId },
      orderBy: { detectedAt: "asc" },
    }),
  ]);
  const open = signals.filter((signal) => signal.resolvedAt === null);
  const resolved = signals.filter((signal) => signal.resolvedAt !== null);
  return {
    state: state?.lifecycleState ?? ("NONE" as const),
    signals: signals.length,
    open: open.length,
    since: state?.lifecycleSinceDate?.toISOString().slice(0, 10),
    lifecycleSince: state?.lifecycleSince,
    observed: open[0]?.observationDate.toISOString().slice(0, 10),
    reconstructed: open[0]?.reconstructed,
    resolution: resolved.at(-1)?.resolutionReason ?? undefined,
  };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // Monitors, strategies, lists, states and Signals all cascade from the owning user.
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
  await prisma.$disconnect();
});

describe("Monitor transitions (fixture table)", () => {
  for (const [index, scenario] of SCENARIOS.entries()) {
    it(scenario.name, async () => {
      const user = await prisma.user.create({
        data: {
          email: `transitions-${randomUUID()}@example.test`,
          plan: "PRO",
        },
      });
      userIds.push(user.id);
      const security = await createSecurity(`FX${index}${suffix.slice(0, 3)}`);
      const { monitorId, stockListId } = await createMonitor({
        userId: user.id,
        definition: scenario.definition,
        security,
      });

      const loader = new FixtureLoader([security]);
      loader.prices.set(
        security.id,
        longHistory(security.id, scenario.closes) as DailyPrice[],
      );
      loader.historyFrames = scenario.history ?? false;
      const calendar = new FixtureCalendar();

      for (const step of scenario.steps) {
        if (step.membership === "remove") {
          await prisma.stockListItem.deleteMany({
            where: { stockListId, securityId: security.id },
          });
        } else if (step.membership === "add") {
          await prisma.stockListItem.create({
            data: { stockListId, securityId: security.id },
          });
        }
        loader.currentPrice = step.price;
        const cycle = new MonitorCycle(repository, loader, calendar, logger, {
          symbolConcurrency: 1,
          quoteMaxAgeMs: 4 * 24 * 60 * 60_000,
          // 10:00 New York on the named session: the cycle derives the observation date from it.
          now: () => new Date(`${step.session}T15:00:00.000Z`),
        });
        cycleSequence += 1;
        await cycle.run(cycleSequence);

        const actual = await observedState(monitorId, scenario.levelId);
        const message = `${scenario.name} @ ${step.session}`;
        expect(actual.state, message).toBe(step.expected.state);
        expect(actual.signals, message).toBe(step.expected.signals);
        expect(actual.open, message).toBe(step.expected.open);
        if (step.expected.since !== undefined) {
          expect(actual.since, message).toBe(step.expected.since);
        }
        if (step.expected.observed !== undefined) {
          expect(actual.observed, message).toBe(step.expected.observed);
        }
        if (step.expected.reconstructed !== undefined) {
          expect(actual.reconstructed, message).toBe(
            step.expected.reconstructed,
          );
        }
        if (step.expected.resolution !== undefined) {
          expect(actual.resolution, message).toBe(step.expected.resolution);
        }
      }

      await prisma.monitor.update({
        where: { id: monitorId },
        data: { enabled: false },
      });
    });
  }

  it("dates a reconstructed activation to its own session, not to the scan", async () => {
    // The `Since` half of AUD-05 at its source: the durable row must carry both the session the
    // occurrence began on and the instant the scan wrote it, and they must differ here.
    const user = await prisma.user.create({
      data: { email: `since-${randomUUID()}@example.test`, plan: "PRO" },
    });
    userIds.push(user.id);
    const security = await createSecurity(`SN${suffix.slice(0, 4)}`);
    const { monitorId } = await createMonitor({
      userId: user.id,
      definition: triggerDefinition(),
      security,
    });
    const loader = new FixtureLoader([security]);
    const prices = longHistory(security.id, CROSSED_HISTORY) as DailyPrice[];
    loader.prices.set(security.id, prices);
    loader.historyFrames = true;
    loader.currentPrice = 118;
    const scan = new Date("2026-03-02T15:00:00.000Z");
    await new MonitorCycle(repository, loader, new FixtureCalendar(), logger, {
      symbolConcurrency: 1,
      quoteMaxAgeMs: 4 * 24 * 60 * 60_000,
      now: () => scan,
    }).run((cycleSequence += 1));

    const crossingDate = prices[CROSSING_INDEX]!.date;
    const actual = await observedState(monitorId, "buy-1");
    expect(actual.observed).toBe(crossingDate);
    expect(actual.since).toBe(crossingDate);
    expect(actual.reconstructed).toBe(true);
    // The write's own clock is kept, and it is later than the session: that gap is exactly what the
    // Dashboard used to show as "Since".
    expect(actual.lifecycleSince?.toISOString()).toBe(scan.toISOString());
    expect(crossingDate < "2026-03-02").toBe(true);

    await prisma.monitor.update({
      where: { id: monitorId },
      data: { enabled: false },
    });
  });
});
