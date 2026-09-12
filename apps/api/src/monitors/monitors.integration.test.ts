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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  /** A second Strategy and Stock List the owner also owns: what a rebind moves the Monitor onto. */
  let secondStrategyId = "";
  let secondStockListId = "";

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
    document: StrategyDefinition = definition(),
  ): Promise<string> {
    const row = await prisma.strategy.create({
      data: {
        userId,
        name,
        versions: {
          create: {
            versionNumber: 1,
            definition: normalizeStrategyDefinition(
              document,
            ) as unknown as object,
            definitionHash: randomUUID(),
          },
        },
      },
    });
    return row.id;
  }

  /**
   * The canonical BUY level plus one exit level built on a position metric.
   *
   * `Gain` and `Loss` are refused in a BUY level by the grammar — they depend on an open position —
   * so an exit level is the only shape they can legally take, which is exactly the shape a Monitor
   * has to cope with. Everything goes through `normalizeStrategyDefinition`, so the fixture cannot
   * claim the product accepts something it does not.
   */
  function definitionWithPositionExit(
    metric: "GAIN" | "LOSS",
  ): StrategyDefinition {
    return {
      ...definition(),
      sellLevels: [
        {
          id: "sell-1",
          percentage: 25,
          signal: {
            conditions: [
              {
                id: "exit-1",
                metric: { kind: metric },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 20 },
              },
            ],
          },
        },
      ],
    } as StrategyDefinition;
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
    // PRO, and cleaned up after every test (see the `afterEach`), so this suite exercises Monitor
    // semantics rather than a plan's active-Monitor capacity. Entitlement enforcement has its own
    // suite; a fixture left on the default plan would make a capacity refusal look like a Monitor
    // bug in thirty unrelated tests.
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
    secondStrategyId = await createStrategyRow(ownerId, "Second Strategy");
    secondStockListId = (
      await prisma.stockList.create({
        data: { userId: ownerId, name: "Second List" },
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

  // Monitors accumulate otherwise: nothing in this suite deletes what it created, and thirty-odd
  // enabled Monitors on one account is past every plan's active capacity. Signals and transition
  // state cascade with the Monitor row, and no test depends on another test's Monitors.
  afterEach(async () => {
    if (prisma) {
      await prisma.monitor.deleteMany({
        where: { user: { email: { in: [ownerEmail, otherEmail] } } },
      });
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

  /**
   * Rebinding: pointing a Monitor at a *different* Strategy or Stock List.
   *
   * Deliberately not the same thing as editing the contents of the ones it already references,
   * which is live and needs no request. A rebind crosses a configuration boundary, and everything
   * below pins what that means: ownership is re-checked, the state left behind is discarded, the
   * Signals it produced survive as history but stop being active, and the new configuration is
   * honestly reported as not yet checked.
   */
  describe("rebinding a monitor", () => {
    let securityIndex = 0;

    async function createSecurityRow(tag: string) {
      securityIndex += 1;
      return prisma.security.create({
        data: {
          providerSymbol: `${tag}${securityIndex}.${suffix.slice(0, 8)}`,
          symbol: `${tag}${securityIndex}${suffix.slice(0, 3).toUpperCase()}`,
          name: `${tag} Test`,
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
      });
    }

    /** A matched level: one active Signal plus the transition state pointing at it. */
    async function seedMatch(monitorId: string, securityId: string) {
      const signal = await prisma.monitorSignal.create({
        data: {
          monitorId,
          securityId,
          levelId: "buy-1",
          levelKind: "BUY",
          strategyVersionId: "version-1",
          hasTrigger: false,
          observationDate: new Date("2026-03-02T00:00:00.000Z"),
          observationPrice: "150.25",
          detectedAt: new Date("2026-03-02T15:00:00.000Z"),
        },
      });
      await prisma.monitorSignalState.create({
        data: {
          monitorId,
          securityId,
          levelId: "buy-1",
          levelKind: "BUY",
          signalFingerprint: "fingerprint-a",
          lastEvaluableResult: "MATCHED",
          lastEvaluableDate: new Date("2026-03-02T00:00:00.000Z"),
          lastEvaluableAt: new Date(),
          lastOutcome: "MATCHED",
          lastOutcomeAt: new Date(),
          activeSignalId: signal.id,
        },
      });
      return signal;
    }

    async function bindingOf(monitorId: string) {
      return prisma.monitor.findUniqueOrThrow({
        where: { id: monitorId },
        select: {
          strategyId: true,
          stockListId: true,
          configVersion: true,
          lastScanAt: true,
        },
      });
    }

    it("moves the monitor onto another strategy", async () => {
      const monitor = await createMonitor(owner, {
        name: "Rebind Strategy",
        strategyId,
        stockListId,
      });

      const response = await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ strategyId: secondStrategyId })
        .expect(200);

      expect((response.body as MonitorSummaryResponse).strategyId).toBe(
        secondStrategyId,
      );
      expect((response.body as MonitorSummaryResponse).strategyName).toBe(
        "Second Strategy",
      );
      const binding = await bindingOf(monitor.id);
      expect(binding.strategyId).toBe(secondStrategyId);
      // The list it was not asked to change is untouched.
      expect(binding.stockListId).toBe(stockListId);
      expect(binding.configVersion).toBe(1);
    });

    it("moves the monitor onto another stock list", async () => {
      const monitor = await createMonitor(owner, {
        name: "Rebind List",
        strategyId,
        stockListId,
      });

      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ stockListId: secondStockListId })
        .expect(200);

      const binding = await bindingOf(monitor.id);
      expect(binding.stockListId).toBe(secondStockListId);
      expect(binding.strategyId).toBe(strategyId);
      expect(binding.configVersion).toBe(1);
    });

    it("moves both, and a name with them, in one request", async () => {
      const monitor = await createMonitor(owner, {
        name: "Rebind Both",
        strategyId,
        stockListId,
      });

      const response = await owner
        .patch(`/monitors/${monitor.id}`)
        .send({
          name: "Renamed And Rebound",
          strategyId: secondStrategyId,
          stockListId: secondStockListId,
          enabled: false,
        })
        .expect(200);

      const summary = response.body as MonitorSummaryResponse;
      expect(summary.name).toBe("Renamed And Rebound");
      expect(summary.enabled).toBe(false);
      const binding = await bindingOf(monitor.id);
      expect(binding.strategyId).toBe(secondStrategyId);
      expect(binding.stockListId).toBe(secondStockListId);
      // One boundary crossed, however many references moved with it.
      expect(binding.configVersion).toBe(1);
    });

    it("refuses a strategy the caller does not own", async () => {
      const monitor = await createMonitor(owner, {
        name: "Foreign Strategy Rebind",
        strategyId,
        stockListId,
      });

      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ strategyId: otherStrategyId })
        .expect(400);

      // Nothing moved, including the generation: a refused rebind is not a boundary.
      const binding = await bindingOf(monitor.id);
      expect(binding.strategyId).toBe(strategyId);
      expect(binding.configVersion).toBe(0);
    });

    it("refuses a stock list the caller does not own", async () => {
      const monitor = await createMonitor(owner, {
        name: "Foreign List Rebind",
        strategyId,
        stockListId,
      });

      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ stockListId: otherStockListId })
        .expect(400);

      const binding = await bindingOf(monitor.id);
      expect(binding.stockListId).toBe(stockListId);
      expect(binding.configVersion).toBe(0);
    });

    it("refuses references that do not exist at all", async () => {
      const monitor = await createMonitor(owner, {
        name: "Missing Reference Rebind",
        strategyId,
        stockListId,
      });

      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ strategyId: randomUUID() })
        .expect(400);
      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ stockListId: randomUUID() })
        .expect(400);
      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ strategyId: "" })
        .expect(400);

      expect((await bindingOf(monitor.id)).configVersion).toBe(0);
    });

    it("cannot rebind another user's monitor", async () => {
      const monitor = await createMonitor(owner, {
        name: "Isolated Rebind",
        strategyId,
        stockListId,
      });

      // The other user owns `otherStrategyId`, so this fails on the monitor, not the reference:
      // a monitor that is not yours is indistinguishable from one that does not exist.
      await other
        .patch(`/monitors/${monitor.id}`)
        .send({ strategyId: otherStrategyId })
        .expect(404);

      const binding = await bindingOf(monitor.id);
      expect(binding.strategyId).toBe(strategyId);
      expect(binding.configVersion).toBe(0);
    });

    it("leaves evaluation state alone for a name-only or enabled-only edit", async () => {
      const security = await createSecurityRow("NAM");
      const monitor = await createMonitor(owner, {
        name: "Identity Only",
        strategyId,
        stockListId,
      });
      const signal = await seedMatch(monitor.id, security.id);
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { lastScanAt: new Date("2026-03-02T15:00:00.000Z") },
      });

      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ name: "Identity Renamed" })
        .expect(200);
      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ enabled: false })
        .expect(200);

      const state = await prisma.monitorSignalState.findFirstOrThrow({
        where: { monitorId: monitor.id },
      });
      expect(state.activeSignalId).toBe(signal.id);
      expect(state.lastEvaluableResult).toBe("MATCHED");
      expect(
        (await prisma.monitorSignal.findUniqueOrThrow({
          where: { id: signal.id },
        })).resolvedAt,
      ).toBeNull();
      const binding = await bindingOf(monitor.id);
      expect(binding.configVersion).toBe(0);
      expect(binding.lastScanAt).not.toBeNull();

      await prisma.monitor.delete({ where: { id: monitor.id } });
      await prisma.security.delete({ where: { id: security.id } });
    });

    it("leaves evaluation state alone when the same references are resubmitted", async () => {
      const security = await createSecurityRow("SAM");
      const monitor = await createMonitor(owner, {
        name: "Same References",
        strategyId,
        stockListId,
      });
      const signal = await seedMatch(monitor.id, security.id);
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { lastScanAt: new Date("2026-03-02T15:00:00.000Z") },
      });

      // What an edit form submits when the user only touched the name: every field, including the
      // Strategy and List it was prepopulated with. Presence of the key is not a rebind.
      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({
          name: "Same References Renamed",
          strategyId,
          stockListId,
          enabled: true,
        })
        .expect(200);

      const state = await prisma.monitorSignalState.findFirstOrThrow({
        where: { monitorId: monitor.id },
      });
      expect(state.activeSignalId).toBe(signal.id);
      const binding = await bindingOf(monitor.id);
      expect(binding.configVersion).toBe(0);
      expect(binding.lastScanAt).not.toBeNull();

      await prisma.monitor.delete({ where: { id: monitor.id } });
      await prisma.security.delete({ where: { id: security.id } });
    });

    it("discards state, closes active signals and keeps their history on a rebind", async () => {
      const security = await createSecurityRow("REB");
      const monitor = await createMonitor(owner, {
        name: "Boundary",
        strategyId,
        stockListId,
      });
      const signal = await seedMatch(monitor.id, security.id);
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { lastScanAt: new Date("2026-03-02T15:00:00.000Z") },
      });

      await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ strategyId: secondStrategyId })
        .expect(200);

      // The latch is gone: nothing from the replaced configuration can decide an edge in the new one.
      expect(
        await prisma.monitorSignalState.count({
          where: { monitorId: monitor.id },
        }),
      ).toBe(0);
      // The Signal survives — a Signal records what was observed — but it is no longer active.
      const persisted = await prisma.monitorSignal.findUniqueOrThrow({
        where: { id: signal.id },
      });
      expect(persisted.resolvedAt).not.toBeNull();
      expect(Number(persisted.observationPrice)).toBeCloseTo(150.25);
      // And the new configuration is honestly reported as unchecked.
      const binding = await bindingOf(monitor.id);
      expect(binding.lastScanAt).toBeNull();
      expect(binding.configVersion).toBe(1);

      const detail = await owner.get(`/monitors/${monitor.id}`).expect(200);
      const body = detail.body as MonitorDetailResponse;
      expect(body.activeSignalCount).toBe(0);
      expect(body.lastScanAt).toBeUndefined();
      // History is still readable, marked resolved.
      expect(body.signals).toHaveLength(1);
      expect(body.signals[0]?.resolvedAt).toBeDefined();

      await prisma.monitor.delete({ where: { id: monitor.id } });
      await prisma.security.delete({ where: { id: security.id } });
    });
  });

  /**
   * The detail response's current-evaluation table.
   *
   * Every status is a projection of what the worker actually recorded. The point of these cases is
   * that the four are genuinely distinguished — a security nothing decided must never read as a
   * decided non-match.
   */
  describe("current evaluation summary", () => {
    it("reports each security as its durable state actually says", async () => {
      const evaluationSecurity = (tag: string, index: number) =>
        prisma.security.create({
          data: {
            providerSymbol: `EVAL${index}.${suffix.slice(0, 8)}`,
            symbol: `${tag}${suffix.slice(0, 3).toUpperCase()}`,
            name: `${tag} Evaluation`,
            exchangeCode: "NASDAQ",
            currency: "USD",
            type: "STOCK",
            isAdr: false,
            isActivelyTrading: true,
          },
        });
      const matched = await evaluationSecurity("AAA", 0);
      const missed = await evaluationSecurity("BBB", 1);
      const undecidable = await evaluationSecurity("CCC", 2);
      const fresh = await evaluationSecurity("DDD", 3);
      const ownerId = (
        await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
      ).id;
      const listId = (
        await prisma.stockList.create({
          data: {
            userId: ownerId,
            name: "Evaluation List",
            items: {
              create: [matched, missed, undecidable, fresh].map((security) => ({
                securityId: security.id,
              })),
            },
          },
        })
      ).id;
      const monitor = await createMonitor(owner, {
        name: "Evaluation",
        strategyId,
        stockListId: listId,
      });

      const decidedAt = new Date("2026-03-02T15:00:00.000Z");
      const signal = await prisma.monitorSignal.create({
        data: {
          monitorId: monitor.id,
          securityId: matched.id,
          levelId: "buy-1",
          levelKind: "BUY",
          strategyVersionId: "version-1",
          hasTrigger: true,
          observationDate: new Date("2026-03-02T00:00:00.000Z"),
          observationPrice: "212.50",
          detectedAt: decidedAt,
        },
      });
      await prisma.monitorSignalState.createMany({
        data: [
          {
            monitorId: monitor.id,
            securityId: matched.id,
            levelId: "buy-1",
            levelKind: "BUY",
            signalFingerprint: "fingerprint-a",
            lastEvaluableResult: "MATCHED",
            lastEvaluableDate: new Date("2026-03-02T00:00:00.000Z"),
            lastEvaluableAt: decidedAt,
            lastOutcome: "MATCHED",
            lastOutcomeAt: decidedAt,
            activeSignalId: signal.id,
          },
          {
            monitorId: monitor.id,
            securityId: missed.id,
            levelId: "buy-1",
            levelKind: "BUY",
            signalFingerprint: "fingerprint-a",
            lastEvaluableResult: "NOT_MATCHED",
            lastEvaluableDate: new Date("2026-03-02T00:00:00.000Z"),
            lastEvaluableAt: decidedAt,
            lastOutcome: "NOT_MATCHED",
            lastOutcomeAt: decidedAt,
          },
          {
            monitorId: monitor.id,
            securityId: undecidable.id,
            levelId: "buy-1",
            levelKind: "BUY",
            signalFingerprint: "fingerprint-a",
            // The latch is whatever it last decided; the *outcome* is what could not be decided
            // now, and that is what the table must report.
            lastEvaluableResult: "NOT_MATCHED",
            lastEvaluableDate: new Date("2026-03-02T00:00:00.000Z"),
            lastEvaluableAt: decidedAt,
            lastOutcome: "NOT_EVALUABLE",
            lastOutcomeAt: decidedAt,
          },
        ],
      });
      // `fresh` deliberately has no state at all, and the Monitor has been scanned — but it joined
      // the List afterwards, so no cycle has reached it.
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { lastScanAt: new Date("2026-03-01T15:00:00.000Z") },
      });

      const response = await owner.get(`/monitors/${monitor.id}`).expect(200);
      const body = response.body as MonitorDetailResponse;
      const status = new Map(
        body.securities.map((entry) => [entry.security.id, entry]),
      );

      expect(status.get(matched.id)?.status).toBe("MATCHED");
      expect(status.get(missed.id)?.status).toBe("NO_MATCH");
      expect(status.get(undecidable.id)?.status).toBe("NOT_EVALUABLE");
      expect(status.get(fresh.id)?.status).toBe("NOT_CHECKED");

      // A match explains itself through the Signal it points at, not a second concept.
      const level = status.get(matched.id)?.matchedLevels[0];
      expect(level?.levelKind).toBe("BUY");
      expect(level?.kind).toBe("TRIGGER");
      expect(level?.observationPrice).toBeCloseTo(212.5);
      expect(level?.signalId).toBe(signal.id);
      // Only a matched security carries levels.
      expect(status.get(missed.id)?.matchedLevels).toEqual([]);
      // Ordered by symbol so the table does not reshuffle between requests.
      expect(body.securities.map((entry) => entry.security.symbol)).toEqual(
        [...body.securities.map((entry) => entry.security.symbol)].sort(),
      );

      await prisma.monitor.delete({ where: { id: monitor.id } });
      await prisma.stockList.delete({ where: { id: listId } });
      await prisma.security.deleteMany({
        where: { id: { in: [matched.id, missed.id, undecidable.id, fresh.id] } },
      });
    });

    it("reports every security as unchecked before the first cycle", async () => {
      const security = await prisma.security.create({
        data: {
          providerSymbol: `NEVER.${suffix.slice(0, 8)}`,
          symbol: `NVR${suffix.slice(0, 3).toUpperCase()}`,
          name: "Never Scanned",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      const ownerId = (
        await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
      ).id;
      const listId = (
        await prisma.stockList.create({
          data: {
            userId: ownerId,
            name: "Unscanned List",
            items: { create: [{ securityId: security.id }] },
          },
        })
      ).id;

      const created = await createMonitor(owner, {
        name: "Unscanned",
        strategyId,
        stockListId: listId,
      });

      // Creation already answers with the universe, so the page has a table before any cycle runs.
      expect(created.securities).toHaveLength(1);
      expect(created.securities[0]?.status).toBe("NOT_CHECKED");
      expect(created.securities[0]?.statusSince).toBeUndefined();
      expect(created.lastScanAt).toBeUndefined();

      await prisma.monitor.delete({ where: { id: created.id } });
      await prisma.stockList.delete({ where: { id: listId } });
      await prisma.security.delete({ where: { id: security.id } });
    });
  });

  /**
   * `Gain` and `Loss` are outside Monitor evaluation, and that costs the user nothing.
   *
   * A Strategy using them stays canonical and remains attachable to a Monitor: creation and
   * rebinding succeed, no validation error is raised, and the levels that do not depend on them
   * continue to decide the security's status. What changes is only what a Monitor *evaluates* —
   * proven at the cycle level in `apps/worker/src/monitor/monitor-cycle.integration.test.ts`, and
   * here at the boundary the browser sees.
   */
  describe("strategies using position metrics", () => {
    let gainStrategyId = "";
    let lossStrategyId = "";
    let evaluationListId = "";
    let evaluationSecurityId = "";

    beforeAll(async () => {
      const ownerId = (
        await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
      ).id;
      gainStrategyId = await createStrategyRow(
        ownerId,
        "Gain Exit Strategy",
        definitionWithPositionExit("GAIN"),
      );
      lossStrategyId = await createStrategyRow(
        ownerId,
        "Loss Exit Strategy",
        definitionWithPositionExit("LOSS"),
      );
      const security = await prisma.security.create({
        data: {
          providerSymbol: `POS.${suffix.slice(0, 8)}`,
          symbol: `POS${suffix.slice(0, 3).toUpperCase()}`,
          name: "Position Metric Test",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      evaluationSecurityId = security.id;
      evaluationListId = (
        await prisma.stockList.create({
          data: {
            userId: ownerId,
            name: "Position Metric List",
            items: { create: [{ securityId: security.id }] },
          },
        })
      ).id;
    });

    afterAll(async () => {
      if (!prisma) {
        return;
      }
      await prisma.stockList.deleteMany({ where: { id: evaluationListId } });
      await prisma.security.deleteMany({ where: { id: evaluationSecurityId } });
    });

    /** Records a decided outcome for one level, as a cycle would. */
    async function seedLevelState(
      monitorId: string,
      levelId: string,
      outcome: "MATCHED" | "NOT_MATCHED",
      activeSignalId?: string,
    ) {
      const decidedAt = new Date("2026-09-12T15:00:00.000Z");
      await prisma.monitorSignalState.create({
        data: {
          monitorId,
          securityId: evaluationSecurityId,
          levelId,
          levelKind: levelId.startsWith("buy") ? "BUY" : "SELL",
          signalFingerprint: `fingerprint-${levelId}`,
          lastEvaluableResult: outcome,
          lastEvaluableDate: new Date("2026-09-12T00:00:00.000Z"),
          lastEvaluableAt: decidedAt,
          lastOutcome: outcome,
          lastOutcomeAt: decidedAt,
          ...(activeSignalId === undefined ? {} : { activeSignalId }),
        },
      });
    }

    async function scannedMonitorOn(strategyId: string, name: string) {
      const monitor = await createMonitor(owner, {
        name,
        strategyId,
        stockListId: evaluationListId,
      });
      await prisma.monitor.update({
        where: { id: monitor.id },
        // Read from the clock, not pinned to a literal. `securityStatusOf` separates "never
        // visited" from "visited, undecidable" by comparing `lastScanAt` against each member's
        // real `createdAt`, and the fixture rows are created now — so a fixed timestamp made this
        // Monitor look unscanned, and the test fail, for every run after that time of day.
        data: { lastScanAt: new Date() },
      });
      return monitor;
    }

    it("attaches a Strategy using Gain to a monitor", async () => {
      const monitor = await createMonitor(owner, {
        name: "Gain Monitor",
        strategyId: gainStrategyId,
        stockListId,
      });

      expect(monitor.strategyId).toBe(gainStrategyId);
      await owner.get(`/monitors/${monitor.id}`).expect(200);
      await prisma.monitor.delete({ where: { id: monitor.id } });
    });

    it("attaches a Strategy using Loss to a monitor", async () => {
      const monitor = await createMonitor(owner, {
        name: "Loss Monitor",
        strategyId: lossStrategyId,
        stockListId,
      });

      expect(monitor.strategyId).toBe(lossStrategyId);
      await prisma.monitor.delete({ where: { id: monitor.id } });
    });

    it("rebinds onto a Strategy using Gain without complaint", async () => {
      const monitor = await createMonitor(owner, {
        name: "Rebind Onto Gain",
        strategyId,
        stockListId,
      });

      const response = await owner
        .patch(`/monitors/${monitor.id}`)
        .send({ strategyId: gainStrategyId })
        .expect(200);

      expect((response.body as MonitorSummaryResponse).strategyId).toBe(
        gainStrategyId,
      );
      await prisma.monitor.delete({ where: { id: monitor.id } });
    });

    it("reports NO_MATCH from the supported level while the Gain level is skipped", async () => {
      const monitor = await scannedMonitorOn(gainStrategyId, "Gain Aggregate");
      // Only the BUY level was evaluated; the Gain exit level was never attempted, so it has no row.
      await seedLevelState(monitor.id, "buy-1", "NOT_MATCHED");

      const response = await owner.get(`/monitors/${monitor.id}`).expect(200);
      const entry = (response.body as MonitorDetailResponse).securities[0];

      // A decided non-match from a monitor-supported level. The skipped level does not drag this
      // into NOT_EVALUABLE.
      expect(entry?.status).toBe("NO_MATCH");
      expect(entry?.matchedLevels).toEqual([]);
      await prisma.monitor.delete({ where: { id: monitor.id } });
    });

    it("reports MATCHED from the supported level while the Gain level is skipped", async () => {
      const monitor = await scannedMonitorOn(gainStrategyId, "Gain Matched");
      const signal = await prisma.monitorSignal.create({
        data: {
          monitorId: monitor.id,
          securityId: evaluationSecurityId,
          levelId: "buy-1",
          levelKind: "BUY",
          strategyVersionId: "version-1",
          hasTrigger: false,
          observationDate: new Date("2026-09-12T00:00:00.000Z"),
          observationPrice: "180.00",
          detectedAt: new Date("2026-09-12T15:00:00.000Z"),
        },
      });
      await seedLevelState(monitor.id, "buy-1", "MATCHED", signal.id);

      const response = await owner.get(`/monitors/${monitor.id}`).expect(200);
      const entry = (response.body as MonitorDetailResponse).securities[0];

      expect(entry?.status).toBe("MATCHED");
      expect(entry?.matchedLevels).toHaveLength(1);
      expect(entry?.matchedLevels[0]?.levelKind).toBe("BUY");
      await prisma.monitor.delete({ where: { id: monitor.id } });
    });

    it("ignores a state row left behind by a level the Strategy no longer monitors", async () => {
      const monitor = await scannedMonitorOn(gainStrategyId, "Stale Level Row");
      // What the unvisited-Signal sweep leaves when a level stops being evaluated: a decided-looking
      // row for a level the current configuration does not evaluate. It must not be read as "a
      // monitor-supported level decided a non-match".
      await seedLevelState(monitor.id, "sell-1", "NOT_MATCHED");

      const response = await owner.get(`/monitors/${monitor.id}`).expect(200);
      const entry = (response.body as MonitorDetailResponse).securities[0];

      // No monitor-supported level has decided anything, so the honest answer is that nothing has
      // been decided — not a fabricated non-match.
      expect(entry?.status).toBe("NOT_EVALUABLE");
      await prisma.monitor.delete({ where: { id: monitor.id } });
    });
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
