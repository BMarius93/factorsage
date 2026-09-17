import { createHash, randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyDetailResponse,
  type StrategySummaryResponse,
  type StrategyValidationErrorResponse,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { StrategiesModule } from "./strategies.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> StrategiesService -> real PostgreSQL, exercising ownership scoping, canonical
 * validation reaching the wire as path-addressed issues, and the version-on-change rule.
 *
 * The slice needs no market data at all: a strategy references the static catalog in
 * `@intrinsic/contracts`, so nothing here touches FMP, Redis, the stock loader or a seeded
 * security.
 */
describe("strategies", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  const ownerEmail = `strategy-owner-${suffix}@example.test`;
  const otherEmail = `strategy-other-${suffix}@example.test`;

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;

  let rowId = 0;
  function nextId(prefix: string): string {
    rowId += 1;
    return `${prefix}-${rowId}`;
  }

  function priceAbove(seriesId: string): StrategyCondition {
    return {
      id: nextId("condition"),
      metric: { kind: "PRICE" },
      operator: "IS_ABOVE",
      value: { kind: "SERIES", seriesId: seriesId as "EMA_200D" },
    };
  }

  function definition(
    overrides: Partial<StrategyDefinition> = {},
  ): StrategyDefinition {
    return {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: nextId("buy"),
          percentage: 25,
          signal: { conditions: [priceAbove("EMA_200D")] },
        },
      ],
      sellLevels: [],
      ...overrides,
    };
  }

  async function createStrategy(
    agent: ReturnType<typeof request.agent>,
    body: object,
  ): Promise<StrategyDetailResponse> {
    const response = await agent.post("/strategies").send(body).expect(201);
    return response.body as StrategyDetailResponse;
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
    await app.init();

    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    // Stated rather than defaulted, so the suite's subject is Strategy semantics. Every
    // authenticated plan may save unlimited Strategies and use every analytical primitive, so the
    // value does not change what this suite proves.
    await prisma.user.createMany({
      data: [
        { email: ownerEmail, passwordHash, emailVerifiedAt, plan: "PRO" },
        { email: otherEmail, passwordHash, emailVerifiedAt, plan: "PRO" },
      ],
    });

    owner = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    await owner
      .post("/auth/login")
      .send({ email: ownerEmail, password })
      .expect(200);
    await other
      .post("/auth/login")
      .send({ email: otherEmail, password })
      .expect(200);
  });

  afterAll(async () => {
    if (prisma) {
      // Strategies and their versions cascade from the users.
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, otherEmail] } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  /**
   * A strategy a Monitor still watches with cannot be deleted.
   *
   * `Monitor.strategyId` is `onDelete: Restrict`, so the guard is the constraint rather than a check
   * that could race a Monitor created a moment later. The rule lives in `ai/product/monitors.md`: a
   * Monitor owns Signal history, which is a record of what was observed, so deleting a strategy must
   * not take it — and every Signal it ever produced — with it silently.
   */
  it("refuses to delete a strategy a monitor is still using", async () => {
    const strategy = await createStrategy(owner, {
      name: "Watched Strategy",
      definition: definition(),
    });
    const ownerId = (
      await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
    ).id;
    const list = await prisma.stockList.create({
      data: { userId: ownerId, name: `Monitor List ${suffix}` },
    });
    const monitor = await prisma.monitor.create({
      data: {
        userId: ownerId,
        name: "Watching",
        strategyId: strategy.id,
        stockListId: list.id,
      },
    });

    const refusal = await owner.delete(`/strategies/${strategy.id}`).expect(409);
    expect(String(refusal.body.message)).toContain("monitor");
    expect(await prisma.strategy.count({ where: { id: strategy.id } })).toBe(1);

    // Once the monitor is gone the strategy deletes normally.
    await prisma.monitor.delete({ where: { id: monitor.id } });
    await owner.delete(`/strategies/${strategy.id}`).expect(204);
    await prisma.stockList.delete({ where: { id: list.id } });
  });

  it("requires authentication on every write, and shows a Guest built-ins only", async () => {
    const anonymous = request(app.getHttpServer());
    const guestStrategies = await anonymous.get("/strategies").expect(200);
    expect(
      (guestStrategies.body as StrategySummaryResponse[]).every(
        (strategy) => strategy.ownership === "SYSTEM" && !strategy.canEdit,
      ),
    ).toBe(true);
    await anonymous.post("/strategies").send({ name: "x" }).expect(401);
    await anonymous.get(`/strategies/${randomUUID()}`).expect(404);
    await anonymous
      .patch(`/strategies/${randomUUID()}`)
      .send({ name: "x" })
      .expect(401);
    await anonymous
      .put(`/strategies/${randomUUID()}/definition`)
      .send({ definition: definition() })
      .expect(401);
    await anonymous.delete(`/strategies/${randomUUID()}`).expect(401);
  });

  it("runs the full create, read, rename, replace and delete lifecycle", async () => {
    const created = await createStrategy(owner, {
      name: "  Value strategy  ",
      description: "Buy the discount",
      definition: definition(),
    });
    expect(created.name).toBe("Value strategy");
    expect(created.description).toBe("Buy the discount");
    expect(created.versionNumber).toBe(1);
    expect(created.buyLevelCount).toBe(1);
    expect(created.sellLevelCount).toBe(0);
    expect(created.hasFinalExit).toBe(false);

    const fetched = await owner.get(`/strategies/${created.id}`).expect(200);
    expect(fetched.body).toEqual(created);

    const renamed = await owner
      .patch(`/strategies/${created.id}`)
      .send({ name: "Renamed", description: null })
      .expect(200);
    expect((renamed.body as StrategySummaryResponse).name).toBe("Renamed");
    expect(renamed.body).not.toHaveProperty("description");
    // A rename is identity, not logic: it must not append a version.
    expect((renamed.body as StrategySummaryResponse).versionNumber).toBe(1);

    const withExit = definition({
      finalExit: {
        id: nextId("exit"),
        rules: [
          {
            id: nextId("exit-rule"),
            signal: {
              conditions: [],
              trigger: {
                id: nextId("trigger"),
                metric: { kind: "PRICE" },
                operator: "CROSSES_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            },
          },
        ],
      },
    });
    const replaced = await owner
      .put(`/strategies/${created.id}/definition`)
      .send({ definition: withExit })
      .expect(200);
    const replacedBody = replaced.body as StrategyDetailResponse;
    expect(replacedBody.versionNumber).toBe(2);
    expect(replacedBody.hasFinalExit).toBe(true);
    expect(replacedBody.definition).toEqual(withExit);

    await owner.delete(`/strategies/${created.id}`).expect(204);
    await owner.get(`/strategies/${created.id}`).expect(404);
  });

  it("lists only the caller's strategies, newest change first", async () => {
    const mine = await createStrategy(owner, {
      name: `Listed ${suffix}`,
      definition: definition(),
    });
    await createStrategy(other, {
      name: `Not mine ${suffix}`,
      definition: definition(),
    });

    const response = await owner.get("/strategies").expect(200);
    const ids = (response.body as StrategySummaryResponse[]).map(
      (row) => row.id,
    );
    expect(ids).toContain(mine.id);
    expect(
      (response.body as StrategySummaryResponse[]).every(
        (row) => row.name !== `Not mine ${suffix}`,
      ),
    ).toBe(true);

    await owner.delete(`/strategies/${mine.id}`).expect(204);
  });

  it("allows two strategies with the same name", async () => {
    const first = await createStrategy(owner, {
      name: "Value Strategy",
      definition: definition(),
    });
    const second = await createStrategy(owner, {
      name: "Value Strategy",
      definition: definition(),
    });
    expect(first.id).not.toBe(second.id);

    await owner.delete(`/strategies/${first.id}`).expect(204);
    await owner.delete(`/strategies/${second.id}`).expect(204);
  });

  it("denies every cross-user access without revealing that the strategy exists", async () => {
    const mine = await createStrategy(owner, {
      name: `Private ${suffix}`,
      definition: definition(),
    });

    await other.get(`/strategies/${mine.id}`).expect(404);
    await other.patch(`/strategies/${mine.id}`).send({ name: "x" }).expect(404);
    await other
      .put(`/strategies/${mine.id}/definition`)
      .send({ definition: definition() })
      .expect(404);
    await other.delete(`/strategies/${mine.id}`).expect(404);
    // Identical answer for an id that does not exist at all.
    await other.get(`/strategies/${randomUUID()}`).expect(404);

    // The owner's strategy is untouched.
    const still = await owner.get(`/strategies/${mine.id}`).expect(200);
    expect((still.body as StrategyDetailResponse).name).toBe(
      `Private ${suffix}`,
    );
    await owner.delete(`/strategies/${mine.id}`).expect(204);
  });

  it("appends a version only when the definition actually changes", async () => {
    const created = await createStrategy(owner, {
      name: `Versioned ${suffix}`,
      definition: definition(),
    });
    const original = created.definition;

    const unchanged = await owner
      .put(`/strategies/${created.id}/definition`)
      .send({ definition: original })
      .expect(200);
    expect((unchanged.body as StrategyDetailResponse).versionNumber).toBe(1);

    // Re-keying rows changes no logic, so it must not churn the history either.
    const rekeyed: StrategyDefinition = {
      ...original,
      buyLevels: original.buyLevels.map((level) => ({
        ...level,
        id: nextId("rekeyed"),
        signal: {
          conditions: level.signal.conditions.map((row) => ({
            ...row,
            id: nextId("rekeyed"),
          })),
        },
      })),
    };
    const afterRekey = await owner
      .put(`/strategies/${created.id}/definition`)
      .send({ definition: rekeyed })
      .expect(200);
    expect((afterRekey.body as StrategyDetailResponse).versionNumber).toBe(1);

    const changed: StrategyDefinition = {
      ...original,
      buyLevels: original.buyLevels.map((level) => ({
        ...level,
        percentage: 50 as const,
      })),
    };
    const afterChange = await owner
      .put(`/strategies/${created.id}/definition`)
      .send({ definition: changed })
      .expect(200);
    expect((afterChange.body as StrategyDetailResponse).versionNumber).toBe(2);

    // The previous version is still there, unmodified.
    const versions = await prisma.strategyVersion.findMany({
      where: { strategyId: created.id },
      orderBy: { versionNumber: "asc" },
    });
    expect(versions.map((row) => row.versionNumber)).toEqual([1, 2]);
    expect(versions[0]?.definition).toEqual(original);
    expect(versions[1]?.definition).toEqual(changed);

    await owner.delete(`/strategies/${created.id}`).expect(204);
  });

  it("serializes concurrent definition replacements instead of losing one", async () => {
    // Two edits of one strategy can land at the same time — two tabs, a retried request. Each
    // must append its own version: the loser of the race must not surface the unique
    // `(strategyId, versionNumber)` constraint as a 500 and silently drop the edit.
    const created = await createStrategy(owner, {
      name: "Contended",
      definition: definition(),
    });
    const submissions = ["SMA_50D", "SMA_100D", "SMA_200D", "EMA_50D"].map(
      (seriesId) =>
        definition({
          buyLevels: [
            {
              id: nextId("buy"),
              percentage: 25,
              signal: { conditions: [priceAbove(seriesId)] },
            },
          ],
        }),
    );

    const responses = await Promise.all(
      submissions.map((submitted) =>
        owner
          .put(`/strategies/${created.id}/definition`)
          .send({ definition: submitted }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);

    const versions = await prisma.strategyVersion.findMany({
      where: { strategyId: created.id },
      orderBy: { versionNumber: "asc" },
      select: { versionNumber: true, definitionHash: true },
    });
    // Version 1 from creation, then exactly one appended version per concurrent edit.
    expect(versions.map((row) => row.versionNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(versions.map((row) => row.definitionHash)).size).toBe(5);

    const fetched = await owner.get(`/strategies/${created.id}`).expect(200);
    expect((fetched.body as StrategyDetailResponse).versionNumber).toBe(5);

    await owner.delete(`/strategies/${created.id}`).expect(204);
  });

  it("returns path-addressed issues for an invalid definition and persists nothing", async () => {
    const before = await owner.get("/strategies").expect(200);

    const response = await owner
      .post("/strategies")
      .send({
        name: `Invalid ${suffix}`,
        definition: { schemaVersion: 1, buyLevels: [], sellLevels: [] },
      })
      .expect(400);
    const body = response.body as StrategyValidationErrorResponse;
    expect(body.code).toBe("STRATEGY_INVALID");
    expect(body.issues).toEqual([
      {
        code: "BUY_LEVEL_REQUIRED",
        path: { levelKind: "BUY", part: "STRATEGY" },
        message: expect.stringContaining("at least one BUY level"),
      },
    ]);

    const after = await owner.get("/strategies").expect(200);
    expect((after.body as StrategySummaryResponse[]).length).toBe(
      (before.body as StrategySummaryResponse[]).length,
    );
  });

  it("rejects a series id outside the canonical catalog", async () => {
    const response = await owner
      .post("/strategies")
      .send({
        name: `Unknown series ${suffix}`,
        definition: definition({
          buyLevels: [
            {
              id: nextId("buy"),
              percentage: 25,
              signal: { conditions: [priceAbove("SMA_42D")] },
            },
          ],
        }),
      })
      .expect(400);
    const body = response.body as StrategyValidationErrorResponse;
    expect(body.issues.map((issue) => issue.code)).toEqual([
      "SERIES_UNKNOWN",
    ]);
    expect(body.issues[0]?.path.field).toBe("VALUE");
  });

  it("rejects Gain in a BUY level", async () => {
    const response = await owner
      .post("/strategies")
      .send({
        name: `Gain in buy ${suffix}`,
        definition: definition({
          buyLevels: [
            {
              id: nextId("buy"),
              percentage: 25,
              signal: {
                conditions: [
                  {
                    id: nextId("condition"),
                    metric: { kind: "GAIN" },
                    operator: "IS_ABOVE",
                    value: { kind: "PERCENT", value: 25 },
                  },
                ],
              },
            },
          ],
        }),
      })
      .expect(400);
    const body = response.body as StrategyValidationErrorResponse;
    expect(body.issues.map((issue) => issue.code)).toEqual([
      "METRIC_NOT_ALLOWED_IN_LEVEL",
    ]);
  });

  it("rejects backtest configuration submitted as a strategy field", async () => {
    for (const key of ["stockListId", "maximumPositions", "initialCapital"]) {
      await owner
        .post("/strategies")
        .send({ name: `Foreign ${key}`, [key]: "x" })
        .expect(400);
    }
    // ... and inside the definition document itself.
    await owner
      .post("/strategies")
      .send({
        name: `Foreign inside ${suffix}`,
        definition: { ...definition(), maximumPositions: 10 },
      })
      .expect(400);
  });

  it("validates the strategy name and the update envelope", async () => {
    await owner.post("/strategies").send({ name: "   " }).expect(400);
    await owner
      .post("/strategies")
      .send({ name: "a".repeat(121) })
      .expect(400);

    const created = await createStrategy(owner, {
      name: `Envelope ${suffix}`,
      definition: definition(),
    });
    await owner.patch(`/strategies/${created.id}`).send({}).expect(400);
    await owner
      .put(`/strategies/${created.id}/definition`)
      .send({})
      .expect(400);
    await owner.delete(`/strategies/${created.id}`).expect(204);
  });

  it("refuses to create a name-only strategy, which could never buy anything", async () => {
    const response = await owner
      .post("/strategies")
      .send({ name: `Draft ${suffix}` })
      .expect(400);
    const body = response.body as StrategyValidationErrorResponse;
    expect(body.issues.map((issue) => issue.code)).toEqual([
      "BUY_LEVEL_REQUIRED",
    ]);
  });
  /**
   * `StrategyVersion.definitionHash` exactly as schema version 1 produced it.
   *
   * Transcribed from the version 1 serialization — `[schemaVersion, buy, sell, finalExitSignal]`
   * with row ids stripped — rather than calling `strategyDefinitionFingerprint`, so this stands as
   * an independent oracle for what is already on disk. A build that changed the serialization would
   * fail here instead of silently appending a version to every strategy a user owns.
   */
  function legacyDefinitionHash(document: {
    schemaVersion: number;
    buyLevels: readonly { percentage: number; signal: unknown }[];
    sellLevels: readonly { percentage: number; signal: unknown }[];
    finalExit?: { signal: unknown };
  }): string {
    type Row = {
      metric: { kind: string; seriesId?: string; sourceId?: string };
      operator: string;
      value: { kind: string; seriesId?: string; value?: number };
    };
    const predicate = (row: Row) => [
      [row.metric.kind, row.metric.seriesId ?? row.metric.sourceId ?? null],
      row.operator,
      row.value.kind === "SERIES"
        ? [row.value.kind, row.value.seriesId]
        : [row.value.kind, row.value.value],
    ];
    const signal = (raw: unknown) => {
      const value = raw as { conditions: Row[]; trigger?: Row };
      return [
        value.conditions.map(predicate),
        value.trigger ? predicate(value.trigger) : null,
      ];
    };
    const level = (entry: { percentage: number; signal: unknown }) => [
      entry.percentage,
      signal(entry.signal),
    ];
    return createHash("sha256")
      .update(
        JSON.stringify([
          document.schemaVersion,
          document.buyLevels.map(level),
          document.sellLevels.map(level),
          document.finalExit ? signal(document.finalExit.signal) : null,
        ]),
      )
      .digest("hex");
  }

  /**
   * FINAL EXIT's Exit Rules across the HTTP boundary and back out of PostgreSQL.
   *
   * The definition is a JSON document, so "does it round-trip" is not a formality: every rule, its
   * order, its own trigger and its ids have to survive a write, a read, an edit and another read.
   * Backwards compatibility is proven the only way that counts — by writing a genuine schema
   * version 1 row and reading it back through the API.
   */
  describe("final exit exit rules", () => {
    function exitRule(seriesId: "SMA_200D" | "EMA_50D" | "EMA_200D") {
      return {
        id: nextId("exit-rule"),
        signal: {
          conditions: [
            {
              id: nextId("condition"),
              metric: { kind: "PRICE" as const },
              operator: "IS_BELOW" as const,
              value: { kind: "SERIES" as const, seriesId },
            },
          ],
        },
      };
    }

    function rsiRule(threshold: number) {
      return {
        id: nextId("exit-rule"),
        signal: {
          conditions: [
            {
              id: nextId("condition"),
              metric: { kind: "OSCILLATOR" as const, seriesId: "RSI_14D" as const },
              operator: "IS_ABOVE" as const,
              value: { kind: "NUMBER" as const, value: threshold },
            },
          ],
        },
      };
    }

    it("persists and reloads a FINAL EXIT with two exit rules", async () => {
      const rules = [exitRule("SMA_200D"), rsiRule(80)];
      const created = await createStrategy(owner, {
        name: `Two exit rules ${suffix}`,
        definition: definition({
          finalExit: { id: nextId("exit"), rules },
        }),
      });

      expect(created.definition.finalExit?.rules).toHaveLength(2);

      const reloaded = await owner
        .get(`/strategies/${created.id}`)
        .expect(200);
      const body = reloaded.body as StrategyDetailResponse;
      expect(body.definition.finalExit?.rules).toEqual(rules);
      expect(body.hasFinalExit).toBe(true);
    });

    it("persists and reloads three exit rules in the order they were sent", async () => {
      const rules = [exitRule("EMA_20D" as "EMA_200D"), exitRule("SMA_200D"), rsiRule(75)];
      const created = await createStrategy(owner, {
        name: `Three exit rules ${suffix}`,
        definition: definition({ finalExit: { id: nextId("exit"), rules } }),
      });

      const body = (await owner.get(`/strategies/${created.id}`).expect(200))
        .body as StrategyDetailResponse;
      expect(body.definition.finalExit?.rules.map((rule) => rule.id)).toEqual(
        rules.map((rule) => rule.id),
      );
      expect(body.definition.finalExit?.rules).toEqual(rules);
    });

    /** Add, save, reload, edit, save, reload — the exact round trip a user performs. */
    it("keeps the structure exactly through an add / save / reload / edit / save / reload cycle", async () => {
      const ruleOne = exitRule("SMA_200D");
      const created = await createStrategy(owner, {
        name: `Round trip ${suffix}`,
        definition: definition({
          finalExit: { id: nextId("exit"), rules: [ruleOne] },
        }),
      });

      // Add a second rule.
      const ruleTwo = rsiRule(80);
      const afterAdd = (
        await owner
          .put(`/strategies/${created.id}/definition`)
          .send({
            definition: {
              ...created.definition,
              finalExit: {
                id: created.definition.finalExit?.id,
                rules: [ruleOne, ruleTwo],
              },
            },
          })
          .expect(200)
      ).body as StrategyDetailResponse;
      expect(afterAdd.versionNumber).toBe(2);

      const reloaded = (await owner.get(`/strategies/${created.id}`).expect(200))
        .body as StrategyDetailResponse;
      expect(reloaded.definition.finalExit?.rules).toEqual([ruleOne, ruleTwo]);

      // Edit only rule 2.
      const editedTwo = {
        ...ruleTwo,
        signal: {
          conditions: [
            { ...ruleTwo.signal.conditions[0]!, value: { kind: "NUMBER" as const, value: 70 } },
          ],
        },
      };
      await owner
        .put(`/strategies/${created.id}/definition`)
        .send({
          definition: {
            ...reloaded.definition,
            finalExit: {
              id: reloaded.definition.finalExit?.id,
              rules: [ruleOne, editedTwo],
            },
          },
        })
        .expect(200);

      const final = (await owner.get(`/strategies/${created.id}`).expect(200))
        .body as StrategyDetailResponse;
      // Rule 1 untouched, rule 2 carries the edit, the OR structure intact.
      expect(final.definition.finalExit?.rules[0]).toEqual(ruleOne);
      expect(final.definition.finalExit?.rules[1]).toEqual(editedTwo);
      expect(final.versionNumber).toBe(3);
    });

    it("removes the middle rule and leaves no stale data behind", async () => {
      const rules = [exitRule("SMA_200D"), rsiRule(80), rsiRule(75)];
      const created = await createStrategy(owner, {
        name: `Remove middle ${suffix}`,
        definition: definition({ finalExit: { id: nextId("exit"), rules } }),
      });

      await owner
        .put(`/strategies/${created.id}/definition`)
        .send({
          definition: {
            ...created.definition,
            finalExit: {
              id: created.definition.finalExit?.id,
              rules: [rules[0], rules[2]],
            },
          },
        })
        .expect(200);

      const body = (await owner.get(`/strategies/${created.id}`).expect(200))
        .body as StrategyDetailResponse;
      expect(body.definition.finalExit?.rules).toEqual([rules[0], rules[2]]);
      // The persisted document holds two rules, not three with one blanked.
      const stored = await prisma.strategyVersion.findFirstOrThrow({
        where: { strategyId: created.id },
        orderBy: { versionNumber: "desc" },
      });
      expect(
        (stored.definition as { finalExit: { rules: unknown[] } }).finalExit
          .rules,
      ).toHaveLength(2);
    });

    it("rejects an empty rule list and a duplicated rule with row-addressed issues", async () => {
      const created = await createStrategy(owner, {
        name: `Invalid rules ${suffix}`,
        definition: definition(),
      });

      const empty = await owner
        .put(`/strategies/${created.id}/definition`)
        .send({
          definition: definition({ finalExit: { id: nextId("exit"), rules: [] } }),
        })
        .expect(400);
      expect((empty.body as StrategyValidationErrorResponse).issues[0]?.code).toBe(
        "EXIT_RULE_REQUIRED",
      );

      const rule = rsiRule(80);
      const duplicated = await owner
        .put(`/strategies/${created.id}/definition`)
        .send({
          definition: definition({
            finalExit: {
              id: nextId("exit"),
              rules: [rule, { ...rsiRule(80), id: nextId("exit-rule") }],
            },
          }),
        })
        .expect(400);
      const issue = (duplicated.body as StrategyValidationErrorResponse)
        .issues[0];
      expect(issue?.code).toBe("DUPLICATE_EXIT_RULE");
      expect(issue?.path).toEqual({
        levelKind: "FINAL_EXIT",
        ruleIndex: 1,
        part: "EXIT_RULE",
      });
    });

    /**
     * The backwards-compatibility proof that matters, against a real row.
     *
     * The version 1 document is written straight to PostgreSQL — the shape every strategy saved
     * before Exit Rules existed still has — and then read back through the ordinary API. It must
     * come out as a single-rule version 2 document, and its `definitionHash` must still be the hash
     * the row was stored with, or the next save would append a version nobody asked for.
     */
    it("reads a stored schema version 1 strategy as one exit rule, without touching the row", async () => {
      const created = await createStrategy(owner, {
        name: `Legacy exit ${suffix}`,
        definition: definition(),
      });
      const legacySignal = {
        conditions: [
          {
            id: "legacy-c1",
            metric: { kind: "PRICE" },
            operator: "IS_BELOW",
            value: { kind: "SERIES", seriesId: "SMA_200D" },
          },
        ],
      };
      const legacyDocument = {
        schemaVersion: 1,
        buyLevels: created.definition.buyLevels,
        sellLevels: [],
        finalExit: { id: "legacy-exit", signal: legacySignal },
      };
      const current = await prisma.strategyVersion.findFirstOrThrow({
        where: { strategyId: created.id },
        orderBy: { versionNumber: "desc" },
      });
      await prisma.strategyVersion.update({
        where: { id: current.id },
        data: {
          definition: legacyDocument,
          // The hash the build that wrote this row would have stored, produced by a transcription
          // of the version 1 serialization rather than by today's helper — otherwise this would
          // only prove the code agrees with itself.
          definitionHash: legacyDefinitionHash(legacyDocument),
        },
      });

      const body = (await owner.get(`/strategies/${created.id}`).expect(200))
        .body as StrategyDetailResponse;
      expect(body.definition.schemaVersion).toBe(STRATEGY_SCHEMA_VERSION);
      expect(body.definition.finalExit).toEqual({
        id: "legacy-exit",
        // The single rule reuses FINAL EXIT's own id: deterministic, and derived from the row.
        rules: [{ id: "legacy-exit", signal: legacySignal }],
      });
      expect(body.hasFinalExit).toBe(true);

      // Nothing rewrote the stored row.
      const stored = await prisma.strategyVersion.findUniqueOrThrow({
        where: { id: current.id },
      });
      expect(stored.definition).toEqual(legacyDocument);

      // And re-saving the upgraded document appends no version, because no logic changed: the
      // upgrade is semantics-preserving, so it fingerprints to exactly what the row already holds.
      const resaved = (
        await owner
          .put(`/strategies/${created.id}/definition`)
          .send({ definition: body.definition })
          .expect(200)
      ).body as StrategyDetailResponse;
      expect(resaved.versionNumber).toBe(current.versionNumber);
    });

    /** A stale client still posting the old shape is served, not refused. */
    it("accepts a schema version 1 payload and returns it as version 2", async () => {
      const created = await createStrategy(owner, {
        name: `Legacy payload ${suffix}`,
        definition: {
          schemaVersion: 1,
          buyLevels: definition().buyLevels,
          sellLevels: [],
          finalExit: {
            id: "legacy-payload-exit",
            signal: {
              conditions: [
                {
                  id: "legacy-payload-c1",
                  metric: { kind: "PRICE" },
                  operator: "IS_BELOW",
                  value: { kind: "SERIES", seriesId: "SMA_200D" },
                },
              ],
            },
          },
        },
      });

      expect(created.definition.schemaVersion).toBe(STRATEGY_SCHEMA_VERSION);
      expect(created.definition.finalExit?.rules).toHaveLength(1);
      expect(created.definition.finalExit?.rules[0]?.id).toBe(
        "legacy-payload-exit",
      );
    });
  });
});
