import { randomUUID } from "node:crypto";
import {
  embedActorGroupScopes,
  normalizeStrategyDefinition,
  STRATEGY_SCHEMA_VERSION,
  type ActorScope,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { Security } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalAlternativeDataService,
  PrismaAlternativeDataStore,
  projectEvaluationFrame,
  projectMonitorEvaluationFrame,
  type MonitorEvaluationFrame,
} from "@intrinsic/stock-data";
import {
  alternativeDataOperand,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MonitorCycle } from "./monitor-cycle.js";
import {
  FixtureCalendar,
  FixtureLoader,
  flatHistory,
} from "./monitor-fixtures.test-helper.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * Monitor cycles over a rule scoped to members of Congress, in every shape a strategy version can
 * hold: a selection, a legacy group read live, and a legacy single member.
 *
 * The cycle, the repository, the lifecycle reducer and the durable rows are the production ones, and
 * so is everything about the congressional data: the disclosures are real rows in PostgreSQL, read
 * by `CanonicalAlternativeDataService.loadFacts` exactly as the production loader reads them for a
 * Monitor — with no resolver, so a group is resolved from the database as it stands. Only prices and
 * the live quote are scripted, as in every other Monitor suite.
 *
 * What it settles:
 *
 * - a selection is evaluated, and it is a membership filter;
 * - a legacy group still evaluates, and editing it moves the rule that names it and no other;
 * - converting a group rule to a selection resets that level exactly once, and says why;
 * - a legacy single-member rule read as a selection does **not** reset;
 * - a scope the build does not define stops that Monitor from being evaluated — it is never read
 *   as "nobody" — while every other Monitor carries on.
 */

const prisma = new PrismaClient();
const repository = new PrismaMonitorRepository(prisma);
const store = new PrismaAlternativeDataStore(prisma);
const logger = createLogger({ service: "worker", level: "silent" });
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

/** 10:00 New York on Monday 2026-03-02, the session after the last bar `flatHistory` writes. */
const SESSION_ONE = new Date("2026-03-02T15:00:00.000Z");
const SESSION_TWO = new Date("2026-03-03T15:00:00.000Z");

/** The provider is never asked: every read here is `loadFacts`, which reaches no provider. */
const alternativeData = new CanonicalAlternativeDataService(
  store,
  {
    async getInsiderTrades() {
      throw new Error("A Monitor read must not reach the provider");
    },
    async getCongressTrades() {
      throw new Error("A Monitor read must not reach the provider");
    },
  },
  { freshnessMs: 60_000, maxPagesPerIngest: 1 },
);

/**
 * The fixture loader, with the congressional columns supplied the way production supplies them.
 *
 * `CanonicalStockDataService.readMonitorEvaluationFrame` loads the disclosures over the projected
 * window and hands them to `projectMonitorEvaluationFrame`; this does the same with the same two
 * functions, so the columns a level reads here are the ones it would read in a worker.
 */
class CongressLoader extends FixtureLoader {
  override async readMonitorEvaluationFrame(input: {
    security: Security;
    operands: readonly OperandKey[];
    observations: number;
    asOf: string;
    observation: { price: number; quotedAt?: string } | null;
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
      observationDate: input.observationDate,
      alternativeData: await alternativeData.loadFacts({
        security: input.security,
        operands: input.operands,
        from: prices[0]?.date ?? input.observationDate,
        to: input.observationDate,
      }),
    });
  }

  override async readReconstructionFrame(
    security: Security,
    range: { from: string; to: string },
    operands: readonly OperandKey[],
  ): Promise<EvaluationFrame> {
    const prices = (this.prices.get(security.id) ?? []).filter(
      (price) => price.date <= range.to,
    );
    return projectEvaluationFrame({
      security,
      prices,
      derived: [],
      operands,
      periodStart: range.from,
      alternativeData: await alternativeData.loadFacts({
        security,
        operands,
        from: prices[0]?.date ?? range.from,
        to: range.to,
      }),
    }).frame;
  }
}

const userIds: string[] = [];
const securityIds: string[] = [];
const createdMonitorIds: string[] = [];
const groupIds: string[] = [];
const externalIds = ["A", "B", "D"].map((letter) => `MAS-${letter}-${suffix}`);
/** Canonical ids of A and B, who are selected, and D, who is not. */
const actor = { A: "", B: "", D: "" };

function definitionScopedTo(scope: unknown): StrategyDefinition {
  // Cast, not normalized: a stored version may hold a legacy shape, or one this build cannot read.
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [
            {
              id: "c1",
              metric: {
                kind: "CONGRESS_ACTIVITY",
                measure: "PURCHASES",
                lookback: 5,
                scope: scope as ActorScope,
                chamber: "ANY",
              },
              operator: "IS_ABOVE",
              value: { kind: "NUMBER", value: 0 },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  };
}

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `monitor-scope-${randomUUID()}@example.test`, plan: "PRO" },
  });
  userIds.push(user.id);
  return user.id;
}

/**
 * A security whose only congressional purchases inside the last five sessions are A's and D's.
 *
 * A — selected — disclosed on Thu 2026-02-26, so the rule reads it from Fri 02-27. D — not selected
 * — disclosed a day earlier. B, selected, disclosed nothing. An early non-stock disclosure sets the
 * coverage floor before the window so the reading is a real zero rather than NOT_EVALUABLE.
 */
async function createSecurityWithDisclosures(label: string): Promise<Security> {
  const symbol = `${label}${suffix.slice(0, 4).toUpperCase()}`;
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
  const trade = (
    actorId: string,
    disclosureDate: string,
    assetClass: "STOCK" | "BOND" = "STOCK",
  ) => {
    const available = new Date(`${disclosureDate}T00:00:00.000Z`);
    available.setUTCDate(available.getUTCDate() + 1);
    return {
      securityId: row.id,
      actorId,
      chamber: "HOUSE" as const,
      transactionDate: "2026-01-05",
      disclosureDate,
      availableFromDate: available.toISOString().slice(0, 10),
      kind: "PURCHASE" as const,
      transactionTypeRaw: "Purchase",
      owner: "SELF" as const,
      assetClass,
      amountRangeRaw: "$15,001 - $50,000",
      amountLowerBound: 15_001,
      amountUpperBound: 50_000,
      raw: { fixture: true },
      contentHash: randomUUID(),
    };
  };
  await store.saveCongressTrades([
    trade(actor.A, "2026-02-26"),
    trade(actor.D, "2026-02-25"),
    trade(actor.D, "2026-01-19", "BOND"),
  ]);
  await store.recordAlternativeDatasetSync({
    securityId: row.id,
    domain: "CONGRESS",
    earliestAvailableDate: "2026-01-20",
    latestAvailableDate: "2026-02-27",
    // After both driven sessions, so neither is past the coverage ceiling.
    syncedAt: "2026-03-10T12:00:00.000Z",
  });
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

async function createGroup(userId: string, members: readonly string[]) {
  const group = await prisma.actorGroup.create({
    data: {
      userId,
      name: `Group ${randomUUID().slice(0, 8)}`,
      members: { create: members.map((actorId) => ({ actorId })) },
    },
  });
  groupIds.push(group.id);
  return group.id;
}

async function createMonitor(input: {
  userId: string;
  definition: StrategyDefinition;
  security: Security;
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
      items: { create: [{ securityId: input.security.id }] },
    },
  });
  const monitor = await prisma.monitor.create({
    data: {
      userId: input.userId,
      name: `Monitor ${randomUUID().slice(0, 8)}`,
      strategyId: strategy.id,
      stockListId: stockList.id,
    },
  });
  createdMonitorIds.push(monitor.id);
  return { monitorId: monitor.id, strategyId: strategy.id };
}

async function appendVersion(
  strategyId: string,
  definition: StrategyDefinition,
): Promise<void> {
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

function loaderFor(...securities: Security[]): CongressLoader {
  const loader = new CongressLoader(securities);
  for (const security of securities) {
    loader.prices.set(security.id, flatHistory(security.id, 100));
  }
  loader.currentPrice = 100;
  return loader;
}

let cycleSequence = 0;
async function runCycle(loader: CongressLoader, now: Date = SESSION_ONE) {
  cycleSequence += 1;
  return new MonitorCycle(repository, loader, new FixtureCalendar(), logger, {
    symbolConcurrency: 4,
    quoteMaxAgeMs: 4 * 24 * 60 * 60_000,
    now: () => now,
  }).run(cycleSequence);
}

async function signalsOf(monitorId: string) {
  return prisma.monitorSignal.findMany({
    where: { monitorId },
    orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
  });
}

async function stateOf(monitorId: string) {
  return prisma.monitorSignalState.findFirst({ where: { monitorId } });
}

async function transitionsOf(monitorId: string) {
  return prisma.monitorStateTransition.findMany({
    where: { monitorId },
    orderBy: { sequence: "asc" },
  });
}

/**
 * Enabled Monitors already in the database are switched off for this file's run and switched back
 * on afterwards: a cycle is global, and these cases are about the Monitors they create. The same
 * arrangement, for the same reason, as `monitor-cycle.integration.test.ts`.
 */
const foreignEnabledMonitorIds: string[] = [];
const foreignSystemMonitorIds: string[] = [];

beforeAll(async () => {
  const foreign = await prisma.monitor.findMany({
    where: { ownership: "USER", enabled: true },
    select: { id: true },
  });
  foreignEnabledMonitorIds.push(...foreign.map((row) => row.id));
  await prisma.monitor.updateMany({
    where: { id: { in: foreignEnabledMonitorIds } },
    data: { enabled: false },
  });
  const system = await prisma.monitor.findMany({
    where: { ownership: "SYSTEM", isGloballyEnabled: true },
    select: { id: true },
  });
  foreignSystemMonitorIds.push(...system.map((row) => row.id));
  await prisma.monitor.updateMany({
    where: { id: { in: foreignSystemMonitorIds } },
    data: { isGloballyEnabled: false },
  });

  await store.upsertActors(
    externalIds.map((externalId) => ({
      externalId,
      displayName: `Member ${externalId}`,
      chamber: "HOUSE" as const,
    })),
  );
  const rows = await prisma.alternativeDataActor.findMany({
    where: { externalId: { in: externalIds } },
    select: { id: true, externalId: true },
  });
  const idOf = (letter: string) =>
    rows.find((row) => row.externalId === `MAS-${letter}-${suffix}`)?.id ?? "";
  actor.A = idOf("A");
  actor.B = idOf("B");
  actor.D = idOf("D");
});

afterEach(async () => {
  await prisma.monitor.updateMany({
    where: { id: { in: createdMonitorIds } },
    data: { enabled: false },
  });
});

afterAll(async () => {
  await prisma.monitor.updateMany({
    where: { id: { in: foreignEnabledMonitorIds } },
    data: { enabled: true },
  });
  await prisma.monitor.updateMany({
    where: { id: { in: foreignSystemMonitorIds } },
    data: { isGloballyEnabled: true },
  });
  await prisma.monitorStateTransition.deleteMany({
    where: { securityId: { in: securityIds } },
  });
  await prisma.monitorSignalState.deleteMany({
    where: { securityId: { in: securityIds } },
  });
  await prisma.monitorSignal.deleteMany({
    where: { securityId: { in: securityIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.actorGroup.deleteMany({ where: { id: { in: groupIds } } });
  await prisma.congressTrade.deleteMany({
    where: { securityId: { in: securityIds } },
  });
  await prisma.stockDatasetState.deleteMany({
    where: { securityId: { in: securityIds } },
  });
  await prisma.alternativeDataActor.deleteMany({
    where: { externalId: { in: externalIds } },
  });
  await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
  await prisma.$disconnect();
});

describe("a Monitor on a rule scoped to members of Congress", () => {
  it("evaluates a selection, and counts only the members it selects", async () => {
    const userId = await createUser();
    const security = await createSecurityWithDisclosures("SEL");
    const withA = await createMonitor({
      userId,
      security,
      definition: definitionScopedTo({
        kind: "ACTORS",
        actorIds: [actor.B, actor.A],
      }),
    });
    // B is selected alone here and disclosed nothing; D, who did, is not selected.
    const withoutA = await createMonitor({
      userId,
      security,
      definition: definitionScopedTo({ kind: "ACTORS", actorIds: [actor.B] }),
    });
    const loader = loaderFor(security);

    const summary = await runCycle(loader);

    expect(summary.monitors).toBe(2);
    const signals = await signalsOf(withA.monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ levelId: "buy-1", resolvedAt: null });
    expect((await stateOf(withA.monitorId))?.lifecycleState).toBe("ACTIVE");
    // A real zero, decided — not an undecidable reading and not a Signal.
    expect(await signalsOf(withoutA.monitorId)).toHaveLength(0);
    expect(await stateOf(withoutA.monitorId)).toMatchObject({
      lifecycleState: "INACTIVE",
      lastOutcome: "NOT_MATCHED",
    });

    // The selection travels in the column's own key, canonically ordered.
    const [first, second] = [actor.A, actor.B].sort();
    expect(loader.lastRequestedOperands.get(security.id)).toEqual(
      expect.arrayContaining([
        `alt:CONGRESS_ACTIVITY|PURCHASES|5|actors:${first}+${second}|ANY|-`,
        `alt:CONGRESS_ACTIVITY|PURCHASES|5|actor:${actor.B}|ANY|-`,
      ]),
    );
  });

  it("still evaluates a legacy group, and an edit to that group moves only the rule naming it", async () => {
    const userId = await createUser();
    const security = await createSecurityWithDisclosures("GRP");
    const groupId = await createGroup(userId, [actor.A, actor.B]);
    const onGroup = await createMonitor({
      userId,
      security,
      definition: definitionScopedTo({ kind: "GROUP", groupId }),
    });
    const onSelection = await createMonitor({
      userId,
      security,
      definition: definitionScopedTo({
        kind: "ACTORS",
        actorIds: [actor.A, actor.B],
      }),
    });
    const loader = loaderFor(security);

    await runCycle(loader);
    // The same members, so the same decision — whichever way the rule names them.
    expect(await signalsOf(onGroup.monitorId)).toHaveLength(1);
    expect(await signalsOf(onSelection.monitorId)).toHaveLength(1);

    // A leaves the group. Nobody edits either strategy.
    await prisma.actorGroupMember.delete({
      where: { groupId_actorId: { groupId, actorId: actor.A } },
    });
    await runCycle(loader, SESSION_TWO);

    // The rule that still names the group follows it: its conditions no longer hold…
    const [groupSignal] = await signalsOf(onGroup.monitorId);
    expect(groupSignal?.resolvedAt).not.toBeNull();
    expect((await stateOf(onGroup.monitorId))?.lifecycleState).not.toBe(
      "ACTIVE",
    );
    // …and the rule that selects its members is exactly where it was.
    const selectionSignals = await signalsOf(onSelection.monitorId);
    expect(selectionSignals).toHaveLength(1);
    expect(selectionSignals[0]?.resolvedAt).toBeNull();
    expect((await stateOf(onSelection.monitorId))?.lifecycleState).toBe(
      "ACTIVE",
    );
  });

  it("resets a level once, and says why, when its group rule is converted to a selection", async () => {
    const userId = await createUser();
    const security = await createSecurityWithDisclosures("CNV");
    const groupId = await createGroup(userId, [actor.A, actor.B]);
    const legacy = definitionScopedTo({ kind: "GROUP", groupId });
    const { monitorId, strategyId } = await createMonitor({
      userId,
      security,
      definition: legacy,
    });
    const loader = loaderFor(security);

    await runCycle(loader);
    const before = await signalsOf(monitorId);
    expect(before).toHaveLength(1);
    const fingerprintBefore = (await stateOf(monitorId))?.signalFingerprint;

    // What the conversion appends: the same strategy with the group's members embedded.
    await appendVersion(
      strategyId,
      embedActorGroupScopes(
        normalizeStrategyDefinition(legacy),
        new Map([[groupId, [actor.A, actor.B]]]),
      ),
    );
    await runCycle(loader);

    const after = await signalsOf(monitorId);
    expect(after).toHaveLength(2);
    const earlier = after.find((row) => row.id === before[0]!.id);
    const later = after.find((row) => row.id !== before[0]!.id);
    expect(earlier?.resolvedAt).not.toBeNull();
    expect(earlier?.resolutionReason).toBe("LOGIC_CHANGED");
    // The members are the same, so the level is active again at once under its new logic.
    expect(later?.resolvedAt).toBeNull();
    const state = await stateOf(monitorId);
    expect(state?.lifecycleState).toBe("ACTIVE");
    expect(state?.signalFingerprint).not.toBe(fingerprintBefore);
    // A digest of the selection, not the selection: this string is stored on every state row.
    expect(state?.signalFingerprint).not.toContain(actor.A);
    expect(state?.signalFingerprint).toMatch(/actors:2:[0-9a-f]{64}/);
    expect(
      (await transitionsOf(monitorId)).map((row) => [
        row.fromState,
        row.toState,
        row.reason,
      ]),
    ).toContainEqual(["ACTIVE", "RESOLVED", "LOGIC_CHANGED"]);

    // Once. A further cycle finds the state it just wrote and changes nothing.
    await runCycle(loader);
    expect(await signalsOf(monitorId)).toHaveLength(2);
    expect((await stateOf(monitorId))?.signalFingerprint).toBe(
      state?.signalFingerprint,
    );
  });

  it("does not reset a legacy single-member rule when it is read, or re-saved, as a selection", async () => {
    const userId = await createUser();
    const security = await createSecurityWithDisclosures("ONE");
    // As stored before the selection existed.
    const legacy = definitionScopedTo({ kind: "ACTOR", actorId: actor.A });
    const { monitorId, strategyId } = await createMonitor({
      userId,
      security,
      definition: legacy,
    });
    const loader = loaderFor(security);

    await runCycle(loader);
    const [signal] = await signalsOf(monitorId);
    expect(signal?.resolvedAt).toBeNull();
    const state = await stateOf(monitorId);
    // The fingerprint the release before this one would have written for the same rule.
    expect(state?.signalFingerprint).toBe(
      `[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|PURCHASES|5|actor:${actor.A}|ANY|-"],"IS_ABOVE",["NUMBER",0]]],null]`,
    );

    // The Builder saves the rule back in the current shape. Same logic, so the same level.
    await appendVersion(strategyId, normalizeStrategyDefinition(legacy));
    await runCycle(loader);

    const signals = await signalsOf(monitorId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.id).toBe(signal?.id);
    expect(signals[0]?.resolvedAt).toBeNull();
    expect((await stateOf(monitorId))?.signalFingerprint).toBe(
      state?.signalFingerprint,
    );
    expect(
      (await transitionsOf(monitorId)).map((row) => row.reason),
    ).not.toContain("LOGIC_CHANGED");
  });

  it("does not evaluate a Monitor whose scope it cannot interpret, and carries on with the rest", async () => {
    const userId = await createUser();
    const security = await createSecurityWithDisclosures("UNK");
    // A version written by a build that knows a scope this one does not.
    const unknown = await createMonitor({
      userId,
      security,
      definition: definitionScopedTo({ kind: "COMMITTEE", committeeId: "c1" }),
    });
    // And a selection of nobody, which no build writes: it must not be read as a quiet rule.
    const empty = await createMonitor({
      userId,
      security,
      definition: definitionScopedTo({ kind: "ACTORS", actorIds: [] }),
    });
    const healthy = await createMonitor({
      userId,
      security,
      definition: definitionScopedTo({ kind: "ACTORS", actorIds: [actor.A] }),
    });
    const loader = loaderFor(security);

    const summary = await runCycle(loader);

    expect(summary.aborted).toBe(false);
    for (const { monitorId } of [unknown, empty]) {
      // Not a zero, not a "not matched", not a Signal: nothing at all was decided for it.
      expect(await stateOf(monitorId)).toBeNull();
      expect(await signalsOf(monitorId)).toHaveLength(0);
    }
    expect(await signalsOf(healthy.monitorId)).toHaveLength(1);
    // No column was ever requested on the unreadable rules' behalf.
    expect(loader.lastRequestedOperands.get(security.id)).toEqual(
      expect.arrayContaining([
        alternativeDataOperand({
          kind: "CONGRESS_ACTIVITY",
          measure: "PURCHASES",
          lookback: 5,
          scope: { kind: "ACTORS", actorIds: [actor.A] },
          chamber: "ANY",
        }),
      ]),
    );
    expect(
      (loader.lastRequestedOperands.get(security.id) ?? []).filter((operand) =>
        operand.startsWith("alt:"),
      ),
    ).toHaveLength(1);
  });
});
