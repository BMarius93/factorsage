import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  STOCK_LIST_MAX_SECURITIES_PER_ADD,
  STRATEGY_SCHEMA_VERSION,
  type EntitlementReasonCode,
  type EntitlementsResponse,
  type MonitorSummaryResponse,
  type StockListDetailResponse,
  type StrategyDefinition,
  type UserPlan,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BacktestsModule } from "../backtests/backtests.module";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { ListsModule } from "../lists/lists.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { StrategiesModule } from "../strategies/strategies.module";
import { EntitlementsModule } from "./entitlements.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> the real services -> real PostgreSQL, proving Entitlements V1 is *enforced*
 * rather than merely described.
 *
 * Every case here drives the canonical server boundary directly with `supertest`. That is the
 * point: `docs/decisions/entitlements-v1.md` section 13 says UI checks are convenience only and a
 * forged or hand-written request must not bypass a limit, so a suite that exercised the browser
 * would prove nothing about the invariant. There is no UI in this file at all.
 *
 * The numbers are written as literals rather than read from the matrix. A suite that imports the
 * value it is checking agrees with the implementation by construction, including when the
 * implementation is wrong.
 */
describe("entitlements", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";

  type Persona = {
    email: string;
    agent: ReturnType<typeof request.agent>;
    userId: string;
  };

  let app: INestApplication;
  let prisma: PrismaService;
  let anonymous: ReturnType<typeof request.agent>;

  const personas = new Map<string, Persona>();
  const securityIds: string[] = [];
  const providerSymbols: string[] = [];

  /** Enough catalog rows to exceed the largest plan's list capacity by one. */
  const SECURITY_COUNT = 101;

  function persona(name: string): Persona {
    const found = personas.get(name);
    if (!found) {
      throw new Error(`Unknown persona ${name}`);
    }
    return found;
  }

  function agentOf(name: string) {
    return persona(name).agent;
  }

  async function setPlan(name: string, plan: UserPlan): Promise<void> {
    await prisma.user.update({
      where: { id: persona(name).userId },
      data: { plan },
    });
  }

  let conditionId = 0;
  function nextId(prefix: string): string {
    conditionId += 1;
    return `${prefix}-${conditionId}`;
  }

  /**
   * A Strategy touching every analytical family the product has: a price comparison against a
   * moving average, an oscillator threshold, an intrinsic-value margin of safety, a Trigger, and
   * a position-dependent SELL level.
   *
   * `docs/decisions/entitlements-v1.md` forbids per-indicator and per-condition paywalls, so the
   * same document is submitted unchanged by every authenticated tier.
   */
  function everyPrimitiveDefinition(): StrategyDefinition {
    return {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: nextId("buy"),
          percentage: 50,
          signal: {
            conditions: [
              {
                id: nextId("condition"),
                metric: { kind: "PRICE" },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
              {
                id: nextId("condition"),
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_BELOW",
                value: { kind: "NUMBER", value: 30 },
              },
              {
                id: nextId("condition"),
                metric: { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 25 },
              },
              {
                id: nextId("condition"),
                metric: { kind: "MOVING_AVERAGE", seriesId: "EMA_200D" },
                operator: "IS_ABOVE",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
            trigger: {
              id: nextId("trigger"),
              metric: { kind: "PRICE" },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "EMA_200D" },
            },
          },
        },
      ],
      sellLevels: [
        {
          id: nextId("sell"),
          // One of the product's allowed SELL fractions; the value is not what this case is about.
          percentage: 50,
          signal: {
            conditions: [
              {
                id: nextId("condition"),
                metric: { kind: "GAIN" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 40 },
              },
            ],
          },
        },
      ],
    };
  }

  function simpleDefinition(): StrategyDefinition {
    return {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: nextId("buy"),
          percentage: 25,
          signal: {
            conditions: [
              {
                id: nextId("condition"),
                metric: { kind: "PRICE" },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    };
  }

  /** Creates a list through the API and returns it, failing loudly on an unexpected status. */
  async function createList(
    name: string,
    symbolCount: number,
    options: { as: string },
  ): Promise<StockListDetailResponse> {
    const response = await agentOf(options.as)
      .post("/lists")
      .send({
        name: `${name} ${randomUUID().slice(0, 8)}`,
        securityIds: securityIds.slice(0, symbolCount),
      })
      .expect(201);
    return response.body as StockListDetailResponse;
  }

  async function createStrategyId(as: string): Promise<string> {
    const response = await agentOf(as)
      .post("/strategies")
      .send({ name: `Strategy ${randomUUID().slice(0, 8)}`, definition: simpleDefinition() })
      .expect(201);
    return (response.body as { id: string }).id;
  }

  /** The machine-readable refusal a request produced, asserted rather than parsed from prose. */
  function refusal(body: unknown): {
    code: EntitlementReasonCode;
    limit?: number;
    current?: number;
    requested?: number;
    tier: string;
  } {
    return body as {
      code: EntitlementReasonCode;
      limit?: number;
      current?: number;
      requested?: number;
      tier: string;
    };
  }

  function isoDaysAgo(days: number): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  }

  /** `years` before the given date, with the product's own 29-February clamp. */
  function yearsBefore(date: string, years: number): string {
    const shifted = new Date(`${date}T00:00:00.000Z`);
    const day = shifted.getUTCDate();
    shifted.setUTCDate(1);
    shifted.setUTCFullYear(shifted.getUTCFullYear() - years);
    const lastDayOfMonth = new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
    ).getUTCDate();
    shifted.setUTCDate(Math.min(day, lastDayOfMonth));
    return shifted.toISOString().slice(0, 10);
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
        EntitlementsModule,
        ListsModule,
        StrategiesModule,
        MonitorsModule,
        BacktestsModule,
        BenchmarksModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();

    const definitions: { name: string; plan: UserPlan; role: "USER" | "ADMIN" }[] =
      [
        { name: "free", plan: "FREE", role: "USER" },
        { name: "starter", plan: "STARTER", role: "USER" },
        { name: "pro", plan: "PRO", role: "USER" },
        { name: "downgrade", plan: "PRO", role: "USER" },
        { name: "monitors", plan: "PRO", role: "USER" },
        { name: "backtests", plan: "PRO", role: "USER" },
        // Deliberately FREE *and* ADMIN: the two are orthogonal, which is exactly what one of
        // these cases has to prove.
        { name: "freeAdmin", plan: "FREE", role: "ADMIN" },
      ];

    for (const entry of definitions) {
      // Lowercased: the identity layer normalizes on both write and lookup, so a persona named
      // `freeAdmin` would otherwise be stored under a different address than it logs in with.
      const email = `ent-${entry.name}-${suffix}@example.test`.toLowerCase();
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          emailVerifiedAt,
          plan: entry.plan,
          role: entry.role,
        },
        select: { id: true },
      });
      const agent = request.agent(app.getHttpServer());
      await agent.post("/auth/login").send({ email, password }).expect(200);
      personas.set(entry.name, { email, agent, userId: user.id });
    }

    anonymous = request.agent(app.getHttpServer());

    for (let index = 0; index < SECURITY_COUNT; index += 1) {
      const providerSymbol = `ENT${index}-${suffix}`;
      providerSymbols.push(providerSymbol);
      const security = await prisma.security.create({
        data: {
          providerSymbol,
          symbol: `ENT${index}-${suffix.slice(0, 8).toUpperCase()}`,
          name: `Entitlement Security ${index}`,
          exchangeCode: "NASDAQ",
          exchangeName: "NASDAQ Global Select",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
        select: { id: true },
      });
      securityIds.push(security.id);
    }
  });

  afterEach(async () => {
    // Runs and Monitors are the two capacity-controlled resources whose accumulation would change
    // what a later case observes. Lists and Strategies are unlimited by decision, so they stay.
    if (prisma) {
      const userIds = [...personas.values()].map((entry) => entry.userId);
      await prisma.backtestRun.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.monitor.deleteMany({ where: { userId: { in: userIds } } });
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: { email: { in: [...personas.values()].map((entry) => entry.email) } },
      });
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: providerSymbols } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 1 & 2 — Guest
  // -------------------------------------------------------------------------

  describe("guest access", () => {
    it("resolves entitlements with no session and creates no user row", async () => {
      const before = await prisma.user.count();

      const response = await anonymous.get("/entitlements").expect(200);
      const body = response.body as EntitlementsResponse;

      expect(body.principal).toBe("GUEST");
      expect(body.plan).toBeUndefined();
      expect(body.role).toBeUndefined();
      expect(body.entitlements.tier).toBe("GUEST");
      expect(body.entitlements.authenticated).toBe(false);
      // The invariant: a Guest is an access state, not an account.
      expect(await prisma.user.count()).toBe(before);
    });

    it("treats an unusable session cookie as signed out rather than as an error", async () => {
      const response = await request(app.getHttpServer())
        .get("/entitlements")
        .set("Cookie", "test_auth=not-a-real-token")
        .expect(200);
      expect((response.body as EntitlementsResponse).principal).toBe("GUEST");
    });

    it("reports full stock-details history and built-in content for a guest", async () => {
      const body = (await anonymous.get("/entitlements").expect(200))
        .body as EntitlementsResponse;
      expect(body.entitlements.stocks.maxHistoricalYears).toBeNull();
      expect(body.entitlements.stocks.canSearch).toBe(true);
      expect(body.entitlements.builtInContent.canViewLists).toBe(true);
      expect(body.entitlements.builtInContent.canViewStrategies).toBe(true);
      expect(body.entitlements.backtests.canViewDemo).toBe(true);
    });

    it("refuses every path that would persist content or start live execution", async () => {
      await anonymous.post("/lists").send({ name: "Guest list" }).expect(401);
      await anonymous
        .post("/strategies")
        .send({ name: "Guest strategy", definition: simpleDefinition() })
        .expect(401);
      await anonymous
        .post("/backtests")
        .send({ strategyId: randomUUID(), stockListId: randomUUID() })
        .expect(401);
      await anonymous
        .post("/monitors")
        .send({
          name: "Guest monitor",
          strategyId: randomUUID(),
          stockListId: randomUUID(),
        })
        .expect(401);
      expect(await prisma.stockList.count({ where: { name: "Guest list" } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3, 4, 13 — Lists
  // -------------------------------------------------------------------------

  describe("custom list capacity", () => {
    const cases: { as: string; limit: number }[] = [
      { as: "free", limit: 10 },
      { as: "starter", limit: 50 },
      { as: "pro", limit: 100 },
    ];

    for (const { as, limit } of cases) {
      it(`allows exactly ${limit} symbols per list on ${as}`, async () => {
        const atLimit = await createList("At limit", limit, { as });
        expect(atLimit.items).toHaveLength(limit);
        expect(atLimit.compliance).toEqual({
          symbolCount: limit,
          symbolLimit: limit,
          compliant: true,
        });

        if (limit < STOCK_LIST_MAX_SECURITIES_PER_ADD) {
          // Creating with one too many is refused by the entitlement, not by the envelope.
          const overflow = await agentOf(as)
            .post("/lists")
            .send({
              name: "One too many",
              securityIds: securityIds.slice(0, limit + 1),
            })
            .expect(403);
          expect(refusal(overflow.body).code).toBe(
            "ENTITLEMENT_LIST_SYMBOL_LIMIT",
          );
          expect(refusal(overflow.body).limit).toBe(limit);
          expect(
            await prisma.stockList.count({ where: { name: "One too many" } }),
          ).toBe(0);
        }
      });

      it(`stops an add that would push a ${as} list past ${limit}`, async () => {
        const list = await createList("Growing", limit - 1, { as });

        await agentOf(as)
          .post(`/lists/${list.id}/items`)
          .send({ securityIds: [securityIds[limit - 1]] })
          .expect(200);

        const rejected = await agentOf(as)
          .post(`/lists/${list.id}/items`)
          .send({ securityIds: [securityIds[limit]] })
          .expect(403);
        expect(refusal(rejected.body).code).toBe("ENTITLEMENT_LIST_SYMBOL_LIMIT");
        expect(
          await prisma.stockListItem.count({ where: { stockListId: list.id } }),
        ).toBe(limit);
      });
    }

    it("refuses a PRO overflow through the add path, where the plan limit is what binds", async () => {
      // `STOCK_LIST_MAX_SECURITIES_PER_ADD` is a structural request bound, not a commercial one,
      // and at 100 it is stricter than PRO's own limit — so a 101-symbol *create* never reaches the
      // entitlement. That interaction is asserted rather than worked around: the add path is where
      // PRO's commercial limit is the thing that refuses.
      const create = await agentOf("pro")
        .post("/lists")
        .send({
          name: "Structurally too large",
          securityIds: securityIds.slice(0, 101),
        })
        .expect(400);
      expect(refusal(create.body).code).toBeUndefined();

      const list = await createList("At PRO limit", 100, { as: "pro" });
      const rejected = await agentOf("pro")
        .post(`/lists/${list.id}/items`)
        .send({ securityIds: [securityIds[100]] })
        .expect(403);
      expect(refusal(rejected.body).code).toBe("ENTITLEMENT_LIST_SYMBOL_LIMIT");
      expect(refusal(rejected.body).limit).toBe(100);
      expect(
        await prisma.stockListItem.count({ where: { stockListId: list.id } }),
      ).toBe(100);
    });

    it("cannot be raced past the symbol limit by simultaneous adds", async () => {
      // The TOCTOU case for list capacity. Four requests each add a *different* stock to a list
      // one short of the FREE limit. Without the per-user entitlement lock inside the writing
      // transaction they would all read nine members, all conclude there is room, and leave the
      // list at thirteen.
      const list = await createList("Raced", 9, { as: "free" });
      const responses = await Promise.all(
        [9, 10, 11, 12].map((index) =>
          agentOf("free")
            .post(`/lists/${list.id}/items`)
            .send({ securityIds: [securityIds[index]] }),
        ),
      );

      expect(responses.filter((entry) => entry.status === 200)).toHaveLength(1);
      expect(responses.filter((entry) => entry.status === 403)).toHaveLength(3);
      expect(
        await prisma.stockListItem.count({ where: { stockListId: list.id } }),
      ).toBe(10);
    });

    it("never refuses re-adding symbols a list already holds", async () => {
      const list = await createList("Idempotent", 10, { as: "free" });
      // At the FREE limit exactly. Re-submitting the same ten creates nothing, so it must pass.
      await agentOf("free")
        .post(`/lists/${list.id}/items`)
        .send({ securityIds: securityIds.slice(0, 10) })
        .expect(200);
      expect(
        await prisma.stockListItem.count({ where: { stockListId: list.id } }),
      ).toBe(10);
    });

    it("places no quota on how many lists or strategies a free user saves", async () => {
      for (let index = 0; index < 12; index += 1) {
        await createList(`Unlimited ${index}`, 1, { as: "free" });
        await agentOf("free")
          .post("/strategies")
          .send({ name: `Unlimited ${index}`, definition: simpleDefinition() })
          .expect(201);
      }
      const owner = persona("free").userId;
      expect(
        await prisma.stockList.count({ where: { userId: owner } }),
      ).toBeGreaterThanOrEqual(12);
      expect(
        await prisma.strategy.count({ where: { userId: owner } }),
      ).toBeGreaterThanOrEqual(12);
    });
  });

  // -------------------------------------------------------------------------
  // 5 — Analytical primitives
  // -------------------------------------------------------------------------

  describe("analytical primitives", () => {
    for (const as of ["free", "starter", "pro"]) {
      it(`lets ${as} save a strategy using every indicator, trigger and valuation primitive`, async () => {
        const response = await agentOf(as)
          .post("/strategies")
          .send({
            name: `Everything ${as}`,
            definition: everyPrimitiveDefinition(),
          })
          .expect(201);
        const saved = response.body as { definition: StrategyDefinition };
        expect(saved.definition.buyLevels[0]?.signal.conditions).toHaveLength(4);
        expect(saved.definition.buyLevels[0]?.signal.trigger).toBeDefined();
        expect(saved.definition.sellLevels).toHaveLength(1);
      });
    }

    it("reports the same primitive entitlement for every authenticated tier", async () => {
      for (const as of ["free", "starter", "pro"]) {
        const body = (await agentOf(as).get("/entitlements").expect(200))
          .body as EntitlementsResponse;
        expect(body.entitlements.strategies.analyticalPrimitives).toBe("ALL");
      }
    });
  });


  // -------------------------------------------------------------------------
  // 6, 7, 8 — Backtests
  // -------------------------------------------------------------------------

  describe("live backtests", () => {
    /**
     * Today. A period may end today but not later, and the deepest case has to start exactly on
     * the product's thirty-year horizon — which is measured from *today*, so an earlier end date
     * would put PRO's own thirty-year period one day outside the horizon the loader keeps.
     */
    const endDate = isoDaysAgo(0);

    async function submissionFor(
      as: string,
      options: { symbolCount: number; years: number },
    ): Promise<Record<string, unknown>> {
      const list = await createList("Backtest universe", options.symbolCount, {
        as,
      });
      return {
        strategyId: await createStrategyId(as),
        stockListId: list.id,
        startDate: yearsBefore(endDate, options.years),
        endDate,
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 10,
      };
    }

    const symbolCases: { as: string; limit: number }[] = [
      { as: "free", limit: 10 },
      { as: "starter", limit: 50 },
    ];

    for (const { as, limit } of symbolCases) {
      it(`runs a backtest over exactly ${limit} symbols on ${as} and refuses ${limit + 1}`, async () => {
        await agentOf(as)
          .post("/backtests")
          .send(await submissionFor(as, { symbolCount: limit, years: 1 }))
          .expect(202);
        await prisma.backtestRun.deleteMany({
          where: { userId: persona(as).userId },
        });

        // The oversized list is built by an account that may hold it, then handed to the plan
        // under test — the same shape a downgrade produces, and the reason the backtest limit is
        // its own check rather than a consequence of the list limit.
        const oversized = await prisma.stockList.create({
          data: {
            userId: persona(as).userId,
            name: `Oversized ${as}`,
            items: {
              create: securityIds
                .slice(0, limit + 1)
                .map((securityId) => ({ securityId })),
            },
          },
          select: { id: true },
        });
        const rejected = await agentOf(as)
          .post("/backtests")
          .send({
            strategyId: await createStrategyId(as),
            stockListId: oversized.id,
            startDate: yearsBefore(endDate, 1),
            endDate,
            initialCapital: 100_000,
            monthlyContribution: 0,
            maximumPositions: 10,
          })
          .expect(403);
        expect(refusal(rejected.body).code).toBe(
          "ENTITLEMENT_BACKTEST_SYMBOL_LIMIT",
        );
        expect(refusal(rejected.body).limit).toBe(limit);
        expect(
          await prisma.backtestRun.count({
            where: { userId: persona(as).userId },
          }),
        ).toBe(0);
      });
    }

    const depthCases: { as: string; years: number }[] = [
      { as: "free", years: 5 },
      { as: "starter", years: 15 },
      { as: "pro", years: 30 },
    ];

    for (const { as, years } of depthCases) {
      it(`allows exactly ${years} years of backtest history on ${as}`, async () => {
        const base = await submissionFor(as, { symbolCount: 2, years });
        await agentOf(as).post("/backtests").send(base).expect(202);
        await prisma.backtestRun.deleteMany({
          where: { userId: persona(as).userId },
        });

        if (years === 30) {
          // PRO's entitlement is the product's whole retention horizon, so one day more is refused
          // by the plan-independent horizon rule instead. Asserted so the interaction is recorded
          // rather than silently untested.
          const beyond = await agentOf(as)
            .post("/backtests")
            .send({
              ...base,
              startDate: yearsBefore(base.startDate as string, 1),
            })
            .expect(400);
          expect((beyond.body as { code: string }).code).toBe("BACKTEST_INVALID");
          return;
        }

        const rejected = await agentOf(as)
          .post("/backtests")
          .send({
            ...base,
            // One day earlier than the plan allows: the period now covers `years + 1`.
            startDate: yearsBefore(endDate, years + 1),
          })
          .expect(403);
        expect(refusal(rejected.body).code).toBe(
          "ENTITLEMENT_BACKTEST_HISTORY_LIMIT",
        );
        expect(refusal(rejected.body).limit).toBe(years);
      });
    }

    it("does not restrict Stock Details history for any plan, including a guest", async () => {
      // The depth limit above applies to execution only. Every access state still reports full
      // history for the chart, which is a separate entitlement on purpose.
      const guest = (await anonymous.get("/entitlements").expect(200))
        .body as EntitlementsResponse;
      expect(guest.entitlements.stocks.maxHistoricalYears).toBeNull();
      for (const as of ["free", "starter", "pro"]) {
        const body = (await agentOf(as).get("/entitlements").expect(200))
          .body as EntitlementsResponse;
        expect(body.entitlements.backtests.maxHistoricalYears).not.toBeNull();
        expect(body.entitlements.stocks.maxHistoricalYears).toBeNull();
      }
    });

    const concurrencyCases: { as: string; limit: number }[] = [
      { as: "free", limit: 1 },
      { as: "starter", limit: 1 },
      { as: "pro", limit: 2 },
    ];

    for (const { as, limit } of concurrencyCases) {
      it(`runs at most ${limit} concurrent backtests on ${as}`, async () => {
        const base = await submissionFor(as, { symbolCount: 2, years: 1 });
        for (let index = 0; index < limit; index += 1) {
          await agentOf(as).post("/backtests").send(base).expect(202);
        }

        const rejected = await agentOf(as)
          .post("/backtests")
          .send(base)
          .expect(403);
        expect(refusal(rejected.body).code).toBe(
          "ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT",
        );
        expect(refusal(rejected.body).limit).toBe(limit);
        expect(
          await prisma.backtestRun.count({
            where: { userId: persona(as).userId },
          }),
        ).toBe(limit);
      });
    }

    it("cannot be raced past the concurrency limit by simultaneous submissions", async () => {
      // The TOCTOU case. Both requests read the caller's in-flight count at effectively the same
      // instant; without the per-user lock inside the creating transaction both would pass, and a
      // plan that runs one backtest would be running two.
      const base = await submissionFor("free", { symbolCount: 2, years: 1 });
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          agentOf("free").post("/backtests").send(base),
        ),
      );

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([202, 403, 403, 403]);
      expect(
        await prisma.backtestRun.count({
          where: { userId: persona("free").userId },
        }),
      ).toBe(1);
      for (const response of responses.filter((entry) => entry.status === 403)) {
        expect(refusal(response.body).code).toBe(
          "ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT",
        );
      }
    });

    it("frees a concurrency slot when a run reaches a terminal status", async () => {
      const base = await submissionFor("free", { symbolCount: 2, years: 1 });
      const first = await agentOf("free").post("/backtests").send(base).expect(202);
      await agentOf("free").post("/backtests").send(base).expect(403);

      await prisma.backtestRun.update({
        where: { id: (first.body as { id: string }).id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });

      // No quota exists in V1, only concurrency: the next run is admitted immediately.
      await agentOf("free").post("/backtests").send(base).expect(202);
    });
  });

  // -------------------------------------------------------------------------
  // 9, 14, 15 — Monitors
  // -------------------------------------------------------------------------

  describe("active monitors", () => {
    async function monitorInputs(as: string, symbolCount = 2) {
      const list = await createList("Monitor universe", symbolCount, { as });
      return { strategyId: await createStrategyId(as), stockListId: list.id };
    }

    function createMonitor(
      as: string,
      inputs: { strategyId: string; stockListId: string },
      overrides: Record<string, unknown> = {},
    ) {
      return agentOf(as)
        .post("/monitors")
        .send({
          name: `Monitor ${randomUUID().slice(0, 8)}`,
          ...inputs,
          ...overrides,
        });
    }

    const cases: { as: string; limit: number }[] = [
      { as: "free", limit: 1 },
      { as: "starter", limit: 3 },
      { as: "pro", limit: 10 },
    ];

    for (const { as, limit } of cases) {
      it(`allows exactly ${limit} active monitors on ${as}`, async () => {
        const inputs = await monitorInputs(as);
        for (let index = 0; index < limit; index += 1) {
          await createMonitor(as, inputs).expect(201);
        }

        const rejected = await createMonitor(as, inputs).expect(403);
        expect(refusal(rejected.body).code).toBe("ENTITLEMENT_MONITOR_LIMIT");
        expect(refusal(rejected.body).limit).toBe(limit);
        expect(
          await prisma.monitor.count({ where: { userId: persona(as).userId } }),
        ).toBe(limit);
      });
    }

    it("places no quota on stored monitors, only on active ones", async () => {
      const inputs = await monitorInputs("free");
      await createMonitor("free", inputs).expect(201);
      // Disabled monitors are stored freely: the limit is on what is *active*.
      const disabled = await Promise.all([
        createMonitor("free", inputs, { enabled: false }).expect(201),
        createMonitor("free", inputs, { enabled: false }).expect(201),
        createMonitor("free", inputs, { enabled: false }).expect(201),
      ]);
      expect(
        await prisma.monitor.count({ where: { userId: persona("free").userId } }),
      ).toBe(4);

      const enabling = await agentOf("free")
        .patch(`/monitors/${(disabled[0]?.body as { id: string }).id}`)
        .send({ enabled: true })
        .expect(403);
      expect(refusal(enabling.body).code).toBe("ENTITLEMENT_MONITOR_LIMIT");
    });

    it("never refuses disabling a monitor, and frees the slot when it does", async () => {
      const inputs = await monitorInputs("free");
      const first = await createMonitor("free", inputs).expect(201);
      const second = await createMonitor("free", inputs, { enabled: false }).expect(201);

      await agentOf("free")
        .patch(`/monitors/${(first.body as { id: string }).id}`)
        .send({ enabled: false })
        .expect(200);
      await agentOf("free")
        .patch(`/monitors/${(second.body as { id: string }).id}`)
        .send({ enabled: true })
        .expect(200);
    });

    it("does not count a monitor against its own limit when it is resaved", async () => {
      const inputs = await monitorInputs("free");
      const created = await createMonitor("free", inputs).expect(201);
      // Already enabled; re-asserting that must not be read as enabling a second one.
      await agentOf("free")
        .patch(`/monitors/${(created.body as { id: string }).id}`)
        .send({ enabled: true, name: "Renamed" })
        .expect(200);
    });
  });


  // -------------------------------------------------------------------------
  // 10, 11, 12, 13, 14, 15 — Downgrade semantics
  // -------------------------------------------------------------------------

  describe("downgrades", () => {
    const endDate = isoDaysAgo(0);

    /**
     * A PRO account carrying content no smaller plan could have created: an oversized list,
     * several strategies, a completed backtest and five enabled monitors.
     */
    async function buildProContent() {
      await setPlan("downgrade", "PRO");
      const as = "downgrade";
      const list = await createList("Wide universe", 60, { as });
      const strategyId = await createStrategyId(as);
      const monitors: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const response = await agentOf(as)
          .post("/monitors")
          .send({
            name: `Downgrade monitor ${index}`,
            strategyId,
            stockListId: list.id,
          })
          .expect(201);
        monitors.push((response.body as { id: string }).id);
      }

      const submission = {
        strategyId,
        stockListId: list.id,
        startDate: yearsBefore(endDate, 20),
        endDate,
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 10,
      };
      const run = await agentOf(as)
        .post("/backtests")
        .send(submission)
        .expect(202);
      const runId = (run.body as { id: string }).id;
      // Completed rather than queued: the rule under test is that finished work stays readable.
      await prisma.backtestRun.update({
        where: { id: runId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });

      return { list, strategyId, monitors, runId, submission };
    }

    it("deletes and truncates nothing when the plan drops", async () => {
      const content = await buildProContent();
      const userId = persona("downgrade").userId;
      const before = {
        items: await prisma.stockListItem.count({
          where: { stockListId: content.list.id },
        }),
        strategies: await prisma.strategy.count({ where: { userId } }),
        monitors: await prisma.monitor.findMany({
          where: { userId },
          select: { id: true, enabled: true },
          orderBy: { id: "asc" },
        }),
        runs: await prisma.backtestRun.count({ where: { userId } }),
      };
      expect(before.items).toBe(60);

      await setPlan("downgrade", "FREE");

      expect(
        await prisma.stockListItem.count({
          where: { stockListId: content.list.id },
        }),
      ).toBe(60);
      expect(await prisma.strategy.count({ where: { userId } })).toBe(
        before.strategies,
      );
      expect(await prisma.backtestRun.count({ where: { userId } })).toBe(
        before.runs,
      );
      // Every Monitor survives, and every `enabled` value with it.
      expect(
        await prisma.monitor.findMany({
          where: { userId },
          select: { id: true, enabled: true },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before.monitors);
      expect(before.monitors.every((row) => row.enabled)).toBe(true);
    });

    it("keeps an oversized list readable and reports it as over the limit", async () => {
      const content = await buildProContent();
      await setPlan("downgrade", "FREE");

      const response = await agentOf("downgrade")
        .get(`/lists/${content.list.id}`)
        .expect(200);
      const list = response.body as StockListDetailResponse;
      expect(list.items).toHaveLength(60);
      expect(list.compliance).toEqual({
        symbolCount: 60,
        symbolLimit: 10,
        compliant: false,
      });
    });

    it("allows corrective removals and renames on an oversized list, and refuses additions", async () => {
      const content = await buildProContent();
      await setPlan("downgrade", "FREE");
      const itemId = content.list.items[0]?.id ?? "";

      await agentOf("downgrade")
        .patch(`/lists/${content.list.id}`)
        .send({ name: "Renamed while over the limit" })
        .expect(200);
      await agentOf("downgrade")
        .delete(`/lists/${content.list.id}/items/${itemId}`)
        .expect(204);
      expect(
        await prisma.stockListItem.count({
          where: { stockListId: content.list.id },
        }),
      ).toBe(59);

      const rejected = await agentOf("downgrade")
        .post(`/lists/${content.list.id}/items`)
        .send({ securityIds: [securityIds[70]] })
        .expect(403);
      expect(refusal(rejected.body).code).toBe("ENTITLEMENT_LIST_SYMBOL_LIMIT");
      expect(
        await prisma.stockListItem.count({
          where: { stockListId: content.list.id },
        }),
      ).toBe(59);
    });

    it("keeps a completed backtest readable but refuses to rerun its configuration", async () => {
      const content = await buildProContent();
      await setPlan("downgrade", "FREE");

      const detail = await agentOf("downgrade")
        .get(`/backtests/${content.runId}`)
        .expect(200);
      expect((detail.body as { status: string }).status).toBe("COMPLETED");
      await agentOf("downgrade")
        .get(`/backtests/${content.runId}/strategy`)
        .expect(200);
      await agentOf("downgrade")
        .get(`/backtests/${content.runId}/progress`)
        .expect(200);
      const listed = await agentOf("downgrade").get("/backtests").expect(200);
      expect(
        (listed.body as { id: string }[]).map((row) => row.id),
      ).toContain(content.runId);

      // Rerunning the identical configuration is a *new* operation and is validated afresh. Depth
      // is decidable from the submitted period alone, so it is checked before anything is read —
      // which is why a configuration violating both bounds reports the depth one.
      const rerun = await agentOf("downgrade")
        .post("/backtests")
        .send(content.submission)
        .expect(403);
      expect(refusal(rerun.body).code).toBe("ENTITLEMENT_BACKTEST_HISTORY_LIMIT");
      expect(refusal(rerun.body).limit).toBe(5);

      // The symbol bound refuses it independently, on a period FREE allows.
      const shortPeriod = await agentOf("downgrade")
        .post("/backtests")
        .send({ ...content.submission, startDate: yearsBefore(endDate, 2) })
        .expect(403);
      expect(refusal(shortPeriod.body).code).toBe(
        "ENTITLEMENT_BACKTEST_SYMBOL_LIMIT",
      );
      expect(refusal(shortPeriod.body).limit).toBe(10);

      // Nothing about the completed run moved while all of that was refused.
      expect(
        (await prisma.backtestRun.findUniqueOrThrow({
          where: { id: content.runId },
          select: { status: true },
        })).status,
      ).toBe("COMPLETED");
    });

    it("preserves monitor intent while blocking execution deterministically", async () => {
      await buildProContent();
      await setPlan("downgrade", "FREE");

      const response = await agentOf("downgrade").get("/monitors").expect(200);
      const monitors = response.body as MonitorSummaryResponse[];
      expect(monitors).toHaveLength(5);
      // Intent is untouched: every one of them is still the user's stated `enabled`.
      expect(monitors.every((row) => row.enabled)).toBe(true);

      const ordered = [...monitors].sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
      // FREE has one active slot, and the oldest enabled Monitor holds it — but its List is now
      // over the limit too, so it is blocked for that reason rather than for capacity.
      expect(ordered[0]?.operationalStatus).toBe("BLOCKED_BY_ENTITLEMENT");
      expect(ordered[0]?.blockedReason).toBe("LIST_OVER_LIMIT");
      for (const monitor of ordered.slice(1)) {
        expect(monitor.operationalStatus).toBe("BLOCKED_BY_ENTITLEMENT");
        expect(monitor.blockedReason).toBe("MONITOR_CAPACITY");
      }
    });

    it("separates a list-compliance block from a capacity block", async () => {
      await setPlan("downgrade", "PRO");
      const wide = await createList("Wide", 60, { as: "downgrade" });
      const narrow = await createList("Narrow", 2, { as: "downgrade" });
      const strategyId = await createStrategyId("downgrade");

      const wideMonitor = await agentOf("downgrade")
        .post("/monitors")
        .send({ name: "Watches the wide list", strategyId, stockListId: wide.id })
        .expect(201);
      const narrowMonitor = await agentOf("downgrade")
        .post("/monitors")
        .send({ name: "Watches the narrow list", strategyId, stockListId: narrow.id })
        .expect(201);

      await setPlan("downgrade", "STARTER");
      const byId = new Map(
        ((await agentOf("downgrade").get("/monitors").expect(200))
          .body as MonitorSummaryResponse[]).map((row) => [row.id, row]),
      );

      // Both are inside STARTER's capacity of three; only the one watching a 60-symbol list is
      // blocked, and it names the reason a user can actually act on.
      const wideId = (wideMonitor.body as { id: string }).id;
      const narrowId = (narrowMonitor.body as { id: string }).id;
      expect(byId.get(wideId)?.operationalStatus).toBe("BLOCKED_BY_ENTITLEMENT");
      expect(byId.get(wideId)?.blockedReason).toBe("LIST_OVER_LIMIT");
      expect(byId.get(narrowId)?.operationalStatus).toBe("ACTIVE");
    });

    it("resumes blocked monitors when capacity returns, with no write of any kind", async () => {
      await setPlan("downgrade", "PRO");
      const list = await createList("Compliant universe", 4, { as: "downgrade" });
      const strategyId = await createStrategyId("downgrade");
      const created: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const response = await agentOf("downgrade")
          .post("/monitors")
          .send({
            name: `Resumable ${index}`,
            strategyId,
            stockListId: list.id,
          })
          .expect(201);
        created.push((response.body as { id: string }).id);
      }

      await setPlan("downgrade", "FREE");
      async function statuses(): Promise<Map<string, MonitorSummaryResponse>> {
        const rows = (await agentOf("downgrade").get("/monitors").expect(200))
          .body as MonitorSummaryResponse[];
        return new Map(rows.map((row) => [row.id, row]));
      }

      const ordered = [...created].sort();
      const oldest = (await prisma.monitor.findMany({
        where: { id: { in: created } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      })).map((row) => row.id);

      let byId = await statuses();
      expect(byId.get(oldest[0] ?? "")?.operationalStatus).toBe("ACTIVE");
      expect(byId.get(oldest[1] ?? "")?.operationalStatus).toBe(
        "BLOCKED_BY_ENTITLEMENT",
      );
      expect(ordered).toHaveLength(3);

      // Disabling the slot-holder hands the slot to the next one, deterministically.
      await agentOf("downgrade")
        .patch(`/monitors/${oldest[0]}`)
        .send({ enabled: false })
        .expect(200);
      byId = await statuses();
      expect(byId.get(oldest[0] ?? "")?.operationalStatus).toBe("DISABLED");
      expect(byId.get(oldest[1] ?? "")?.operationalStatus).toBe("ACTIVE");

      // And upgrading restores all of them, again without touching a row.
      await setPlan("downgrade", "PRO");
      byId = await statuses();
      expect(byId.get(oldest[1] ?? "")?.operationalStatus).toBe("ACTIVE");
      expect(byId.get(oldest[2] ?? "")?.operationalStatus).toBe("ACTIVE");
      expect(byId.get(oldest[0] ?? "")?.operationalStatus).toBe("DISABLED");
      expect(byId.get(oldest[0] ?? "")?.enabled).toBe(false);
    });

    it("re-derives compliance rather than reading a stored flag", async () => {
      await setPlan("downgrade", "PRO");
      const list = await createList("Derived", 20, { as: "downgrade" });

      await setPlan("downgrade", "FREE");
      expect(
        ((await agentOf("downgrade").get(`/lists/${list.id}`).expect(200))
          .body as StockListDetailResponse).compliance.compliant,
      ).toBe(false);

      await setPlan("downgrade", "STARTER");
      expect(
        ((await agentOf("downgrade").get(`/lists/${list.id}`).expect(200))
          .body as StockListDetailResponse).compliance,
      ).toEqual({ symbolCount: 20, symbolLimit: 50, compliant: true });
    });
  });

  // -------------------------------------------------------------------------
  // 16 — Role is never client input
  // -------------------------------------------------------------------------

  describe("the ADMIN role", () => {
    it("is reported from persisted state, independently of the commercial plan", async () => {
      const body = (await agentOf("freeAdmin").get("/entitlements").expect(200))
        .body as EntitlementsResponse;
      expect(body.plan).toBe("FREE");
      expect(body.role).toBe("ADMIN");
      expect(body.entitlements.admin.canAccessAdminSurfaces).toBe(true);
    });

    it("cannot be claimed by a registration that asks for it", async () => {
      const email = `ent-escalation-${suffix}@example.test`;
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ email, password, role: "ADMIN", plan: "PRO" })
        // No SMTP is configured for the suite, so the verification mail is reported undeliverable.
        // What matters here is the row that was written, not whether the email went out.
        .expect((response) => {
          expect([201, 202, 409, 503]).toContain(response.status);
        });

      const created = await prisma.user.findUnique({
        where: { email },
        select: { role: true, plan: true },
      });
      expect(created?.role).toBe("USER");
      expect(created?.plan).toBe("FREE");
      await prisma.user.deleteMany({ where: { email } });
    });

    it("cannot be claimed by sending a role or plan on an authenticated request", async () => {
      await agentOf("free")
        .post("/lists")
        .send({ name: "Escalation attempt", role: "ADMIN", plan: "PRO" })
        .expect(201);

      const unchanged = await prisma.user.findUniqueOrThrow({
        where: { id: persona("free").userId },
        select: { role: true, plan: true },
      });
      expect(unchanged).toEqual({ role: "USER", plan: "FREE" });

      const body = (await agentOf("free").get("/entitlements").expect(200))
        .body as EntitlementsResponse;
      expect(body.role).toBe("USER");
      expect(body.entitlements.admin.canAccessAdminSurfaces).toBe(false);
      expect(body.entitlements.lists.maxSymbols).toBe(10);
    });

    it("exposes no route that writes a plan", async () => {
      // The persisted plan moves only at the billing boundary (`changeUserPlan`). Nothing a client
      // can reach writes it, so these all fail rather than succeeding quietly.
      for (const path of ["/entitlements", "/auth/me"]) {
        await agentOf("free").post(path).send({ plan: "PRO" }).expect(404);
      }
      expect(
        (await prisma.user.findUniqueOrThrow({
          where: { id: persona("free").userId },
          select: { plan: true },
        })).plan,
      ).toBe("FREE");
    });
  });
});
