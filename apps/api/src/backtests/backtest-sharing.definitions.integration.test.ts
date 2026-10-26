import { randomBytes, randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  BACKTEST_SHARE_DEFINITIONS_UNAVAILABLE_CODE,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type BacktestRunDetailResponse,
  type BacktestRunSnapshot,
  type BacktestShareResponse,
  type SharedBacktestReportResponse,
  type StockListDetailResponse,
  type StrategyDefinition,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import {
  deserializeList,
  deserializeStrategy,
  describeDefinition,
  snapshotIndexMembershipResolver,
  snapshotListMembers,
  validateDefinition,
  type CanonicalListDocument,
  type CanonicalStrategyDocument,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { ListsModule } from "../lists/lists.module";
import { definitionHashOf } from "../strategies/strategy-versions";
import { StrategiesModule } from "../strategies/strategies.module";
import { BacktestsModule } from "./backtests.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * Canonical definitions on shared backtests, end to end: HTTP → Nest → share service → real
 * PostgreSQL (`docs/decisions/canonical-definitions-v1.md`).
 *
 * What is proved: a new link records both canonical documents and both descriptions, written from
 * the run's **frozen snapshot**; provenance is built-in, custom or derived on evidence — ownership,
 * the copy record, the copy's frozen logic or membership — and unknown otherwise; later edits and
 * deletions change nothing a link recorded; the owner's choice gates every custom and derived
 * description, a premium built-in's rules are never published, and a link created before
 * definitions were recorded reads exactly as it did; a definition that cannot be recorded leaves no
 * link behind; and a point-in-time universe is pinned, compactly, to the membership the run froze.
 */
describe("canonical definitions on shared backtests", () => {
  const suffix = randomUUID();
  const short = suffix.slice(0, 6).toUpperCase();
  const password = "Local-test-password-42";
  const ownerEmail = `share-def-owner-${suffix}@example.test`;
  const symbols = Array.from({ length: 4 }, (_, index) => `SD${short}${index}`);
  const providerSymbols = symbols.map((symbol) => `${symbol}-${suffix}`);
  const securityName = (index: number) => `Undisclosed Corp ${index} ${suffix}`;
  const BUILT_IN_STRATEGY_KEY = `share-def-trend-${short.toLowerCase()}`;
  const PREMIUM_STRATEGY_KEY = `share-def-premium-${short.toLowerCase()}`;
  const BUILT_IN_LIST_KEY = `share-def-leaders-${short.toLowerCase()}`;
  const TWIN_STRATEGY_KEY = `share-def-twin-${short.toLowerCase()}`;
  const UNIVERSE_KEY = "sp500-historical-pit";
  const CUSTOM_STRATEGY_NAME = `My secret edge ${suffix}`;
  const CUSTOM_LIST_NAME = `My watchlist ${suffix}`;

  const condition = (
    id: string,
    seriesId: string,
    operator: "IS_ABOVE" | "IS_BELOW" = "IS_ABOVE",
  ) => ({
    id,
    metric: { kind: "PRICE" as const },
    operator,
    value: { kind: "SERIES" as const, seriesId },
  });

  /** The official logic: buy above the 200-day average, exit below it. */
  const BUILT_IN_DEFINITION = normalizeStrategyDefinition({
    schemaVersion: 2,
    buyLevels: [
      {
        id: "bi-buy",
        percentage: 100,
        signal: { conditions: [condition("bi-buy-1", "SMA_200D")] },
      },
    ],
    sellLevels: [],
    finalExit: {
      id: "bi-exit",
      rules: [
        {
          id: "bi-exit-1",
          signal: {
            conditions: [condition("bi-exit-c", "SMA_200D", "IS_BELOW")],
          },
        },
      ],
    },
  });

  /** A customer's own logic: RSI and a valuation ratio. */
  const CUSTOM_DEFINITION = normalizeStrategyDefinition({
    schemaVersion: 2,
    buyLevels: [
      {
        id: "c-buy",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "c-buy-1",
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "IS_BELOW",
              value: { kind: "NUMBER", value: 27 },
            },
            {
              id: "c-buy-2",
              metric: {
                kind: "VALUATION_RATIO",
                ratioId: "PRICE_TO_EARNINGS_TTM",
              },
              operator: "IS_BELOW",
              value: { kind: "MULTIPLE", value: 13 },
            },
          ],
        },
      },
    ],
    sellLevels: [],
    finalExit: {
      id: "c-exit",
      rules: [
        {
          id: "c-exit-1",
          signal: {
            conditions: [condition("c-exit-c", "EMA_50D", "IS_BELOW")],
          },
        },
      ],
    },
  });

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let anonymous: ReturnType<typeof request>;
  let ownerId = "";
  const securityIds: string[] = [];
  let builtInStrategyId = "";
  let premiumStrategyId = "";
  let builtInListId = "";

  async function signIn(email: string) {
    const agent = request.agent(app.getHttpServer());
    await agent.post("/auth/login").send({ email, password }).expect(200);
    return agent;
  }

  /** Submits a run through the real route — so it carries a real snapshot — and completes it. */
  async function completedRun(
    strategyId: string,
    stockListId: string,
    period: { startDate: string; endDate: string } = {
      startDate: "2015-01-02",
      endDate: "2020-12-31",
    },
  ): Promise<string> {
    const submitted = await owner.post("/backtests").send({
      strategyId,
      stockListId,
      ...period,
      initialCapital: 100_000,
      monthlyContribution: 0,
      maximumPositions: 5,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    const runId = (submitted.body as BacktestRunDetailResponse).id;
    await prisma.backtestRun.update({
      where: { id: runId },
      data: {
        status: "COMPLETED",
        startedAt: new Date(),
        completedAt: new Date(),
        job: { update: { status: "COMPLETED" } },
      },
    });
    await prisma.backtestRunSummary.create({
      data: {
        runId,
        firstSimulatedDate: new Date(`${period.startDate}T00:00:00.000Z`),
        lastSimulatedDate: new Date(`${period.endDate}T00:00:00.000Z`),
        tradingDays: 1,
        investedCapital: 100_000,
        finalCash: 100_000,
        finalPositionsValue: 0,
        finalValue: 110_000,
        netProfit: 10_000,
        portfolioReturnPercent: 10,
        benchmarkReturnPercent: 8,
        alphaPercent: 2,
        portfolioCagrPercent: 1.9,
        maxDrawdownPercent: 12,
        benchmarkMaxDrawdownPercent: 20,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalTrades: 0,
        buyTrades: 0,
        sellTrades: 0,
        finalExitTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        openPositions: 0,
      },
    });
    return runId;
  }

  async function share(
    runId: string,
    body?: { publishDescriptions?: boolean },
  ): Promise<BacktestShareResponse> {
    const call = owner.put(`/backtests/${runId}/share`);
    const response = await (body ? call.send(body) : call);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as BacktestShareResponse;
  }

  function tokenOf(response: BacktestShareResponse): string {
    const token = response.url?.split("/share/")[1];
    if (!token) {
      throw new Error(`Not a share URL: ${response.url}`);
    }
    return token;
  }

  async function report(
    token: string,
  ): Promise<{ body: SharedBacktestReportResponse; text: string }> {
    const response = await anonymous
      .get(`/shared-backtests/${token}`)
      .expect(200);
    return {
      body: response.body as SharedBacktestReportResponse,
      text: response.text,
    };
  }

  async function recorded(runId: string) {
    const row = await prisma.backtestShare.findUniqueOrThrow({
      where: { runId },
      select: {
        definitions: true,
        descriptions: true,
        publishDescriptions: true,
      },
    });
    const definitions = row.definitions as unknown as {
      strategy: CanonicalStrategyDocument;
      list: CanonicalListDocument;
    } | null;
    return { ...row, definitions };
  }

  async function snapshotOf(runId: string): Promise<BacktestRunSnapshot> {
    const row = await prisma.backtestRun.findUniqueOrThrow({
      where: { id: runId },
      select: { snapshot: true },
    });
    return row.snapshot as unknown as BacktestRunSnapshot;
  }

  async function createStrategy(
    name: string,
    definition: StrategyDefinition,
  ): Promise<string> {
    const response = await owner
      .post("/strategies")
      .send({ name, definition })
      .expect(201);
    return (response.body as StrategyDetailResponse).id;
  }

  async function createList(name: string): Promise<StockListDetailResponse> {
    const response = await owner
      .post("/lists")
      .send({ name, securityIds })
      .expect(201);
    return response.body as StockListDetailResponse;
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";
    process.env.WEB_BASE_URL = "https://factorsage.example.test";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigurationModule,
        DatabaseModule,
        AuthModule,
        BacktestsModule,
        BenchmarksModule,
        StrategiesModule,
        ListsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);

    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const created = await prisma.user.create({
      data: {
        email: ownerEmail,
        passwordHash,
        emailVerifiedAt: new Date(),
        plan: "PRO",
      },
      select: { id: true },
    });
    ownerId = created.id;

    for (const [index, symbol] of symbols.entries()) {
      const security = await prisma.security.create({
        data: {
          providerSymbol: providerSymbols[index] as string,
          symbol,
          name: securityName(index),
          exchangeCode: index % 2 === 0 ? "NASDAQ" : "NYSE",
          exchangeName: "Exchange",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
        select: { id: true },
      });
      securityIds.push(security.id);
    }

    const systemStrategy = (
      systemKey: string,
      name: string,
      premium: boolean,
    ) =>
      prisma.strategy.create({
        data: {
          ownership: "SYSTEM",
          systemKey,
          name,
          premium,
          versions: {
            create: {
              versionNumber: 1,
              definition: BUILT_IN_DEFINITION as unknown as object,
              definitionHash: definitionHashOf(BUILT_IN_DEFINITION),
            },
          },
        },
        select: { id: true },
      });
    builtInStrategyId = (
      await systemStrategy(BUILT_IN_STRATEGY_KEY, "Official Trend", false)
    ).id;
    premiumStrategyId = (
      await systemStrategy(PREMIUM_STRATEGY_KEY, "Official Premium Trend", true)
    ).id;
    // The premium twin holds different logic, so the copy-of-logic evidence stays unambiguous.
    await prisma.strategyVersion.updateMany({
      where: { strategyId: premiumStrategyId },
      data: {
        definition: CUSTOM_DEFINITION as unknown as object,
        definitionHash: `premium-${definitionHashOf(CUSTOM_DEFINITION)}`,
      },
    });
    const list = await prisma.stockList.create({
      data: {
        ownership: "SYSTEM",
        systemKey: BUILT_IN_LIST_KEY,
        name: "Official Leaders",
        items: {
          create: securityIds.map((securityId, index) => ({
            securityId,
            buyWindowMode:
              index === 0 ? ("CUSTOM" as const) : ("FULL" as const),
            ...(index === 0
              ? {
                  buyWindows: {
                    create: [
                      {
                        startDate: new Date("2016-03-01T00:00:00.000Z"),
                        endDate: null,
                      },
                    ],
                  },
                }
              : {}),
          })),
        },
      },
      select: { id: true },
    });
    builtInListId = list.id;

    owner = await signIn(ownerEmail);
    anonymous = request(app.getHttpServer());
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { email: ownerEmail } });
      await prisma.strategy.deleteMany({
        where: {
          systemKey: {
            in: [
              BUILT_IN_STRATEGY_KEY,
              PREMIUM_STRATEGY_KEY,
              TWIN_STRATEGY_KEY,
            ],
          },
        },
      });
      await prisma.stockList.deleteMany({
        where: { systemKey: { in: [BUILT_IN_LIST_KEY, UNIVERSE_KEY] } },
      });
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: providerSymbols } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  describe("a custom strategy and list", () => {
    let runId = "";
    let strategyId = "";
    let list: StockListDetailResponse;

    beforeAll(async () => {
      strategyId = await createStrategy(
        CUSTOM_STRATEGY_NAME,
        CUSTOM_DEFINITION,
      );
      list = await createList(CUSTOM_LIST_NAME);
      runId = await completedRun(strategyId, list.id);
    });

    it("records both canonical documents and both descriptions, from the frozen snapshot", async () => {
      const response = await share(runId);
      expect(response.publishDescriptions).toBe(false);
      expect(response.definitions).toEqual({
        strategy: {
          origin: "custom",
          publication: "opt_in",
          short:
            "Buys when RSI 14D is below 27 and P/E is below 13.0x. Closes the position when Price is below EMA 50D.",
        },
        list: {
          origin: "custom",
          publication: "opt_in",
          short: "4 securities, each eligible to buy on any date.",
        },
      });

      const row = await recorded(runId);
      const strategy = row.definitions?.strategy;
      const recordedList = row.definitions?.list;
      expect(validateDefinition(strategy).valid).toBe(true);
      expect(validateDefinition(recordedList).valid).toBe(true);
      expect(strategy?.provenance).toEqual({
        origin: "custom",
        evidence: "authored_record",
      });
      expect(recordedList?.provenance).toEqual({
        origin: "custom",
        evidence: "authored_record",
      });
      expect(row.descriptions).toEqual({
        strategy: describeDefinition(strategy),
        list: describeDefinition(recordedList),
      });

      // The recorded logic is the run's own: it reads back to the snapshot's fingerprint.
      const snapshot = await snapshotOf(runId);
      const { draft } = deserializeStrategy(strategy, {
        resolveActor: () => undefined,
      });
      expect(strategyDefinitionFingerprint(draft.definition)).toBe(
        strategyDefinitionFingerprint(
          normalizeStrategyDefinition(snapshot.strategy.definition),
        ),
      );
      expect(draft.name).toBe(CUSTOM_STRATEGY_NAME);
      const read = deserializeList(recordedList, {
        resolveSecurity: (security) =>
          snapshot.securities.find(
            (frozen) =>
              frozen.symbol === security.symbol &&
              frozen.exchangeCode === security.exchange,
          )?.securityId,
      });
      expect(read.members.map((member) => member.securityId).sort()).toEqual(
        [...securityIds].sort(),
      );
    });

    it("publishes the owner's descriptions only when the owner chooses to", async () => {
      const token = tokenOf(await share(runId));
      const withheld = await report(token);
      expect(withheld.body.definitions).toEqual({
        strategy: {
          origin: "custom",
          description: { status: "withheld", reason: "owner" },
        },
        list: {
          origin: "custom",
          description: { status: "withheld", reason: "owner" },
        },
      });
      expect(withheld.text).not.toContain("RSI 14D");

      const turnedOn = await share(runId, { publishDescriptions: true });
      expect(tokenOf(turnedOn)).toBe(token);
      expect(turnedOn.publishDescriptions).toBe(true);
      const row = await recorded(runId);
      const published = await report(token);
      expect(published.body.definitions?.strategy).toEqual({
        origin: "custom",
        description: {
          status: "published",
          ...(row.descriptions as { strategy: object }).strategy,
        },
      });
      expect(published.body.definitions?.list.description.status).toBe(
        "published",
      );
      expect(published.text).toContain("RSI 14D is below 27");

      // Even published, nothing but the words: no name, no id, no symbol, no document.
      for (const secret of [
        CUSTOM_STRATEGY_NAME,
        CUSTOM_LIST_NAME,
        strategyId,
        list.id,
        ownerId,
        ...symbols,
        ...securityIds,
        securityName(0),
        "RSI_14D",
        "PRICE_TO_EARNINGS_TTM",
        '"metadata"',
        '"provenance"',
        '"members"',
        "factorsage.definition",
      ]) {
        expect(
          published.text.replaceAll(token, "<token>"),
          `leaked ${secret}`,
        ).not.toContain(secret);
      }

      await share(runId, { publishDescriptions: false });
      expect(
        (await report(token)).body.definitions?.strategy.description,
      ).toEqual({
        status: "withheld",
        reason: "owner",
      });
    });

    it("refuses a malformed publication choice instead of ignoring it", async () => {
      await owner
        .put(`/backtests/${runId}/share`)
        .send({ publishDescriptions: "yes" })
        .expect(400);
      await owner
        .put(`/backtests/${runId}/share`)
        .send({ makePublic: true })
        .expect(400);
    });

    it("keeps what it recorded when the strategy and list are edited or deleted afterwards", async () => {
      const token = tokenOf(await share(runId, { publishDescriptions: true }));
      const before = await recorded(runId);
      const publicBefore = (await report(token)).body.definitions;

      await owner
        .put(`/strategies/${strategyId}/definition`)
        .send({ definition: BUILT_IN_DEFINITION })
        .expect(200);
      await owner
        .patch(`/strategies/${strategyId}`)
        .send({ name: "Renamed" })
        .expect(200);
      await owner
        .delete(`/lists/${list.id}/items/${list.items[0]?.id}`)
        .expect((response) => expect([200, 204]).toContain(response.status));
      await owner.delete(`/strategies/${strategyId}`).expect(204);
      await owner.delete(`/lists/${list.id}`).expect(204);

      expect(await recorded(runId)).toEqual(before);
      expect((await report(token)).body.definitions).toEqual(publicBefore);
    });
  });

  it("serializes the definitions the run executed, not the ones saved since", async () => {
    const strategyId = await createStrategy(
      `Edited before sharing ${suffix}`,
      CUSTOM_DEFINITION,
    );
    const list = await createList(`Edited list ${suffix}`);
    const runId = await completedRun(strategyId, list.id);
    // Both change after the run was submitted and before it is shared.
    await owner
      .put(`/strategies/${strategyId}/definition`)
      .send({ definition: BUILT_IN_DEFINITION })
      .expect(200);
    await owner.delete(`/lists/${list.id}/items/${list.items[0]?.id}`);

    await share(runId);
    const row = await recorded(runId);
    const { draft } = deserializeStrategy(row.definitions?.strategy, {
      resolveActor: () => undefined,
    });
    expect(strategyDefinitionFingerprint(draft.definition)).toBe(
      strategyDefinitionFingerprint(CUSTOM_DEFINITION),
    );
    const membership = row.definitions?.list.definition.membership;
    expect(membership?.kind === "members" ? membership.members.length : 0).toBe(
      4,
    );
  });

  describe("built-in content", () => {
    it("is official, named and described publicly without the owner's opt-in", async () => {
      const runId = await completedRun(builtInStrategyId, builtInListId);
      const response = await share(runId);
      expect(response.definitions?.strategy).toMatchObject({
        origin: "built_in",
        builtInName: "Official Trend",
        publication: "always",
      });
      const row = await recorded(runId);
      expect(row.definitions?.strategy.provenance).toEqual({
        origin: "built_in",
        evidence: "system_content",
        builtIn: {
          systemKey: BUILT_IN_STRATEGY_KEY,
          name: "Official Trend",
          version: 1,
        },
      });
      expect(row.definitions?.list.provenance).toEqual({
        origin: "built_in",
        evidence: "system_content",
        builtIn: { systemKey: BUILT_IN_LIST_KEY, name: "Official Leaders" },
      });

      const { body } = await report(tokenOf(response));
      expect(body.definitions?.strategy).toEqual({
        origin: "built_in",
        builtInName: "Official Trend",
        description: {
          status: "published",
          short:
            "Buys when Price is above SMA 200D. Closes the position when Price is below SMA 200D.",
          detailed: (row.descriptions as { strategy: { detailed: string } })
            .strategy.detailed,
        },
      });
      expect(body.definitions?.list).toEqual({
        origin: "built_in",
        builtInName: "Official Leaders",
        description: {
          status: "published",
          short:
            "4 securities: 3 eligible to buy on any date, 1 only during their membership periods.",
          detailed:
            "A list of 4 securities. 3 may be bought on any date. 1 may be bought only inside its membership periods: 1 period in total, the earliest starting Mar 1, 2016; 1 is still open-ended. Membership limits new buys only: a holding is not sold when its membership period ends.",
        },
      });
    });

    it("never publishes a premium built-in strategy's rules, even with the owner's opt-in", async () => {
      const runId = await completedRun(premiumStrategyId, builtInListId);
      const response = await share(runId, { publishDescriptions: true });
      expect(response.definitions?.strategy).toMatchObject({
        origin: "built_in",
        builtInName: "Official Premium Trend",
        publication: "never",
      });
      const { body, text } = await report(tokenOf(response));
      expect(body.definitions?.strategy).toEqual({
        origin: "built_in",
        builtInName: "Official Premium Trend",
        description: { status: "withheld", reason: "premium" },
      });
      expect(text).not.toContain("RSI 14D");
    });
  });

  describe("copies of built-in content", () => {
    it("is still the built-in while unchanged, and derived from it once edited", async () => {
      const copy = await owner
        .post(`/strategies/${builtInStrategyId}/duplicate`)
        .send({ name: `My copy ${suffix}` })
        .expect(201);
      const copyId = (copy.body as StrategyDetailResponse).id;
      const listCopy = await owner
        .post(`/lists/${builtInListId}/duplicate`)
        .send({ name: `My list copy ${suffix}` })
        .expect(201);
      const listCopyBody = listCopy.body as StockListDetailResponse;
      expect(
        await prisma.strategy.findUniqueOrThrow({
          where: { id: copyId },
          select: {
            origin: true,
            originSystemKey: true,
            originVersionNumber: true,
          },
        }),
      ).toEqual({
        origin: "COPIED",
        originSystemKey: BUILT_IN_STRATEGY_KEY,
        originVersionNumber: 1,
      });

      // Unchanged: the run executed the official logic and the official membership.
      const unchangedRun = await completedRun(copyId, listCopyBody.id);
      await share(unchangedRun);
      const unchanged = await recorded(unchangedRun);
      expect(unchanged.definitions?.strategy.provenance).toEqual({
        origin: "built_in",
        evidence: "copy_record",
        builtIn: {
          systemKey: BUILT_IN_STRATEGY_KEY,
          name: "Official Trend",
          version: 1,
        },
      });
      expect(unchanged.definitions?.list.provenance).toMatchObject({
        origin: "built_in",
        evidence: "copy_record",
      });
      // The customer's own name for their copy is recorded, never the official one.
      expect(unchanged.definitions?.strategy.metadata.name).toBe(
        `My copy ${suffix}`,
      );

      // Edited: derived, naming the built-in it began as.
      await owner
        .put(`/strategies/${copyId}/definition`)
        .send({ definition: CUSTOM_DEFINITION })
        .expect(200);
      const item = listCopyBody.items.find(
        (candidate) => candidate.buyWindowMode === "FULL",
      );
      await owner.delete(`/lists/${listCopyBody.id}/items/${item?.id}`);
      const editedRun = await completedRun(copyId, listCopyBody.id);
      const response = await share(editedRun);
      expect(response.definitions?.strategy).toMatchObject({
        origin: "derived",
        builtInName: "Official Trend",
        publication: "opt_in",
      });
      const edited = await recorded(editedRun);
      expect(edited.definitions?.strategy.provenance).toEqual({
        origin: "derived",
        evidence: "copy_record",
        derivedFrom: {
          systemKey: BUILT_IN_STRATEGY_KEY,
          name: "Official Trend",
          version: 1,
        },
      });
      expect(edited.definitions?.list.provenance).toEqual({
        origin: "derived",
        evidence: "copy_record",
        derivedFrom: { systemKey: BUILT_IN_LIST_KEY, name: "Official Leaders" },
      });
      const { body } = await report(tokenOf(response));
      expect(body.definitions?.strategy).toEqual({
        origin: "derived",
        builtInName: "Official Trend",
        description: { status: "withheld", reason: "owner" },
      });
    });
  });

  describe("content whose origin was never recorded", () => {
    it("is unknown unless its history proves it began as a built-in", async () => {
      // Saved the way rows were before origins existed: no origin columns at all.
      const legacy = await prisma.strategy.create({
        data: {
          userId: ownerId,
          name: "Legacy strategy",
          versions: {
            create: {
              versionNumber: 1,
              definition: CUSTOM_DEFINITION as unknown as object,
              definitionHash: definitionHashOf(CUSTOM_DEFINITION),
            },
          },
        },
        select: { id: true },
      });
      const legacyCopy = await prisma.strategy.create({
        data: {
          userId: ownerId,
          name: "Legacy copy of the built-in",
          versions: {
            create: {
              versionNumber: 1,
              definition: BUILT_IN_DEFINITION as unknown as object,
              definitionHash: definitionHashOf(BUILT_IN_DEFINITION),
            },
          },
        },
        select: { id: true },
      });
      const legacyList = await prisma.stockList.create({
        data: {
          userId: ownerId,
          name: "Legacy list",
          items: { create: securityIds.map((securityId) => ({ securityId })) },
        },
        select: { id: true },
      });

      const unknownRun = await completedRun(legacy.id, legacyList.id);
      await share(unknownRun);
      const unknown = await recorded(unknownRun);
      expect(unknown.definitions?.strategy.provenance).toEqual({
        origin: "unknown",
      });
      expect(unknown.definitions?.list.provenance).toEqual({
        origin: "unknown",
      });

      // Its first version is the built-in's logic byte for byte: it began as that built-in.
      const historyRun = await completedRun(legacyCopy.id, legacyList.id);
      await share(historyRun);
      expect(
        (await recorded(historyRun)).definitions?.strategy.provenance,
      ).toEqual({
        origin: "built_in",
        evidence: "version_history",
        builtIn: {
          systemKey: BUILT_IN_STRATEGY_KEY,
          name: "Official Trend",
          version: 1,
        },
      });
    });
  });

  describe("a link created before definitions were recorded", () => {
    it("reads exactly as it did, until its owner chooses to publish descriptions", async () => {
      const strategyId = await createStrategy(
        `Old link ${suffix}`,
        CUSTOM_DEFINITION,
      );
      const list = await createList(`Old link list ${suffix}`);
      const runId = await completedRun(strategyId, list.id);
      const token = randomBytes(32).toString("base64url");
      await prisma.backtestShare.create({ data: { runId, token } });

      const before = await report(token);
      expect(before.body.definitions).toBeUndefined();
      expect(Object.keys(before.body).sort()).toEqual(
        ["completedAt", "configuration", "result", "runNumber", "url"].sort(),
      );
      const ownerView = (
        await owner.get(`/backtests/${runId}/share`).expect(200)
      ).body as BacktestShareResponse;
      expect(ownerView).toMatchObject({
        shared: true,
        publishDescriptions: false,
      });
      expect(ownerView.definitions).toBeUndefined();
      // Asking for the link again changes nothing.
      expect((await share(runId)).definitions).toBeUndefined();
      expect((await recorded(runId)).definitions).toBeNull();

      const published = await share(runId, { publishDescriptions: true });
      expect(tokenOf(published)).toBe(token);
      expect(published.definitions?.strategy.origin).toBe("custom");
      expect(
        (await report(token)).body.definitions?.strategy.description.status,
      ).toBe("published");
    });
  });

  it("creates no link when a definition cannot be recorded", async () => {
    const strategyId = await createStrategy(
      `Unrecordable ${suffix}`,
      CUSTOM_DEFINITION,
    );
    const list = await createList(`Unrecordable list ${suffix}`);
    const runId = await completedRun(strategyId, list.id);
    // A frozen definition this build's Strategy rules refuse: no BUY level.
    const snapshot = await snapshotOf(runId);
    await prisma.backtestRun.update({
      where: { id: runId },
      data: {
        snapshot: {
          ...snapshot,
          strategy: {
            ...snapshot.strategy,
            definition: { schemaVersion: 2, buyLevels: [], sellLevels: [] },
          },
        } as unknown as object,
      },
    });

    const refused = await owner.put(`/backtests/${runId}/share`).expect(409);
    expect(refused.body).toMatchObject({
      code: BACKTEST_SHARE_DEFINITIONS_UNAVAILABLE_CODE,
    });
    expect(await prisma.backtestShare.count({ where: { runId } })).toBe(0);
    // The owner can still look: nothing to show, nothing recorded.
    const view = (await owner.get(`/backtests/${runId}/share`).expect(200))
      .body as BacktestShareResponse;
    expect(view).toMatchObject({ shared: false });
    expect(view.definitions).toBeUndefined();
  });

  describe("a point-in-time universe", () => {
    let universeListId = "";

    beforeAll(async () => {
      // Only a test leftover can hold the key in the test database: the ingestion refuses it.
      await prisma.stockList.deleteMany({ where: { systemKey: UNIVERSE_KEY } });
      const universe = await prisma.stockList.create({
        data: {
          ownership: "SYSTEM",
          systemKey: UNIVERSE_KEY,
          name: "S&P 500 — Historical PIT",
          premium: true,
          items: {
            create: securityIds.map((securityId, index) => ({
              securityId,
              buyWindowMode: "CUSTOM" as const,
              buyWindows: {
                create:
                  index === 0
                    ? [
                        {
                          startDate: new Date("2014-01-02T00:00:00.000Z"),
                          endDate: new Date("2016-06-30T00:00:00.000Z"),
                        },
                        {
                          startDate: new Date("2018-01-02T00:00:00.000Z"),
                          endDate: null,
                        },
                      ]
                    : index === 3
                      ? [
                          // Left before the period: not part of the run's membership.
                          {
                            startDate: new Date("2001-01-02T00:00:00.000Z"),
                            endDate: new Date("2009-12-31T00:00:00.000Z"),
                          },
                        ]
                      : [
                          {
                            startDate: new Date("2012-01-02T00:00:00.000Z"),
                            endDate: null,
                          },
                        ],
              },
            })),
          },
        },
        select: { id: true },
      });
      universeListId = universe.id;
    });

    it("is pinned to the membership the run froze, compactly, and reconstructs only from it", async () => {
      const runId = await completedRun(builtInStrategyId, universeListId);
      const response = await share(runId);
      expect(response.definitions?.list).toMatchObject({
        origin: "built_in",
        builtInName: "S&P 500 — Historical PIT",
        publication: "always",
      });
      const row = await recorded(runId);
      const document = row.definitions?.list as CanonicalListDocument;
      expect(document.provenance).toMatchObject({
        origin: "built_in",
        builtIn: { systemKey: UNIVERSE_KEY, premium: true },
      });
      expect(document.definition.membership).toMatchObject({
        kind: "point_in_time_index",
        index: "SP500",
        universe: UNIVERSE_KEY,
        period: { startDate: "2015-01-02", endDate: "2020-12-31" },
        membership: { securities: 3, windows: 4 },
      });
      // A reference, not a copy: no member is written into the share.
      expect(JSON.stringify(document)).not.toMatch(
        new RegExp(symbols.join("|")),
      );
      expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThan(1_000);

      const snapshot = await snapshotOf(runId);
      const read = deserializeList(document, {
        resolveSecurity: (security) =>
          snapshot.securities.find(
            (frozen) => frozen.symbol === security.symbol,
          )?.securityId,
        resolveIndexMembership: snapshotIndexMembershipResolver(snapshot),
      });
      expect(read.members).toHaveLength(3);

      // The projection moves afterwards — a corrected boundary — and the pin refuses it.
      await prisma.stockListBuyWindow.updateMany({
        where: {
          item: { stockListId: universeListId, securityId: securityIds[1] },
        },
        data: { startDate: new Date("2012-01-03T00:00:00.000Z") },
      });
      const moved = snapshotListMembers({
        ...snapshot,
        securities: snapshot.securities.map((security) =>
          security.securityId === securityIds[1]
            ? {
                ...security,
                buyWindows: [{ startDate: "2012-01-03", endDate: null }],
              }
            : security,
        ),
      });
      expect(() =>
        deserializeList(document, {
          resolveSecurity: () => "id",
          resolveIndexMembership: () => moved,
        }),
      ).toThrow(/pinned/);

      const { body, text } = await report(tokenOf(response));
      expect(body.definitions?.list.description).toMatchObject({
        status: "published",
        short:
          "Uses historical S&P 500 membership to determine eligible securities at each point in time.",
      });
      for (const symbol of symbols) {
        expect(text).not.toContain(symbol);
      }
    });
  });

  // Last, because it adds a built-in that makes the official logic's evidence ambiguous.
  it("calls an unrecorded strategy unknown when its history matches more than one built-in", async () => {
    await prisma.strategy.create({
      data: {
        ownership: "SYSTEM",
        systemKey: TWIN_STRATEGY_KEY,
        name: "Official Twin",
        versions: {
          create: {
            versionNumber: 1,
            definition: BUILT_IN_DEFINITION as unknown as object,
            definitionHash: definitionHashOf(BUILT_IN_DEFINITION),
          },
        },
      },
    });
    const legacyCopy = await prisma.strategy.create({
      data: {
        userId: ownerId,
        name: "Legacy copy of one of two identical built-ins",
        versions: {
          create: {
            versionNumber: 1,
            definition: BUILT_IN_DEFINITION as unknown as object,
            definitionHash: definitionHashOf(BUILT_IN_DEFINITION),
          },
        },
      },
      select: { id: true },
    });
    const list = await createList(`Twin list ${suffix}`);
    const runId = await completedRun(legacyCopy.id, list.id);
    await share(runId);
    expect((await recorded(runId)).definitions?.strategy.provenance).toEqual({
      origin: "unknown",
    });
  });
});
