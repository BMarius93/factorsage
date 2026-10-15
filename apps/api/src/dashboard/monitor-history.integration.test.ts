import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  STRATEGY_SCHEMA_VERSION,
  type DashboardActivityResponse,
  type MonitorDetailResponse,
  type MonitorSignalPageResponse,
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
import { MonitorsModule } from "../monitors/monitors.module";
import { DashboardModule } from "./dashboard.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * The Monitor history read models (`docs/decisions/monitor-eod-v2.md` §6): the Dashboard's Monitor
 * Activity feed, the Monitor's one Signal table, and its coverage line — each a projection of what
 * the worker recorded, with every Why rendered from the version and evidence stored beside it.
 *
 * Rows are seeded exactly as the EOD evaluation writes them, so what these cases pin is the read
 * side: which changes count as activity, the order, the paging, visibility, and the fallback to the
 * rule's wording when no evidence was recorded.
 */
describe("Monitor history read models", () => {
  const suffix = randomUUID().slice(0, 8);
  const password = "Local-test-password-42";
  const emails = {
    owner: `history-owner-${suffix}@example.test`,
    other: `history-other-${suffix}@example.test`,
  };
  const definition = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [
            {
              id: "c1",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_200D" },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  };

  let app: INestApplication;
  let prisma: PrismaService;
  let guest: ReturnType<typeof request>;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  const securityIds: string[] = [];
  const ids = {
    ownerId: "",
    builtIn: "",
    builtInVersion: "",
    own: "",
    ownVersion: "",
    strategies: [] as string[],
    lists: [] as string[],
  };
  const signal = { a: "", b: "", c: "", d: "" };

  const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
  const evidence = (result: "TRUE" | "FALSE", metric: number) => ({
    v: 1,
    rules: [
      {
        ruleId: "buy-1",
        predicates: [
          { id: "c1", role: "CONDITION", result, metric, value: 100 },
        ],
      },
    ],
  });

  async function createContent(
    ownership: "SYSTEM" | "USER",
    name: string,
  ): Promise<{ monitorId: string; versionId: string }> {
    const userId = ownership === "USER" ? ids.ownerId : null;
    const systemKey = (kind: string) =>
      ownership === "SYSTEM" ? `test-history-${kind}-${suffix}` : null;
    const strategy = await prisma.strategy.create({
      data: {
        ownership,
        userId,
        systemKey: systemKey("strategy"),
        name: `${name} strategy`,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as never,
            definitionHash: randomUUID(),
          },
        },
      },
      include: { versions: true },
    });
    const list = await prisma.stockList.create({
      data: {
        ownership,
        userId,
        systemKey: systemKey("list"),
        name: `${name} list`,
        items: {
          create: securityIds.map((securityId) => ({ securityId })),
        },
      },
    });
    const monitor = await prisma.monitor.create({
      data: {
        ownership,
        userId,
        systemKey: systemKey("monitor"),
        name: `${name} monitor`,
        strategyId: strategy.id,
        stockListId: list.id,
        ...(ownership === "SYSTEM"
          ? { isPublished: true, isGloballyEnabled: false }
          : { enabled: true }),
      },
    });
    ids.strategies.push(strategy.id);
    ids.lists.push(list.id);
    return { monitorId: monitor.id, versionId: strategy.versions[0]!.id };
  }

  async function transition(input: {
    monitorId: string;
    securityId: string;
    from: "INACTIVE" | "PENDING_TRIGGER" | "ACTIVE" | "RESOLVED";
    to: "INACTIVE" | "PENDING_TRIGGER" | "ACTIVE" | "RESOLVED";
    reason: string;
    origin: "OBSERVED" | "HISTORY" | "ADMINISTRATIVE";
    on: string | null;
    signalId?: string;
    versionId?: string | null;
    evidence?: unknown;
  }) {
    await prisma.monitorStateTransition.create({
      data: {
        monitorId: input.monitorId,
        securityId: input.securityId,
        levelId: "buy-1",
        levelKind: "BUY",
        signalFingerprint: "fingerprint",
        fromState: input.from,
        toState: input.to,
        reason: input.reason as never,
        origin: input.origin,
        observationDate: input.on ? date(input.on) : null,
        signalId: input.signalId ?? null,
        strategyVersionId: input.versionId ?? null,
        ...(input.evidence ? { evidence: input.evidence as never } : {}),
      },
    });
  }

  async function createSignal(input: {
    monitorId: string;
    securityId: string;
    versionId: string;
    on: string;
    price: number;
    resolvedOn?: string | null;
    resolvedAt?: Date;
    reason?: string;
    reconstructed?: boolean;
  }): Promise<string> {
    const row = await prisma.monitorSignal.create({
      data: {
        monitorId: input.monitorId,
        securityId: input.securityId,
        levelId: "buy-1",
        levelKind: "BUY",
        strategyVersionId: input.versionId,
        hasTrigger: false,
        observationDate: date(input.on),
        observationPrice: input.price,
        detectedAt: new Date("2026-10-14T22:00:00.000Z"),
        reconstructed: input.reconstructed ?? false,
        ...(input.resolvedAt
          ? {
              resolvedAt: input.resolvedAt,
              resolvedObservationDate: input.resolvedOn
                ? date(input.resolvedOn)
                : null,
              resolutionReason: input.reason as never,
            }
          : {}),
      },
    });
    return row.id;
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
        DashboardModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);

    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: emails.owner, passwordHash, emailVerifiedAt, plan: "FREE" },
        { email: emails.other, passwordHash, emailVerifiedAt, plan: "FREE" },
      ],
    });
    ids.ownerId = (
      await prisma.user.findUniqueOrThrow({ where: { email: emails.owner } })
    ).id;
    for (const tag of ["HA", "HB"]) {
      const symbol = `${tag}${suffix.slice(0, 4)}`.toUpperCase();
      const row = await prisma.security.create({
        data: {
          providerSymbol: `${symbol}.${suffix}`,
          symbol,
          name: `${symbol} History`,
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityIds.push(row.id);
    }
    const builtIn = await createContent("SYSTEM", "Built-in history");
    ids.builtIn = builtIn.monitorId;
    ids.builtInVersion = builtIn.versionId;
    const own = await createContent("USER", "Own history");
    ids.own = own.monitorId;
    ids.ownVersion = own.versionId;
    const [s1, s2] = securityIds as [string, string];

    // The built-in: S1 matched Oct 9 and stopped matching Oct 13 — both observed.
    signal.a = await createSignal({
      monitorId: ids.builtIn,
      securityId: s1,
      versionId: ids.builtInVersion,
      on: "2026-10-09",
      price: 105,
      resolvedOn: "2026-10-13",
      resolvedAt: new Date("2026-10-13T22:00:00.000Z"),
      reason: "CONDITIONS_ENDED",
    });
    await transition({
      monitorId: ids.builtIn,
      securityId: s1,
      from: "INACTIVE",
      to: "ACTIVE",
      reason: "CONDITIONS_MET",
      origin: "OBSERVED",
      on: "2026-10-09",
      signalId: signal.a,
      versionId: ids.builtInVersion,
      evidence: evidence("TRUE", 105),
    });
    await transition({
      monitorId: ids.builtIn,
      securityId: s1,
      from: "ACTIVE",
      to: "RESOLVED",
      reason: "CONDITIONS_ENDED",
      origin: "OBSERVED",
      on: "2026-10-13",
      signalId: signal.a,
      versionId: ids.builtInVersion,
      evidence: evidence("FALSE", 95),
    });
    // Matched again Oct 14, observed.
    signal.b = await createSignal({
      monitorId: ids.builtIn,
      securityId: s1,
      versionId: ids.builtInVersion,
      on: "2026-10-14",
      price: 106,
    });
    await transition({
      monitorId: ids.builtIn,
      securityId: s1,
      from: "RESOLVED",
      to: "ACTIVE",
      reason: "CONDITIONS_MET",
      origin: "OBSERVED",
      on: "2026-10-14",
      signalId: signal.b,
      versionId: ids.builtInVersion,
      evidence: evidence("TRUE", 106),
    });
    // S2: active since Oct 1 from history (a replay), never activity.
    signal.c = await createSignal({
      monitorId: ids.builtIn,
      securityId: s2,
      versionId: ids.builtInVersion,
      on: "2026-10-01",
      price: 101,
      reconstructed: true,
    });
    await transition({
      monitorId: ids.builtIn,
      securityId: s2,
      from: "INACTIVE",
      to: "ACTIVE",
      reason: "RECONSTRUCTED",
      origin: "HISTORY",
      on: "2026-10-01",
      signalId: signal.c,
      versionId: ids.builtInVersion,
      evidence: evidence("TRUE", 101),
    });
    // An older occurrence ended administratively — no session, no evidence.
    signal.d = await createSignal({
      monitorId: ids.builtIn,
      securityId: s2,
      versionId: ids.builtInVersion,
      on: "2026-09-01",
      price: 99,
      resolvedOn: null,
      resolvedAt: new Date("2026-10-12T15:00:00.000Z"),
      reason: "MEMBERSHIP_CHANGED",
    });
    await transition({
      monitorId: ids.builtIn,
      securityId: s2,
      from: "ACTIVE",
      to: "RESOLVED",
      reason: "MEMBERSHIP_CHANGED",
      origin: "ADMINISTRATIVE",
      on: null,
      signalId: signal.d,
    });
    // Neither a trigger day passing nor a setup is activity.
    await transition({
      monitorId: ids.builtIn,
      securityId: s2,
      from: "ACTIVE",
      to: "RESOLVED",
      reason: "EVENT_SESSION_ENDED",
      origin: "OBSERVED",
      on: "2026-10-14",
      versionId: ids.builtInVersion,
    });
    await transition({
      monitorId: ids.builtIn,
      securityId: s2,
      from: "INACTIVE",
      to: "PENDING_TRIGGER",
      reason: "SETUP_STARTED",
      origin: "OBSERVED",
      on: "2026-10-10",
      versionId: ids.builtInVersion,
      evidence: evidence("TRUE", 102),
    });
    await prisma.monitorSignalState.create({
      data: {
        monitorId: ids.builtIn,
        securityId: s2,
        levelId: "buy-1",
        levelKind: "BUY",
        signalFingerprint: "fingerprint",
        lastEvaluableResult: "NOT_MATCHED",
        lastEvaluableDate: date("2026-10-14"),
        lastEvaluableAt: new Date(),
        lastOutcome: "NOT_MATCHED",
        lastOutcomeAt: new Date(),
        lifecycleState: "PENDING_TRIGGER",
        lifecycleSince: new Date("2026-10-10T22:00:00.000Z"),
        lifecycleSinceDate: date("2026-10-10"),
        lifecycleSincePrice: 102,
        ruleStates: {},
      },
    });
    // The owner's Monitor: a V1-era activation, recorded without evidence or version.
    const ownSignal = await createSignal({
      monitorId: ids.own,
      securityId: s2,
      versionId: ids.ownVersion,
      on: "2026-10-14",
      price: 50,
    });
    await transition({
      monitorId: ids.own,
      securityId: s2,
      from: "INACTIVE",
      to: "ACTIVE",
      reason: "CONDITIONS_MET",
      origin: "OBSERVED",
      on: "2026-10-14",
      signalId: ownSignal,
    });
    await prisma.monitorEvaluationCheckpoint.createMany({
      data: [
        {
          monitorId: ids.builtIn,
          securityId: s1,
          evaluatedThrough: date("2026-10-14"),
          configVersion: 0,
          basisGeneration: 0,
        },
        {
          monitorId: ids.builtIn,
          securityId: s2,
          evaluatedThrough: date("2026-10-13"),
          configVersion: 0,
          basisGeneration: 0,
        },
      ],
    });

    guest = request(app.getHttpServer());
    owner = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    await owner
      .post("/auth/login")
      .send({ email: emails.owner, password })
      .expect(200);
    await other
      .post("/auth/login")
      .send({ email: emails.other, password })
      .expect(200);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.monitor.deleteMany({
        where: { id: { in: [ids.builtIn, ids.own] } },
      });
      await prisma.strategy.deleteMany({
        where: { id: { in: ids.strategies } },
      });
      await prisma.stockList.deleteMany({ where: { id: { in: ids.lists } } });
      await prisma.user.deleteMany({
        where: { email: { in: Object.values(emails) } },
      });
      await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    }
    if (app) {
      await app.close();
    }
  });

  const ours = (body: DashboardActivityResponse) =>
    body.events.filter((event) =>
      [ids.builtIn, ids.own].includes(event.monitor.id),
    );

  describe("the Dashboard's Monitor Activity feed", () => {
    it("shows only observed activations and market resolutions, newest session first", async () => {
      const body = (await guest.get("/dashboard/activity").expect(200))
        .body as DashboardActivityResponse;
      expect(body.viewer).toBe("GUEST");
      // A Guest sees the published built-in only; history, administrative endings, a trigger day
      // passing and a setup are never activity.
      expect(
        ours(body).map((event) => [
          event.sessionDate,
          event.kind,
          event.reason,
        ]),
      ).toEqual([
        ["2026-10-14", "ACTIVATED", "CONDITIONS_MET"],
        ["2026-10-13", "RESOLVED", "CONDITIONS_ENDED"],
        ["2026-10-09", "ACTIVATED", "CONDITIONS_MET"],
      ]);
      const resolved = ours(body)[1]!;
      expect(resolved).toMatchObject({
        levelKind: "BUY",
        levelIndex: 1,
        levelPercentage: 100,
        signalId: signal.a,
        price: 105,
        observationBasis: "EOD_CLOSE",
        why: {
          basis: "EVIDENCE",
          sessionDate: "2026-10-13",
          rules: [
            {
              predicates: [
                {
                  role: "CONDITION",
                  description: "Price is above SMA 200D",
                  result: "FALSE",
                  metric: 95,
                  value: 100,
                },
              ],
            },
          ],
        },
      });
    });

    it("adds the owner's own Monitors, explaining a change recorded without evidence by its rule alone", async () => {
      const body = (await owner.get("/dashboard/activity").expect(200))
        .body as DashboardActivityResponse;
      const events = ours(body);
      expect(events.map((event) => event.monitor.id)).toEqual([
        ids.own,
        ids.builtIn,
        ids.builtIn,
        ids.builtIn,
      ]);
      expect(events[0]!.why).toEqual({
        basis: "RULE_ONLY",
        sessionDate: "2026-10-14",
        rules: [
          {
            predicates: [
              { role: "CONDITION", description: "Price is above SMA 200D" },
            ],
          },
        ],
      });
      // Another customer never sees the owner's Monitor.
      const theirs = (await other.get("/dashboard/activity").expect(200))
        .body as DashboardActivityResponse;
      expect(
        ours(theirs).every((event) => event.monitor.id === ids.builtIn),
      ).toBe(true);
    });

    it("pages by session and insertion order, and narrows to one visible Monitor", async () => {
      const first = (
        await owner
          .get(`/dashboard/activity?monitorId=${ids.builtIn}&limit=2`)
          .expect(200)
      ).body as DashboardActivityResponse;
      expect(first.events.map((event) => event.sessionDate)).toEqual([
        "2026-10-14",
        "2026-10-13",
      ]);
      expect(first.nextCursor).toBeDefined();
      const second = (
        await owner
          .get(
            `/dashboard/activity?monitorId=${ids.builtIn}&limit=2&cursor=${first.nextCursor}`,
          )
          .expect(200)
      ).body as DashboardActivityResponse;
      expect(second.events.map((event) => event.sessionDate)).toEqual([
        "2026-10-09",
      ]);
      expect(second.nextCursor).toBeUndefined();

      // Someone else's Monitor yields nothing; a forged cursor is refused.
      const foreign = (
        await other.get(`/dashboard/activity?monitorId=${ids.own}`).expect(200)
      ).body as DashboardActivityResponse;
      expect(foreign.events).toEqual([]);
      await owner.get("/dashboard/activity?cursor=not-a-cursor").expect(400);
      await owner.get("/dashboard/activity?limit=500").expect(400);
      await owner.get("/dashboard/activity?since=2026-01-01").expect(400);
    });

    it("leaves out a built-in the viewer hid", async () => {
      await owner
        .put(`/dashboard/monitors/${ids.builtIn}/visibility`)
        .send({ visible: false })
        .expect(200);
      const body = (await owner.get("/dashboard/activity").expect(200))
        .body as DashboardActivityResponse;
      expect(ours(body).map((event) => event.monitor.id)).toEqual([ids.own]);
      await owner
        .put(`/dashboard/monitors/${ids.builtIn}/visibility`)
        .send({ visible: true })
        .expect(200);
    });
  });

  describe("the Monitor's Signal table", () => {
    it("lists active occurrences first, then resolved ones, each with why it is there", async () => {
      const body = (
        await guest.get(`/monitors/${ids.builtIn}/signals`).expect(200)
      ).body as MonitorSignalPageResponse;
      expect(
        body.rows.map((row) => [row.id, row.state, row.sessionDate]),
      ).toEqual([
        [signal.b, "ACTIVE", "2026-10-14"],
        [signal.c, "ACTIVE", "2026-10-01"],
        [signal.a, "RESOLVED", "2026-10-13"],
        // Ended administratively: placed by the New York day it was recorded.
        [signal.d, "RESOLVED", "2026-10-12"],
      ]);
      const [active, replayed, resolved, administrative] = body.rows as [
        (typeof body.rows)[number],
        (typeof body.rows)[number],
        (typeof body.rows)[number],
        (typeof body.rows)[number],
      ];
      expect(active.why).toMatchObject({
        basis: "EVIDENCE",
        rules: [{ predicates: [{ result: "TRUE", metric: 106 }] }],
      });
      expect(replayed.fromHistory).toBe(true);
      expect(resolved).toMatchObject({
        activatedOn: "2026-10-09",
        activationPrice: 105,
        resolvedOn: "2026-10-13",
        resolutionReason: "CONDITIONS_ENDED",
        why: {
          basis: "EVIDENCE",
          sessionDate: "2026-10-13",
          rules: [{ predicates: [{ result: "FALSE", metric: 95 }] }],
        },
      });
      expect(administrative.resolutionReason).toBe("MEMBERSHIP_CHANGED");
      expect(administrative.resolvedOn).toBeUndefined();
      expect(administrative.why?.basis).toBe("RULE_ONLY");
    });

    it("pages across both groups, filters by state and level, and lists waiting setups on request", async () => {
      const first = (
        await guest.get(`/monitors/${ids.builtIn}/signals?limit=3`).expect(200)
      ).body as MonitorSignalPageResponse;
      expect(first.rows.map((row) => row.id)).toEqual([
        signal.b,
        signal.c,
        signal.a,
      ]);
      const second = (
        await guest
          .get(
            `/monitors/${ids.builtIn}/signals?limit=3&cursor=${first.nextCursor}`,
          )
          .expect(200)
      ).body as MonitorSignalPageResponse;
      expect(second.rows.map((row) => row.id)).toEqual([signal.d]);
      expect(second.nextCursor).toBeUndefined();

      const resolved = (
        await guest
          .get(`/monitors/${ids.builtIn}/signals?state=RESOLVED`)
          .expect(200)
      ).body as MonitorSignalPageResponse;
      expect(resolved.rows.map((row) => row.id)).toEqual([signal.a, signal.d]);
      const sells = (
        await guest
          .get(`/monitors/${ids.builtIn}/signals?levelKind=SELL`)
          .expect(200)
      ).body as MonitorSignalPageResponse;
      expect(sells.rows).toEqual([]);

      const pending = (
        await guest
          .get(`/monitors/${ids.builtIn}/signals?state=PENDING_TRIGGER`)
          .expect(200)
      ).body as MonitorSignalPageResponse;
      expect(pending.rows).toHaveLength(1);
      expect(pending.rows[0]).toMatchObject({
        state: "PENDING_TRIGGER",
        sessionDate: "2026-10-10",
        activationPrice: 102,
        fromHistory: false,
        why: { basis: "EVIDENCE", sessionDate: "2026-10-10" },
      });

      await guest
        .get(`/monitors/${ids.builtIn}/signals?state=OPEN`)
        .expect(400);
      await guest
        .get(`/monitors/${ids.builtIn}/signals?cursor=bogus`)
        .expect(400);
    });

    it("is visible exactly where the Monitor is", async () => {
      await guest.get(`/monitors/${ids.own}/signals`).expect(404);
      await other.get(`/monitors/${ids.own}/signals`).expect(404);
      const mine = (await owner.get(`/monitors/${ids.own}/signals`).expect(200))
        .body as MonitorSignalPageResponse;
      expect(mine.rows).toHaveLength(1);
      expect(mine.rows[0]!.why?.basis).toBe("RULE_ONLY");
    });
  });

  it("reports the coverage line from the members' checkpoints", async () => {
    const body = (await guest.get(`/monitors/${ids.builtIn}`).expect(200))
      .body as MonitorDetailResponse;
    expect(body.coverage).toEqual({
      latestSession: "2026-10-14",
      evaluatedMembers: 1,
      currentMembers: 2,
      listedMembers: 2,
    });
    const detail = body.signals.find((row) => row.id === signal.a);
    expect(detail).toMatchObject({
      observationBasis: "EOD_CLOSE",
      resolvedObservationDate: "2026-10-13",
    });
  });
});
