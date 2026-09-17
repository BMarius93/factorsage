import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import type {
  BuiltInContentAdminResponse,
  DashboardResponse,
  MonitorDetailResponse,
  MonitorSummaryResponse,
  StockListDetailResponse,
  StockListSummaryResponse,
  StrategyDetailResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminModule } from "../admin/admin.module";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { ConfigurationModule } from "../config/configuration.module";
import { DashboardModule } from "../dashboard/dashboard.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { ListsModule } from "../lists/lists.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { StrategiesModule } from "../strategies/strategies.module";
import {
  BuiltInSecuritiesMissingError,
  bootstrapBuiltIns,
  type BuiltInCatalog,
} from "./builtin-bootstrap";
import { BUILT_IN_STRATEGIES } from "./builtin-catalog";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * Built-in (SYSTEM) content end to end: bootstrap, read access for every viewer, administrator-only
 * changes through the ordinary routes, customer capacity, and the Dashboard read model with its
 * per-user visibility preference (`docs/decisions/builtin-dashboard-signals-v1.md`).
 *
 * The catalog under test is a private one with suffixed `systemKey`s and fictional securities, so
 * the suite never depends on — or collides with — the real built-in catalog. Its Monitors are left
 * globally paused except while a Dashboard case needs them running: the worker's cycle suite may
 * run concurrently against the same database and evaluates every globally enabled built-in.
 */
describe("built-in content", () => {
  const suffix = randomUUID().slice(0, 8);
  const password = "Local-test-password-42";
  const emails = {
    user: `builtin-user-${suffix}@example.test`,
    other: `builtin-other-${suffix}@example.test`,
    admin: `builtin-admin-${suffix}@example.test`,
  };
  const key = (name: string) => `test-${name}-${suffix}`;
  const symbols = [1, 2, 3].map((index) =>
    `BI${index}${suffix.slice(0, 4)}`.toUpperCase(),
  );
  const trendConfirmation = BUILT_IN_STRATEGIES[1]!.definition;

  const catalog: BuiltInCatalog = {
    lists: [
      {
        systemKey: key("list-a"),
        name: "Built-in List A",
        description: "The first test universe.",
        displayOrder: 1,
        members: [
          { symbol: symbols[0]!, eligibleFrom: null },
          { symbol: symbols[1]!, eligibleFrom: "2024-01-02" },
        ],
      },
      {
        systemKey: key("list-b"),
        name: "Built-in List B",
        description: "The second test universe.",
        displayOrder: 2,
        members: [
          { symbol: symbols[0]!, eligibleFrom: null },
          { symbol: symbols[2]!, eligibleFrom: "2025-03-28" },
        ],
      },
    ],
    strategies: [
      {
        systemKey: key("strategy"),
        name: "Built-in Trend",
        description: "The test strategy.",
        displayOrder: 1,
        definition: trendConfirmation,
      },
    ],
    monitors: [
      {
        systemKey: key("monitor-a"),
        name: "Built-in Monitor A",
        displayOrder: 1,
        listKey: key("list-a"),
        strategyKey: key("strategy"),
      },
      {
        systemKey: key("monitor-b"),
        name: "Built-in Monitor B",
        displayOrder: 2,
        listKey: key("list-b"),
        strategyKey: key("strategy"),
      },
    ],
  };

  let app: INestApplication;
  let prisma: PrismaService;
  let guest: ReturnType<typeof request>;
  let user: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let admin: ReturnType<typeof request.agent>;
  let userId = "";
  let adminId = "";
  const securityIds: string[] = [];
  const ids = {
    listA: "",
    listB: "",
    strategy: "",
    monitorA: "",
    monitorB: "",
  };

  async function pauseTestMonitors(): Promise<void> {
    await prisma.monitor.updateMany({
      where: { systemKey: { in: [key("monitor-a"), key("monitor-b")] } },
      data: { isGloballyEnabled: false },
    });
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
        ListsModule,
        StrategiesModule,
        MonitorsModule,
        DashboardModule,
        AdminModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);

    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: emails.user, passwordHash, emailVerifiedAt, plan: "FREE" },
        { email: emails.other, passwordHash, emailVerifiedAt, plan: "FREE" },
        {
          email: emails.admin,
          passwordHash,
          emailVerifiedAt,
          plan: "FREE",
          role: "ADMIN",
        },
      ],
    });
    userId = (
      await prisma.user.findUniqueOrThrow({ where: { email: emails.user } })
    ).id;
    adminId = (
      await prisma.user.findUniqueOrThrow({ where: { email: emails.admin } })
    ).id;

    for (const symbol of symbols) {
      const row = await prisma.security.create({
        data: {
          providerSymbol: `${symbol}.${suffix}`,
          symbol,
          name: `${symbol} Built-in Test`,
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityIds.push(row.id);
    }

    guest = request(app.getHttpServer());
    user = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    admin = request.agent(app.getHttpServer());
    for (const [agent, email] of [
      [user, emails.user],
      [other, emails.other],
      [admin, emails.admin],
    ] as const) {
      await agent.post("/auth/login").send({ email, password }).expect(200);
    }
  });

  afterAll(async () => {
    if (prisma) {
      const keys = [
        key("monitor-a"),
        key("monitor-b"),
        key("list-a"),
        key("list-b"),
        key("strategy"),
      ];
      await prisma.monitor.deleteMany({ where: { systemKey: { in: keys } } });
      await prisma.strategy.deleteMany({ where: { systemKey: { in: keys } } });
      await prisma.stockList.deleteMany({ where: { systemKey: { in: keys } } });
      await prisma.user.deleteMany({
        where: { email: { in: Object.values(emails) } },
      });
      await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    }
    if (app) {
      await app.close();
    }
  });

  describe("bootstrap", () => {
    it("fails loudly, naming every missing security, before writing anything", async () => {
      const missing = `MISSING${suffix}`.toUpperCase();
      const broken: BuiltInCatalog = {
        ...catalog,
        lists: [
          {
            ...catalog.lists[0]!,
            systemKey: key("broken"),
            members: [{ symbol: missing, eligibleFrom: null }],
          },
        ],
        monitors: [],
      };
      await expect(
        bootstrapBuiltIns(prisma, "create-missing", broken),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof BuiltInSecuritiesMissingError &&
          error.symbols.includes(missing) &&
          error.message.includes("/admin/securities/sync"),
      );
      expect(
        await prisma.stockList.count({ where: { systemKey: key("broken") } }),
      ).toBe(0);
    });

    it("creates every built-in by systemKey, and is idempotent", async () => {
      const first = await bootstrapBuiltIns(prisma, "create-missing", catalog);
      expect(Object.values(first.lists)).toEqual(["created", "created"]);
      expect(Object.values(first.strategies)).toEqual(["created"]);
      expect(Object.values(first.monitors)).toEqual(["created", "created"]);

      const second = await bootstrapBuiltIns(prisma, "create-missing", catalog);
      expect([
        ...Object.values(second.lists),
        ...Object.values(second.strategies),
        ...Object.values(second.monitors),
      ]).toEqual([
        "unchanged",
        "unchanged",
        "unchanged",
        "unchanged",
        "unchanged",
      ]);

      const listA = await prisma.stockList.findUniqueOrThrow({
        where: { systemKey: key("list-a") },
        include: { items: { include: { buyWindows: true, security: true } } },
      });
      expect(listA.ownership).toBe("SYSTEM");
      expect(listA.userId).toBeNull();
      const bySymbol = new Map(
        listA.items.map((item) => [item.security.symbol, item]),
      );
      expect(bySymbol.get(symbols[0]!)?.buyWindowMode).toBe("FULL");
      expect(bySymbol.get(symbols[1]!)?.buyWindowMode).toBe("CUSTOM");
      expect(
        bySymbol
          .get(symbols[1]!)
          ?.buyWindows.map((window) => [
            window.startDate.toISOString().slice(0, 10),
            window.endDate,
          ]),
      ).toEqual([["2024-01-02", null]]);
      expect(
        await prisma.strategyVersion.count({
          where: { strategy: { systemKey: key("strategy") } },
        }),
      ).toBe(1);

      ids.listA = listA.id;
      ids.listB = (
        await prisma.stockList.findUniqueOrThrow({
          where: { systemKey: key("list-b") },
        })
      ).id;
      ids.strategy = (
        await prisma.strategy.findUniqueOrThrow({
          where: { systemKey: key("strategy") },
        })
      ).id;
      ids.monitorA = (
        await prisma.monitor.findUniqueOrThrow({
          where: { systemKey: key("monitor-a") },
        })
      ).id;
      ids.monitorB = (
        await prisma.monitor.findUniqueOrThrow({
          where: { systemKey: key("monitor-b") },
        })
      ).id;
      await pauseTestMonitors();
    });

    it("does not overwrite administrator edits on a normal bootstrap; reset restores the catalog", async () => {
      await admin
        .patch(`/lists/${ids.listA}`)
        .send({ name: "Operator's name" })
        .expect(200);
      const edited = structuredClone(trendConfirmation);
      edited.buyLevels[0]!.percentage = 50;
      await admin
        .put(`/strategies/${ids.strategy}/definition`)
        .send({ definition: edited })
        .expect(200);

      await bootstrapBuiltIns(prisma, "create-missing", catalog);
      expect(
        (await prisma.stockList.findUniqueOrThrow({ where: { id: ids.listA } }))
          .name,
      ).toBe("Operator's name");
      expect(
        await prisma.strategyVersion.count({
          where: { strategyId: ids.strategy },
        }),
      ).toBe(2);

      const reset = await bootstrapBuiltIns(prisma, "reset", catalog);
      expect(reset.lists[key("list-a")]).toBe("reset");
      const restored = await prisma.stockList.findUniqueOrThrow({
        where: { id: ids.listA },
      });
      expect(restored.name).toBe("Built-in List A");
      expect(restored.systemKey).toBe(key("list-a"));
      // The restore is a new version, never a rewrite of history.
      const versions = await prisma.strategyVersion.findMany({
        where: { strategyId: ids.strategy },
        orderBy: { versionNumber: "asc" },
      });
      expect(versions).toHaveLength(3);
      expect(versions[2]!.definitionHash).toBe(versions[0]!.definitionHash);
      // Reset brings the monitors back to published and running; keep them paused for the suite.
      await pauseTestMonitors();
    });
  });

  describe("authorization", () => {
    it("lets every viewer read built-ins, and marks them read-only for customers", async () => {
      const guestLists = (await guest.get("/lists").expect(200))
        .body as StockListSummaryResponse[];
      const builtIn = guestLists.find((list) => list.id === ids.listA);
      expect(builtIn).toMatchObject({
        ownership: "SYSTEM",
        systemKey: key("list-a"),
        canEdit: false,
      });
      expect(builtIn?.compliance.compliant).toBe(true);

      const detail = (await guest.get(`/lists/${ids.listA}`).expect(200))
        .body as StockListDetailResponse;
      expect(detail.items).toHaveLength(2);
      const strategies = (await user.get("/strategies").expect(200))
        .body as StrategySummaryResponse[];
      expect(strategies.find((row) => row.id === ids.strategy)?.canEdit).toBe(
        false,
      );
      const adminStrategies = (await admin.get("/strategies").expect(200))
        .body as StrategySummaryResponse[];
      expect(
        adminStrategies.find((row) => row.id === ids.strategy)?.canEdit,
      ).toBe(true);
      await guest.get(`/strategies/${ids.strategy}`).expect(200);
    });

    it("refuses every customer change to built-in content with a 403", async () => {
      const item = await prisma.stockListItem.findFirstOrThrow({
        where: { stockListId: ids.listA },
      });
      const refusals = [
        () => user.patch(`/lists/${ids.listA}`).send({ name: "Mine now" }),
        () =>
          user
            .post(`/lists/${ids.listA}/items`)
            .send({ securityIds: [securityIds[2]] }),
        () => user.delete(`/lists/${ids.listA}/items/${item.id}`),
        () =>
          user
            .put(`/lists/${ids.listA}/items/${item.id}/buy-windows`)
            .send({ mode: "FULL", ranges: [] }),
        () => user.delete(`/lists/${ids.listA}`),
        () =>
          user.patch(`/strategies/${ids.strategy}`).send({ name: "Mine now" }),
        () =>
          user
            .put(`/strategies/${ids.strategy}/definition`)
            .send({ definition: trendConfirmation }),
        () => user.delete(`/strategies/${ids.strategy}`),
        () =>
          user.patch(`/monitors/${ids.monitorA}`).send({ name: "Mine now" }),
        () => user.delete(`/monitors/${ids.monitorA}`),
      ];
      for (const refusal of refusals) {
        const response = await refusal().expect(403);
        expect(response.body.code).toBe("SYSTEM_CONTENT_READ_ONLY");
      }
      // Nothing moved.
      const list = await prisma.stockList.findUniqueOrThrow({
        where: { id: ids.listA },
        include: { _count: { select: { items: true } } },
      });
      expect(list.name).toBe("Built-in List A");
      expect(list._count.items).toBe(2);
      expect(
        await prisma.strategyVersion.count({
          where: { strategyId: ids.strategy },
        }),
      ).toBe(3);
      await guest.patch(`/lists/${ids.listA}`).send({ name: "x" }).expect(401);
    });

    it("lets an administrator change built-ins through the ordinary routes", async () => {
      await admin
        .patch(`/lists/${ids.listA}`)
        .send({ description: "Edited by an admin" })
        .expect(200);
      const list = await prisma.stockList.findUniqueOrThrow({
        where: { id: ids.listA },
      });
      expect(list.updatedByUserId).toBe(adminId);
      expect(list.systemKey).toBe(key("list-a"));

      const added = (
        await admin
          .post(`/lists/${ids.listA}/items`)
          .send({ securityIds: [securityIds[2]] })
          .expect(200)
      ).body as StockListDetailResponse;
      expect(added.items).toHaveLength(3);
      const addedItem = added.items.find(
        (entry) => entry.security.id === securityIds[2],
      )!;
      await admin
        .put(`/lists/${ids.listA}/items/${addedItem.id}/buy-windows`)
        .send({
          mode: "CUSTOM",
          ranges: [{ startDate: "2025-01-02", endDate: null }],
        })
        .expect(200);
      await admin
        .delete(`/lists/${ids.listA}/items/${addedItem.id}`)
        .expect(204);

      const edited = structuredClone(trendConfirmation);
      edited.buyLevels[0]!.percentage = 75;
      const strategy = (
        await admin
          .put(`/strategies/${ids.strategy}/definition`)
          .send({ definition: edited })
          .expect(200)
      ).body as StrategyDetailResponse;
      expect(strategy.versionNumber).toBe(4);
      expect(strategy.systemKey).toBe(key("strategy"));

      const renamed = (
        await admin
          .patch(`/monitors/${ids.monitorA}`)
          .send({ name: "Renamed monitor", displayOrder: 5 })
          .expect(200)
      ).body as MonitorSummaryResponse;
      expect(renamed).toMatchObject({
        name: "Renamed monitor",
        systemKey: key("monitor-a"),
        displayOrder: 5,
      });

      const deleted = await admin.delete(`/lists/${ids.listA}`).expect(409);
      expect(deleted.body.code).toBe("SYSTEM_CONTENT_PROTECTED");
      expect(
        (await admin.delete(`/monitors/${ids.monitorA}`).expect(409)).body.code,
      ).toBe("SYSTEM_CONTENT_PROTECTED");
      expect(
        (await admin.delete(`/strategies/${ids.strategy}`).expect(409)).body
          .code,
      ).toBe("SYSTEM_CONTENT_PROTECTED");

      const overview = (await admin.get("/admin/built-ins").expect(200))
        .body as BuiltInContentAdminResponse;
      expect(
        overview.monitors.find((row) => row.id === ids.monitorA),
      ).toMatchObject({
        systemKey: key("monitor-a"),
        updatedByEmail: emails.admin,
      });
      await user.get("/admin/built-ins").expect(403);
      await guest.get("/admin/built-ins").expect(401);
    });

    it("publishes, pauses and rebinds a built-in monitor, for administrators only", async () => {
      await admin
        .patch(`/monitors/${ids.monitorB}`)
        .send({ isPublished: false })
        .expect(200);
      await guest.get(`/monitors/${ids.monitorB}`).expect(404);
      await user.get(`/monitors/${ids.monitorB}`).expect(404);
      const hidden = (await admin.get(`/monitors/${ids.monitorB}`).expect(200))
        .body as MonitorDetailResponse;
      expect(hidden).toMatchObject({
        isPublished: false,
        isGloballyEnabled: false,
        operationalStatus: "DISABLED",
      });
      await admin
        .patch(`/monitors/${ids.monitorB}`)
        .send({ isPublished: true })
        .expect(200);

      // A built-in watches built-in content only, and `enabled` is not its switch.
      const ownList = await prisma.stockList.create({
        data: { userId: adminId, name: "Admin's own" },
      });
      await admin
        .patch(`/monitors/${ids.monitorB}`)
        .send({ stockListId: ownList.id })
        .expect(400);
      await admin
        .patch(`/monitors/${ids.monitorB}`)
        .send({ enabled: false })
        .expect(400);

      const rebound = (
        await admin
          .patch(`/monitors/${ids.monitorB}`)
          .send({ stockListId: ids.listA })
          .expect(200)
      ).body as MonitorSummaryResponse;
      expect(rebound.stockListId).toBe(ids.listA);
      const row = await prisma.monitor.findUniqueOrThrow({
        where: { id: ids.monitorB },
      });
      expect(row.configVersion).toBe(1);
      await admin
        .patch(`/monitors/${ids.monitorB}`)
        .send({ stockListId: ids.listB })
        .expect(200);
      await prisma.stockList.delete({ where: { id: ownList.id } });
    });

    it("keeps built-in-only fields off a customer's own monitor", async () => {
      const strategy = await prisma.strategy.create({
        data: {
          userId,
          name: "Own strategy",
          versions: {
            create: {
              versionNumber: 1,
              definition: trendConfirmation as never,
              definitionHash: randomUUID(),
            },
          },
        },
      });
      const list = await prisma.stockList.create({
        data: { userId, name: "Own list" },
      });
      const monitor = await prisma.monitor.create({
        data: {
          userId,
          name: "Own monitor",
          strategyId: strategy.id,
          stockListId: list.id,
          enabled: false,
        },
      });
      await user
        .patch(`/monitors/${monitor.id}`)
        .send({ isPublished: false })
        .expect(400);
      await user
        .patch(`/monitors/${monitor.id}`)
        .send({ isGloballyEnabled: false })
        .expect(400);
      // A customer's Monitor cannot watch built-in content.
      await user
        .patch(`/monitors/${monitor.id}`)
        .send({ stockListId: ids.listA })
        .expect(400);
      await prisma.monitor.delete({ where: { id: monitor.id } });
      await prisma.strategy.delete({ where: { id: strategy.id } });
      await prisma.stockList.delete({ where: { id: list.id } });
    });

    it("does not count built-ins against a customer's capacity", async () => {
      await prisma.monitor.updateMany({
        where: { id: { in: [ids.monitorA, ids.monitorB] } },
        data: { isGloballyEnabled: true },
      });
      try {
        // FREE allows one active Monitor; the running built-ins take none of it.
        const strategy = await prisma.strategy.create({
          data: {
            userId,
            name: "Capacity strategy",
            versions: {
              create: {
                versionNumber: 1,
                definition: trendConfirmation as never,
                definitionHash: randomUUID(),
              },
            },
          },
        });
        const list = await prisma.stockList.create({
          data: { userId, name: "Capacity list" },
        });
        const created = (
          await user
            .post("/monitors")
            .send({
              name: "My one monitor",
              strategyId: strategy.id,
              stockListId: list.id,
            })
            .expect(201)
        ).body as MonitorDetailResponse;
        expect(created.operationalStatus).toBe("ACTIVE");
        const own = (await user.get("/monitors").expect(200))
          .body as MonitorSummaryResponse[];
        expect(own.map((monitor) => monitor.id)).toEqual([created.id]);
        await prisma.monitor.delete({ where: { id: created.id } });
        await prisma.strategy.delete({ where: { id: strategy.id } });
        await prisma.stockList.delete({ where: { id: list.id } });
      } finally {
        await pauseTestMonitors();
      }
    });
  });

  describe("dashboard", () => {
    const levelBuy = trendConfirmation.buyLevels[0]!.id;
    const levelExit = trendConfirmation.finalExit!.id;

    async function seedState(input: {
      monitorId: string;
      securityId: string;
      levelId: string;
      levelKind: "BUY" | "FINAL_EXIT";
      state: "ACTIVE" | "PENDING_TRIGGER" | "RESOLVED" | "INACTIVE";
      date: string;
      price: number;
    }): Promise<void> {
      const since = new Date(`${input.date}T15:00:00.000Z`);
      const signal =
        input.state === "ACTIVE"
          ? await prisma.monitorSignal.create({
              data: {
                monitorId: input.monitorId,
                securityId: input.securityId,
                levelId: input.levelId,
                levelKind: input.levelKind,
                strategyVersionId: "version",
                hasTrigger: true,
                observationDate: new Date(`${input.date}T00:00:00.000Z`),
                observationPrice: input.price,
                detectedAt: since,
              },
            })
          : null;
      await prisma.monitorSignalState.create({
        data: {
          monitorId: input.monitorId,
          securityId: input.securityId,
          levelId: input.levelId,
          levelKind: input.levelKind,
          signalFingerprint: "fingerprint",
          lastEvaluableResult:
            input.state === "ACTIVE" ? "MATCHED" : "NOT_MATCHED",
          lastEvaluableDate: new Date(`${input.date}T00:00:00.000Z`),
          lastEvaluableAt: since,
          lastOutcome: input.state === "ACTIVE" ? "MATCHED" : "NOT_MATCHED",
          lastOutcomeAt: since,
          lifecycleState: input.state,
          lifecycleSince: since,
          lifecycleSinceDate: new Date(`${input.date}T00:00:00.000Z`),
          lifecycleSincePrice: input.price,
          ruleStates: {
            [input.levelId]: {
              state: input.state,
              since: input.date,
              triggerDate: input.state === "ACTIVE" ? input.date : null,
            },
          },
          activeSignalId: signal?.id ?? null,
        },
      });
    }

    beforeAll(async () => {
      // A: the first security active, the second waiting for its trigger.
      await seedState({
        monitorId: ids.monitorA,
        securityId: securityIds[0]!,
        levelId: levelBuy,
        levelKind: "BUY",
        state: "ACTIVE",
        date: "2026-09-10",
        price: 101,
      });
      await seedState({
        monitorId: ids.monitorA,
        securityId: securityIds[1]!,
        levelId: levelBuy,
        levelKind: "BUY",
        state: "PENDING_TRIGGER",
        date: "2026-09-15",
        price: 55,
      });
      // B: the same first security active too; everything else is not current.
      await seedState({
        monitorId: ids.monitorB,
        securityId: securityIds[0]!,
        levelId: levelBuy,
        levelKind: "BUY",
        state: "ACTIVE",
        date: "2026-09-12",
        price: 102,
      });
      await seedState({
        monitorId: ids.monitorB,
        securityId: securityIds[2]!,
        levelId: levelExit,
        levelKind: "FINAL_EXIT",
        state: "RESOLVED",
        date: "2026-09-16",
        price: 30,
      });
      await seedState({
        monitorId: ids.monitorB,
        securityId: securityIds[0]!,
        levelId: levelExit,
        levelKind: "FINAL_EXIT",
        state: "INACTIVE",
        date: "2026-09-16",
        price: 30,
      });
      await prisma.monitor.updateMany({
        where: { id: { in: [ids.monitorA, ids.monitorB] } },
        data: {
          isGloballyEnabled: true,
          isPublished: true,
          lastScanAt: new Date(),
        },
      });
    });

    afterAll(async () => {
      await pauseTestMonitors();
    });

    function testRows(body: DashboardResponse) {
      return body.rows.filter((row) =>
        [ids.monitorA, ids.monitorB].includes(row.monitor.id),
      );
    }

    it("shows a Guest every current match and setup of the default built-ins", async () => {
      const body = (await guest.get("/dashboard").expect(200))
        .body as DashboardResponse;
      expect(body.viewer).toBe("GUEST");
      expect(
        await prisma.userBuiltInMonitorPreference.count({
          where: { monitorId: { in: [ids.monitorA, ids.monitorB] } },
        }),
      ).toBe(0);
      const rows = testRows(body);
      // Newest state first; the same security under two monitors is two rows.
      expect(
        rows.map((row) => [row.monitor.id, row.security.id, row.state]),
      ).toEqual([
        [ids.monitorA, securityIds[1], "PENDING_TRIGGER"],
        [ids.monitorB, securityIds[0], "ACTIVE"],
        [ids.monitorA, securityIds[0], "ACTIVE"],
      ]);
      expect(rows[0]).toMatchObject({
        levelKind: "BUY",
        levelIndex: 1,
        // The administrator's edit above made the level 75%; the Dashboard reads the live version.
        levelPercentage: 75,
        price: 55,
        observationDate: "2026-09-15",
        reasons: [
          {
            conditions: [
              "SMA 50D is above SMA 200D",
              "Price is above SMA 200D",
            ],
            trigger: "Price crosses above SMA 20D",
            waitingForTrigger: true,
          },
        ],
        strategy: { id: ids.strategy },
        stockList: { id: ids.listA },
      });
      expect(rows[2]).toMatchObject({ price: 101, reconstructed: false });
      expect(rows[2]!.signalId).toBeDefined();
      expect(rows[2]!.reasons[0]!.waitingForTrigger).toBe(false);
      const monitors = body.monitors.filter(
        (monitor) => monitor.ownership === "SYSTEM",
      );
      const a = monitors.find((monitor) => monitor.id === ids.monitorA);
      expect(a).toMatchObject({
        visible: true,
        control: "BUILT_IN_PREFERENCE",
        freshness: "CURRENT",
        activeCount: 1,
        pendingCount: 1,
      });
    });

    it("asks a Guest to sign in rather than storing a preference", async () => {
      await guest
        .put(`/dashboard/monitors/${ids.monitorA}/visibility`)
        .send({ visible: false })
        .expect(401);
      expect(
        await prisma.userBuiltInMonitorPreference.count({
          where: { monitorId: ids.monitorA },
        }),
      ).toBe(0);
    });

    it("hides a built-in for one user only, without changing its evaluation", async () => {
      await user
        .put(`/dashboard/monitors/${ids.monitorA}/visibility`)
        .send({ visible: false })
        .expect(200);
      const mine = (await user.get("/dashboard").expect(200))
        .body as DashboardResponse;
      expect(mine.viewer).toBe("AUTHENTICATED");
      expect(testRows(mine).map((row) => row.monitor.id)).toEqual([
        ids.monitorB,
      ]);
      expect(
        mine.monitors.find((monitor) => monitor.id === ids.monitorA)?.visible,
      ).toBe(false);

      expect(
        testRows(
          (await other.get("/dashboard").expect(200)).body as DashboardResponse,
        ),
      ).toHaveLength(3);
      expect(
        testRows(
          (await guest.get("/dashboard").expect(200)).body as DashboardResponse,
        ),
      ).toHaveLength(3);
      const shared = await prisma.monitor.findUniqueOrThrow({
        where: { id: ids.monitorA },
      });
      expect(shared).toMatchObject({
        isGloballyEnabled: true,
        isPublished: true,
      });

      await user
        .put(`/dashboard/monitors/${ids.monitorA}/visibility`)
        .send({ visible: true })
        .expect(200);
      expect(
        testRows(
          (await user.get("/dashboard").expect(200)).body as DashboardResponse,
        ),
      ).toHaveLength(3);
      await user
        .put(`/dashboard/monitors/${ids.monitorA}/visibility`)
        .send({ hidden: true })
        .expect(400);
    });

    it("refuses a visibility preference for anything but a published built-in", async () => {
      await user
        .put(`/dashboard/monitors/${randomUUID()}/visibility`)
        .send({ visible: false })
        .expect(404);
      await prisma.monitor.update({
        where: { id: ids.monitorB },
        data: { isPublished: false },
      });
      try {
        await user
          .put(`/dashboard/monitors/${ids.monitorB}/visibility`)
          .send({ visible: false })
          .expect(404);
        const body = (await guest.get("/dashboard").expect(200))
          .body as DashboardResponse;
        expect(
          body.monitors.some((monitor) => monitor.id === ids.monitorB),
        ).toBe(false);
        expect(
          testRows(body).every((row) => row.monitor.id === ids.monitorA),
        ).toBe(true);
      } finally {
        await prisma.monitor.update({
          where: { id: ids.monitorB },
          data: { isPublished: true },
        });
      }
    });

    it("reports freshness honestly and hides a paused monitor's frozen rows", async () => {
      await prisma.monitor.update({
        where: { id: ids.monitorB },
        data: { lastScanAt: new Date(Date.now() - 24 * 60 * 60_000) },
      });
      await prisma.monitor.update({
        where: { id: ids.monitorA },
        data: { isGloballyEnabled: false },
      });
      try {
        const body = (await guest.get("/dashboard").expect(200))
          .body as DashboardResponse;
        const freshness = new Map(
          body.monitors.map((monitor) => [monitor.id, monitor.freshness]),
        );
        expect(freshness.get(ids.monitorB)).toBe("STALE");
        expect(freshness.get(ids.monitorA)).toBe("PAUSED");
        expect(testRows(body).map((row) => row.monitor.id)).toEqual([
          ids.monitorB,
        ]);

        await prisma.monitor.update({
          where: { id: ids.monitorB },
          data: { lastScanAt: null },
        });
        const unscanned = (await guest.get("/dashboard").expect(200))
          .body as DashboardResponse;
        expect(
          unscanned.monitors.find((monitor) => monitor.id === ids.monitorB)
            ?.freshness,
        ).toBe("NOT_SCANNED");
      } finally {
        await prisma.monitor.updateMany({
          where: { id: { in: [ids.monitorA, ids.monitorB] } },
          data: { isGloballyEnabled: true, lastScanAt: new Date() },
        });
      }
    });

    it("reports a built-in monitor's waiting setups on its detail page", async () => {
      const detail = (await guest.get(`/monitors/${ids.monitorA}`).expect(200))
        .body as MonitorDetailResponse;
      expect(detail).toMatchObject({
        ownership: "SYSTEM",
        canEdit: false,
        operationalStatus: "ACTIVE",
      });
      const statuses = new Map(
        detail.securities.map((entry) => [entry.security.id, entry]),
      );
      expect(statuses.get(securityIds[0]!)?.status).toBe("MATCHED");
      expect(statuses.get(securityIds[1]!)?.status).toBe("WAITING_FOR_TRIGGER");
      expect(statuses.get(securityIds[1]!)?.waitingLevels).toHaveLength(1);
    });
  });
});
