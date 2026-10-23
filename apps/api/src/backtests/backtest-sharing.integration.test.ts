import { createHash, randomBytes, randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  BACKTEST_SHARE_TOKEN_BYTES,
  normalizeStrategyDefinition,
  SHARED_BACKTEST_PREVIEW_MAX_POINTS,
  strategyDefinitionFingerprint,
  type BacktestRunDetailResponse,
  type BacktestShareResponse,
  type SharedBacktestPreviewResponse,
  type SharedBacktestReportResponse,
  type StrategyDefinition,
} from "@intrinsic/contracts";
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
import { BacktestsModule } from "./backtests.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * Public backtest sharing end to end: HTTP -> Nest -> BacktestSharingService -> real PostgreSQL
 * (`docs/decisions/backtest-sharing-v1.md`).
 *
 * The shared run is deliberately beyond a Starter plan — eighty securities over twenty-nine years —
 * and is submitted through the real route, so it carries a real snapshot. No worker runs: the run
 * is then marked completed and given the rows a worker writes (summary, daily equity with monthly
 * contributions, trades), which is what the public report is projected from.
 *
 * What is proved, besides the lifecycle: the public report carries exactly the allowlisted keys;
 * nothing private appears anywhere in the bytes it serves; every figure equals the owner's own
 * page; no plan or session changes the answer; and a revoked token never answers again.
 */
describe("public backtest sharing", () => {
  const suffix = randomUUID();
  const shortSuffix = suffix.slice(0, 6).toUpperCase();
  const password = "Local-test-password-42";
  const ownerEmail = `share-owner-${suffix}@example.test`;
  const starterEmail = `share-starter-${suffix}@example.test`;
  const freeEmail = `share-free-${suffix}@example.test`;
  const STRATEGY_NAME = `Secret momentum ${suffix}`;
  const LIST_NAME = `Private universe ${suffix}`;
  const SECURITY_COUNT = 80;
  const symbols = Array.from(
    { length: SECURITY_COUNT },
    (_, index) => `SH${shortSuffix}${String(index).padStart(2, "0")}`,
  );
  const providerSymbols = symbols.map((symbol) => `${symbol}-${suffix}`);
  const securityName = (index: number) =>
    `Confidential Holdings ${index} ${suffix}`;
  const START = "1997-01-02";
  const END = "2025-12-31";
  const MONTHLY_CONTRIBUTION = 500;

  /** Two BUY conditions plus a trigger, one SELL condition, two FINAL EXIT rules of one each. */
  const EXPECTED_RULE_COUNT = 6;
  const definition: StrategyDefinition = normalizeStrategyDefinition({
    schemaVersion: 2,
    buyLevels: [
      {
        id: "secret-buy-level",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "secret-buy-condition-1",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "EMA_200D" },
            },
            {
              id: "secret-buy-condition-2",
              metric: { kind: "PRICE" },
              operator: "IS_BELOW",
              value: { kind: "SERIES", seriesId: "SMA_50D" },
            },
          ],
          trigger: {
            id: "secret-buy-trigger",
            metric: { kind: "PRICE" },
            operator: "CROSSES_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_200D" },
          },
        },
      },
    ],
    sellLevels: [
      {
        id: "secret-sell-level",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "secret-sell-condition",
              metric: { kind: "PRICE" },
              operator: "IS_BELOW",
              value: { kind: "SERIES", seriesId: "SMA_100D" },
            },
          ],
        },
      },
    ],
    finalExit: {
      id: "secret-final-exit",
      rules: [
        {
          id: "secret-exit-rule-1",
          signal: {
            conditions: [
              {
                id: "secret-exit-condition-1",
                metric: { kind: "PRICE" },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
          },
        },
        {
          id: "secret-exit-rule-2",
          signal: {
            conditions: [
              {
                id: "secret-exit-condition-2",
                metric: { kind: "PRICE" },
                operator: "IS_ABOVE",
                value: { kind: "SERIES", seriesId: "EMA_20D" },
              },
            ],
          },
        },
      ],
    },
  });

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let starter: ReturnType<typeof request.agent>;
  let free: ReturnType<typeof request.agent>;
  let anonymous: ReturnType<typeof request>;
  let ownerId = "";
  let strategyId = "";
  let listId = "";
  let runId = "";
  let queuedRunId = "";
  let snapshotHash = "";
  let benchmarkId = "";
  let equityDays = 0;
  let previousWebBaseUrl: string | undefined;

  /** Weekdays of the period, each with a deterministic portfolio, benchmark and cash scenario. */
  function equityRows(id: string) {
    const rows = [];
    let invested = 100_000;
    let benchmarkShares = 1_000;
    let lastMonth = "";
    const day = new Date(`${START}T00:00:00.000Z`);
    const end = new Date(`${END}T00:00:00.000Z`);
    let index = 0;
    while (day <= end) {
      const weekday = day.getUTCDay();
      if (weekday !== 0 && weekday !== 6) {
        const date = day.toISOString().slice(0, 10);
        const month = date.slice(0, 7);
        const benchmarkPrice = 100 * (1 + index / 4_000);
        if (lastMonth !== "" && month !== lastMonth) {
          invested += MONTHLY_CONTRIBUTION;
          benchmarkShares += MONTHLY_CONTRIBUTION / benchmarkPrice;
        }
        lastMonth = month;
        // A long climb with one deep, short crash in 2008 that even striding would step over.
        const crash = date >= "2008-10-06" && date <= "2008-10-08" ? 0.45 : 1;
        const returnIndex = (1 + index / 3_000) * crash;
        rows.push({
          runId: id,
          date: new Date(`${date}T00:00:00.000Z`),
          cash: 1_000,
          positionsValue: invested * returnIndex - 1_000,
          totalValue: invested * returnIndex,
          investedCapital: invested,
          returnIndex,
          benchmarkIndex: benchmarkPrice / 100,
          benchmarkValue: benchmarkShares * benchmarkPrice,
          cashBaselineValue: invested,
          openPositions: 7,
        });
        index += 1;
      }
      day.setUTCDate(day.getUTCDate() + 1);
    }
    return rows;
  }

  async function signIn(email: string) {
    const agent = request.agent(app.getHttpServer());
    await agent.post("/auth/login").send({ email, password }).expect(200);
    return agent;
  }

  async function enable(): Promise<BacktestShareResponse> {
    const response = await owner.put(`/backtests/${runId}/share`).expect(200);
    return response.body as BacktestShareResponse;
  }

  function tokenOf(share: BacktestShareResponse): string {
    const token = share.url?.split("/share/")[1];
    if (!token) {
      throw new Error(`Not a share URL: ${share.url}`);
    }
    return token;
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";
    previousWebBaseUrl = process.env.WEB_BASE_URL;
    process.env.WEB_BASE_URL = "https://factorsage.example.test";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigurationModule,
        DatabaseModule,
        AuthModule,
        BacktestsModule,
        BenchmarksModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);

    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: ownerEmail, passwordHash, emailVerifiedAt, plan: "PRO" },
        { email: starterEmail, passwordHash, emailVerifiedAt, plan: "STARTER" },
        { email: freeEmail, passwordHash, emailVerifiedAt, plan: "FREE" },
      ],
    });
    ownerId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: ownerEmail },
        select: { id: true },
      })
    ).id;

    const securityIds: string[] = [];
    for (const [index, symbol] of symbols.entries()) {
      const security = await prisma.security.create({
        data: {
          providerSymbol: providerSymbols[index] as string,
          symbol,
          name: securityName(index),
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
    const strategy = await prisma.strategy.create({
      data: {
        userId: ownerId,
        name: STRATEGY_NAME,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as unknown as object,
            definitionHash: createHash("sha256")
              .update(strategyDefinitionFingerprint(definition))
              .digest("hex"),
          },
        },
      },
    });
    strategyId = strategy.id;
    const list = await prisma.stockList.create({
      data: { userId: ownerId, name: LIST_NAME },
    });
    listId = list.id;
    await prisma.stockListItem.createMany({
      data: securityIds.map((securityId) => ({
        stockListId: list.id,
        securityId,
        buyWindowMode: "FULL" as const,
      })),
    });

    owner = await signIn(ownerEmail);
    starter = await signIn(starterEmail);
    free = await signIn(freeEmail);
    anonymous = request(app.getHttpServer());

    const submission = {
      strategyId,
      stockListId: listId,
      startDate: START,
      endDate: END,
      initialCapital: 100_000,
      monthlyContribution: MONTHLY_CONTRIBUTION,
      maximumPositions: 10,
    };
    const submitted = await owner.post("/backtests").send(submission);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    runId = (submitted.body as BacktestRunDetailResponse).id;
    // Completed, its job settled so no worker sharing the database can claim it, with the rows a
    // worker writes.
    await prisma.backtestRun.update({
      where: { id: runId },
      data: {
        status: "COMPLETED",
        startedAt: new Date(),
        completedAt: new Date(),
        job: { update: { status: "COMPLETED" } },
      },
    });
    const run = await prisma.backtestRun.findUniqueOrThrow({
      where: { id: runId },
      select: { snapshotHash: true, benchmarkId: true },
    });
    snapshotHash = run.snapshotHash;
    benchmarkId = run.benchmarkId;
    const rows = equityRows(runId);
    equityDays = rows.length;
    for (let start = 0; start < rows.length; start += 1_000) {
      await prisma.backtestDailyEquity.createMany({
        data: rows.slice(start, start + 1_000),
      });
    }
    const last = rows.at(-1) as (typeof rows)[number];
    await prisma.backtestRunSummary.create({
      data: {
        runId,
        firstSimulatedDate: new Date(`${START}T00:00:00.000Z`),
        lastSimulatedDate: last.date,
        tradingDays: rows.length,
        investedCapital: last.investedCapital,
        finalCash: last.totalValue,
        finalPositionsValue: 0,
        finalValue: last.totalValue,
        netProfit: last.totalValue - last.investedCapital,
        portfolioReturnPercent: (last.returnIndex - 1) * 100,
        benchmarkReturnPercent: (last.benchmarkIndex - 1) * 100,
        alphaPercent: (last.returnIndex - last.benchmarkIndex) * 100,
        portfolioCagrPercent: 12.34,
        maxDrawdownPercent: 55.12,
        benchmarkMaxDrawdownPercent: 33.21,
        realizedPnl: 1_234,
        unrealizedPnl: 0,
        totalTrades: 2,
        buyTrades: 1,
        sellTrades: 1,
        finalExitTrades: 0,
        winningTrades: 1,
        losingTrades: 0,
        openPositions: 0,
      },
    });
    for (const [sequence, action] of (["BUY", "SELL"] as const).entries()) {
      await prisma.backtestTrade.create({
        data: {
          runId,
          sequence: sequence + 1,
          date: new Date(`2010-0${sequence + 1}-04T00:00:00.000Z`),
          securityId: securityIds[0] as string,
          symbol: symbols[0] as string,
          name: securityName(0),
          action,
          levelId: action === "BUY" ? "secret-buy-level" : "secret-sell-level",
          levelPercentage: 50,
          shares: 10,
          price: 100,
          amount: 1_000,
          fees: 0,
          cashAfter: 1_000,
          sharesAfter: action === "BUY" ? 10 : 0,
        },
      });
    }

    // A second run, still queued: it has no result, so it cannot be shared.
    const queued = await owner
      .post("/backtests")
      .send({ ...submission, startDate: "2016-01-04" })
      .expect(202);
    queuedRunId = (queued.body as BacktestRunDetailResponse).id;
    // Settled out of the queue so no worker claims it; still not COMPLETED.
    await prisma.backtestJob.update({
      where: { runId: queuedRunId },
      data: { status: "FAILED" },
    });
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      // Runs, shares, equity and trades cascade from the users; trades restrict their securities,
      // so the users go first.
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, starterEmail, freeEmail] } },
      });
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: providerSymbols } },
      });
    }
    if (app) {
      await app.close();
    }
    if (previousWebBaseUrl === undefined) {
      delete process.env.WEB_BASE_URL;
    } else {
      process.env.WEB_BASE_URL = previousWebBaseUrl;
    }
  });

  describe("the owner", () => {
    it("starts unshared", async () => {
      const response = await owner.get(`/backtests/${runId}/share`).expect(200);
      expect(response.body).toEqual({
        shared: false,
        url: null,
        sharedAt: null,
      });
    });

    it("cannot share a run that has not completed", async () => {
      await owner.put(`/backtests/${queuedRunId}/share`).expect(409);
      expect(
        await prisma.backtestShare.count({ where: { runId: queuedRunId } }),
      ).toBe(0);
    });

    it("shares a completed run behind an unguessable link that names no database id", async () => {
      const share = await enable();
      expect(share.shared).toBe(true);
      expect(share.sharedAt).not.toBeNull();
      expect(share.url).toMatch(
        /^https:\/\/factorsage\.example\.test\/share\/[A-Za-z0-9_-]{43}$/,
      );
      expect(share.url).not.toContain(runId);
      expect(share.url).not.toContain(ownerId);
      expect(Buffer.from(tokenOf(share), "base64url").byteLength).toBe(
        BACKTEST_SHARE_TOKEN_BYTES,
      );
    });

    it("reuses the active link rather than minting a second one", async () => {
      const first = await enable();
      const second = await enable();
      expect(second).toEqual(first);
      const read = await owner.get(`/backtests/${runId}/share`).expect(200);
      expect(read.body).toEqual(first);
      expect(await prisma.backtestShare.count({ where: { runId } })).toBe(1);
    });

    it("cannot be impersonated: another user can neither read, share nor revoke it", async () => {
      const before = await enable();
      await starter.get(`/backtests/${runId}/share`).expect(404);
      await starter.put(`/backtests/${runId}/share`).expect(404);
      await starter.delete(`/backtests/${runId}/share`).expect(404);
      await anonymous.put(`/backtests/${runId}/share`).expect(401);
      await anonymous.delete(`/backtests/${runId}/share`).expect(401);
      // The private run itself stays private to everybody else.
      await starter.get(`/backtests/${runId}`).expect(404);
      await starter.get(`/backtests/${runId}/trades`).expect(404);
      await anonymous.get(`/backtests/${runId}`).expect(401);
      expect(await enable()).toEqual(before);
    });
  });

  describe("a public reader", () => {
    it("reads the report without a session, on any plan, and gets the same answer", async () => {
      const token = tokenOf(await enable());
      const guest = await anonymous
        .get(`/shared-backtests/${token}`)
        .expect(200);
      expect(guest.headers["cache-control"]).toBe("no-store");
      expect(guest.headers["x-robots-tag"]).toBe("noindex, nofollow");
      // Starter allows 50 securities and 15 years; this run has 80 over 29. Free allows less still.
      const asStarter = await starter
        .get(`/shared-backtests/${token}`)
        .expect(200);
      const asFree = await free.get(`/shared-backtests/${token}`).expect(200);
      const asOwner = await owner.get(`/shared-backtests/${token}`).expect(200);
      expect(asStarter.body).toEqual(guest.body);
      expect(asFree.body).toEqual(guest.body);
      expect(asOwner.body).toEqual(guest.body);
    });

    it("receives exactly the allowlisted fields and nothing else", async () => {
      const token = tokenOf(await enable());
      const body = (
        await anonymous.get(`/shared-backtests/${token}`).expect(200)
      ).body as SharedBacktestReportResponse;
      expect(Object.keys(body).sort()).toEqual(
        ["completedAt", "configuration", "result", "runNumber", "url"].sort(),
      );
      expect(Object.keys(body.configuration).sort()).toEqual(
        [
          "benchmark",
          "endDate",
          "fullPositionPercent",
          "initialCapital",
          "maximumPositions",
          "monthlyContribution",
          "securityCount",
          "startDate",
          "strategyRuleCount",
        ].sort(),
      );
      expect(Object.keys(body.configuration.benchmark).sort()).toEqual([
        "code",
        "name",
      ]);
      expect(Object.keys(body.result).sort()).toEqual(
        ["annualReturns", "curve", "summary"].sort(),
      );
      expect(Object.keys(body.result.summary).sort()).toEqual(
        [
          "alphaPercent",
          "benchmarkCagrPercent",
          "benchmarkMaxDrawdownPercent",
          "benchmarkReturnPercent",
          "finalValue",
          "firstSimulatedDate",
          "lastSimulatedDate",
          "maxDrawdownPercent",
          "netProfit",
          "portfolioCagrPercent",
          "portfolioReturnPercent",
          "totalTrades",
        ].sort(),
      );
      for (const point of body.result.curve) {
        expect(Object.keys(point).sort()).toEqual(
          [
            "benchmarkReturnPercent",
            "benchmarkValue",
            "cashBaselineValue",
            "date",
            "portfolioReturnPercent",
            "strategyValue",
          ].sort(),
        );
      }
      for (const year of body.result.annualReturns) {
        expect(Object.keys(year).sort()).toEqual(
          [
            "benchmarkReturnPercent",
            "partial",
            "returnPercent",
            "simulatedThrough",
            "year",
          ].sort(),
        );
      }
    });

    it("never receives a private name, identifier, symbol, rule or trade, in any response", async () => {
      const token = tokenOf(await enable());
      const report = await anonymous
        .get(`/shared-backtests/${token}`)
        .expect(200);
      const preview = await anonymous
        .get(`/shared-backtests/${token}/preview`)
        .expect(200);
      const strategyVersion = await prisma.strategyVersion.findFirstOrThrow({
        where: { strategyId },
        select: { id: true, definitionHash: true },
      });
      const forbidden = [
        STRATEGY_NAME,
        LIST_NAME,
        strategyId,
        strategyVersion.id,
        strategyVersion.definitionHash,
        listId,
        ownerId,
        ownerEmail,
        snapshotHash,
        // The run's UUID: the public report names the run by its Run ID only.
        runId,
        benchmarkId,
        ...symbols,
        ...providerSymbols,
        securityName(0),
        "Confidential Holdings",
        "secret-",
        "EMA_200D",
        "SMA_50D",
        "IS_ABOVE",
        "CROSSES_ABOVE",
        "buyWindow",
        "securityId",
        "levelId",
        "seriesId",
        "providerSymbol",
        "definition",
        "snapshot",
        "trades",
        "holdings",
      ];
      for (const response of [report, preview]) {
        // The report names its own link; the token is random, so it is set aside before searching.
        const served = response.text.replaceAll(token, "<token>");
        for (const text of forbidden) {
          expect(served, `leaked ${text}`).not.toContain(text);
        }
      }
    });

    it("sees every figure exactly as the owner's own page does", async () => {
      const token = tokenOf(await enable());
      const shared = (
        await anonymous.get(`/shared-backtests/${token}`).expect(200)
      ).body as SharedBacktestReportResponse;
      const own = (await owner.get(`/backtests/${runId}`).expect(200))
        .body as BacktestRunDetailResponse;
      const result = own.result;
      if (!result) {
        throw new Error("The owner's run has no result");
      }

      // The owner page's Run ID (`Run #0001` for this owner's first run), never the UUID.
      expect(shared.runNumber).toBe(own.runNumber);
      expect(shared.runNumber).toBe(1);
      expect(shared.completedAt).toBe(own.completedAt);
      expect(shared.result.curve).toEqual(result.curve);
      expect(shared.result.annualReturns).toEqual(result.annualReturns);
      // The Strategy vs benchmark heatmap's data: both figures for every whole year.
      expect(shared.result.annualReturns.length).toBeGreaterThan(20);
      expect(
        shared.result.annualReturns.every(
          (year) => year.benchmarkReturnPercent !== null,
        ),
      ).toBe(true);
      for (const [field, value] of Object.entries(shared.result.summary)) {
        expect(value, field).toEqual(
          result.summary[field as keyof typeof result.summary],
        );
      }
      expect(shared.configuration).toEqual({
        startDate: own.configuration.startDate,
        endDate: own.configuration.endDate,
        initialCapital: own.configuration.initialCapital,
        monthlyContribution: MONTHLY_CONTRIBUTION,
        maximumPositions: own.configuration.maximumPositions,
        fullPositionPercent: own.configuration.fullPositionPercent,
        benchmark: {
          code: own.configuration.benchmark.code,
          name: own.configuration.benchmark.name,
        },
        securityCount: SECURITY_COUNT,
        strategyRuleCount: EXPECTED_RULE_COUNT,
      });
      // The funded benchmark scenario's values, contributions included, are the stored ones.
      expect(shared.result.curve.at(-1)?.benchmarkValue).toBe(
        result.curve.at(-1)?.benchmarkValue,
      );
    });

    it("counts rules and securities from the frozen run, whatever the strategy and list say now", async () => {
      const token = tokenOf(await enable());
      await prisma.stockListItem.deleteMany({ where: { stockListId: listId } });
      await prisma.strategy.update({
        where: { id: strategyId },
        data: { name: "Renamed afterwards" },
      });
      const body = (
        await anonymous.get(`/shared-backtests/${token}`).expect(200)
      ).body as SharedBacktestReportResponse;
      expect(body.configuration.securityCount).toBe(SECURITY_COUNT);
      expect(body.configuration.strategyRuleCount).toBe(EXPECTED_RULE_COUNT);
    });

    it("gets the link-preview data: stored headline figures and a bounded, faithful series", async () => {
      const token = tokenOf(await enable());
      const response = await anonymous
        .get(`/shared-backtests/${token}/preview`)
        .expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const preview = response.body as SharedBacktestPreviewResponse;
      const report = (
        await anonymous.get(`/shared-backtests/${token}`).expect(200)
      ).body as SharedBacktestReportResponse;
      const summary = report.result.summary;

      expect(preview.headline).toEqual({
        portfolioCagrPercent: summary.portfolioCagrPercent,
        benchmarkCagrPercent: summary.benchmarkCagrPercent,
        portfolioReturnPercent: summary.portfolioReturnPercent,
        benchmarkReturnPercent: summary.benchmarkReturnPercent,
        maxDrawdownPercent: summary.maxDrawdownPercent,
      });
      expect(preview.configuration).toEqual({
        startDate: START,
        endDate: report.configuration.endDate,
        benchmark: report.configuration.benchmark,
        securityCount: SECURITY_COUNT,
        strategyRuleCount: EXPECTED_RULE_COUNT,
      });
      expect(equityDays).toBeGreaterThan(SHARED_BACKTEST_PREVIEW_MAX_POINTS);
      expect(preview.series.length).toBeLessThanOrEqual(
        SHARED_BACKTEST_PREVIEW_MAX_POINTS,
      );
      expect(preview.series[0]?.date).toBe(START);
      const finalPoint = report.result.curve.at(-1);
      expect(preview.series.at(-1)).toEqual({
        date: finalPoint?.date,
        strategyValue: finalPoint?.strategyValue,
        benchmarkValue: finalPoint?.benchmarkValue,
      });
      // The three-day 2008 crash survives the thinning.
      expect(
        preview.series.some(
          (point) => point.date >= "2008-10-06" && point.date <= "2008-10-08",
        ),
      ).toBe(true);
    });

    it("never starts, queues or changes a backtest", async () => {
      const token = tokenOf(await enable());
      const before = await prisma.backtestRun.findMany({
        where: { userId: ownerId },
        select: { id: true, status: true, updatedAt: true },
        orderBy: { id: "asc" },
      });
      const jobs = await prisma.backtestJob.count();
      for (let read = 0; read < 3; read += 1) {
        await anonymous.get(`/shared-backtests/${token}`).expect(200);
        await free.get(`/shared-backtests/${token}/preview`).expect(200);
      }
      expect(
        await prisma.backtestRun.findMany({
          where: { userId: ownerId },
          select: { id: true, status: true, updatedAt: true },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
      expect(await prisma.backtestJob.count()).toBe(jobs);
    });

    it("gets the same not-found for a malformed, an unknown and a revoked token", async () => {
      const unknown = randomBytes(BACKTEST_SHARE_TOKEN_BYTES).toString(
        "base64url",
      );
      for (const token of ["not-a-token", unknown, runId]) {
        const response = await anonymous
          .get(`/shared-backtests/${token}`)
          .expect(404);
        expect(response.body.message).toBe("Shared backtest was not found");
        await anonymous.get(`/shared-backtests/${token}/preview`).expect(404);
      }
    });
  });

  describe("revocation", () => {
    it("stops the link at once, and sharing again mints a new link the old one never matches", async () => {
      const old = tokenOf(await enable());
      await anonymous.get(`/shared-backtests/${old}`).expect(200);

      await owner.delete(`/backtests/${runId}/share`).expect(204);
      await anonymous.get(`/shared-backtests/${old}`).expect(404);
      await anonymous.get(`/shared-backtests/${old}/preview`).expect(404);
      await starter.get(`/shared-backtests/${old}`).expect(404);
      expect(
        (await owner.get(`/backtests/${runId}/share`).expect(200)).body,
      ).toEqual({ shared: false, url: null, sharedAt: null });
      // Idempotent.
      await owner.delete(`/backtests/${runId}/share`).expect(204);

      const renewed = tokenOf(await enable());
      expect(renewed).not.toBe(old);
      await anonymous.get(`/shared-backtests/${renewed}`).expect(200);
      await anonymous.get(`/shared-backtests/${old}`).expect(404);
    });

    it("leaves the owner's run, its result and its trade log untouched", async () => {
      await enable();
      await owner.delete(`/backtests/${runId}/share`).expect(204);
      const own = (await owner.get(`/backtests/${runId}`).expect(200))
        .body as BacktestRunDetailResponse;
      expect(own.status).toBe("COMPLETED");
      expect(own.result?.summary.totalTrades).toBe(2);
      const trades = await owner.get(`/backtests/${runId}/trades`).expect(200);
      expect(trades.body.totalCount).toBe(2);
    });
  });
});
