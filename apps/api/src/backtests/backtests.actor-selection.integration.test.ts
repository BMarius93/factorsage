import { createHash, randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  BACKTEST_SNAPSHOT_VERSION,
  BACKTEST_SNAPSHOT_VERSION_ACTOR_SELECTION,
  canonicalBacktestSnapshotDocument,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type ActorScope,
  type BacktestRunDetailResponse,
  type BacktestRunSnapshot,
  type BacktestTradePageResponse,
  type DashboardResponse,
  type StrategyDefinition,
  type StrategyDetailResponse,
  strategySignalFingerprint,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AlternativeDataModule } from "../alternative-data/alternative-data.module";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DashboardModule } from "../dashboard/dashboard.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { StrategiesModule } from "../strategies/strategies.module";
import { BacktestsModule } from "./backtests.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> real PostgreSQL, for a rule that selects members of Congress itself.
 *
 * Three things only a real write path and a real stored row can prove:
 *
 * 1. **What may be written.** A selection is stored canonically; a member the catalog does not hold,
 *    a selection of nobody and a Congress group are refused on create and on edit. A duplicate of a
 *    strategy that still names a group selects the group's members instead, and is refused only
 *    when the group cannot be resolved.
 * 2. **What still reads.** A strategy version saved with the legacy single-member or group shape is
 *    served, and re-saving the single-member one changes nothing: same hash, no new version.
 * 3. **What a run freezes.** The selection is in the frozen definition; the snapshot adds who those
 *    members were, and is written at the version an older worker refuses. A snapshot stored before
 *    any of this is read exactly as it was.
 *
 * No worker runs here, so every run stays `QUEUED`; the subject is the document submission wrote and
 * what the API says about it.
 */
describe("strategies and backtests that select members of Congress", () => {
  const suffix = randomUUID();
  const shortSuffix = suffix.slice(0, 8).toUpperCase();
  const password = "Local-test-password-42";
  const ownerEmail = `selbt-owner-${suffix}@example.test`;
  const providerSymbol = `SBT-${suffix}`;
  const members = [
    {
      externalId: `SELC-A-${suffix}`,
      displayName: `Tommy Fixture ${shortSuffix}`,
    },
    {
      externalId: `SELC-B-${suffix}`,
      displayName: `Nancy Fixture ${shortSuffix}`,
    },
    {
      externalId: `SELC-C-${suffix}`,
      displayName: `Ro Fixture ${shortSuffix}`,
    },
  ] as const;

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let ownerUserId = "";
  let stockListId = "";
  let securityId = "";
  /** Canonical actor ids, in the order of `members`. */
  let actorIds: string[] = [];

  function definitionScopedTo(scope: unknown): unknown {
    return {
      schemaVersion: 2,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "condition-1",
                metric: {
                  kind: "CONGRESS_ACTIVITY",
                  measure: "PURCHASES",
                  lookback: 30,
                  scope,
                  chamber: "ANY",
                },
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 1 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    };
  }

  function scopeOf(definition: StrategyDefinition): ActorScope | undefined {
    const metric = definition.buyLevels[0]?.signal.conditions[0]?.metric;
    return metric?.kind === "CONGRESS_ACTIVITY" ? metric.scope : undefined;
  }

  /**
   * A strategy version written straight to the tables, exactly as given.
   *
   * This is how a document saved before 2026-10-11 exists: the API normalizes what it writes now, so
   * the legacy single-member and group shapes can only be found already stored.
   */
  async function storeStrategy(definition: unknown): Promise<string> {
    const strategy = await prisma.strategy.create({
      data: {
        userId: ownerUserId,
        name: `Stored ${randomUUID().slice(0, 8)}`,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as Prisma.InputJsonValue,
            definitionHash: createHash("sha256")
              .update(
                strategyDefinitionFingerprint(
                  normalizeStrategyDefinition(definition),
                ),
              )
              .digest("hex"),
          },
        },
      },
    });
    return strategy.id;
  }

  async function createStrategy(
    scope: unknown,
  ): Promise<StrategyDetailResponse> {
    const response = await owner
      .post("/strategies")
      .send({
        name: `Selection ${randomUUID().slice(0, 8)}`,
        definition: definitionScopedTo(scope),
      })
      .expect(201);
    return response.body as StrategyDetailResponse;
  }

  async function versionsOf(strategyId: string) {
    return prisma.strategyVersion.findMany({
      where: { strategyId },
      orderBy: { versionNumber: "asc" },
      select: { versionNumber: true, definitionHash: true, definition: true },
    });
  }

  async function submit(
    strategyId: string,
  ): Promise<BacktestRunDetailResponse> {
    const response = await owner
      .post("/backtests")
      .send({
        strategyId,
        stockListId,
        startDate: "2020-01-01",
        endDate: "2020-12-31",
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 10,
      })
      .expect(202);
    return response.body as BacktestRunDetailResponse;
  }

  async function storedRun(runId: string) {
    const row = await prisma.backtestRun.findUniqueOrThrow({
      where: { id: runId },
      select: { snapshot: true, snapshotHash: true },
    });
    return {
      snapshot: row.snapshot as unknown as BacktestRunSnapshot,
      snapshotHash: row.snapshotHash,
    };
  }

  /** One BUY of the run's only level, so the trade log has a reason to describe. */
  async function recordBuy(runId: string): Promise<void> {
    await prisma.backtestTrade.create({
      data: {
        runId,
        sequence: 1,
        date: new Date("2020-03-02T00:00:00.000Z"),
        securityId,
        symbol: `SBT${shortSuffix}`,
        name: "Selection Backtest Security",
        action: "BUY",
        source: "STRATEGY",
        levelId: "buy-1",
        levelPercentage: 100,
        shares: 10,
        price: 100,
        amount: 1_000,
        fees: 0,
        cashAfter: 99_000,
        sharesAfter: 10,
        averageCostAfter: 100,
      },
    });
  }

  async function firstTradeConditions(
    runId: string,
  ): Promise<readonly string[]> {
    const response = await owner.get(`/backtests/${runId}/trades`).expect(200);
    const reason = (response.body as BacktestTradePageResponse).items[0]
      ?.reason;
    return reason?.kind === "STRATEGY" ? reason.conditions : [];
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigurationModule,
        DatabaseModule,
        AuthModule,
        StrategiesModule,
        BacktestsModule,
        BenchmarksModule,
        AlternativeDataModule,
        DashboardModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Bound to loopback explicitly (TEST-001): an unlistened Nest app lets supertest bind a wildcard
    // ephemeral port that a foreign local listener may already hold.
    await app.listen(0, "127.0.0.1");

    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const user = await prisma.user.create({
      data: {
        email: ownerEmail,
        passwordHash,
        emailVerifiedAt: new Date(),
        plan: "PRO",
      },
    });
    ownerUserId = user.id;

    const security = await prisma.security.create({
      data: {
        providerSymbol,
        symbol: `SBT${shortSuffix}`,
        name: "Selection Backtest Security",
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
        userId: ownerUserId,
        name: "Selection universe",
        items: { create: [{ securityId: security.id }] },
      },
    });
    stockListId = list.id;

    await prisma.alternativeDataActor.createMany({
      data: members.map((member) => ({ ...member, chamber: "HOUSE" as const })),
    });
    const rows = await prisma.alternativeDataActor.findMany({
      where: { externalId: { in: members.map((member) => member.externalId) } },
      select: { id: true, externalId: true },
    });
    actorIds = members.map(
      (member) =>
        rows.find((row) => row.externalId === member.externalId)?.id as string,
    );

    owner = request.agent(app.getHttpServer());
    await owner
      .post("/auth/login")
      .send({ email: ownerEmail, password })
      .expect(200);
  });

  afterEach(async () => {
    if (prisma) {
      await prisma.backtestRun.deleteMany({ where: { userId: ownerUserId } });
      // Before the strategies they watch with: a Monitor restricts its strategy's deletion.
      await prisma.monitor.deleteMany({ where: { userId: ownerUserId } });
      await prisma.strategy.deleteMany({ where: { userId: ownerUserId } });
      await prisma.actorGroup.deleteMany({ where: { userId: ownerUserId } });
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { email: ownerEmail } });
      await prisma.alternativeDataActor.deleteMany({
        where: {
          externalId: { in: members.map((member) => member.externalId) },
        },
      });
      await prisma.security.deleteMany({ where: { providerSymbol } });
    }
    if (app) {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Writing a selection
  // -------------------------------------------------------------------------

  it("stores a selection canonically, however the request wrote it", async () => {
    const [a, b, c] = actorIds as [string, string, string];
    const created = await createStrategy({
      kind: "ACTORS",
      actorIds: [c, a, b, a],
    });
    const canonical = [a, b, c].sort();
    expect(scopeOf(created.definition)).toEqual({
      kind: "ACTORS",
      actorIds: canonical,
    });
    // And that is what the row holds, not merely what the response says.
    const [version] = await versionsOf(created.id);
    expect(
      scopeOf(version!.definition as unknown as StrategyDefinition),
    ).toEqual({ kind: "ACTORS", actorIds: canonical });
  });

  it("refuses a member the catalog does not hold, and says how many", async () => {
    const one = await owner
      .post("/strategies")
      .send({
        name: "Unknown member",
        definition: definitionScopedTo({
          kind: "ACTORS",
          actorIds: [actorIds[0], randomUUID()],
        }),
      })
      .expect(400);
    expect(one.body.code).toBe("STRATEGY_INVALID");
    expect(
      (one.body.issues as { code: string; message: string }[]).map((issue) => [
        issue.code,
        issue.message,
      ]),
    ).toEqual([
      [
        "SCOPE_INVALID",
        "Congress purchases selects a member of Congress who is not available.",
      ],
    ]);

    const two = await owner
      .post("/strategies")
      .send({
        name: "Unknown members",
        definition: definitionScopedTo({
          kind: "ACTORS",
          actorIds: [randomUUID(), randomUUID()],
        }),
      })
      .expect(400);
    expect((two.body.issues as { message: string }[])[0]?.message).toBe(
      "Congress purchases selects 2 members of Congress who are not available.",
    );
  });

  it("refuses a selection of nobody", async () => {
    const refusal = await owner
      .post("/strategies")
      .send({
        name: "Nobody",
        definition: definitionScopedTo({ kind: "ACTORS", actorIds: [] }),
      })
      .expect(400);
    expect(
      (refusal.body.issues as { code: string; message: string }[]).map(
        (issue) => [issue.code, issue.message],
      ),
    ).toEqual([
      [
        "SCOPE_INVALID",
        "Choose at least one member of Congress, or count every member.",
      ],
    ]);
  });

  it("appends a version when the selection changes, and none when it is only reordered", async () => {
    const [a, b, c] = actorIds as [string, string, string];
    const created = await createStrategy({ kind: "ACTORS", actorIds: [a, b] });

    await owner
      .put(`/strategies/${created.id}/definition`)
      .send({
        definition: definitionScopedTo({ kind: "ACTORS", actorIds: [b, a, a] }),
      })
      .expect(200);
    expect(await versionsOf(created.id)).toHaveLength(1);

    const edited = await owner
      .put(`/strategies/${created.id}/definition`)
      .send({
        definition: definitionScopedTo({ kind: "ACTORS", actorIds: [a, c] }),
      })
      .expect(200);
    expect((edited.body as StrategyDetailResponse).versionNumber).toBe(2);
    const versions = await versionsOf(created.id);
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);
    expect(versions[0]!.definitionHash).not.toBe(versions[1]!.definitionHash);
  });

  it("copies the selection, member for member, when a strategy is duplicated", async () => {
    const [a, b] = actorIds as [string, string];
    const created = await createStrategy({ kind: "ACTORS", actorIds: [a, b] });
    const copy = (
      await owner
        .post(`/strategies/${created.id}/duplicate`)
        .send({ name: "Copy of the selection" })
        .expect(201)
    ).body as StrategyDetailResponse;

    expect(copy.id).not.toBe(created.id);
    expect(scopeOf(copy.definition)).toEqual(scopeOf(created.definition));
    // The same logic under a new identity: the hash is the proof nothing but ids moved.
    const [original] = await versionsOf(created.id);
    const [copied] = await versionsOf(copy.id);
    expect(copied!.definitionHash).toBe(original!.definitionHash);

    // Independent afterwards: editing the copy's members leaves the source's alone.
    await owner
      .put(`/strategies/${copy.id}/definition`)
      .send({
        definition: {
          ...copy.definition,
          buyLevels: copy.definition.buyLevels.map((level) => ({
            ...level,
            signal: {
              conditions: level.signal.conditions.map((condition) => ({
                ...condition,
                metric: {
                  ...condition.metric,
                  scope: { kind: "ACTORS", actorIds: [a] },
                },
              })),
            },
          })),
        },
      })
      .expect(200);
    const source = (await owner.get(`/strategies/${created.id}`).expect(200))
      .body as StrategyDetailResponse;
    expect(scopeOf(source.definition)).toEqual({
      kind: "ACTORS",
      actorIds: [a, b].sort(),
    });
  });

  // -------------------------------------------------------------------------
  // Legacy shapes: read, never written
  // -------------------------------------------------------------------------

  it("serves a version saved with the single-member shape, and re-saving it moves nothing", async () => {
    const [a] = actorIds as [string];
    const strategyId = await storeStrategy(
      definitionScopedTo({ kind: "ACTOR", actorId: a }),
    );
    const [stored] = await versionsOf(strategyId);

    const read = (await owner.get(`/strategies/${strategyId}`).expect(200))
      .body as StrategyDetailResponse;
    // Read as the one-entry selection it always meant…
    expect(scopeOf(read.definition)).toEqual({ kind: "ACTORS", actorIds: [a] });
    // …listed without error beside everything else the user owns…
    const listed = (await owner.get("/strategies").expect(200)).body as {
      id: string;
    }[];
    expect(listed.map((entry) => entry.id)).toContain(strategyId);

    // …and saved back exactly as read: the logic did not change, so no version is appended, the
    // hash a Monitor and every earlier backtest recorded is the one still current, and the stored
    // row is the row that was stored.
    await owner
      .put(`/strategies/${strategyId}/definition`)
      .send({ definition: read.definition })
      .expect(200);
    const versions = await versionsOf(strategyId);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.definitionHash).toBe(stored!.definitionHash);
    expect(versions[0]!.definition).toEqual(stored!.definition);
  });

  it("serves a version that still names a group, and refuses to write another", async () => {
    const [a, b] = actorIds as [string, string];
    const group = await prisma.actorGroup.create({
      data: {
        userId: ownerUserId,
        name: "House leadership",
        members: { create: [{ actorId: a }, { actorId: b }] },
      },
    });
    const groupScope = { kind: "GROUP", groupId: group.id };
    const strategyId = await storeStrategy(definitionScopedTo(groupScope));

    const read = (await owner.get(`/strategies/${strategyId}`).expect(200))
      .body as StrategyDetailResponse;
    expect(scopeOf(read.definition)).toEqual(groupScope);

    const expectGroupRefusal = (body: {
      code?: string;
      issues?: { code: string; message: string }[];
    }) => {
      expect(body.code).toBe("STRATEGY_INVALID");
      expect(body.issues?.map((issue) => issue.code)).toEqual([
        "SCOPE_INVALID",
      ]);
      expect(body.issues?.[0]?.message).toContain(
        "groups are no longer supported",
      );
    };
    // Carried over unchanged from the version being edited…
    expectGroupRefusal(
      (
        await owner
          .put(`/strategies/${strategyId}/definition`)
          .send({ definition: read.definition })
          .expect(400)
      ).body,
    );
    // …or typed into a new strategy.
    expectGroupRefusal(
      (
        await owner
          .post("/strategies")
          .send({ name: "New group rule", definition: read.definition })
          .expect(400)
      ).body,
    );
    expect(await versionsOf(strategyId)).toHaveLength(1);

    // Selecting the group's members instead is the way forward, and it is an ordinary edit.
    await owner
      .put(`/strategies/${strategyId}/definition`)
      .send({
        definition: definitionScopedTo({ kind: "ACTORS", actorIds: [a, b] }),
      })
      .expect(200);
    expect(await versionsOf(strategyId)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Duplicating a strategy that still names a group
  // -------------------------------------------------------------------------

  /** A strategy stored before groups left, naming a group of this owner's with `memberIds`. */
  async function storeGroupStrategy(
    memberIds: readonly string[],
  ): Promise<{ strategyId: string; groupId: string }> {
    const group = await prisma.actorGroup.create({
      data: {
        userId: ownerUserId,
        name: `Legacy group ${randomUUID().slice(0, 8)}`,
        members: { create: memberIds.map((actorId) => ({ actorId })) },
      },
    });
    const strategyId = await storeStrategy(
      definitionScopedTo({ kind: "GROUP", groupId: group.id }),
    );
    return { strategyId, groupId: group.id };
  }

  it("copies a group-scoped strategy as a selection of the group's members, and leaves the original alone", async () => {
    const [a, b, c] = actorIds as [string, string, string];
    // Stored in the group's own order, which is not canonical order.
    const { strategyId, groupId } = await storeGroupStrategy([c, a, b]);
    const [sourceBefore] = await versionsOf(strategyId);
    const groupBefore = await prisma.actorGroup.findUniqueOrThrow({
      where: { id: groupId },
      include: { members: { orderBy: { createdAt: "asc" } } },
    });

    const copy = (
      await owner
        .post(`/strategies/${strategyId}/duplicate`)
        .send({ name: "Copy of a group rule" })
        .expect(201)
    ).body as StrategyDetailResponse;

    // The copy selects exactly the members the group held, canonically, and names no group.
    expect(scopeOf(copy.definition)).toEqual({
      kind: "ACTORS",
      actorIds: [a, b, c].sort(),
    });
    expect(JSON.stringify(copy.definition)).not.toContain(groupId);
    // Everything else about the rule is the source's: it is the same rule about the same people.
    const sourceMetric = definitionScopedTo(null) as {
      buyLevels: { signal: { conditions: { metric: object }[] } }[];
    };
    expect(copy.definition.buyLevels[0]?.signal.conditions[0]?.metric).toEqual({
      ...sourceMetric.buyLevels[0]!.signal.conditions[0]!.metric,
      scope: { kind: "ACTORS", actorIds: [a, b, c].sort() },
    });
    const [copied] = await versionsOf(copy.id);
    expect(copied!.versionNumber).toBe(1);
    // The rule now says who rather than which group, so it is a different document.
    expect(copied!.definitionHash).not.toBe(sourceBefore!.definitionHash);

    // The original was only read: same single version, same stored document, same hash — it still
    // names its group, and the group still holds its members.
    expect(await versionsOf(strategyId)).toEqual([sourceBefore]);
    expect(
      scopeOf(
        (
          (await owner.get(`/strategies/${strategyId}`).expect(200))
            .body as StrategyDetailResponse
        ).definition,
      ),
    ).toEqual({ kind: "GROUP", groupId });
    expect(
      await prisma.actorGroup.findUniqueOrThrow({
        where: { id: groupId },
        include: { members: { orderBy: { createdAt: "asc" } } },
      }),
    ).toEqual(groupBefore);

    // And the copy is an ordinary strategy from here on: it saves like any other, and editing the
    // group afterwards does not reach it.
    await owner
      .put(`/strategies/${copy.id}/definition`)
      .send({ definition: copy.definition })
      .expect(200);
    await prisma.actorGroupMember.deleteMany({
      where: { groupId, actorId: c },
    });
    expect(
      scopeOf(
        (
          (await owner.get(`/strategies/${copy.id}`).expect(200))
            .body as StrategyDetailResponse
        ).definition,
      ),
    ).toEqual({ kind: "ACTORS", actorIds: [a, b, c].sort() });
  });

  it("refuses to copy a strategy whose group cannot be resolved, and says why", async () => {
    const [a] = actorIds as [string];
    const refusal = async (strategyId: string): Promise<string> => {
      const before = await prisma.strategy.count({
        where: { userId: ownerUserId },
      });
      const body = (
        await owner
          .post(`/strategies/${strategyId}/duplicate`)
          .send({ name: "Copy that must not exist" })
          .expect(400)
      ).body as { code?: string; issues?: { code: string; message: string }[] };
      expect(body.code).toBe("STRATEGY_INVALID");
      expect(body.issues?.map((issue) => issue.code)).toEqual([
        "SCOPE_INVALID",
      ]);
      // Nothing was created, and the source still has its one version.
      expect(
        await prisma.strategy.count({ where: { userId: ownerUserId } }),
      ).toBe(before);
      expect(await versionsOf(strategyId)).toHaveLength(1);
      return body.issues?.[0]?.message ?? "";
    };

    // A group with no members: an empty selection is not a rule.
    const empty = await storeGroupStrategy([]);
    const emptyGroup = await prisma.actorGroup.findUniqueOrThrow({
      where: { id: empty.groupId },
    });
    expect(await refusal(empty.strategyId)).toBe(
      `This strategy cannot be duplicated: one of its rules counts the Congress group “${emptyGroup.name}”, which has no members. Open the original, choose the members that rule counts, and duplicate it then.`,
    );

    // A group that no longer exists.
    const missing = await storeStrategy(
      definitionScopedTo({ kind: "GROUP", groupId: randomUUID() }),
    );
    expect(await refusal(missing)).toBe(
      "This strategy cannot be duplicated: one of its rules counts a Congress group that is no longer available. Open the original, choose the members that rule counts, and duplicate it then.",
    );

    // Somebody else's group reads exactly as a missing one, and none of its members leak.
    const stranger = await prisma.user.create({
      data: { email: `selbt-stranger-${randomUUID()}@example.test` },
    });
    try {
      const theirs = await prisma.actorGroup.create({
        data: {
          userId: stranger.id,
          name: "Somebody else's selection",
          members: { create: [{ actorId: a }] },
        },
      });
      const foreign = await storeStrategy(
        definitionScopedTo({ kind: "GROUP", groupId: theirs.id }),
      );
      const message = await refusal(foreign);
      expect(message).toContain("a Congress group that is no longer available");
      expect(message).not.toContain("Somebody else's selection");
    } finally {
      await prisma.actorGroup.deleteMany({ where: { userId: stranger.id } });
      await prisma.user.delete({ where: { id: stranger.id } });
    }
  });

  // -------------------------------------------------------------------------
  // What a run freezes
  // -------------------------------------------------------------------------

  it("freezes who the selected members were, and writes the snapshot at the version an older worker refuses", async () => {
    const [a, b, c] = actorIds as [string, string, string];
    const strategy = await createStrategy({
      kind: "ACTORS",
      actorIds: [c, a, b],
    });
    const run = await submit(strategy.id);
    const { snapshot, snapshotHash } = await storedRun(run.id);

    expect(snapshot.snapshotVersion).toBe(
      BACKTEST_SNAPSHOT_VERSION_ACTOR_SELECTION,
    );
    // The selection itself is in the frozen definition…
    expect(scopeOf(snapshot.strategy.definition)).toEqual({
      kind: "ACTORS",
      actorIds: [a, b, c].sort(),
    });
    // …and beside it, who those ids were: bioguide id and the name at submission, sorted by id.
    expect(snapshot.actors).toEqual(
      members
        .map((member, index) => ({
          actorId: actorIds[index] as string,
          externalId: member.externalId,
          displayName: member.displayName,
        }))
        .sort((left, right) => left.actorId.localeCompare(right.actorId)),
    );
    expect(snapshot.actorGroups).toBeUndefined();
    expect(snapshotHash).toBe(
      createHash("sha256")
        .update(canonicalBacktestSnapshotDocument(snapshot))
        .digest("hex"),
    );
  });

  it("writes a run that selects nobody directly exactly as it always was", async () => {
    const anyone = await createStrategy({ kind: "ANY" });
    const { snapshot } = await storedRun((await submit(anyone.id)).id);
    expect(snapshot.snapshotVersion).toBe(BACKTEST_SNAPSHOT_VERSION);
    expect("actors" in snapshot).toBe(false);
    expect("actorGroups" in snapshot).toBe(false);
  });

  it("names the selected members in the trade log, from the labels the run froze", async () => {
    const [a, b, c] = actorIds as [string, string, string];
    const strategy = await createStrategy({
      kind: "ACTORS",
      actorIds: [a, b, c],
    });
    const run = await submit(strategy.id);
    await recordBuy(run.id);

    expect(await firstTradeConditions(run.id)).toEqual([
      `Congress purchases is above 1 (30D · Nancy Fixture ${shortSuffix}, Ro Fixture ${shortSuffix} +1)`,
    ]);

    // The catalog renames a member afterwards. The run still says who it counted when it ran.
    await prisma.alternativeDataActor.update({
      where: { id: b },
      data: { displayName: `Renamed ${shortSuffix}` },
    });
    try {
      expect(await firstTradeConditions(run.id)).toEqual([
        `Congress purchases is above 1 (30D · Nancy Fixture ${shortSuffix}, Ro Fixture ${shortSuffix} +1)`,
      ]);
    } finally {
      await prisma.alternativeDataActor.update({
        where: { id: b },
        data: { displayName: members[1].displayName },
      });
    }
  });

  it("does not move a submitted run when the strategy's selection is edited afterwards", async () => {
    const [a, b, c] = actorIds as [string, string, string];
    const strategy = await createStrategy({ kind: "ACTORS", actorIds: [a, b] });
    const run = await submit(strategy.id);
    const before = await storedRun(run.id);

    await owner
      .put(`/strategies/${strategy.id}/definition`)
      .send({
        definition: definitionScopedTo({ kind: "ACTORS", actorIds: [c] }),
      })
      .expect(200);

    const after = await storedRun(run.id);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.snapshotHash).toBe(before.snapshotHash);
  });

  it("refuses to run a stored strategy whose selected member the catalog does not hold", async () => {
    // Not reachable through the API, which checks every member on write; a row holding one is
    // corrupt, and counting nobody in its place would be a result nobody could explain.
    const strategyId = await storeStrategy(
      definitionScopedTo({ kind: "ACTORS", actorIds: [randomUUID()] }),
    );
    const refusal = await owner
      .post("/backtests")
      .send({
        strategyId,
        stockListId,
        startDate: "2020-01-01",
        endDate: "2020-12-31",
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 10,
      })
      .expect(400);
    expect(String(refusal.body.message)).toContain(
      "selects a member of Congress who is no longer available",
    );
    expect(
      await prisma.backtestRun.count({ where: { userId: ownerUserId } }),
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The Dashboard
  // -------------------------------------------------------------------------

  it("names the selected members in a Dashboard reason", async () => {
    const [a, b] = actorIds as [string, string];
    const strategy = await createStrategy({ kind: "ACTORS", actorIds: [a, b] });
    const level = strategy.definition.buyLevels[0]!;
    const monitor = await prisma.monitor.create({
      data: {
        userId: ownerUserId,
        strategyId: strategy.id,
        stockListId,
        name: `Selection monitor ${shortSuffix}`,
        lastScanAt: new Date(),
      },
    });
    const decidedAt = new Date();
    const signal = await prisma.monitorSignal.create({
      data: {
        monitorId: monitor.id,
        securityId,
        levelId: level.id,
        levelKind: "BUY",
        strategyVersionId: "version",
        hasTrigger: false,
        observationDate: new Date("2026-03-02T00:00:00.000Z"),
        observationPrice: 100,
        detectedAt: decidedAt,
      },
    });
    await prisma.monitorSignalState.create({
      data: {
        monitorId: monitor.id,
        securityId,
        levelId: level.id,
        levelKind: "BUY",
        // The level's real fingerprint, as the worker would have written it.
        signalFingerprint: strategySignalFingerprint(level.signal),
        lastEvaluableResult: "MATCHED",
        lastEvaluableDate: new Date("2026-03-02T00:00:00.000Z"),
        lastEvaluableAt: decidedAt,
        lastOutcome: "MATCHED",
        lastOutcomeAt: decidedAt,
        lifecycleState: "ACTIVE",
        lifecycleSince: decidedAt,
        lifecycleSinceDate: new Date("2026-03-02T00:00:00.000Z"),
        lifecycleSincePrice: 100,
        ruleStates: {
          [level.id]: {
            state: "ACTIVE",
            since: "2026-03-02",
            triggerDate: null,
          },
        },
        activeSignalId: signal.id,
      },
    });

    const body = (await owner.get("/dashboard").expect(200))
      .body as DashboardResponse;
    const row = body.rows.find((entry) => entry.monitor.id === monitor.id);
    // Who the rule counts, by name — not "2 selected members" where two people are plainly named.
    expect(row?.reasons[0]?.conditions).toEqual([
      `Congress purchases is above 1 (30D · ${members[1].displayName}, ${members[0].displayName})`,
    ]);
  });

  // -------------------------------------------------------------------------
  // Runs submitted before the selection existed
  // -------------------------------------------------------------------------

  /**
   * A run as an earlier release wrote it: version 1, the definition holding a legacy scope, no
   * `actors` field. Stored directly, because nothing writes this shape any more.
   */
  async function storeLegacyRun(
    scope: unknown,
    extra: Partial<BacktestRunSnapshot> = {},
  ): Promise<{ runId: string; snapshot: unknown; snapshotHash: string }> {
    // A real submission supplies everything a snapshot holds besides the strategy; its definition
    // is then replaced by the legacy one, exactly as stored.
    const template = await createStrategy({ kind: "ANY" });
    const submitted = await storedRun((await submit(template.id)).id);
    const snapshot = {
      ...submitted.snapshot,
      ...extra,
      snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
      strategy: {
        ...submitted.snapshot.strategy,
        definition: definitionScopedTo(scope),
      },
    } as unknown as BacktestRunSnapshot;
    const snapshotHash = createHash("sha256")
      .update(canonicalBacktestSnapshotDocument(snapshot))
      .digest("hex");
    const run = await prisma.backtestRun.findFirstOrThrow({
      where: { userId: ownerUserId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: {
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        snapshotHash,
      },
    });
    return { runId: run.id, snapshot, snapshotHash };
  }

  it("still reads a run whose snapshot holds a single-member scope, and names the member", async () => {
    const [a] = actorIds as [string];
    const legacy = await storeLegacyRun({ kind: "ACTOR", actorId: a });
    await recordBuy(legacy.runId);

    const detail = (await owner.get(`/backtests/${legacy.runId}`).expect(200))
      .body as BacktestRunDetailResponse;
    expect(detail.id).toBe(legacy.runId);
    // The run froze no label for the member — there was nowhere to put one — but who it was is
    // known, so the reason names them rather than counting "1 selected member".
    expect(await firstTradeConditions(legacy.runId)).toEqual([
      `Congress purchases is above 1 (30D · ${members[0].displayName})`,
    ]);

    // Reading it changed nothing: the stored document and its hash are what was stored.
    const after = await storedRun(legacy.runId);
    expect(after.snapshot).toEqual(legacy.snapshot);
    expect(after.snapshotHash).toBe(legacy.snapshotHash);
  });

  it("still reads a run whose snapshot froze a group, and names the group it froze", async () => {
    const [a, b] = actorIds as [string, string];
    const groupId = randomUUID();
    // The group itself is long gone; the run carries everything about it that the run needs.
    const legacy = await storeLegacyRun(
      { kind: "GROUP", groupId },
      {
        actorGroups: [
          {
            groupId,
            name: "House leadership",
            members: [
              {
                actorId: a,
                externalId: members[0].externalId,
                displayName: members[0].displayName,
              },
              {
                actorId: b,
                externalId: members[1].externalId,
                displayName: members[1].displayName,
              },
            ],
          },
        ],
      },
    );
    await recordBuy(legacy.runId);

    await owner.get(`/backtests/${legacy.runId}`).expect(200);
    expect(await firstTradeConditions(legacy.runId)).toEqual([
      "Congress purchases is above 1 (30D · House leadership)",
    ]);
    const after = await storedRun(legacy.runId);
    expect(after.snapshot).toEqual(legacy.snapshot);
    expect(after.snapshotHash).toBe(legacy.snapshotHash);
  });
});
