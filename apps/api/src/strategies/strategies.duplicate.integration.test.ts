import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  EntitlementError,
  STRATEGY_SCHEMA_VERSION,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  strategyFinalExitFingerprint,
  strategySignalFingerprint,
  type StrategyDefinition,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { StrategiesModule } from "./strategies.module";
import { definitionHashOf } from "./strategy-versions";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * `POST /strategies/:strategyId/duplicate`: HTTP -> Nest -> StrategiesService -> real PostgreSQL.
 *
 * A copy is a new strategy the caller owns, holding the source's description and current logic —
 * every level, condition, trigger and Exit Rule, in order — under entirely new identities, as its
 * own version 1. It shares no row id with the source, so no Monitor state keyed by the source's
 * level ids can ever apply to it. The source may be the caller's own strategy or a built-in;
 * anybody else's reads as missing.
 */
describe("duplicating a strategy", () => {
  const suffix = randomUUID();
  const tag = suffix.slice(0, 8);
  const password = "Local-test-password-42";
  const emails = {
    owner: `dup-strategy-owner-${suffix}@example.test`,
    other: `dup-strategy-other-${suffix}@example.test`,
    free: `dup-strategy-free-${suffix}@example.test`,
  };
  const builtInKey = `test-dup-strategy-${suffix}`;
  const providerSymbol = `DUPS-${suffix}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let entitlements: EntitlementsService;
  let anonymous: ReturnType<typeof request>;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let free: ReturnType<typeof request.agent>;
  const userIds = { owner: "", other: "", free: "" };
  let builtInId = "";
  let securityId = "";

  /**
   * Enough structure to prove a deep copy: two BUY levels (one with a Trigger), two SELL levels on
   * position metrics and a moving average, and a FINAL EXIT reached by three Exit Rules — a
   * trigger-only rule, a two-condition rule and a rule with both. Every metric family appears.
   */
  function richDefinition(prefix: string): StrategyDefinition {
    const id = (name: string) => `${prefix}-${name}`;
    return normalizeStrategyDefinition({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: id("buy-1"),
          percentage: 25,
          signal: {
            conditions: [
              {
                id: id("buy-1-price"),
                metric: { kind: "PRICE" },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "BALANCED" },
              },
              {
                id: id("buy-1-rsi"),
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_BELOW",
                value: { kind: "NUMBER", value: 30 },
              },
            ],
            trigger: {
              id: id("buy-1-cross"),
              metric: { kind: "PRICE" },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "EMA_50D" },
            },
          },
        },
        {
          id: id("buy-2"),
          percentage: 50,
          signal: {
            conditions: [
              {
                id: id("buy-2-margin"),
                metric: { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 22.5 },
              },
            ],
          },
        },
      ],
      sellLevels: [
        {
          id: id("sell-1"),
          percentage: 50,
          signal: {
            conditions: [
              {
                id: id("sell-1-gain"),
                metric: { kind: "GAIN" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 25 },
              },
            ],
          },
        },
        {
          id: id("sell-2"),
          percentage: 25,
          signal: {
            conditions: [
              {
                id: id("sell-2-trend"),
                metric: { kind: "MOVING_AVERAGE", seriesId: "EMA_50D" },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
          },
        },
      ],
      finalExit: {
        id: id("exit"),
        rules: [
          {
            id: id("exit-loss"),
            signal: {
              conditions: [],
              trigger: {
                id: id("exit-loss-cross"),
                metric: { kind: "LOSS" },
                operator: "CROSSES_ABOVE",
                value: { kind: "PERCENT", value: 10 },
              },
            },
          },
          {
            id: id("exit-trend"),
            signal: {
              conditions: [
                {
                  id: id("exit-trend-price"),
                  metric: { kind: "PRICE" },
                  operator: "IS_BELOW",
                  value: { kind: "SERIES", seriesId: "SMA_200D" },
                },
                {
                  id: id("exit-trend-rsi"),
                  metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 70 },
                },
              ],
            },
          },
          {
            id: id("exit-profit"),
            signal: {
              conditions: [
                {
                  id: id("exit-profit-gain"),
                  metric: { kind: "GAIN" },
                  operator: "IS_ABOVE",
                  value: { kind: "PERCENT", value: 50 },
                },
              ],
              trigger: {
                id: id("exit-profit-cross"),
                metric: { kind: "PRICE" },
                operator: "CROSSES_BELOW",
                value: { kind: "SERIES", seriesId: "EMA_50D" },
              },
            },
          },
        ],
      },
    });
  }

  /** A smaller, different strategy: the "older version" of a source, or an edit. */
  function simpleDefinition(prefix: string): StrategyDefinition {
    return normalizeStrategyDefinition({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: `${prefix}-buy`,
          percentage: 100,
          signal: {
            conditions: [
              {
                id: `${prefix}-buy-trend`,
                metric: { kind: "PRICE" },
                operator: "IS_ABOVE",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    });
  }

  /** Every `id` anywhere in a document, found by walking it rather than by naming row kinds. */
  function idsIn(node: unknown): string[] {
    if (Array.isArray(node)) {
      return node.flatMap(idsIn);
    }
    if (node !== null && typeof node === "object") {
      return Object.entries(node).flatMap(([key, value]) =>
        key === "id" && typeof value === "string" ? [value] : idsIn(value),
      );
    }
    return [];
  }

  function withoutIds(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(withoutIds);
    }
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => key !== "id")
          .map(([key, value]) => [key, withoutIds(value)]),
      );
    }
    return node;
  }

  /** The copy is the source's logic, level for level and rule for rule, and none of its ids. */
  function expectSameLogicNewIdentity(
    copy: StrategyDefinition,
    source: StrategyDefinition,
  ): void {
    expect(withoutIds(copy)).toEqual(withoutIds(source));
    expect(strategyDefinitionFingerprint(copy)).toBe(
      strategyDefinitionFingerprint(source),
    );
    for (const kind of ["buyLevels", "sellLevels"] as const) {
      expect(copy[kind].map((level) => level.percentage)).toEqual(
        source[kind].map((level) => level.percentage),
      );
      expect(
        copy[kind].map((level) => strategySignalFingerprint(level.signal)),
      ).toEqual(
        source[kind].map((level) => strategySignalFingerprint(level.signal)),
      );
    }
    expect(copy.finalExit?.rules.length).toBe(source.finalExit?.rules.length);
    expect(
      copy.finalExit?.rules.map((rule) =>
        strategySignalFingerprint(rule.signal),
      ),
    ).toEqual(
      source.finalExit?.rules.map((rule) =>
        strategySignalFingerprint(rule.signal),
      ),
    );
    if (copy.finalExit && source.finalExit) {
      expect(strategyFinalExitFingerprint(copy.finalExit)).toBe(
        strategyFinalExitFingerprint(source.finalExit),
      );
    }

    const sourceIds = idsIn(source);
    const copyIds = idsIn(copy);
    expect(copyIds).toHaveLength(sourceIds.length);
    expect(new Set(copyIds).size).toBe(copyIds.length);
    expect(copyIds.filter((id) => sourceIds.includes(id))).toEqual([]);
  }

  async function createStrategy(
    agent: ReturnType<typeof request.agent>,
    name: string,
    definition: StrategyDefinition,
    description?: string,
  ): Promise<StrategyDetailResponse> {
    const response = await agent
      .post("/strategies")
      .send({ name, definition, ...(description ? { description } : {}) })
      .expect(201);
    return response.body as StrategyDetailResponse;
  }

  async function readStrategy(
    agent: ReturnType<typeof request.agent>,
    strategyId: string,
  ): Promise<StrategyDetailResponse> {
    return (await agent.get(`/strategies/${strategyId}`).expect(200))
      .body as StrategyDetailResponse;
  }

  async function duplicate(
    agent: ReturnType<typeof request.agent>,
    strategyId: string,
    name: string,
  ): Promise<StrategyDetailResponse> {
    return (
      await agent
        .post(`/strategies/${strategyId}/duplicate`)
        .send({ name })
        .expect(201)
    ).body as StrategyDetailResponse;
  }

  async function strategyNamesOf(userId: string): Promise<string[]> {
    const rows = await prisma.strategy.findMany({
      where: { userId },
      select: { name: true },
    });
    return rows.map((row) => row.name);
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
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // A bound loopback port rather than `init()`: supertest would otherwise pick an ephemeral
    // wildcard port per request, which on macOS can collide with an editor helper's listener.
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);
    entitlements = moduleRef.get(EntitlementsService);

    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: emails.owner, passwordHash, emailVerifiedAt, plan: "PRO" },
        { email: emails.other, passwordHash, emailVerifiedAt, plan: "PRO" },
        { email: emails.free, passwordHash, emailVerifiedAt, plan: "FREE" },
      ],
    });
    for (const user of await prisma.user.findMany({
      where: { email: { in: Object.values(emails) } },
      select: { id: true, email: true },
    })) {
      const role = (Object.keys(emails) as (keyof typeof emails)[]).find(
        (key) => emails[key] === user.email,
      )!;
      userIds[role] = user.id;
    }

    // A built-in as bootstrap and an administrator leave one: two versions, a key, an operator
    // order and an audit column. Only the current version's logic may reach a copy.
    const older = simpleDefinition("builtin-v1");
    const current = richDefinition("builtin");
    const builtIn = await prisma.strategy.create({
      data: {
        ownership: "SYSTEM",
        systemKey: builtInKey,
        name: `Built-in Trend ${tag}`,
        description: "A built-in strategy.",
        displayOrder: 901,
        updatedByUserId: userIds.other,
        versions: {
          create: [
            {
              versionNumber: 1,
              definition: older as unknown as Prisma.InputJsonValue,
              definitionHash: definitionHashOf(older),
            },
            {
              versionNumber: 2,
              definition: current as unknown as Prisma.InputJsonValue,
              definitionHash: definitionHashOf(current),
            },
          ],
        },
      },
    });
    builtInId = builtIn.id;

    securityId = (
      await prisma.security.create({
        data: {
          providerSymbol,
          symbol: `DUPS-${tag.toUpperCase()}`,
          name: "Duplicate Strategy Test Security",
          exchangeCode: "NASDAQ",
          exchangeName: "NASDAQ Global Select",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
      })
    ).id;

    anonymous = request(app.getHttpServer());
    owner = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    free = request.agent(app.getHttpServer());
    for (const [agent, email] of [
      [owner, emails.owner],
      [other, emails.other],
      [free, emails.free],
    ] as const) {
      await agent.post("/auth/login").send({ email, password }).expect(200);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (prisma) {
      // Monitors restrict their strategy's and list's deletion, so they go first; strategies,
      // versions and lists then cascade from their users, and the built-in is removed by key.
      await prisma.monitor.deleteMany({
        where: { userId: { in: Object.values(userIds) } },
      });
      await prisma.strategy.deleteMany({ where: { systemKey: builtInKey } });
      await prisma.user.deleteMany({
        where: { email: { in: Object.values(emails) } },
      });
      await prisma.security.deleteMany({ where: { providerSymbol } });
    }
    if (app) {
      await app.close();
    }
  });

  it("copies the caller's own strategy into a new one they own: every level, rule and trigger", async () => {
    const created = await createStrategy(
      owner,
      `Deep value ${tag}`,
      simpleDefinition("own-v1"),
      "Buy the discount.",
    );
    // A second version, so the copy has to take the current logic and leave the history behind.
    await owner
      .put(`/strategies/${created.id}/definition`)
      .send({ definition: richDefinition("own") })
      .expect(200);
    const source = await readStrategy(owner, created.id);
    expect(source.versionNumber).toBe(2);

    const copy = (
      await owner
        .post(`/strategies/${source.id}/duplicate`)
        .send({ name: `  Deep value ${tag} — Copy  ` })
        .expect(201)
    ).body as StrategyDetailResponse;

    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      name: `Deep value ${tag} — Copy`,
      description: "Buy the discount.",
      ownership: "USER",
      canEdit: true,
      versionNumber: 1,
      buyLevelCount: 2,
      sellLevelCount: 2,
      hasFinalExit: true,
    });
    expect(copy.systemKey).toBeUndefined();
    expectSameLogicNewIdentity(copy.definition, source.definition);
    expect(copy.definition.finalExit?.rules).toHaveLength(3);

    // Its own history of one version, whose hash is the source's current one — same logic.
    const versionsOf = (strategyId: string) =>
      prisma.strategyVersion.findMany({
        where: { strategyId },
        orderBy: { versionNumber: "asc" },
      });
    const sourceVersions = await versionsOf(source.id);
    const copyVersions = await versionsOf(copy.id);
    expect(copyVersions.map((version) => version.versionNumber)).toEqual([1]);
    expect(copyVersions[0]?.definitionHash).toBe(
      sourceVersions.at(-1)?.definitionHash,
    );
    expect(sourceVersions).toHaveLength(2);

    expect(
      await prisma.strategy.findUniqueOrThrow({ where: { id: copy.id } }),
    ).toMatchObject({
      userId: userIds.owner,
      ownership: "USER",
      systemKey: null,
      displayOrder: null,
      updatedByUserId: null,
    });
    // The source is exactly as it was, and the copy reads back as it was answered.
    expect(await readStrategy(owner, source.id)).toEqual(source);
    expect(await readStrategy(owner, copy.id)).toEqual(copy);
  });

  it("keeps the copy and its source independent in both directions", async () => {
    const source = await createStrategy(
      owner,
      `Independent ${tag}`,
      richDefinition("independent"),
    );
    const copy = await duplicate(owner, source.id, `Independent copy ${tag}`);

    // Editing the copy — its logic and its identity — changes nothing about the source.
    await owner
      .put(`/strategies/${copy.id}/definition`)
      .send({ definition: simpleDefinition("edited-copy") })
      .expect(200);
    await owner
      .patch(`/strategies/${copy.id}`)
      .send({ name: `Renamed copy ${tag}`, description: "Changed." })
      .expect(200);
    expect(await readStrategy(owner, source.id)).toEqual(source);

    // And the other way round.
    const copyBefore = await readStrategy(owner, copy.id);
    expect(copyBefore.versionNumber).toBe(2);
    await owner
      .put(`/strategies/${source.id}/definition`)
      .send({ definition: simpleDefinition("edited-source") })
      .expect(200);
    await owner.delete(`/strategies/${source.id}`).expect(204);
    expect(await readStrategy(owner, copy.id)).toEqual(copyBefore);
  });

  it("copies a built-in's current logic into an ordinary strategy the caller owns", async () => {
    const builtInBefore = await readStrategy(owner, builtInId);
    const builtInRowBefore = await prisma.strategy.findUniqueOrThrow({
      where: { id: builtInId },
      include: { versions: { orderBy: { versionNumber: "asc" } } },
    });
    expect(builtInBefore).toMatchObject({
      ownership: "SYSTEM",
      canEdit: false,
      versionNumber: 2,
    });

    const copy = await duplicate(
      owner,
      builtInId,
      `Built-in Trend ${tag} — Copy`,
    );

    expect(copy).toMatchObject({
      ownership: "USER",
      canEdit: true,
      versionNumber: 1,
      description: "A built-in strategy.",
    });
    expect(copy.systemKey).toBeUndefined();
    // The current version, not the first one.
    expectSameLogicNewIdentity(copy.definition, builtInBefore.definition);
    expect(
      await prisma.strategy.findUniqueOrThrow({ where: { id: copy.id } }),
    ).toMatchObject({
      userId: userIds.owner,
      ownership: "USER",
      systemKey: null,
      displayOrder: null,
      updatedByUserId: null,
    });

    // The built-in is untouched, versions and audit columns included.
    expect(await readStrategy(owner, builtInId)).toEqual(builtInBefore);
    expect(
      await prisma.strategy.findUniqueOrThrow({
        where: { id: builtInId },
        include: { versions: { orderBy: { versionNumber: "asc" } } },
      }),
    ).toEqual(builtInRowBefore);

    // The copy is the customer's to change and delete; the built-in never is.
    const edit = { definition: simpleDefinition("edited-built-in") };
    await owner
      .put(`/strategies/${builtInId}/definition`)
      .send(edit)
      .expect(403);
    await owner.put(`/strategies/${copy.id}/definition`).send(edit).expect(200);
    await owner.delete(`/strategies/${builtInId}`).expect(403);
    await owner.delete(`/strategies/${copy.id}`).expect(204);
  });

  it("shares no runtime identity with the source: its levels cannot match the source's monitor state", async () => {
    const source = await createStrategy(
      owner,
      `Monitored ${tag}`,
      richDefinition("monitored"),
    );
    const list = await prisma.stockList.create({
      data: { userId: userIds.owner, name: `Monitored list ${tag}` },
    });
    // Switched off, so no concurrently running monitor cycle ever picks this fixture up.
    const monitor = await prisma.monitor.create({
      data: {
        userId: userIds.owner,
        name: `Monitor ${tag}`,
        strategyId: source.id,
        stockListId: list.id,
        enabled: false,
      },
    });
    // Durable state for the source's first BUY level, keyed as the engine keys it.
    const level = source.definition.buyLevels[0]!;
    const now = new Date();
    await prisma.monitorSignalState.create({
      data: {
        monitorId: monitor.id,
        securityId,
        levelId: level.id,
        levelKind: "BUY",
        signalFingerprint: strategySignalFingerprint(level.signal),
        lastEvaluableResult: "MATCHED",
        lastEvaluableDate: new Date("2026-09-18T00:00:00.000Z"),
        lastEvaluableAt: now,
        lastOutcome: "MATCHED",
        lastOutcomeAt: now,
        lifecycleState: "ACTIVE",
      },
    });

    const copy = await duplicate(owner, source.id, `Unmonitored ${tag}`);

    // Same logic, level for level — and not one level id in common.
    const copiedLevel = copy.definition.buyLevels[0]!;
    expect(strategySignalFingerprint(copiedLevel.signal)).toBe(
      strategySignalFingerprint(level.signal),
    );
    const copyLevelIds = [
      ...copy.definition.buyLevels,
      ...copy.definition.sellLevels,
    ]
      .map((entry) => entry.id)
      .concat(copy.definition.finalExit ? [copy.definition.finalExit.id] : []);
    expect(copyLevelIds).not.toContain(level.id);
    expect(
      await prisma.monitorSignalState.count({
        where: { levelId: { in: copyLevelIds } },
      }),
    ).toBe(0);
    // Nothing runtime came across: no monitor, no state, no run points at the copy.
    expect(await prisma.monitor.count({ where: { strategyId: copy.id } })).toBe(
      0,
    );
    expect(
      await prisma.backtestRun.count({ where: { strategyId: copy.id } }),
    ).toBe(0);
    // The source's monitor and its state are exactly where they were.
    expect(
      (await prisma.monitor.findUniqueOrThrow({ where: { id: monitor.id } }))
        .strategyId,
    ).toBe(source.id);
    expect(
      await prisma.monitorSignalState.count({
        where: { monitorId: monitor.id, levelId: level.id },
      }),
    ).toBe(1);
    // Nothing references the copy, so it deletes even while its source cannot.
    await owner.delete(`/strategies/${source.id}`).expect(409);
    await owner.delete(`/strategies/${copy.id}`).expect(204);
  });

  it("answers another customer's strategy exactly like one that does not exist, and copies nothing", async () => {
    const hidden = await createStrategy(
      owner,
      `Private ${tag}`,
      richDefinition("private"),
    );

    const refused = await other
      .post(`/strategies/${hidden.id}/duplicate`)
      .send({ name: "Stolen" })
      .expect(404);
    const missing = await other
      .post(`/strategies/${randomUUID()}/duplicate`)
      .send({ name: "Stolen" })
      .expect(404);
    expect(refused.body).toEqual(missing.body);
    expect(JSON.stringify(refused.body)).not.toContain("private-");
    expect(await strategyNamesOf(userIds.other)).toEqual([]);
  });

  it("requires a session, and creates nothing without one", async () => {
    await anonymous
      .post(`/strategies/${builtInId}/duplicate`)
      .send({ name: `Guest copy ${tag}` })
      .expect(401);
    expect(
      await prisma.strategy.count({ where: { name: `Guest copy ${tag}` } }),
    ).toBe(0);
  });

  it("asks exactly the entitlement question creating a strategy asks", async () => {
    // Every plan may create strategies and there is no quota on them, so a FREE account copies too.
    await duplicate(free, builtInId, `Free copy ${tag}`);
    expect(await strategyNamesOf(userIds.free)).toEqual([`Free copy ${tag}`]);

    // Were the capability withdrawn, duplicating would be refused by the same guard as creating.
    const guard = vi
      .spyOn(entitlements, "assertCanCreateCustomStrategy")
      .mockImplementation(() => {
        throw new EntitlementError(
          "Your plan does not include custom strategies",
          {
            code: "ENTITLEMENT_FEATURE_UNAVAILABLE",
            tier: "FREE",
          },
        );
      });
    const refused = await free
      .post(`/strategies/${builtInId}/duplicate`)
      .send({ name: `Refused copy ${tag}` })
      .expect(403);
    expect(refused.body).toMatchObject({
      code: "ENTITLEMENT_FEATURE_UNAVAILABLE",
    });
    await free
      .post("/strategies")
      .send({
        name: `Refused create ${tag}`,
        definition: simpleDefinition("refused"),
      })
      .expect(403);
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard.mock.calls[0]?.[0]).toMatchObject({ id: userIds.free });
    expect(await strategyNamesOf(userIds.free)).toEqual([`Free copy ${tag}`]);
  });

  it("validates the name exactly as a new strategy's name, and accepts nothing but a name", async () => {
    const source = await createStrategy(
      owner,
      `Named ${tag}`,
      richDefinition("named"),
      "Kept.",
    );
    const before = await prisma.strategy.count({
      where: { userId: userIds.owner },
    });

    for (const body of [
      {},
      { name: "" },
      { name: "   " },
      { name: 7 },
      { name: "x".repeat(121) },
      // What a copy holds is the server's decision; a client cannot shape it.
      { name: "Smuggled", definition: simpleDefinition("smuggled") },
      { name: "Smuggled", description: "Injected." },
    ]) {
      await owner
        .post(`/strategies/${source.id}/duplicate`)
        .send(body)
        .expect(400);
    }
    expect(
      await prisma.strategy.count({ where: { userId: userIds.owner } }),
    ).toBe(before);

    // The longest valid name is accepted, and names may repeat: two copies are two strategies.
    const first = await duplicate(owner, source.id, "y".repeat(120));
    const second = await duplicate(owner, source.id, "y".repeat(120));
    expect(first.id).not.toBe(second.id);
    expect(first.description).toBe("Kept.");
    // Each copy is re-keyed on its own, so not even two copies share an id.
    const firstIds = idsIn(first.definition);
    expect(
      idsIn(second.definition).filter((id) => firstIds.includes(id)),
    ).toEqual([]);
  });

  it("leaves nothing behind when writing the copy's first version fails", async () => {
    const source = await createStrategy(
      owner,
      `Fragile ${tag}`,
      richDefinition("fragile"),
    );
    const name = `Half a copy ${tag}`;
    // The strategy row is written before its first version, which this trigger refuses — so the
    // only way to end with no copy is for the whole write to roll back.
    const trigger = `dup_fail_${suffix.replace(/-/g, "_")}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT "name" FROM "Strategy" WHERE "id" = NEW."strategyId") = '${name}' THEN
          RAISE EXCEPTION 'simulated failure while copying a strategy version';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "StrategyVersion" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`,
    );
    try {
      await owner
        .post(`/strategies/${source.id}/duplicate`)
        .send({ name })
        .expect(500);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "StrategyVersion"`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${trigger}"()`);
    }
    expect(await prisma.strategy.count({ where: { name } })).toBe(0);

    // With the fault gone the same request succeeds.
    const copy = await duplicate(owner, source.id, name);
    expectSameLogicNewIdentity(copy.definition, source.definition);
  });
});
