import { randomUUID } from "node:crypto";
import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { Security } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MonitorEodEvaluation } from "./monitor-evaluation.js";
import {
  afterClose,
  EodFixtureData,
  fixturePolicy,
  longHistory,
  scopedRepository,
} from "./monitor-evaluation.test-helper.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * The Monitor lifecycle as a table of named sessions and the transitions each one must produce.
 *
 * Every expectation below is **written out** — the state, how many Signals exist, which one is
 * open, the session the state began on — rather than read back from whatever the implementation
 * did. A defect that changed the lifecycle's meaning could satisfy a test that derives its
 * expectation from the code; it cannot satisfy a table someone wrote from `ai/product/monitors.md`.
 *
 * Each step is one **finalized session**: its close is stored, and the EOD evaluation runs after it
 * became final (`docs/decisions/monitor-eod-v2.md` §3). Only storage is replaced
 * (`EodFixtureData`); the evaluation, the transitions and the Signal rows are the production ones
 * against real PostgreSQL. The first step of a scenario is the Monitor's first evaluation, which
 * reconstructs from the history before it — the result a full replay reaches.
 */

const prisma = new PrismaClient();
const real = new PrismaMonitorRepository(prisma);
const running = new Set<string>();
const repository = scopedRepository(real, () => running);
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

/** A condition on another series than the trigger's, so a setup can begin without a crossing. */
function waitingDefinition(): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [
            {
              id: "c-buy",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_50D" },
            },
          ],
          trigger: priceCrossesAboveSma("t-buy"),
        },
      },
    ],
    sellLevels: [],
  };
}

/**
 * Thirty flat closes at 100, ending on Friday 2026-02-27, so a 20-bar SMA is warm and equals 100.
 */
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
  /** The session evaluated: its close is stored, and the evaluation runs once it is final. */
  readonly session: string;
  /** The session's close, or null when the security printed no bar that day. */
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
        price: 130,
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
        price: 130,
        expected: { state: "ACTIVE", signals: 1, open: 1, since: "2026-03-02" },
      },
      {
        session: "2026-03-03",
        price: 135,
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
        price: 138,
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
        price: 130,
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
        price: 130,
        expected: { state: "ACTIVE", signals: 1, open: 1 },
      },
      {
        session: "2026-03-03",
        price: 80,
        expected: { state: "RESOLVED", signals: 1, open: 0 },
      },
      {
        session: "2026-03-04",
        price: 132,
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
        price: 130,
        expected: { state: "ACTIVE", signals: 1, open: 1 },
      },
      {
        session: "2026-03-03",
        price: 130,
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
        price: 130,
        expected: { state: "ACTIVE", signals: 1, open: 1 },
      },
      {
        session: "2026-03-03",
        price: 130,
        membership: "remove",
        expected: { state: "NONE", signals: 1, open: 0 },
      },
      {
        session: "2026-03-04",
        price: 130,
        membership: "add",
        // The forgotten state is not resumed: the member is reconstructed from its history, so the
        // new occurrence is dated to the session the condition has held since — March 2, the result
        // a full replay reaches — and is marked as established by history.
        expected: {
          state: "ACTIVE",
          signals: 2,
          open: 1,
          since: "2026-03-02",
          observed: "2026-03-02",
          reconstructed: true,
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
        price: 130,
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
        price: 130,
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
        price: 130,
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
    definition: waitingDefinition(),
    // A fall from 120 to 100, then a recovery: the price crossed its 20-day average at 108 while it
    // was still below its 50-day one, so that crossing armed nothing.
    closes: [...Array(50).fill(120), ...Array(15).fill(100), 104, 108, 112],
    steps: [
      {
        session: "2026-03-02",
        // Above its 50-day average now (113.20), and already above its 20-day one yesterday: the
        // condition holds and nothing crossed today.
        price: 116,
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
      const security = await createSecurity(`FX${index}${suffix}`);
      const { monitorId, stockListId } = await createMonitor({
        userId: user.id,
        definition: scenario.definition,
        security,
      });

      running.add(monitorId);
      const data = new EodFixtureData([security]);
      data.prices.set(security.id, longHistory(security.id, scenario.closes));

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
        if (step.price !== null) {
          data.addBar(security.id, step.session, step.price);
        }
        const clock = { now: afterClose(step.session) };
        cycleSequence += 1;
        await new MonitorEodEvaluation(
          repository,
          data,
          fixturePolicy(clock),
          logger,
          {
            securityConcurrency: 1,
            lateRecoveryMs: 24 * 60 * 60_000,
            now: () => clock.now,
          },
        ).run(cycleSequence);

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

      running.delete(monitorId);
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
    running.add(monitorId);
    const data = new EodFixtureData([security]);
    const prices = longHistory(security.id, CROSSED_HISTORY);
    data.prices.set(security.id, prices);
    data.addBar(security.id, "2026-03-02", 118);
    const scan = afterClose("2026-03-02");
    await new MonitorEodEvaluation(
      repository,
      data,
      fixturePolicy({ now: scan }),
      logger,
      {
        securityConcurrency: 1,
        lateRecoveryMs: 24 * 60 * 60_000,
        now: () => scan,
      },
    ).run((cycleSequence += 1));

    const crossingDate = prices[CROSSING_INDEX]!.date;
    const actual = await observedState(monitorId, "buy-1");
    expect(actual.observed).toBe(crossingDate);
    expect(actual.since).toBe(crossingDate);
    expect(actual.reconstructed).toBe(true);
    // The write's own clock is kept, and it is later than the session: that gap is exactly what the
    // Dashboard used to show as "Since".
    expect(actual.lifecycleSince?.toISOString()).toBe(scan.toISOString());
    expect(crossingDate < "2026-03-02").toBe(true);

    running.delete(monitorId);
  });
});
