import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  newYorkDate,
  STRATEGY_SCHEMA_VERSION,
  type StockListSummaryResponse,
  type StrategyDefinition,
  type StrategySummaryResponse,
  type UserPlan,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BacktestsModule } from "../backtests/backtests.module";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { EMAIL_SENDER } from "../email/email-sender";
import { InMemoryEmailSender } from "../email/in-memory-email-sender";
import { ListsModule } from "../lists/lists.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { StrategiesModule } from "../strategies/strategies.module";
import { EntitlementsModule } from "./entitlements.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * Premium built-in content (`docs/decisions/entitlements-v2.md` §6), over HTTP against real
 * PostgreSQL: premium predefined Lists and Strategies are *named* to every viewer but read in full,
 * backtested and duplicated only on a plan that includes premium content — Pro and Pro+.
 *
 * Every gate is asserted at the canonical server boundary with a hand-written request, because a UI
 * that hid a button would prove nothing.
 */
describe("premium built-in content", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  let app: INestApplication;
  let prisma: PrismaService;
  let anonymous: ReturnType<typeof request.agent>;

  const agents = new Map<string, ReturnType<typeof request.agent>>();
  const userIds: string[] = [];
  const securityIds: string[] = [];
  let premiumListId = "";
  let standardListId = "";
  let premiumStrategyId = "";

  function agentOf(name: string) {
    const agent = agents.get(name);
    if (!agent) {
      throw new Error(`Unknown persona ${name}`);
    }
    return agent;
  }

  function definition(): StrategyDefinition {
    return {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: `buy-${randomUUID()}`,
          percentage: 25,
          signal: {
            conditions: [
              {
                id: `condition-${randomUUID()}`,
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

  function refusalCode(body: unknown): string | undefined {
    return (body as { code?: string }).code;
  }

  async function submission(as: string, overrides: Record<string, unknown>) {
    const endDate = newYorkDate(new Date());
    const start = new Date(`${endDate}T00:00:00.000Z`);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    const list = await agentOf(as)
      .post("/lists")
      .send({ name: `Own ${randomUUID().slice(0, 8)}`, securityIds: securityIds.slice(0, 2) })
      .expect(201);
    const strategy = await agentOf(as)
      .post("/strategies")
      .send({ name: `Own ${randomUUID().slice(0, 8)}`, definition: definition() })
      .expect(201);
    return {
      strategyId: (strategy.body as { id: string }).id,
      stockListId: (list.body as { id: string }).id,
      startDate: start.toISOString().slice(0, 10),
      endDate,
      initialCapital: 100_000,
      monthlyContribution: 0,
      maximumPositions: 10,
      ...overrides,
    };
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET = "test-only-jwt-secret-that-is-at-least-32-characters";
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
    })
      .overrideProvider(EMAIL_SENDER)
      .useValue(new InMemoryEmailSender())
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);

    const personas: { name: string; plan: UserPlan }[] = [
      { name: "free", plan: "FREE" },
      { name: "starter", plan: "STARTER" },
      { name: "pro", plan: "PRO" },
      { name: "proplus", plan: "PRO_PLUS" },
    ];
    for (const persona of personas) {
      const email = `premium-${persona.name}-${suffix}@example.test`;
      const user = await prisma.user.create({
        data: { email, passwordHash, emailVerifiedAt: new Date(), plan: persona.plan },
        select: { id: true },
      });
      userIds.push(user.id);
      const agent = request.agent(app.getHttpServer());
      await agent.post("/auth/login").send({ email, password }).expect(200);
      agents.set(persona.name, agent);
    }
    anonymous = request.agent(app.getHttpServer());

    for (let index = 0; index < 3; index += 1) {
      const security = await prisma.security.create({
        data: {
          providerSymbol: `PREM${index}-${suffix}`,
          symbol: `PREM${index}-${suffix.slice(0, 6).toUpperCase()}`,
          name: `Premium Fixture ${index}`,
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

    const premiumList = await prisma.stockList.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `premium-list-${suffix}`,
        name: "Premium Fixture List",
        description: "A premium predefined list",
        displayOrder: 90,
        premium: true,
        items: { create: securityIds.map((securityId) => ({ securityId })) },
      },
      select: { id: true },
    });
    premiumListId = premiumList.id;
    const standardList = await prisma.stockList.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `standard-list-${suffix}`,
        name: "Standard Fixture List",
        displayOrder: 91,
        items: { create: securityIds.map((securityId) => ({ securityId })) },
      },
      select: { id: true },
    });
    standardListId = standardList.id;
    const premiumStrategy = await prisma.strategy.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `premium-strategy-${suffix}`,
        name: "Premium Fixture Strategy",
        displayOrder: 90,
        premium: true,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition() as never,
            definitionHash: `premium-${suffix}`,
          },
        },
      },
      select: { id: true },
    });
    premiumStrategyId = premiumStrategy.id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.backtestRun.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.stockList.deleteMany({
        where: { id: { in: [premiumListId, standardListId].filter(Boolean) } },
      });
      if (premiumStrategyId) {
        await prisma.strategy.delete({ where: { id: premiumStrategyId } });
      }
      await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    }
    if (app) {
      await app.close();
    }
  });

  it("only lets a SYSTEM row be premium", async () => {
    // The CHECK constraint behind §6: a customer's content can never carry the flag.
    await expect(
      prisma.stockList.create({
        data: { userId: userIds[0]!, name: "Not allowed", premium: true },
      }),
    ).rejects.toThrow();
  });

  it("names a premium List to everyone and marks it locked where the plan lacks premium content", async () => {
    for (const [viewer, locked] of [
      [anonymous, true],
      [agentOf("free"), true],
      [agentOf("starter"), true],
      [agentOf("pro"), false],
      [agentOf("proplus"), false],
    ] as const) {
      const lists = (await viewer.get("/lists").expect(200)).body as StockListSummaryResponse[];
      const premium = lists.find((list) => list.id === premiumListId);
      expect(premium?.premium).toBe(true);
      expect(premium?.itemCount).toBe(3);
      expect(premium?.locked).toBe(locked ? true : undefined);
      const standard = lists.find((list) => list.id === standardListId);
      expect(standard?.premium).toBeUndefined();
      expect(standard?.locked).toBeUndefined();
    }
  });

  it("withholds a premium List's members from Guest, Free and Starter, and shows them to Pro and Pro+", async () => {
    for (const viewer of [anonymous, agentOf("free"), agentOf("starter")]) {
      const refused = await viewer.get(`/lists/${premiumListId}`).expect(403);
      expect(refusalCode(refused.body)).toBe("ENTITLEMENT_PREMIUM_CONTENT");
      expect(JSON.stringify(refused.body)).not.toContain(securityIds[0]!);
    }
    for (const as of ["pro", "proplus"]) {
      const detail = await agentOf(as).get(`/lists/${premiumListId}`).expect(200);
      expect((detail.body as { items: unknown[] }).items).toHaveLength(3);
      expect((detail.body as { premium?: boolean }).premium).toBe(true);
    }
    // A standard built-in stays readable by everyone, Guests included.
    await anonymous.get(`/lists/${standardListId}`).expect(200);
  });

  it("refuses to copy a premium List below Pro, and the copy a Pro user makes is ordinary content", async () => {
    for (const as of ["free", "starter"]) {
      const refused = await agentOf(as)
        .post(`/lists/${premiumListId}/duplicate`)
        .send({ name: "Copy" })
        .expect(403);
      expect(refusalCode(refused.body)).toBe("ENTITLEMENT_PREMIUM_CONTENT");
    }
    const copy = await agentOf("pro")
      .post(`/lists/${premiumListId}/duplicate`)
      .send({ name: `Pro copy ${suffix.slice(0, 6)}` })
      .expect(201);
    const body = copy.body as { ownership: string; premium?: boolean; items: unknown[] };
    expect(body.ownership).toBe("USER");
    expect(body.premium).toBeUndefined();
    expect(body.items).toHaveLength(3);
  });

  it("withholds a premium Strategy's rules and refuses copying it below Pro", async () => {
    const summaries = (await agentOf("free").get("/strategies").expect(200))
      .body as StrategySummaryResponse[];
    const named = summaries.find((strategy) => strategy.id === premiumStrategyId);
    expect(named?.premium).toBe(true);
    expect(named?.locked).toBe(true);
    expect(named?.buyLevelCount).toBe(1);

    for (const viewer of [anonymous, agentOf("free"), agentOf("starter")]) {
      const refused = await viewer.get(`/strategies/${premiumStrategyId}`).expect(403);
      expect(refusalCode(refused.body)).toBe("ENTITLEMENT_PREMIUM_CONTENT");
    }
    await agentOf("pro").get(`/strategies/${premiumStrategyId}`).expect(200);
    await agentOf("proplus").get(`/strategies/${premiumStrategyId}`).expect(200);

    const refusedCopy = await agentOf("starter")
      .post(`/strategies/${premiumStrategyId}/duplicate`)
      .send({ name: "Copy" })
      .expect(403);
    expect(refusalCode(refusedCopy.body)).toBe("ENTITLEMENT_PREMIUM_CONTENT");
    const copy = await agentOf("proplus")
      .post(`/strategies/${premiumStrategyId}/duplicate`)
      .send({ name: `Pro+ copy ${suffix.slice(0, 6)}` })
      .expect(201);
    expect((copy.body as { ownership: string }).ownership).toBe("USER");
  });

  it("refuses a backtest of premium content below Pro, before anything is queued", async () => {
    for (const as of ["free", "starter"]) {
      const withPremiumStrategy = await agentOf(as)
        .post("/backtests")
        .send(await submission(as, { strategyId: premiumStrategyId }))
        .expect(403);
      expect(refusalCode(withPremiumStrategy.body)).toBe("ENTITLEMENT_PREMIUM_CONTENT");
      const withPremiumList = await agentOf(as)
        .post("/backtests")
        .send(await submission(as, { stockListId: premiumListId }))
        .expect(403);
      expect(refusalCode(withPremiumList.body)).toBe("ENTITLEMENT_PREMIUM_CONTENT");
    }
    expect(
      await prisma.backtestRun.count({
        where: { userId: { in: userIds.slice(0, 2) } },
      }),
    ).toBe(0);

    await agentOf("pro")
      .post("/backtests")
      .send(
        await submission("pro", {
          strategyId: premiumStrategyId,
          stockListId: premiumListId,
        }),
      )
      .expect(202);
  });
});
