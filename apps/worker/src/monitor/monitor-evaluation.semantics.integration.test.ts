import { randomUUID } from "node:crypto";
import {
  STRATEGY_SCHEMA_VERSION,
  type SelectableSeriesId,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategySignal,
  type StrategyTrigger,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { Security } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MonitorEodEvaluation } from "./monitor-evaluation.js";
import {
  afterClose,
  EodFixtureData,
  fixturePolicy,
  longHistory,
  scopedRepository,
} from "./monitor-evaluation.test-helper.js";
import {
  PrismaMonitorRepository,
  type MonitorEvaluationRepository,
} from "./monitor-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * What the EOD evaluation decides across a wide surface, one behaviour at a time, against real
 * PostgreSQL (`docs/decisions/monitor-eod-v2.md` §3–§5). These are the V1 cycle's cases that still
 * describe the product once observations are finalized sessions: which Monitors run, one read per
 * security, a read failure isolated to its security, FINAL EXIT alternatives, position-dependent
 * levels, logic edits, built-ins, the rebind fence, state loss and the conditions-plus-trigger
 * lifecycle. Cases about live quotes, provisional bars and intraday whipsaws ended with the
 * live-quote cycle (`docs/decisions/monitor-eod-v2.md` §8) and are not restated.
 *
 * Only storage is replaced (`EodFixtureData`): the evaluation, the lifecycle reducer, the
 * repository and its transactions are the production ones.
 */

const prisma = new PrismaClient();
const real = new PrismaMonitorRepository(prisma);
const running = new Set<string>();
const repository = scopedRepository(real, () => running);
const logger = createLogger({ service: "worker", level: "silent" });
const suffix = randomUUID().replaceAll("-", "").slice(0, 6);
const userIds: string[] = [];
const securityIds: string[] = [];
const systemRows: {
  monitorId: string;
  strategyId: string;
  stockListId: string;
}[] = [];
let cycle = 0;

const FLAT = Array.from({ length: 30 }, () => 100);

const above = (
  id: string,
  seriesId: SelectableSeriesId = "SMA_20D",
): StrategyCondition => ({
  id,
  metric: { kind: "PRICE" },
  operator: "IS_ABOVE",
  value: { kind: "SERIES", seriesId },
});

const crossesAbove = (
  id: string,
  seriesId: SelectableSeriesId = "SMA_20D",
): StrategyTrigger => ({
  id,
  metric: { kind: "PRICE" },
  operator: "CROSSES_ABOVE",
  value: { kind: "SERIES", seriesId },
});

function buyOnly(signal: StrategySignal): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "buy-1", percentage: 100, signal }],
    sellLevels: [],
  };
}

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `eod-semantics-${randomUUID()}@example.test`, plan: "PRO" },
  });
  userIds.push(user.id);
  return user.id;
}

async function createSecurity(tag: string): Promise<Security> {
  const symbol = `${tag}${suffix.slice(0, 3)}`.toUpperCase();
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
  definition: unknown;
  securities: readonly Security[];
  enabled?: boolean;
}): Promise<{ monitorId: string; strategyId: string; stockListId: string }> {
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
  running.add(monitor.id);
  return {
    monitorId: monitor.id,
    strategyId: strategy.id,
    stockListId: stockList.id,
  };
}

async function appendVersion(strategyId: string, definition: unknown) {
  const latest = await prisma.strategyVersion.findFirstOrThrow({
    where: { strategyId },
    orderBy: { versionNumber: "desc" },
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

function evaluation(
  data: EodFixtureData,
  session: string,
  options: {
    repository?: MonitorEvaluationRepository;
    isAborted?: () => boolean;
  } = {},
) {
  const clock = { now: afterClose(session) };
  return new MonitorEodEvaluation(
    options.repository ?? repository,
    data,
    fixturePolicy(clock),
    logger,
    {
      securityConcurrency: 1,
      lateRecoveryMs: 24 * 60 * 60_000,
      now: () => clock.now,
    },
  ).run((cycle += 1), options.isAborted);
}

const signalsOf = (monitorId: string, levelId?: string) =>
  prisma.monitorSignal.findMany({
    where: { monitorId, ...(levelId ? { levelId } : {}) },
    // An occurrence a pass re-decides on the same session ties the one it replaced on both dates,
    // `detectedAt` being the pass's clock: the closed occurrence comes first, the open one last.
    orderBy: [
      { observationDate: "asc" },
      { detectedAt: "asc" },
      { resolvedAt: { sort: "asc", nulls: "last" } },
    ],
  });
const statesOf = (monitorId: string) =>
  prisma.monitorSignalState.findMany({ where: { monitorId } });
const transitionsOf = (monitorId: string) =>
  prisma.monitorStateTransition.findMany({
    where: { monitorId },
    orderBy: { sequence: "asc" },
  });

function fixture(security: Security, closes: readonly number[] = FLAT) {
  const data = new EodFixtureData([security]);
  data.prices.set(security.id, longHistory(security.id, closes));
  return data;
}

beforeEach(() => {
  running.clear();
});

afterAll(async () => {
  for (const row of systemRows) {
    await prisma.monitor.deleteMany({ where: { id: row.monitorId } });
    await prisma.stockList.deleteMany({ where: { id: row.stockListId } });
    await prisma.strategy.deleteMany({ where: { id: row.strategyId } });
  }
  // Monitors, strategies, lists, states and Signals all cascade from the owning user.
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
  await prisma.$disconnect();
});

describe("the EOD evaluation's semantics", () => {
  it("evaluates an enabled Monitor and ignores a disabled one", async () => {
    const userId = await createUser();
    const security = await createSecurity("EN");
    const enabled = await createMonitor({
      userId,
      definition: buyOnly({ conditions: [above("c1")] }),
      securities: [security],
    });
    const disabled = await createMonitor({
      userId,
      definition: buyOnly({ conditions: [above("c1")] }),
      securities: [security],
      enabled: false,
    });
    const data = fixture(security);
    data.addBar(security.id, "2026-03-02", 130);
    const summary = await evaluation(data, "2026-03-02");
    expect(summary.monitors).toBe(1);
    expect(await signalsOf(enabled.monitorId)).toHaveLength(1);
    expect(await statesOf(disabled.monitorId)).toHaveLength(0);
  });

  it("reads each security once however many Monitors watch it, asking for the union of operands", async () => {
    const userId = await createUser();
    const security = await createSecurity("SH");
    const first = await createMonitor({
      userId,
      definition: buyOnly({ conditions: [above("c1", "SMA_20D")] }),
      securities: [security],
    });
    const second = await createMonitor({
      userId,
      definition: buyOnly({ conditions: [above("c2", "EMA_20D")] }),
      securities: [security],
    });
    const data = fixture(security);
    data.addBar(security.id, "2026-03-02", 130);
    await evaluation(data, "2026-03-02");
    const reads = data.frameReads.filter(
      (read) => read.securityId === security.id,
    );
    expect(reads).toHaveLength(1);
    expect([...reads[0]!.operands].sort()).toEqual(
      ["price", "series:EMA_20D", "series:SMA_20D"].sort(),
    );
    expect(await signalsOf(first.monitorId)).toHaveLength(1);
    expect(await signalsOf(second.monitorId)).toHaveLength(1);
  });

  it("fails only the security whose read fails, writing nothing for it, and decides it on the next pass", async () => {
    const userId = await createUser();
    const failing = await createSecurity("RF");
    const healthy = await createSecurity("RH");
    const { monitorId } = await createMonitor({
      userId,
      definition: buyOnly({ conditions: [above("c1")] }),
      securities: [failing, healthy],
    });
    const data = new EodFixtureData([failing, healthy]);
    for (const security of [failing, healthy]) {
      data.prices.set(security.id, longHistory(security.id, FLAT));
      data.addBar(security.id, "2026-03-02", 130);
    }
    data.failNextRead.set(failing.id, new Error("storage unavailable"));

    const failed = await evaluation(data, "2026-03-02");
    expect(failed.securitiesFailed).toBe(1);
    expect((await signalsOf(monitorId)).map((row) => row.securityId)).toEqual([
      healthy.id,
    ]);
    expect(
      (await statesOf(monitorId)).filter(
        (row) => row.securityId === failing.id,
      ),
    ).toEqual([]);
    expect(
      await prisma.monitorEvaluationCheckpoint.findMany({
        where: { monitorId, securityId: failing.id },
      }),
    ).toEqual([]);

    // Nothing is lost: the next pass decides the same session for it, and only for it.
    const recovered = await evaluation(data, "2026-03-02");
    expect(recovered.securitiesFailed).toBe(0);
    const signals = await signalsOf(monitorId);
    expect(signals.map((row) => row.securityId).sort()).toEqual(
      [failing.id, healthy.id].sort(),
    );
    expect(
      signals
        .find((row) => row.securityId === failing.id)
        ?.observationDate.toISOString()
        .slice(0, 10),
    ).toBe("2026-03-02");
    expect(await transitionsOf(monitorId)).toHaveLength(2);
  });

  it("keeps a FINAL EXIT to one occurrence when two Exit Rules match together", async () => {
    const userId = await createUser();
    const security = await createSecurity("FE");
    const { monitorId } = await createMonitor({
      userId,
      definition: {
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [
          {
            id: "buy-1",
            percentage: 100,
            signal: { conditions: [above("c-buy", "SMA_50D")] },
          },
        ],
        sellLevels: [],
        finalExit: {
          id: "exit-1",
          rules: [
            { id: "exit-a", signal: { conditions: [above("c-a")] } },
            { id: "exit-b", signal: { conditions: [above("c-b", "EMA_20D")] } },
          ],
        },
      },
      securities: [security],
    });
    const data = fixture(security);
    data.addBar(security.id, "2026-03-02", 100);
    await evaluation(data, "2026-03-02");
    data.addBar(security.id, "2026-03-03", 130);
    await evaluation(data, "2026-03-03");
    const exits = await signalsOf(monitorId, "exit-1");
    expect(exits).toHaveLength(1);
    expect(exits[0]!.resolvedAt).toBeNull();
    data.addBar(security.id, "2026-03-04", 131);
    await evaluation(data, "2026-03-04");
    expect(await signalsOf(monitorId, "exit-1")).toHaveLength(1);
  });

  it("keeps a schema version 1 Strategy's FINAL EXIT state across sessions, never resetting it", async () => {
    const userId = await createUser();
    const security = await createSecurity("V1");
    const { monitorId } = await createMonitor({
      userId,
      // A stored version 1 document: one FINAL EXIT signal, upcast when it is read.
      definition: {
        schemaVersion: 1,
        buyLevels: [
          {
            id: "buy-1",
            percentage: 100,
            signal: { conditions: [above("c-buy", "SMA_50D")] },
          },
        ],
        sellLevels: [],
        finalExit: { id: "exit-1", signal: { conditions: [above("c-exit")] } },
      },
      securities: [security],
    });
    const data = fixture(security);
    data.addBar(security.id, "2026-03-02", 130);
    await evaluation(data, "2026-03-02");
    data.addBar(security.id, "2026-03-03", 131);
    await evaluation(data, "2026-03-03");
    const exits = await signalsOf(monitorId, "exit-1");
    expect(exits).toHaveLength(1);
    expect(exits[0]!.resolvedAt).toBeNull();
    expect(
      (await transitionsOf(monitorId)).filter(
        (t) => t.reason === "LOGIC_CHANGED",
      ),
    ).toHaveLength(0);
  });

  it("never matches while a required series is warming up", async () => {
    const userId = await createUser();
    const security = await createSecurity("WU");
    const { monitorId } = await createMonitor({
      userId,
      definition: buyOnly({ conditions: [above("c1", "SMA_20D")] }),
      securities: [security],
    });
    // Ten sessions of history: a 20-day average does not exist yet.
    const data = fixture(
      security,
      Array.from({ length: 10 }, () => 100),
    );
    data.addBar(security.id, "2026-03-02", 500);
    await evaluation(data, "2026-03-02");
    expect(await signalsOf(monitorId)).toHaveLength(0);
    expect(await statesOf(monitorId)).toHaveLength(0);
  });

  describe("position-dependent levels", () => {
    const mixed = (sellUsesGain: boolean): StrategyDefinition => ({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: { conditions: [above("c-buy")] },
        },
      ],
      sellLevels: [
        {
          id: "sell-1",
          percentage: 50,
          signal: {
            conditions: sellUsesGain
              ? [
                  above("c-sell"),
                  {
                    id: "c-gain",
                    metric: { kind: "GAIN" },
                    operator: "IS_ABOVE",
                    value: { kind: "PERCENT", value: 20 },
                  },
                ]
              : [above("c-sell")],
          },
        },
      ],
    });

    it("skips a level that reads Gain whole, and evaluates the rest of the Strategy", async () => {
      const userId = await createUser();
      const security = await createSecurity("GN");
      const { monitorId } = await createMonitor({
        userId,
        definition: mixed(true),
        securities: [security],
      });
      const data = fixture(security);
      data.addBar(security.id, "2026-03-02", 130);
      await evaluation(data, "2026-03-02");
      expect(await signalsOf(monitorId, "buy-1")).toHaveLength(1);
      expect(await signalsOf(monitorId, "sell-1")).toHaveLength(0);
      expect((await statesOf(monitorId)).map((state) => state.levelId)).toEqual(
        ["buy-1"],
      );
    });

    it("ends a level's occurrence when an edit makes it read Gain, and evaluates it again once reverted", async () => {
      const userId = await createUser();
      const security = await createSecurity("GE");
      const { monitorId, strategyId } = await createMonitor({
        userId,
        definition: mixed(false),
        securities: [security],
      });
      const data = fixture(security);
      data.addBar(security.id, "2026-03-02", 130);
      await evaluation(data, "2026-03-02");
      expect(await signalsOf(monitorId, "sell-1")).toHaveLength(1);

      await appendVersion(strategyId, mixed(true));
      data.addBar(security.id, "2026-03-03", 131);
      await evaluation(data, "2026-03-03");
      const ended = await signalsOf(monitorId, "sell-1");
      expect(ended).toHaveLength(1);
      expect(ended[0]!.resolutionReason).toBe("LEVEL_REMOVED");

      await appendVersion(strategyId, mixed(false));
      data.addBar(security.id, "2026-03-04", 132);
      await evaluation(data, "2026-03-04");
      const again = await signalsOf(monitorId, "sell-1");
      expect(again).toHaveLength(2);
      expect(again[1]!.resolvedAt).toBeNull();
    });
  });

  it("resets only the level whose logic changed, administratively, and keeps the unchanged one", async () => {
    const userId = await createUser();
    const security = await createSecurity("LC");
    const definition = (
      sellSeries: SelectableSeriesId,
    ): StrategyDefinition => ({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: { conditions: [above("c-buy")] },
        },
      ],
      sellLevels: [
        {
          id: "sell-1",
          percentage: 50,
          signal: { conditions: [above("c-sell", sellSeries)] },
        },
      ],
    });
    const { monitorId, strategyId } = await createMonitor({
      userId,
      definition: definition("SMA_20D"),
      securities: [security],
    });
    const data = fixture(security);
    data.addBar(security.id, "2026-03-02", 130);
    await evaluation(data, "2026-03-02");
    const [buyBefore] = await signalsOf(monitorId, "buy-1");

    await appendVersion(strategyId, definition("EMA_20D"));
    data.addBar(security.id, "2026-03-03", 131);
    await evaluation(data, "2026-03-03");

    // BUY is untouched: the same open occurrence.
    const buyAfter = await signalsOf(monitorId, "buy-1");
    expect(buyAfter.map((signal) => signal.id)).toEqual([buyBefore!.id]);
    expect(buyAfter[0]!.resolvedAt).toBeNull();
    // SELL's old occurrence ended as a logic change — administrative — and its new logic was
    // reconstructed.
    const sells = await signalsOf(monitorId, "sell-1");
    expect(sells[0]!.resolutionReason).toBe("LOGIC_CHANGED");
    const reset = (await transitionsOf(monitorId)).find(
      (t) => t.reason === "LOGIC_CHANGED",
    );
    expect(reset?.origin).toBe("ADMINISTRATIVE");
    expect(reset?.observationDate).toBeNull();
    expect(sells.at(-1)!.resolvedAt).toBeNull();
  });

  it("applies a Strategy edit on the next pass, without waiting for the next close", async () => {
    const userId = await createUser();
    const security = await createSecurity("ED");
    const definition = (
      sellSeries: SelectableSeriesId,
    ): StrategyDefinition => ({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: { conditions: [above("c-buy")] },
        },
      ],
      sellLevels: [
        {
          id: "sell-1",
          percentage: 50,
          signal: { conditions: [above("c-sell", sellSeries)] },
        },
      ],
    });
    const { monitorId, strategyId } = await createMonitor({
      userId,
      definition: definition("SMA_20D"),
      securities: [security],
    });
    const data = fixture(security);
    data.addBar(security.id, "2026-03-02", 130);
    await evaluation(data, "2026-03-02");
    const transitionsBefore = (await transitionsOf(monitorId)).length;

    // Edited after the evening's evaluation; no new session arrives.
    await appendVersion(strategyId, definition("EMA_20D"));
    await evaluation(data, "2026-03-02");
    const sells = await signalsOf(monitorId, "sell-1");
    expect(sells[0]!.resolutionReason).toBe("LOGIC_CHANGED");
    expect(sells.at(-1)!.resolvedAt).toBeNull();
    // The unchanged BUY level was not decided twice: one occurrence, no new transition of its own.
    expect(await signalsOf(monitorId, "buy-1")).toHaveLength(1);
    const after = await transitionsOf(monitorId);
    expect(
      after.slice(transitionsBefore).every((t) => t.levelId === "sell-1"),
    ).toBe(true);

    // Once: a further pass over the same session changes nothing.
    await evaluation(data, "2026-03-02");
    expect(await transitionsOf(monitorId)).toHaveLength(after.length);
  });

  it("evaluates a globally enabled built-in with no owner, and skips a paused one", async () => {
    const security = await createSecurity("BI");
    const create = async (enabled: boolean) => {
      const key = randomUUID();
      const strategy = await prisma.strategy.create({
        data: {
          ownership: "SYSTEM",
          systemKey: `eod-semantics-strategy-${key}`,
          name: "Built-in strategy",
          versions: {
            create: {
              versionNumber: 1,
              definition: buyOnly({ conditions: [above("c1")] }) as never,
              definitionHash: randomUUID(),
            },
          },
        },
      });
      const stockList = await prisma.stockList.create({
        data: {
          ownership: "SYSTEM",
          systemKey: `eod-semantics-list-${key}`,
          name: "Built-in list",
          items: { create: [{ securityId: security.id }] },
        },
      });
      const monitor = await prisma.monitor.create({
        data: {
          ownership: "SYSTEM",
          systemKey: `eod-semantics-monitor-${key}`,
          name: "Built-in monitor",
          strategyId: strategy.id,
          stockListId: stockList.id,
          isPublished: true,
          isGloballyEnabled: enabled,
        },
      });
      systemRows.push({
        monitorId: monitor.id,
        strategyId: strategy.id,
        stockListId: stockList.id,
      });
      running.add(monitor.id);
      return monitor.id;
    };
    const live = await create(true);
    const paused = await create(false);
    const data = fixture(security);
    data.addBar(security.id, "2026-03-02", 130);
    await evaluation(data, "2026-03-02");
    expect(await signalsOf(live)).toHaveLength(1);
    expect(await statesOf(paused)).toHaveLength(0);
  });

  it("records the evaluation without touching the Monitor's user-facing updatedAt", async () => {
    const userId = await createUser();
    const security = await createSecurity("UA");
    const { monitorId } = await createMonitor({
      userId,
      definition: buyOnly({ conditions: [above("c1")] }),
      securities: [security],
    });
    const before = await prisma.monitor.findUniqueOrThrow({
      where: { id: monitorId },
    });
    const data = fixture(security);
    data.addBar(security.id, "2026-03-02", 130);
    await evaluation(data, "2026-03-02");
    const after = await prisma.monitor.findUniqueOrThrow({
      where: { id: monitorId },
    });
    expect(after.lastScanAt).not.toBeNull();
    expect(after.watchingSince).not.toBeNull();
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it("stops cleanly when aborted, and the next pass finishes the work", async () => {
    const userId = await createUser();
    const first = await createSecurity("AB");
    const second = await createSecurity("AC");
    const { monitorId } = await createMonitor({
      userId,
      definition: buyOnly({ conditions: [above("c1")] }),
      securities: [first, second],
    });
    const data = new EodFixtureData([first, second]);
    for (const security of [first, second]) {
      data.prices.set(security.id, longHistory(security.id, FLAT));
      data.addBar(security.id, "2026-03-02", 130);
    }
    let decided = 0;
    const aborted = await evaluation(data, "2026-03-02", {
      isAborted: () => decided++ >= 1,
    });
    expect(aborted.aborted).toBe(true);
    expect(await signalsOf(monitorId)).toHaveLength(1);
    // Aborted before reconciliation: nothing was marked scanned.
    expect(
      (await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } }))
        .lastScanAt,
    ).toBeNull();

    const resumed = await evaluation(data, "2026-03-02");
    expect(resumed.aborted).toBe(false);
    expect(await signalsOf(monitorId)).toHaveLength(2);
  });

  it("writes nothing and stamps no scan for a Monitor rebound while it was evaluated", async () => {
    const userId = await createUser();
    const security = await createSecurity("RB");
    const { monitorId } = await createMonitor({
      userId,
      definition: buyOnly({ conditions: [above("c1")] }),
      securities: [security],
    });
    // A rebind lands between the pass loading the Monitor and writing its first member.
    const rebinding: MonitorEvaluationRepository = {
      ...repository,
      applyMemberEvaluation: async (write) => {
        await prisma.monitor.update({
          where: { id: write.monitorId },
          data: { configVersion: { increment: 1 } },
        });
        return repository.applyMemberEvaluation(write);
      },
    };
    const data = fixture(security);
    data.addBar(security.id, "2026-03-02", 130);
    const summary = await evaluation(data, "2026-03-02", {
      repository: rebinding,
    });
    expect(summary.staleConfiguration).toBe(1);
    expect(await signalsOf(monitorId)).toHaveLength(0);
    expect(
      (await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } }))
        .lastScanAt,
    ).toBeNull();
  });

  describe("state loss", () => {
    it("does not fabricate a trigger when the state is lost after its session", async () => {
      const userId = await createUser();
      const security = await createSecurity("SL");
      const { monitorId } = await createMonitor({
        userId,
        definition: buyOnly({ conditions: [], trigger: crossesAbove("t1") }),
        securities: [security],
      });
      const data = fixture(security);
      data.addBar(security.id, "2026-03-02", 100);
      await evaluation(data, "2026-03-02");
      data.addBar(security.id, "2026-03-03", 120);
      await evaluation(data, "2026-03-03");
      expect(await signalsOf(monitorId)).toHaveLength(1);

      // Every durable record of the member is lost; the next session sees no crossing.
      await prisma.monitorSignalState.deleteMany({ where: { monitorId } });
      await prisma.monitorEvaluationCheckpoint.deleteMany({
        where: { monitorId },
      });
      data.addBar(security.id, "2026-03-04", 121);
      await evaluation(data, "2026-03-04");
      expect(await signalsOf(monitorId)).toHaveLength(1);
    });

    it("re-establishes a condition that is genuinely still true, dated to when it began", async () => {
      const userId = await createUser();
      const security = await createSecurity("SK");
      const { monitorId } = await createMonitor({
        userId,
        definition: buyOnly({ conditions: [above("c1")] }),
        securities: [security],
      });
      const data = fixture(security);
      data.addBar(security.id, "2026-03-02", 130);
      await evaluation(data, "2026-03-02");
      await prisma.monitorSignalState.deleteMany({ where: { monitorId } });
      await prisma.monitorEvaluationCheckpoint.deleteMany({
        where: { monitorId },
      });
      data.addBar(security.id, "2026-03-03", 131);
      await evaluation(data, "2026-03-03");
      const rows = await signalsOf(monitorId);
      expect(rows.at(-1)!.observationDate.toISOString().slice(0, 10)).toBe(
        "2026-03-02",
      );
      expect(rows.at(-1)!.reconstructed).toBe(true);
    });
  });

  it("waits for a trigger, latches it, and resolves only when a Condition fails", async () => {
    const userId = await createUser();
    const security = await createSecurity("CT");
    const { monitorId } = await createMonitor({
      userId,
      definition: buyOnly({
        conditions: [above("c-buy", "SMA_50D")],
        trigger: crossesAbove("t-buy", "SMA_20D"),
      }),
      securities: [security],
    });
    // A fall and a recovery: the 20-day crossing at 108 came while the price was still below its
    // 50-day average, so it armed nothing. The averages each session are written beside it.
    const data = fixture(security, [
      ...Array(50).fill(120),
      ...Array(15).fill(100),
      104,
      108,
      112,
    ]);
    const stateAfter = async (session: string, close: number) => {
      data.addBar(security.id, session, close);
      await evaluation(data, session);
      return (await statesOf(monitorId))[0]!.lifecycleState;
    };
    // Above the 50-day average, no crossing today: a setup waits.
    expect(await stateAfter("2026-03-02", 116)).toBe("PENDING_TRIGGER");
    expect(await signalsOf(monitorId)).toHaveLength(0);
    // The Condition breaks before the trigger: the setup is dropped, no Signal.
    expect(await stateAfter("2026-03-03", 102)).toBe("INACTIVE");
    expect(await signalsOf(monitorId)).toHaveLength(0);
    // The Condition holds and the price crosses its 20-day average: the trigger fires.
    expect(await stateAfter("2026-03-04", 118)).toBe("ACTIVE");
    // Latched while the Condition holds, with no new crossing.
    expect(await stateAfter("2026-03-05", 119)).toBe("ACTIVE");
    expect(await signalsOf(monitorId)).toHaveLength(1);
    // The Condition fails: the occurrence ends.
    expect(await stateAfter("2026-03-06", 105)).toBe("RESOLVED");
    const [occurrence] = await signalsOf(monitorId);
    expect(occurrence!.observationDate.toISOString().slice(0, 10)).toBe(
      "2026-03-04",
    );
    expect(occurrence!.resolutionReason).toBe("CONDITIONS_ENDED");
  });

  it("opens a Fundamental Condition on the persisted reading; an unavailable one neither opens nor ends it", async () => {
    const userId = await createUser();
    const security = await createSecurity("FU");
    const { monitorId } = await createMonitor({
      userId,
      definition: buyOnly({
        conditions: [
          {
            id: "roic-above-15",
            metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
            operator: "IS_ABOVE",
            value: { kind: "PERCENT", value: 15 },
          },
        ],
      }),
      securities: [security],
    });
    const data = fixture(security);
    const readings: [string, number | undefined][] = [
      ["2026-03-02", undefined],
      ["2026-03-03", 12],
      ["2026-03-04", 18],
      ["2026-03-05", undefined],
      ["2026-03-06", 12],
    ];
    const derived: { securityId: string; date: string; roicTtm?: number }[] =
      [];
    const open = async () =>
      (await signalsOf(monitorId)).map((signal) => signal.resolvedAt === null);
    const outcomes: boolean[][] = [];
    for (const [session, roic] of readings) {
      data.addBar(security.id, session, 100);
      derived.push({
        securityId: security.id,
        date: session,
        ...(roic === undefined ? {} : { roicTtm: roic }),
      });
      data.derived.set(security.id, derived);
      await evaluation(data, session);
      outcomes.push(await open());
    }
    expect(data.frameReads.at(-1)!.operands).toEqual([
      "fundamental:ROIC_TTM",
      "price",
    ]);
    expect(outcomes).toEqual([
      [], // unavailable: nothing decided
      [], // 12 is not above 15
      [true], // 18 is: one occurrence opens
      [true], // a reading gone missing is not a condition that ended
      [false], // a real reading below the threshold ends it
    ]);
  });
});
