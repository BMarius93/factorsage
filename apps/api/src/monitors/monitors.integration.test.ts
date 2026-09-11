import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  STRATEGY_SCHEMA_VERSION,
  normalizeStrategyDefinition,
  type MonitorDetailResponse,
  type MonitorSummaryResponse,
  type StrategyDefinition,
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
import { MonitorsModule } from "./monitors.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> MonitorsService -> real PostgreSQL.
 *
 * The slice needs no market data: creating and configuring a Monitor references a Strategy and a
 * Stock List and nothing else, so nothing here touches FMP, Redis or the stock loader. What it does
 * exercise is ownership scoping, the two user controls, and the envelope rule that keeps a cadence
 * field from ever being accepted.
 *
 * The Strategy and Stock List fixtures are written straight through Prisma rather than through their
 * own HTTP routes. They are setup, not the behaviour under test, and compiling two more feature
 * modules into this suite would add a third of a Nest application to every parallel test run for
 * nothing. The delete-protection rule those routes enforce is covered where they live, in
 * `strategies.integration.test.ts` and `stock-lists.integration.test.ts`.
 */
describe("monitors", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  const ownerEmail = `monitor-owner-${suffix}@example.test`;
  const otherEmail = `monitor-other-${suffix}@example.test`;

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let strategyId = "";
  let stockListId = "";
  let otherStrategyId = "";
  let otherStockListId = "";

  function definition(): StrategyDefinition {
    return {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 25,
          signal: {
            conditions: [
              {
                id: "condition-1",
                metric: { kind: "PRICE" },
                operator: "IS_ABOVE",
                value: { kind: "SERIES", seriesId: "EMA_200D" },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    };
  }

  /** The definition still goes through the canonical normalizer, so the fixture cannot drift. */
  async function createStrategyRow(
    userId: string,
    name: string,
  ): Promise<string> {
    const row = await prisma.strategy.create({
      data: {
        userId,
        name,
        versions: {
          create: {
            versionNumber: 1,
            definition: normalizeStrategyDefinition(
              definition(),
            ) as unknown as object,
            definitionHash: randomUUID(),
          },
        },
      },
    });
    return row.id;
  }

  async function createMonitor(
    agent: ReturnType<typeof request.agent>,
    body: object,
  ): Promise<MonitorDetailResponse> {
    const response = await agent.post("/monitors").send(body).expect(201);
    return response.body as MonitorDetailResponse;
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
        MonitorsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: ownerEmail, passwordHash, emailVerifiedAt },
        { email: otherEmail, passwordHash, emailVerifiedAt },
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

    const ownerId = (
      await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
    ).id;
    const otherId = (
      await prisma.user.findUniqueOrThrow({ where: { email: otherEmail } })
    ).id;

    strategyId = await createStrategyRow(ownerId, "Monitor Strategy");
    otherStrategyId = await createStrategyRow(otherId, "Someone Else's Strategy");
    stockListId = (
      await prisma.stockList.create({
        data: { userId: ownerId, name: "Monitor List" },
      })
    ).id;
    otherStockListId = (
      await prisma.stockList.create({
        data: { userId: otherId, name: "Someone Else's List" },
      })
    ).id;
  });

  afterAll(async () => {
    if (prisma) {
      // Monitors, strategies and lists all cascade from the users.
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, otherEmail] } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  it("requires authentication on every route", async () => {
    const anonymous = request(app.getHttpServer());
    await anonymous.get("/monitors").expect(401);
    await anonymous.post("/monitors").send({ name: "x" }).expect(401);
    await anonymous.get("/monitors/any-id").expect(401);
    await anonymous.patch("/monitors/any-id").send({ enabled: false }).expect(401);
    await anonymous.delete("/monitors/any-id").expect(401);
  });

  it("creates an enabled monitor by default", async () => {
    const monitor = await createMonitor(owner, {
      name: "Value Watch",
      strategyId,
      stockListId,
    });

    expect(monitor.name).toBe("Value Watch");
    expect(monitor.enabled).toBe(true);
    expect(monitor.strategyId).toBe(strategyId);
    expect(monitor.stockListId).toBe(stockListId);
    expect(monitor.signals).toEqual([]);
    expect(monitor.activeSignalCount).toBe(0);
    expect(monitor.lastScanAt).toBeUndefined();
  });

  it("creates a disabled monitor when asked", async () => {
    const monitor = await createMonitor(owner, {
      name: "Paused Watch",
      strategyId,
      stockListId,
      enabled: false,
    });
    expect(monitor.enabled).toBe(false);
  });

  it("enables and disables a monitor", async () => {
    const monitor = await createMonitor(owner, {
      name: "Toggle Watch",
      strategyId,
      stockListId,
    });

    const disabled = await owner
      .patch(`/monitors/${monitor.id}`)
      .send({ enabled: false })
      .expect(200);
    expect((disabled.body as MonitorSummaryResponse).enabled).toBe(false);

    const enabled = await owner
      .patch(`/monitors/${monitor.id}`)
      .send({ enabled: true })
      .expect(200);
    expect((enabled.body as MonitorSummaryResponse).enabled).toBe(true);
  });

  it("keeps persisted transition state across a disable and re-enable", async () => {
    const monitor = await createMonitor(owner, {
      name: "Resume Watch",
      strategyId,
      stockListId,
    });

    const security = await prisma.security.create({
      data: {
        providerSymbol: `RESUME.${suffix.slice(0, 8)}`,
        symbol: `RSM${suffix.slice(0, 4).toUpperCase()}`,
        name: "Resume Test",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    await prisma.monitorSignalState.create({
      data: {
        monitorId: monitor.id,
        securityId: security.id,
        levelId: "buy-1",
        levelKind: "BUY",
        signalFingerprint: "fingerprint-a",
        lastEvaluableResult: "MATCHED",
        lastEvaluableDate: new Date("2026-03-02T00:00:00.000Z"),
        lastEvaluableAt: new Date(),
        lastOutcome: "MATCHED",
        lastOutcomeAt: new Date(),
      },
    });

    await owner
      .patch(`/monitors/${monitor.id}`)
      .send({ enabled: false })
      .expect(200);
    await owner
      .patch(`/monitors/${monitor.id}`)
      .send({ enabled: true })
      .expect(200);

    // Disabling stops future evaluations and nothing else: re-enabling resumes with the trigger
    // semantics intact rather than treating an already-matched condition as newly matched.
    const state = await prisma.monitorSignalState.findFirstOrThrow({
      where: { monitorId: monitor.id },
    });
    expect(state.lastEvaluableResult).toBe("MATCHED");

    await prisma.monitorSignalState.deleteMany({
      where: { monitorId: monitor.id },
    });
    await prisma.monitor.delete({ where: { id: monitor.id } });
    await prisma.security.delete({ where: { id: security.id } });
  });

  it("renames a monitor", async () => {
    const monitor = await createMonitor(owner, {
      name: "Before",
      strategyId,
      stockListId,
    });
    const renamed = await owner
      .patch(`/monitors/${monitor.id}`)
      .send({ name: "After" })
      .expect(200);
    expect((renamed.body as MonitorSummaryResponse).name).toBe("After");
  });

  it("rejects a cadence field rather than ignoring it", async () => {
    // Monitoring cadence is an application decision. A silently ignored field would look to a
    // client exactly like a supported one.
    for (const body of [
      { name: "x", strategyId, stockListId, intervalMs: 60_000 },
      { name: "x", strategyId, stockListId, cadence: "hourly" },
      { name: "x", strategyId, stockListId, scanFrequency: 5 },
    ]) {
      await owner.post("/monitors").send(body).expect(400);
    }
    await owner
      .patch("/monitors/any-id")
      .send({ intervalMs: 60_000 })
      .expect(400);
  });

  it("rejects a monitor over a strategy or a stock list the caller does not own", async () => {
    // Both references are checked against the caller, and a foreign row must be indistinguishable
    // from one that does not exist: the rejection is the same body as for an unknown id.
    const unknownStrategy = await owner
      .post("/monitors")
      .send({ name: "Borrowed", strategyId: randomUUID(), stockListId })
      .expect(400);
    const foreignStrategy = await owner
      .post("/monitors")
      .send({ name: "Borrowed", strategyId: otherStrategyId, stockListId })
      .expect(400);
    expect(foreignStrategy.body).toEqual(unknownStrategy.body);

    const unknownList = await owner
      .post("/monitors")
      .send({ name: "Borrowed", strategyId, stockListId: randomUUID() })
      .expect(400);
    const foreignList = await owner
      .post("/monitors")
      .send({ name: "Borrowed", strategyId, stockListId: otherStockListId })
      .expect(400);
    expect(foreignList.body).toEqual(unknownList.body);

    // Nothing was created for either owner.
    expect(
      await prisma.monitor.count({
        where: { OR: [{ stockListId: otherStockListId }, { strategyId: otherStrategyId }] },
      }),
    ).toBe(0);
  });

  it("requires a name, a strategy and a stock list", async () => {
    await owner.post("/monitors").send({ strategyId, stockListId }).expect(400);
    await owner.post("/monitors").send({ name: "x", stockListId }).expect(400);
    await owner.post("/monitors").send({ name: "x", strategyId }).expect(400);
    await owner
      .post("/monitors")
      .send({ name: "   ", strategyId, stockListId })
      .expect(400);
  });

  it("requires at least one field to update", async () => {
    const monitor = await createMonitor(owner, {
      name: "Patch Watch",
      strategyId,
      stockListId,
    });
    await owner.patch(`/monitors/${monitor.id}`).send({}).expect(400);
  });

  it("hides another user's monitor exactly like one that does not exist", async () => {
    const monitor = await createMonitor(owner, {
      name: "Private Watch",
      strategyId,
      stockListId,
    });

    await other.get(`/monitors/${monitor.id}`).expect(404);
    await other.patch(`/monitors/${monitor.id}`).send({ enabled: false }).expect(404);
    await other.delete(`/monitors/${monitor.id}`).expect(404);
    await other.get(`/monitors/${randomUUID()}`).expect(404);

    // And the owner still has it, untouched.
    const still = await owner.get(`/monitors/${monitor.id}`).expect(200);
    expect((still.body as MonitorDetailResponse).enabled).toBe(true);
  });

  it("lists only the caller's own monitors", async () => {
    const mine = await createMonitor(owner, {
      name: "Listed Watch",
      strategyId,
      stockListId,
    });

    const ownerList = await owner.get("/monitors").expect(200);
    expect(
      (ownerList.body as MonitorSummaryResponse[]).map((row) => row.id),
    ).toContain(mine.id);

    const otherList = await other.get("/monitors").expect(200);
    expect(
      (otherList.body as MonitorSummaryResponse[]).map((row) => row.id),
    ).not.toContain(mine.id);
  });

  it("deletes a monitor", async () => {
    const monitor = await createMonitor(owner, {
      name: "Doomed Watch",
      strategyId,
      stockListId,
    });
    await owner.delete(`/monitors/${monitor.id}`).expect(204);
    await owner.get(`/monitors/${monitor.id}`).expect(404);
  });
});
