import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  STRATEGY_SCHEMA_VERSION,
  type DashboardActivityResponse,
  type MonitorDetailResponse,
  type MonitorDetailSummaryResponse,
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
import { DASHBOARD_OPTIONS } from "./dashboard.tokens";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * The Monitor history read models (`docs/decisions/monitor-eod-v2.md` §6): the Dashboard's Monitor
 * Activity feed, the Monitor's one Signal table, and its coverage line — each a projection of what
 * the worker recorded, with every Why rendered from the version and evidence stored beside it.
 *
 * Rows are seeded exactly as the EOD evaluation writes them, so what these cases pin is the read
 * side: which changes count as activity (§12: finalized sessions only, observed or found afterwards,
 * always with recorded evidence, never an intraday occurrence, within the Dashboard's rolling 30-day
 * window), the order, the paging, which Monitors are enabled for the viewer, and the Signal table's
 * fallback to the rule's wording when no evidence was recorded.
 *
 * The Dashboard's clock is pinned to Thursday 2026-10-15, so its window is Sep 15 – Oct 14.
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
  const signal = {
    a: "",
    b: "",
    c: "",
    d: "",
    e: "",
    live: "",
    old: "",
    ownEvidenced: "",
  };
  /** Events that must never reach the Dashboard feed, by why. */
  const excluded = { live: "", oldWindow: "", ownRuleOnly: "" };

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
    occurredAt?: Date;
  }) {
    return prisma.monitorStateTransition.create({
      data: {
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
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
    basis?: "LIVE_QUOTE" | "EOD_CLOSE";
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
        observationBasis: input.basis ?? "EOD_CLOSE",
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
    })
      .overrideProvider(DASHBOARD_OPTIONS)
      .useValue({
        staleAfterMs: 30 * 60_000,
        now: () => new Date("2026-10-15T12:00:00.000Z"),
      })
      .compile();
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
    // S2: activated Oct 6 while the Monitor was paused, found by its catch-up on Oct 12 — an event,
    // From history, dated by its session.
    signal.e = await createSignal({
      monitorId: ids.builtIn,
      securityId: s2,
      versionId: ids.builtInVersion,
      on: "2026-10-06",
      price: 104,
      reconstructed: true,
    });
    await transition({
      monitorId: ids.builtIn,
      securityId: s2,
      from: "INACTIVE",
      to: "ACTIVE",
      reason: "CONDITIONS_MET",
      origin: "HISTORY",
      on: "2026-10-06",
      signalId: signal.e,
      versionId: ids.builtInVersion,
      evidence: evidence("TRUE", 104),
      occurredAt: new Date("2026-10-12T22:05:00.000Z"),
    });
    // An occurrence the live-quote Monitor decided on an intraday price, ended by an EOD session
    // with evidence: neither change is activity.
    signal.live = await createSignal({
      monitorId: ids.builtIn,
      securityId: s1,
      versionId: ids.builtInVersion,
      on: "2026-10-02",
      price: 101.37,
      basis: "LIVE_QUOTE",
      resolvedOn: "2026-10-08",
      resolvedAt: new Date("2026-10-08T22:00:00.000Z"),
      reason: "CONDITIONS_ENDED",
    });
    await transition({
      monitorId: ids.builtIn,
      securityId: s1,
      from: "INACTIVE",
      to: "ACTIVE",
      reason: "CONDITIONS_MET",
      origin: "OBSERVED",
      on: "2026-10-02",
      signalId: signal.live,
    });
    excluded.live = (
      await transition({
        monitorId: ids.builtIn,
        securityId: s1,
        from: "ACTIVE",
        to: "RESOLVED",
        reason: "CONDITIONS_ENDED",
        origin: "OBSERVED",
        on: "2026-10-08",
        signalId: signal.live,
        versionId: ids.builtInVersion,
        evidence: evidence("FALSE", 98),
      })
    ).id;
    // Observed, with evidence — but on Sep 10, before the Dashboard's window: on the Monitor's own
    // history only.
    signal.old = await createSignal({
      monitorId: ids.builtIn,
      securityId: s1,
      versionId: ids.builtInVersion,
      on: "2026-09-10",
      price: 102,
      resolvedOn: "2026-09-11",
      resolvedAt: new Date("2026-09-11T22:00:00.000Z"),
      reason: "CONDITIONS_ENDED",
    });
    excluded.oldWindow = (
      await transition({
        monitorId: ids.builtIn,
        securityId: s1,
        from: "INACTIVE",
        to: "ACTIVE",
        reason: "CONDITIONS_MET",
        origin: "OBSERVED",
        on: "2026-09-10",
        signalId: signal.old,
        versionId: ids.builtInVersion,
        evidence: evidence("TRUE", 102),
      })
    ).id;
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
    // The owner's Monitor: an activation recorded before evidence existed — never activity until
    // its evidence is verified and recorded — and one recorded with its evidence.
    const ownSignal = await createSignal({
      monitorId: ids.own,
      securityId: s2,
      versionId: ids.ownVersion,
      on: "2026-10-14",
      price: 50,
    });
    excluded.ownRuleOnly = (
      await transition({
        monitorId: ids.own,
        securityId: s2,
        from: "INACTIVE",
        to: "ACTIVE",
        reason: "CONDITIONS_MET",
        origin: "OBSERVED",
        on: "2026-10-14",
        signalId: ownSignal,
      })
    ).id;
    signal.ownEvidenced = await createSignal({
      monitorId: ids.own,
      securityId: s1,
      versionId: ids.ownVersion,
      on: "2026-10-12",
      price: 51,
    });
    await transition({
      monitorId: ids.own,
      securityId: s1,
      from: "INACTIVE",
      to: "ACTIVE",
      reason: "CONDITIONS_MET",
      origin: "OBSERVED",
      on: "2026-10-12",
      signalId: signal.ownEvidenced,
      versionId: ids.ownVersion,
      evidence: evidence("TRUE", 101.5),
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
    it("shows the window's end-of-day activations and market resolutions, with evidence, newest session first", async () => {
      const body = (await guest.get("/dashboard/activity").expect(200))
        .body as DashboardActivityResponse;
      expect(body.viewer).toBe("GUEST");
      expect(body.windowStart).toBe("2026-09-15");
      // A Guest sees the published built-in only. A reconstructed state, an administrative ending,
      // a trigger day passing, a setup, a live-quote occurrence and a session before the window are
      // never activity; one found afterwards is, From history.
      expect(
        ours(body).map((event) => [
          event.sessionDate,
          event.kind,
          event.reason,
          event.fromHistory,
        ]),
      ).toEqual([
        ["2026-10-14", "ACTIVATED", "CONDITIONS_MET", false],
        ["2026-10-13", "RESOLVED", "CONDITIONS_ENDED", false],
        ["2026-10-09", "ACTIVATED", "CONDITIONS_MET", false],
        ["2026-10-06", "ACTIVATED", "CONDITIONS_MET", true],
      ]);
      const ids_ = ours(body).map((event) => event.id);
      for (const id of Object.values(excluded)) {
        expect(ids_).not.toContain(id);
      }
      // Every event explains itself with the values its session compared — never a rule alone.
      expect(
        ours(body).every(
          (event) =>
            event.why.basis === "EVIDENCE" &&
            event.why.rules.every((rule) =>
              rule.predicates.every(
                (predicate) =>
                  predicate.result !== undefined &&
                  predicate.metric !== undefined,
              ),
            ),
        ),
      ).toBe(true);
      expect(ours(body).every((event) => !("observationBasis" in event))).toBe(
        true,
      );
      const resolved = ours(body)[1]!;
      expect(resolved).toMatchObject({
        levelKind: "BUY",
        levelIndex: 1,
        levelPercentage: 100,
        signalId: signal.a,
        price: 105,
        fromHistory: false,
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
      // From history keeps both dates apart: the session it happened on, and when it was found.
      const found = ours(body)[3]!;
      expect(found).toMatchObject({
        sessionDate: "2026-10-06",
        recordedAt: "2026-10-12T22:05:00.000Z",
        signalId: signal.e,
        fromHistory: true,
      });
    });

    it("adds the owner's own enabled Monitors, never a change recorded without evidence", async () => {
      const body = (await owner.get("/dashboard/activity").expect(200))
        .body as DashboardActivityResponse;
      const events = ours(body);
      expect(
        events.map((event) => [event.monitor.id, event.sessionDate]),
      ).toEqual([
        [ids.builtIn, "2026-10-14"],
        [ids.builtIn, "2026-10-13"],
        [ids.own, "2026-10-12"],
        [ids.builtIn, "2026-10-09"],
        [ids.builtIn, "2026-10-06"],
      ]);
      expect(events[2]!.why).toEqual({
        basis: "EVIDENCE",
        sessionDate: "2026-10-12",
        rules: [
          {
            predicates: [
              {
                role: "CONDITION",
                description: "Price is above SMA 200D",
                result: "TRUE",
                metric: 101.5,
                value: 100,
              },
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
        "2026-10-06",
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

    it("narrows to one kind of event in the query, so pages, cursors and the Monitor filter stay exact", async () => {
      const activated = (
        await owner.get("/dashboard/activity?kind=ACTIVATED").expect(200)
      ).body as DashboardActivityResponse;
      expect(
        ours(activated).map((event) => [
          event.monitor.id,
          event.sessionDate,
          event.kind,
        ]),
      ).toEqual([
        [ids.builtIn, "2026-10-14", "ACTIVATED"],
        [ids.own, "2026-10-12", "ACTIVATED"],
        [ids.builtIn, "2026-10-09", "ACTIVATED"],
        [ids.builtIn, "2026-10-06", "ACTIVATED"],
      ]);
      const resolved = (
        await owner.get("/dashboard/activity?kind=RESOLVED").expect(200)
      ).body as DashboardActivityResponse;
      expect(
        ours(resolved).map((event) => [event.sessionDate, event.kind]),
      ).toEqual([["2026-10-13", "RESOLVED"]]);

      // Both filters at once, one event per page: the cursor continues within the filter and
      // never surfaces the other kind or the other Monitor.
      const first = (
        await owner
          .get(
            `/dashboard/activity?monitorId=${ids.builtIn}&kind=ACTIVATED&limit=1`,
          )
          .expect(200)
      ).body as DashboardActivityResponse;
      expect(first.events.map((event) => event.sessionDate)).toEqual([
        "2026-10-14",
      ]);
      expect(first.nextCursor).toBeDefined();
      const second = (
        await owner
          .get(
            `/dashboard/activity?monitorId=${ids.builtIn}&kind=ACTIVATED&limit=1&cursor=${first.nextCursor}`,
          )
          .expect(200)
      ).body as DashboardActivityResponse;
      expect(
        second.events.map((event) => [event.sessionDate, event.kind]),
      ).toEqual([["2026-10-09", "ACTIVATED"]]);
      const third = (
        await owner
          .get(
            `/dashboard/activity?monitorId=${ids.builtIn}&kind=ACTIVATED&limit=1&cursor=${second.nextCursor}`,
          )
          .expect(200)
      ).body as DashboardActivityResponse;
      expect(
        third.events.map((event) => [event.sessionDate, event.kind]),
      ).toEqual([["2026-10-06", "ACTIVATED"]]);
      expect(third.nextCursor).toBeUndefined();

      await owner.get("/dashboard/activity?kind=ENDED").expect(400);
      await owner.get("/dashboard/activity?kind=").expect(400);
    });

    it("leaves out a built-in the viewer disabled, for that viewer alone", async () => {
      await owner
        .patch(`/monitors/${ids.builtIn}`)
        .send({ enabled: false })
        .expect(200);
      try {
        const body = (await owner.get("/dashboard/activity").expect(200))
          .body as DashboardActivityResponse;
        expect(ours(body).map((event) => event.monitor.id)).toEqual([
          ids.own,
        ]);
        // Asked for by id, it is still not activity for them.
        expect(
          (
            await owner
              .get(`/dashboard/activity?monitorId=${ids.builtIn}`)
              .expect(200)
          ).body.events,
        ).toEqual([]);
        // Another user's feed, a Guest's and the shared Monitor are untouched.
        const theirs = (await other.get("/dashboard/activity").expect(200))
          .body as DashboardActivityResponse;
        expect(ours(theirs)).toHaveLength(4);
        expect(
          ours(
            (await guest.get("/dashboard/activity").expect(200))
              .body as DashboardActivityResponse,
          ),
        ).toHaveLength(4);
        expect(
          await prisma.monitor.findUniqueOrThrow({
            where: { id: ids.builtIn },
            select: { isPublished: true },
          }),
        ).toEqual({ isPublished: true });
      } finally {
        await owner
          .patch(`/monitors/${ids.builtIn}`)
          .send({ enabled: true })
          .expect(200);
      }
    });

    it("re-reads the range a reader holds, through a given event, so an event written late for an older session appears in place", async () => {
      const [s1] = securityIds as [string];
      const scoped = `/dashboard/activity?monitorId=${ids.builtIn}`;
      const read = async (path: string) =>
        (await owner.get(path).expect(200)).body as DashboardActivityResponse;
      const created: string[] = [];
      const createdSignals: string[] = [];
      try {
        // The reader holds the newest two events: their range ends at the October 13 ending.
        const held = await read(`${scoped}&limit=2`);
        expect(held.events.map((event) => event.sessionDate)).toEqual([
          "2026-10-14",
          "2026-10-13",
        ]);
        const bottom = held.events[1]!;

        // An event written now for October 13, a session the reader already passed, and one for an
        // older session, which lies outside what they hold.
        const lateSignal = await createSignal({
          monitorId: ids.builtIn,
          securityId: s1,
          versionId: ids.builtInVersion,
          on: "2026-10-13",
          price: 103,
        });
        createdSignals.push(lateSignal);
        const late = await transition({
          monitorId: ids.builtIn,
          securityId: s1,
          from: "INACTIVE",
          to: "ACTIVE",
          reason: "CONDITIONS_MET",
          origin: "OBSERVED",
          on: "2026-10-13",
          signalId: lateSignal,
          versionId: ids.builtInVersion,
          evidence: evidence("TRUE", 103),
        });
        const older = await transition({
          monitorId: ids.builtIn,
          securityId: s1,
          from: "INACTIVE",
          to: "ACTIVE",
          reason: "CONDITIONS_MET",
          origin: "OBSERVED",
          on: "2026-10-01",
          signalId: lateSignal,
          versionId: ids.builtInVersion,
          evidence: evidence("TRUE", 103),
        });
        created.push(late.id, older.id);

        // Re-reading through the bottom event returns the whole range again — the late event in its
        // session, newest written first — and nothing below it.
        const range = await read(`${scoped}&through=${bottom.id}`);
        expect(
          range.events.map((event) => [event.id, event.sessionDate]),
        ).toEqual([
          [held.events[0]!.id, "2026-10-14"],
          [late.id, "2026-10-13"],
          [bottom.id, "2026-10-13"],
        ]);
        expect(range.nextCursor).toBeUndefined();
        // The older one is reached by paging, in its place.
        const next = await read(`${scoped}&limit=5&cursor=${held.nextCursor}`);
        expect(next.events.map((event) => event.id)).toContain(older.id);

        // The kind filter narrows the range too; an event of another kind ends it at once.
        expect(
          (
            await read(`${scoped}&kind=ACTIVATED&through=${late.id}`)
          ).events.map((event) => event.id),
        ).toEqual([held.events[0]!.id, late.id]);
        expect(
          (await read(`${scoped}&kind=ACTIVATED&through=${bottom.id}`)).events,
        ).toEqual([]);
        // So does an event the viewer cannot see in this feed.
        expect(
          (
            await read(
              `/dashboard/activity?monitorId=${ids.own}&through=${bottom.id}`,
            )
          ).events,
        ).toEqual([]);

        // A range longer than one read continues with the cursor, still bounded by `through`.
        const backlog = Array.from({ length: 201 }, () => ({
          monitorId: ids.builtIn,
          securityId: s1,
          levelId: "buy-1",
          levelKind: "BUY" as const,
          signalFingerprint: "fingerprint",
          fromState: "INACTIVE" as const,
          toState: "ACTIVE" as const,
          reason: "CONDITIONS_MET" as const,
          origin: "OBSERVED" as const,
          observationDate: date("2026-10-15"),
          strategyVersionId: ids.builtInVersion,
          signalId: lateSignal,
          evidence: evidence("TRUE", 107),
        }));
        await prisma.monitorStateTransition.createMany({ data: backlog });
        const written = await prisma.monitorStateTransition.findMany({
          where: {
            monitorId: ids.builtIn,
            observationDate: date("2026-10-15"),
          },
          select: { id: true },
        });
        created.push(...written.map((row) => row.id));
        const first = await read(`${scoped}&through=${bottom.id}`);
        expect(first.events).toHaveLength(200);
        expect(first.nextCursor).toBeDefined();
        const rest = await read(
          `${scoped}&through=${bottom.id}&cursor=${first.nextCursor}`,
        );
        expect(rest.nextCursor).toBeUndefined();
        expect(rest.events.at(-1)?.id).toBe(bottom.id);
        expect(first.events.length + rest.events.length).toBe(201 + 3);

        await owner.get(`${scoped}&through=not-an-id`).expect(400);
      } finally {
        await prisma.monitorStateTransition.deleteMany({
          where: { id: { in: created } },
        });
        await prisma.monitorSignal.deleteMany({
          where: { id: { in: createdSignals } },
        });
      }
    });
  });

  describe("a Monitor's own Activity history", () => {
    const history = async (
      agent: ReturnType<typeof request.agent> | ReturnType<typeof request>,
      monitorId: string,
      query = "",
    ) =>
      (await agent.get(`/monitors/${monitorId}/activity${query}`).expect(200))
        .body as DashboardActivityResponse;

    it("is the Dashboard feed narrowed to that Monitor, unwindowed: the same events, in the same order", async () => {
      const builtIn = await history(guest, ids.builtIn);
      const narrowed = (
        await guest
          .get(`/dashboard/activity?monitorId=${ids.builtIn}`)
          .expect(200)
      ).body as DashboardActivityResponse;
      // The same events inside the Dashboard's window, and the older ones besides — every one of
      // them still an end-of-day change with its evidence.
      expect(builtIn).not.toHaveProperty("windowStart");
      expect(
        builtIn.events.filter(
          (event) => event.sessionDate >= narrowed.windowStart!,
        ),
      ).toEqual(narrowed.events);
      expect(builtIn.events.map((event) => event.id)).toContain(
        excluded.oldWindow,
      );
      expect(builtIn.events.map((event) => event.id)).not.toContain(
        excluded.live,
      );
      expect(builtIn.events.length).toBeGreaterThan(0);

      const own = await history(owner, ids.own);
      expect(own.events.every((event) => event.monitor.id === ids.own)).toBe(
        true,
      );
      const ownNarrowed = (
        await owner.get(`/dashboard/activity?monitorId=${ids.own}`).expect(200)
      ).body as DashboardActivityResponse;
      expect(own.events).toEqual(ownNarrowed.events);
    });

    it("keeps a Monitor's history on its own page when the Dashboard does not show it", async () => {
      const before = await history(owner, ids.builtIn);
      // Disabled for this viewer: gone from their feed, still on the Monitor's page.
      await owner
        .patch(`/monitors/${ids.builtIn}`)
        .send({ enabled: false })
        .expect(200);
      try {
        const feed = (
          await owner
            .get(`/dashboard/activity?monitorId=${ids.builtIn}`)
            .expect(200)
        ).body as DashboardActivityResponse;
        expect(feed.events).toEqual([]);
        expect((await history(owner, ids.builtIn)).events).toEqual(
          before.events,
        );
      } finally {
        await owner
          .patch(`/monitors/${ids.builtIn}`)
          .send({ enabled: true })
          .expect(200);
      }

      // Switched off by its owner: no longer on the Dashboard, its history still its own.
      const ownBefore = await history(owner, ids.own);
      await prisma.monitor.update({
        where: { id: ids.own },
        data: { enabled: false },
      });
      try {
        const feed = (
          await owner
            .get(`/dashboard/activity?monitorId=${ids.own}`)
            .expect(200)
        ).body as DashboardActivityResponse;
        expect(feed.events).toEqual([]);
        expect((await history(owner, ids.own)).events).toEqual(
          ownBefore.events,
        );
      } finally {
        await prisma.monitor.update({
          where: { id: ids.own },
          data: { enabled: true },
        });
      }
    });

    it("is visible exactly where the Monitor is", async () => {
      await guest.get(`/monitors/${ids.own}/activity`).expect(404);
      await other.get(`/monitors/${ids.own}/activity`).expect(404);
      await owner.get(`/monitors/${randomUUID()}/activity`).expect(404);
      await owner.get(`/monitors/${ids.own}/activity`).expect(200);
      await other.get(`/monitors/${ids.builtIn}/activity`).expect(200);
    });

    it("pages with the feed's own cursors, and takes no Monitor filter of its own", async () => {
      const all = await history(guest, ids.builtIn);
      const first = await history(guest, ids.builtIn, "?limit=1");
      expect(first.events).toEqual(all.events.slice(0, 1));
      expect(first.nextCursor).toBeTruthy();
      const second = await history(
        guest,
        ids.builtIn,
        `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      );
      expect(second.events).toEqual(all.events.slice(1, 2));
      // `through` re-reads the range held, as on the Dashboard.
      const through = await history(
        guest,
        ids.builtIn,
        `?through=${second.events[0]!.id}`,
      );
      expect(through.events).toEqual(all.events.slice(0, 2));
      const kind = await history(guest, ids.builtIn, "?kind=RESOLVED");
      expect(kind.events.every((event) => event.kind === "RESOLVED")).toBe(
        true,
      );

      await guest
        .get(`/monitors/${ids.builtIn}/activity?monitorId=${ids.own}`)
        .expect(400);
      await guest
        .get(`/monitors/${ids.builtIn}/activity?cursor=not-a-cursor`)
        .expect(400);
    });
  });

  it("answers the page as it renders with ?view=summary: members counted, no member rows or Signals", async () => {
    const full = (await guest.get(`/monitors/${ids.builtIn}`).expect(200))
      .body as MonitorDetailResponse;
    const summary = (
      await guest.get(`/monitors/${ids.builtIn}?view=summary`).expect(200)
    ).body as MonitorDetailSummaryResponse;

    expect(summary).not.toHaveProperty("securities");
    expect(summary).not.toHaveProperty("signals");
    expect(summary.memberCounts.total).toBe(full.securities.length);
    const counted: Record<string, number> = {};
    for (const entry of full.securities) {
      counted[entry.status] = (counted[entry.status] ?? 0) + 1;
    }
    for (const [status, count] of Object.entries(
      summary.memberCounts.byStatus,
    )) {
      expect(count, status).toBe(counted[status] ?? 0);
    }
    // Everything else is the full detail's, exactly.
    const without = <T extends object>(value: T, keys: readonly string[]) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => !keys.includes(key)),
      );
    expect(without(summary, ["memberCounts"])).toEqual(
      without(full, ["securities", "signals"]),
    );
    // Visible exactly where the full detail is.
    await guest.get(`/monitors/${ids.own}?view=summary`).expect(404);
  });

  describe("the Monitor's Signal table", () => {
    // The feed's own fixtures — an occurrence found by a catch-up, a live-quote one and one older
    // than the window — are not this table's cases.
    beforeAll(async () => {
      const feedOnly = [
        signal.e,
        signal.live,
        signal.old,
        signal.ownEvidenced,
      ];
      await prisma.monitorStateTransition.deleteMany({
        where: { signalId: { in: feedOnly } },
      });
      await prisma.monitorSignal.deleteMany({
        where: { id: { in: feedOnly } },
      });
    });

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

    it("pages one table by keyset, counting each group, and refuses a cursor from other filters", async () => {
      const url = `/monitors/${ids.builtIn}/signals`;
      const read = async (path: string) =>
        (await guest.get(path).expect(200)).body as MonitorSignalPageResponse;
      const first = await read(`${url}?limit=1`);
      expect(first.counts).toEqual({ active: 2, ended: 2, waiting: 1 });
      const seen = first.rows.map((row) => row.id);
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await read(`${url}?limit=1&cursor=${cursor}`);
        expect(page.counts).toBeUndefined();
        seen.push(...page.rows.map((row) => row.id));
        cursor = page.nextCursor;
      }
      // One row at a time, across both groups: every occurrence exactly once, in order.
      expect(seen).toEqual([signal.b, signal.c, signal.a, signal.d]);

      // Waiting setups page by keyset too.
      const waiting = await read(`${url}?state=PENDING_TRIGGER&limit=1`);
      expect(waiting.rows).toHaveLength(1);
      expect(waiting.nextCursor).toBeUndefined();

      // A cursor continues only the filters it was issued for.
      const activeOnly = await read(`${url}?state=ACTIVE&limit=1`);
      await guest
        .get(`${url}?limit=1&cursor=${activeOnly.nextCursor}`)
        .expect(400);
      await guest
        .get(`${url}?state=RESOLVED&limit=1&cursor=${activeOnly.nextCursor}`)
        .expect(400);
    });

    it("restarts rather than mix two states when an evaluation lands between pages", async () => {
      const [s1] = securityIds as [string];
      const url = `/monitors/${ids.builtIn}/signals`;
      const read = async (path: string) =>
        (await guest.get(path).expect(200)).body as MonitorSignalPageResponse;
      const page1 = await read(`${url}?limit=1`);
      expect(page1.rows.map((row) => [row.id, row.state])).toEqual([
        [signal.b, "ACTIVE"],
      ]);
      let ending = "";
      try {
        // The next session's evaluation ends the occurrence the reader just saw as active — in one
        // transaction, as the worker writes it.
        const [, written] = await prisma.$transaction([
          prisma.monitorSignal.update({
            where: { id: signal.b },
            data: {
              resolvedAt: new Date("2026-10-15T22:00:00.000Z"),
              resolvedObservationDate: date("2026-10-15"),
              resolutionReason: "CONDITIONS_ENDED",
            },
          }),
          prisma.monitorStateTransition.create({
            data: {
              monitorId: ids.builtIn,
              securityId: s1,
              levelId: "buy-1",
              levelKind: "BUY",
              signalFingerprint: "fingerprint",
              fromState: "ACTIVE",
              toState: "RESOLVED",
              reason: "CONDITIONS_ENDED",
              origin: "OBSERVED",
              observationDate: date("2026-10-15"),
              signalId: signal.b,
            },
          }),
        ]);
        ending = written.id;
        // Continuing would show it again among the ended ones: the page is refused.
        await guest
          .get(`${url}?limit=1&cursor=${page1.nextCursor}`)
          .expect(409);

        // Starting over reads the table as it now is, each occurrence once.
        const restarted = await read(`${url}?limit=2`);
        expect(restarted.counts).toEqual({ active: 1, ended: 3, waiting: 1 });
        const rest = await read(
          `${url}?limit=2&cursor=${restarted.nextCursor}`,
        );
        expect(
          [...restarted.rows, ...rest.rows].map((row) => [row.id, row.state]),
        ).toEqual([
          [signal.c, "ACTIVE"],
          [signal.b, "RESOLVED"],
          [signal.a, "RESOLVED"],
          [signal.d, "RESOLVED"],
        ]);
      } finally {
        await prisma.monitorSignal.update({
          where: { id: signal.b },
          data: {
            resolvedAt: null,
            resolvedObservationDate: null,
            resolutionReason: null,
          },
        });
        if (ending) {
          await prisma.monitorStateTransition.delete({ where: { id: ending } });
        }
      }
      expect(
        (
          await prisma.monitorSignal.findUniqueOrThrow({
            where: { id: signal.b },
          })
        ).resolvedSession,
      ).toBeNull();
    });

    it("orders an ending no observation made by the New York day it was recorded", async () => {
      const [s1] = securityIds as [string];
      const created: string[] = [];
      try {
        // Observed ending on October 14 at 01:00 UTC; an administrative ending at 03:00 UTC the same
        // night — still October 13 in New York.
        created.push(
          await createSignal({
            monitorId: ids.builtIn,
            securityId: s1,
            versionId: ids.builtInVersion,
            on: "2026-10-02",
            price: 100,
            resolvedOn: "2026-10-14",
            resolvedAt: new Date("2026-10-14T01:00:00.000Z"),
            reason: "CONDITIONS_ENDED",
          }),
          await createSignal({
            monitorId: ids.builtIn,
            securityId: s1,
            versionId: ids.builtInVersion,
            on: "2026-10-03",
            price: 100,
            resolvedOn: null,
            resolvedAt: new Date("2026-10-14T03:00:00.000Z"),
            reason: "LEVEL_REMOVED",
          }),
        );
        const [observed, administrative] = created as [string, string];
        const stored = await prisma.monitorSignal.findUniqueOrThrow({
          where: { id: administrative },
        });
        expect(stored.resolvedSession?.toISOString().slice(0, 10)).toBe(
          "2026-10-13",
        );
        const resolved = (
          await guest
            .get(`/monitors/${ids.builtIn}/signals?state=RESOLVED`)
            .expect(200)
        ).body as MonitorSignalPageResponse;
        expect(resolved.rows.map((row) => row.id)).toEqual([
          observed,
          administrative,
          signal.a,
          signal.d,
        ]);
      } finally {
        await prisma.monitorSignal.deleteMany({
          where: { id: { in: created } },
        });
      }
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
