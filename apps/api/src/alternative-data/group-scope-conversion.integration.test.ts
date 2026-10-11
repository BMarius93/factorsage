import { createHash, randomUUID } from "node:crypto";
import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  strategySignalFingerprint,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient, type Prisma } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  convertGroupScopes,
  type GroupScopeStrategyReport,
} from "./group-scope-conversion";

useTestDatabase();

/**
 * The conversion of strategies that still name a Congress group, against real PostgreSQL.
 *
 * What it must never do is the point of every case here: rewrite a stored version, turn an
 * unresolved group into nobody, or reset a Monitor without having been told to. Each case writes its
 * own strategies for its own user and restricts the run to them, so the suite reads the same whatever
 * else the shared test database holds.
 */
describe("converting Congress group scopes to selections", () => {
  const suffix = randomUUID();
  const short = suffix.slice(0, 8).toUpperCase();
  const prisma = new PrismaClient();
  const ownerEmail = `gsc-owner-${suffix}@example.test`;
  const otherEmail = `gsc-other-${suffix}@example.test`;
  const externalIds = ["A", "B", "C"].map(
    (letter) => `GSC-${letter}-${suffix}`,
  );
  const systemKeys: string[] = [];

  let ownerId = "";
  let otherId = "";
  let stockListId = "";
  let securityId = "";
  /** Canonical ids of members A, B and C, in that order. */
  let actorIds: string[] = [];

  type Scope =
    | { kind: "ANY" }
    | { kind: "ACTORS"; actorIds: string[] }
    | { kind: "GROUP"; groupId: string };

  function condition(id: string, scope: Scope, measure = "PURCHASES") {
    return {
      id,
      metric: {
        kind: "CONGRESS_ACTIVITY",
        measure,
        lookback: 30,
        scope,
        chamber: "ANY",
      },
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 1 },
    };
  }

  /** A BUY level on `buyScope` and a SELL level on `sellScope`, so levels can change independently. */
  function definitionOf(buyScope: Scope, sellScope?: Scope): unknown {
    return {
      schemaVersion: 2,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: { conditions: [condition("c-buy", buyScope)] },
        },
      ],
      sellLevels: sellScope
        ? [
            {
              id: "sell-1",
              percentage: 50,
              signal: { conditions: [condition("c-sell", sellScope, "SALES")] },
            },
          ]
        : [],
    };
  }

  function hashOf(definition: unknown): string {
    return createHash("sha256")
      .update(
        strategyDefinitionFingerprint(normalizeStrategyDefinition(definition)),
      )
      .digest("hex");
  }

  async function storeStrategy(
    definition: unknown,
    owner: { userId: string } | { systemKey: string } = { userId: ownerId },
    definitionHash?: string,
  ): Promise<string> {
    if ("systemKey" in owner) {
      systemKeys.push(owner.systemKey);
    }
    const strategy = await prisma.strategy.create({
      data: {
        ...("systemKey" in owner
          ? { ownership: "SYSTEM", systemKey: owner.systemKey }
          : { userId: owner.userId }),
        name: `GSC ${randomUUID().slice(0, 8)}`,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as Prisma.InputJsonValue,
            definitionHash: definitionHash ?? hashOf(definition),
          },
        },
      },
    });
    return strategy.id;
  }

  async function createGroup(
    members: readonly string[],
    owner: { userId: string } | { systemKey: string } = { userId: ownerId },
  ): Promise<string> {
    if ("systemKey" in owner) {
      systemKeys.push(owner.systemKey);
    }
    const createdAt = Date.now();
    const group = await prisma.actorGroup.create({
      data: {
        ...("systemKey" in owner
          ? { ownership: "SYSTEM", systemKey: owner.systemKey }
          : { userId: owner.userId }),
        name: `Group ${randomUUID().slice(0, 8)}`,
        members: {
          create: members.map((actorId, index) => ({
            actorId,
            createdAt: new Date(createdAt + index),
          })),
        },
      },
    });
    return group.id;
  }

  async function versionsOf(strategyId: string) {
    return prisma.strategyVersion.findMany({
      where: { strategyId },
      orderBy: { versionNumber: "asc" },
      select: {
        id: true,
        versionNumber: true,
        definition: true,
        definitionHash: true,
        createdAt: true,
      },
    });
  }

  function only(
    strategies: readonly GroupScopeStrategyReport[],
    strategyId: string,
  ): GroupScopeStrategyReport {
    const found = strategies.find((entry) => entry.strategyId === strategyId);
    if (!found) {
      throw new Error(`Strategy ${strategyId} is not in the report`);
    }
    return found;
  }

  beforeAll(async () => {
    const users = await Promise.all(
      [ownerEmail, otherEmail].map((email) =>
        prisma.user.create({
          data: { email, passwordHash: "unused", emailVerifiedAt: new Date() },
        }),
      ),
    );
    ownerId = users[0]!.id;
    otherId = users[1]!.id;

    await prisma.alternativeDataActor.createMany({
      data: externalIds.map((externalId, index) => ({
        externalId,
        displayName: `Member ${index} ${short}`,
        chamber: "HOUSE" as const,
      })),
    });
    const actors = await prisma.alternativeDataActor.findMany({
      where: { externalId: { in: externalIds } },
      select: { id: true, externalId: true },
    });
    actorIds = externalIds.map(
      (externalId) =>
        actors.find((actor) => actor.externalId === externalId)?.id as string,
    );

    const security = await prisma.security.create({
      data: {
        providerSymbol: `GSC-${suffix}`,
        symbol: `GSC${short}`,
        name: "Group Scope Conversion Security",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securityId = security.id;
    const list = await prisma.stockList.create({
      data: {
        userId: ownerId,
        name: "GSC universe",
        items: { create: [{ securityId }] },
      },
    });
    stockListId = list.id;
  });

  afterEach(async () => {
    await prisma.monitor.deleteMany({
      where: { OR: [{ userId: ownerId }, { userId: otherId }] },
    });
    await prisma.strategy.deleteMany({
      where: {
        OR: [
          { userId: ownerId },
          { userId: otherId },
          { systemKey: { in: systemKeys } },
        ],
      },
    });
    await prisma.actorGroup.deleteMany({
      where: {
        OR: [
          { userId: ownerId },
          { userId: otherId },
          { systemKey: { in: systemKeys } },
        ],
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { in: [ownerEmail, otherEmail] } },
    });
    await prisma.alternativeDataActor.deleteMany({
      where: { externalId: { in: externalIds } },
    });
    await prisma.security.deleteMany({
      where: { providerSymbol: `GSC-${suffix}` },
    });
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Dry run
  // -------------------------------------------------------------------------

  it("reports what it would convert and writes nothing", async () => {
    const [a, b, c] = actorIds as [string, string, string];
    const groupId = await createGroup([c, a, b]);
    const strategyId = await storeStrategy(
      definitionOf({ kind: "GROUP", groupId }),
    );
    const untouched = await storeStrategy(definitionOf({ kind: "ANY" }));
    const before = await versionsOf(strategyId);

    const report = await convertGroupScopes(prisma, {
      strategyIds: [strategyId, untouched],
    });

    expect(report.mode).toBe("DRY_RUN");
    expect(report).toMatchObject({
      strategiesScanned: 2,
      strategiesWithGroupScope: 1,
      convertible: 1,
      converted: 0,
      skipped: 0,
      monitorsAffected: 0,
    });
    expect(only(report.strategies, strategyId)).toMatchObject({
      outcome: "CONVERTIBLE",
      versionNumber: 1,
      skipReasons: [],
      groups: [{ groupId, memberCount: 3, status: "RESOLVED" }],
      monitors: [],
    });
    expect(await versionsOf(strategyId)).toEqual(before);
  });

  it("is a dry run unless apply is asked for", async () => {
    const groupId = await createGroup([actorIds[0] as string]);
    const strategyId = await storeStrategy(
      definitionOf({ kind: "GROUP", groupId }),
    );
    for (const options of [{}, { apply: false }, { includeMonitored: true }]) {
      const report = await convertGroupScopes(prisma, {
        ...options,
        strategyIds: [strategyId],
      });
      expect(report.mode).toBe("DRY_RUN");
    }
    expect(await versionsOf(strategyId)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------

  it("appends a version selecting the group's members and leaves the old version exactly as stored", async () => {
    const [a, b, c] = actorIds as [string, string, string];
    const groupId = await createGroup([c, a, b]);
    const stored = definitionOf({ kind: "GROUP", groupId }, { kind: "ANY" });
    const strategyId = await storeStrategy(stored);
    const [original] = await versionsOf(strategyId);

    const report = await convertGroupScopes(prisma, {
      apply: true,
      strategyIds: [strategyId],
    });

    expect(report).toMatchObject({ mode: "APPLY", converted: 1, skipped: 0 });
    expect(only(report.strategies, strategyId)).toMatchObject({
      outcome: "CONVERTED",
      versionNumber: 1,
      convertedVersionNumber: 2,
    });

    const versions = await versionsOf(strategyId);
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);
    // The earlier version is the row it was: same id, same document, same hash, same timestamp.
    expect(versions[0]).toEqual(original);

    const converted = normalizeStrategyDefinition(versions[1]!.definition);
    expect(converted).toEqual(
      normalizeStrategyDefinition(
        definitionOf(
          { kind: "ACTORS", actorIds: [a, b, c].sort() },
          { kind: "ANY" },
        ),
      ),
    );
    // Row identities are carried over: it is the same strategy with one scope rewritten.
    expect(converted.buyLevels[0]!.id).toBe("buy-1");
    expect(converted.buyLevels[0]!.signal.conditions[0]!.id).toBe("c-buy");
    expect(versions[1]!.definitionHash).toBe(hashOf(converted));
    expect(versions[1]!.definitionHash).not.toBe(original!.definitionHash);
    // The group itself is not touched: other things may still name it.
    expect(await prisma.actorGroupMember.count({ where: { groupId } })).toBe(3);
  });

  it("finds nothing to do the second time", async () => {
    const groupId = await createGroup([actorIds[0] as string]);
    const strategyId = await storeStrategy(
      definitionOf({ kind: "GROUP", groupId }),
    );
    await convertGroupScopes(prisma, {
      apply: true,
      strategyIds: [strategyId],
    });
    const afterFirst = await versionsOf(strategyId);

    const second = await convertGroupScopes(prisma, {
      apply: true,
      strategyIds: [strategyId],
    });

    expect(second).toMatchObject({
      strategiesWithGroupScope: 0,
      converted: 0,
      skipped: 0,
      strategies: [],
    });
    expect(await versionsOf(strategyId)).toEqual(afterFirst);
  });

  it("decides on the current version only: an old version naming a group is history", async () => {
    const groupId = await createGroup([actorIds[0] as string]);
    const strategyId = await storeStrategy(
      definitionOf({ kind: "GROUP", groupId }),
    );
    const current = definitionOf({ kind: "ANY" });
    await prisma.strategyVersion.create({
      data: {
        strategyId,
        versionNumber: 2,
        definition: current as Prisma.InputJsonValue,
        definitionHash: hashOf(current),
      },
    });

    const report = await convertGroupScopes(prisma, {
      apply: true,
      strategyIds: [strategyId],
    });
    expect(report.strategiesWithGroupScope).toBe(0);
    expect(await versionsOf(strategyId)).toHaveLength(2);
  });

  it("converts every group a definition names, each to its own members", async () => {
    const [a, b, c] = actorIds as [string, string, string];
    const buyGroup = await createGroup([a, b]);
    const sellGroup = await createGroup([c]);
    const strategyId = await storeStrategy(
      definitionOf(
        { kind: "GROUP", groupId: buyGroup },
        { kind: "GROUP", groupId: sellGroup },
      ),
    );

    await convertGroupScopes(prisma, {
      apply: true,
      strategyIds: [strategyId],
    });

    const [, converted] = await versionsOf(strategyId);
    expect(normalizeStrategyDefinition(converted!.definition)).toEqual(
      normalizeStrategyDefinition(
        definitionOf(
          { kind: "ACTORS", actorIds: [a, b].sort() },
          { kind: "ACTORS", actorIds: [c] },
        ),
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Never guessing
  // -------------------------------------------------------------------------

  it("skips a strategy whose group is gone, empty or somebody else's, and says which", async () => {
    const [a] = actorIds as [string];
    const missing = await storeStrategy(
      definitionOf({ kind: "GROUP", groupId: randomUUID() }),
    );
    const empty = await storeStrategy(
      definitionOf({ kind: "GROUP", groupId: await createGroup([]) }),
    );
    const foreign = await storeStrategy(
      definitionOf({
        kind: "GROUP",
        groupId: await createGroup([a], { userId: otherId }),
      }),
    );
    // One good group does not rescue a rule beside it that cannot be resolved.
    const partial = await storeStrategy(
      definitionOf(
        { kind: "GROUP", groupId: await createGroup([a]) },
        { kind: "GROUP", groupId: await createGroup([]) },
      ),
    );
    const ids = [missing, empty, foreign, partial];
    const before = await Promise.all(ids.map(versionsOf));

    const report = await convertGroupScopes(prisma, {
      apply: true,
      strategyIds: ids,
    });

    expect(report).toMatchObject({
      strategiesWithGroupScope: 4,
      converted: 0,
      skipped: 4,
      skippedByReason: {
        GROUP_MISSING: 1,
        GROUP_EMPTY: 2,
        GROUP_INACCESSIBLE: 1,
      },
    });
    expect(only(report.strategies, missing)).toMatchObject({
      outcome: "SKIPPED",
      skipReasons: ["GROUP_MISSING"],
      groups: [{ name: null, memberCount: 0, status: "MISSING" }],
    });
    expect(only(report.strategies, empty)).toMatchObject({
      outcome: "SKIPPED",
      skipReasons: ["GROUP_EMPTY"],
      groups: [{ memberCount: 0, status: "EMPTY" }],
    });
    expect(only(report.strategies, foreign)).toMatchObject({
      outcome: "SKIPPED",
      skipReasons: ["GROUP_INACCESSIBLE"],
      groups: [{ memberCount: 1, status: "INACCESSIBLE" }],
    });
    expect(
      only(report.strategies, partial).groups.map((group) => group.status),
    ).toEqual(expect.arrayContaining(["RESOLVED", "EMPTY"]));
    // Skipped means untouched: no version, no rewritten document, no selection of nobody.
    expect(await Promise.all(ids.map(versionsOf))).toEqual(before);
  });

  it("uses a built-in group for anyone, and never an administrator's own group for a built-in strategy", async () => {
    const [a, b] = actorIds as [string, string];
    const builtInGroup = await createGroup([a, b], {
      systemKey: `gsc-group-${suffix}`,
    });
    const usesBuiltIn = await storeStrategy(
      definitionOf({ kind: "GROUP", groupId: builtInGroup }),
    );
    // A built-in strategy naming the group of whichever administrator last edited it: customers
    // cannot read that group, and embedding its members would publish a private selection.
    const builtInStrategy = await storeStrategy(
      definitionOf({ kind: "GROUP", groupId: await createGroup([a]) }),
      { systemKey: `gsc-strategy-${suffix}` },
    );

    const report = await convertGroupScopes(prisma, {
      strategyIds: [usesBuiltIn, builtInStrategy],
    });

    expect(only(report.strategies, usesBuiltIn).outcome).toBe("CONVERTIBLE");
    expect(only(report.strategies, builtInStrategy)).toMatchObject({
      ownership: "SYSTEM",
      outcome: "SKIPPED",
      skipReasons: ["GROUP_INACCESSIBLE"],
    });
  });

  it("skips a conversion that would leave an invalid definition, with the validator's reason", async () => {
    const [a, b] = actorIds as [string, string];
    // Two rules that differ only in the group they name, where both groups hold the same members:
    // embedded, they are one rule written twice.
    const first = await createGroup([a, b]);
    const second = await createGroup([b, a]);
    const definition = {
      schemaVersion: 2,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: {
            conditions: [
              condition("c-1", { kind: "GROUP", groupId: first }),
              condition("c-2", { kind: "GROUP", groupId: second }),
            ],
          },
        },
      ],
      sellLevels: [],
    };
    const strategyId = await storeStrategy(definition);

    const report = await convertGroupScopes(prisma, {
      apply: true,
      strategyIds: [strategyId],
    });

    const entry = only(report.strategies, strategyId);
    expect(entry).toMatchObject({
      outcome: "SKIPPED",
      skipReasons: ["CONVERSION_INVALID"],
    });
    expect(entry.detail).toBeTruthy();
    expect(await versionsOf(strategyId)).toHaveLength(1);
  });

  it("reports a version it cannot read instead of failing the whole run", async () => {
    const groupId = await createGroup([actorIds[0] as string]);
    const good = await storeStrategy(definitionOf({ kind: "GROUP", groupId }));
    // A rule the validator no longer admits: the inclusive operator the product removed on
    // 2026-09-28. Such a version cannot be read, so it cannot be converted either.
    const stale = definitionOf({ kind: "GROUP", groupId }) as {
      buyLevels: { signal: { conditions: { operator: string }[] } }[];
    };
    stale.buyLevels[0]!.signal.conditions[0]!.operator = "IS_AT_LEAST";
    const unreadable = await storeStrategy(
      stale,
      { userId: ownerId },
      "unreadable",
    );

    const report = await convertGroupScopes(prisma, {
      apply: true,
      strategyIds: [good, unreadable],
    });

    const refused = only(report.strategies, unreadable);
    expect(refused).toMatchObject({
      outcome: "SKIPPED",
      skipReasons: ["DEFINITION_UNREADABLE"],
    });
    expect(refused.detail).toBeTruthy();
    expect(await versionsOf(unreadable)).toHaveLength(1);
    expect(only(report.strategies, good).outcome).toBe("CONVERTED");
  });

  // -------------------------------------------------------------------------
  // Monitors
  // -------------------------------------------------------------------------

  /** A Monitor on `strategyId` with one state row per level, keyed to that level's current logic. */
  async function monitorWithState(
    strategyId: string,
    definition: unknown,
    lifecycle: Record<string, "ACTIVE" | "PENDING_TRIGGER" | "INACTIVE">,
  ): Promise<string> {
    const normalized: StrategyDefinition =
      normalizeStrategyDefinition(definition);
    const monitor = await prisma.monitor.create({
      data: {
        userId: ownerId,
        strategyId,
        stockListId,
        name: `GSC monitor ${randomUUID().slice(0, 8)}`,
      },
    });
    const levels = [
      ...normalized.buyLevels.map((level) => ({ level, kind: "BUY" as const })),
      ...normalized.sellLevels.map((level) => ({
        level,
        kind: "SELL" as const,
      })),
    ];
    const decidedAt = new Date();
    for (const { level, kind } of levels) {
      const state = lifecycle[level.id] ?? "INACTIVE";
      const signal =
        state === "ACTIVE"
          ? await prisma.monitorSignal.create({
              data: {
                monitorId: monitor.id,
                securityId,
                levelId: level.id,
                levelKind: kind,
                strategyVersionId: "version-1",
                hasTrigger: false,
                observationDate: new Date("2026-03-02T00:00:00.000Z"),
                observationPrice: "100.00",
                detectedAt: decidedAt,
              },
            })
          : null;
      await prisma.monitorSignalState.create({
        data: {
          monitorId: monitor.id,
          securityId,
          levelId: level.id,
          levelKind: kind,
          signalFingerprint: strategySignalFingerprint(level.signal),
          lastEvaluableResult: state === "ACTIVE" ? "MATCHED" : "NOT_MATCHED",
          lastEvaluableDate: new Date("2026-03-02T00:00:00.000Z"),
          lastEvaluableAt: decidedAt,
          lastOutcome: state === "ACTIVE" ? "MATCHED" : "NOT_MATCHED",
          lastOutcomeAt: decidedAt,
          lifecycleState: state,
          ...(signal ? { activeSignalId: signal.id } : {}),
        },
      });
    }
    return monitor.id;
  }

  it("counts exactly the Monitor levels whose logic changes, and the Signals that would close", async () => {
    const [a, b] = actorIds as [string, string];
    const groupId = await createGroup([a, b]);
    // BUY names the group; SELL already selects its members and is not affected by the conversion.
    const definition = definitionOf(
      { kind: "GROUP", groupId },
      { kind: "ACTORS", actorIds: [a] },
    );
    const strategyId = await storeStrategy(definition);
    const monitorId = await monitorWithState(strategyId, definition, {
      "buy-1": "ACTIVE",
      "sell-1": "ACTIVE",
    });

    const report = await convertGroupScopes(prisma, {
      strategyIds: [strategyId],
    });

    expect(report).toMatchObject({
      convertible: 1,
      monitorsAffected: 1,
      statesReset: 1,
      activeSignalsClosed: 1,
    });
    expect(only(report.strategies, strategyId).monitors).toEqual([
      expect.objectContaining({
        monitorId,
        ownership: "USER",
        evaluated: true,
        levelsReset: 1,
        statesReset: 1,
        activeSignalsClosed: 1,
        pendingSetupsDropped: 0,
      }),
    ]);
  });

  it("will not convert a strategy that has a Monitor until told to, and then says what it reset", async () => {
    const [a, b] = actorIds as [string, string];
    const groupId = await createGroup([a, b]);
    const definition = definitionOf({ kind: "GROUP", groupId });
    const strategyId = await storeStrategy(definition);
    const monitorId = await monitorWithState(strategyId, definition, {
      "buy-1": "PENDING_TRIGGER",
    });
    const statesBefore = await prisma.monitorSignalState.findMany({
      where: { monitorId },
    });

    const refused = await convertGroupScopes(prisma, {
      apply: true,
      strategyIds: [strategyId],
    });
    expect(refused).toMatchObject({
      converted: 0,
      skipped: 1,
      skippedByReason: { MONITORED: 1 },
      // Nothing converted, so nothing is reset.
      monitorsAffected: 0,
    });
    expect(only(refused.strategies, strategyId)).toMatchObject({
      outcome: "SKIPPED",
      skipReasons: ["MONITORED"],
    });
    expect(await versionsOf(strategyId)).toHaveLength(1);

    const applied = await convertGroupScopes(prisma, {
      apply: true,
      includeMonitored: true,
      strategyIds: [strategyId],
    });
    expect(applied).toMatchObject({
      converted: 1,
      monitorsAffected: 1,
      statesReset: 1,
      activeSignalsClosed: 0,
    });
    expect(only(applied.strategies, strategyId).monitors[0]).toMatchObject({
      monitorId,
      levelsReset: 1,
      pendingSetupsDropped: 1,
    });
    expect(await versionsOf(strategyId)).toHaveLength(2);

    // The conversion itself writes no Monitor state: the reset is the worker's, on its next cycle,
    // when it finds the level's fingerprint no longer matches the row.
    expect(
      await prisma.monitorSignalState.findMany({ where: { monitorId } }),
    ).toEqual(statesBefore);
    const [, converted] = await versionsOf(strategyId);
    const level = normalizeStrategyDefinition(converted!.definition)
      .buyLevels[0]!;
    expect(strategySignalFingerprint(level.signal)).not.toBe(
      statesBefore[0]!.signalFingerprint,
    );
  });
});
