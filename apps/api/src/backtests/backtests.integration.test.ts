import { createHash, randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  BACKTEST_MAX_PERIOD_YEARS,
  BACKTEST_RESULT_MAX_CURVE_POINTS,
  BACKTEST_SNAPSHOT_VERSION,
  DEFAULT_BENCHMARK_CODE,
  STRATEGY_SCHEMA_VERSION,
  canonicalBacktestSnapshotDocument,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type BacktestLiveSnapshotResponse,
  type BacktestProgressResponse,
  type BacktestRunDetailResponse,
  type BacktestRunSnapshot,
  type BacktestRunStrategyResponse,
  type BacktestRunSummaryResponse,
  type BenchmarkResponse,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaBenchmarkDataStore } from "@intrinsic/stock-data";
import { BACKTEST_METHODOLOGY } from "@intrinsic/strategy";
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
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { BacktestsModule } from "./backtests.module";
import { EXECUTION_CALENDAR_REFERENCE } from "./backtests.tokens";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> BacktestsService -> real PostgreSQL.
 *
 * The subject is the API's half of the boundary: validating a submitted configuration, freezing it
 * into an immutable snapshot, creating the durable job atomically with the run, and reporting
 * execution state that a *worker* wrote. No worker runs here, so progress, results and failures
 * are written directly with Prisma — exactly the rows the worker produces — which is what lets this
 * suite prove the read contract without a simulation.
 *
 * Nothing here touches FMP or Redis: submission resolves only local rows.
 */
describe("backtests", () => {
  const suffix = randomUUID();
  const shortSuffix = suffix.slice(0, 8).toUpperCase();
  const password = "Local-test-password-42";
  const ownerEmail = `backtest-owner-${suffix}@example.test`;
  const otherEmail = `backtest-other-${suffix}@example.test`;
  const providerSymbols = ["C", "A", "B"].map(
    (letter) => `BT${letter}-${suffix}`,
  );

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;

  let ownerUserId = "";
  let strategyId = "";
  let strategyVersionId = "";
  let stockListId = "";
  let emptyListId = "";
  let otherStrategyId = "";
  const securityIdsBySymbol = new Map<string, string>();

  /** Symbols sort A, B, C while the securities and memberships are created C, A, B. */
  function symbolOf(letter: string): string {
    return `BT${letter}${shortSuffix}`;
  }

  const definition: StrategyDefinition = normalizeStrategyDefinition({
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
  } satisfies StrategyDefinition);

  const definitionHash = createHash("sha256")
    .update(strategyDefinitionFingerprint(definition))
    .digest("hex");

  function submission(overrides: Record<string, unknown> = {}): object {
    return {
      strategyId,
      stockListId,
      startDate: "2020-01-01",
      endDate: "2020-12-31",
      initialCapital: 100_000,
      monthlyContribution: 500,
      maximumPositions: 10,
      ...overrides,
    };
  }

  async function submit(
    overrides: Record<string, unknown> = {},
  ): Promise<BacktestRunDetailResponse> {
    const response = await owner
      .post("/backtests")
      .send(submission(overrides))
      .expect(202);
    return response.body as BacktestRunDetailResponse;
  }

  async function expectRejected(
    body: object,
    fragment: string,
  ): Promise<{ message: string; code: string }> {
    const response = await owner.post("/backtests").send(body).expect(400);
    const rejection = response.body as { message: string; code: string };
    expect(rejection.code).toBe("BACKTEST_INVALID");
    expect(rejection.message).toContain(fragment);
    return rejection;
  }

  function isoDate(offsetDays: number): string {
    const date = new Date("2015-01-01T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
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
        BacktestsModule,
        BenchmarksModule,
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
    const users = await prisma.user.findMany({
      where: { email: { in: [ownerEmail, otherEmail] } },
      select: { id: true, email: true },
    });
    ownerUserId = users.find((row) => row.email === ownerEmail)?.id ?? "";
    const otherUserId = users.find((row) => row.email === otherEmail)?.id ?? "";

    // Created C, A, B so the snapshot's symbol ordering cannot be insertion order by accident.
    for (const letter of ["C", "A", "B"]) {
      const security = await prisma.security.create({
        data: {
          providerSymbol: `BT${letter}-${suffix}`,
          symbol: symbolOf(letter),
          name: `Backtest Security ${letter}`,
          exchangeCode: "NASDAQ",
          exchangeName: "NASDAQ Global Select",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
        select: { id: true, symbol: true },
      });
      securityIdsBySymbol.set(security.symbol, security.id);
    }

    const strategy = await prisma.strategy.create({
      data: {
        userId: ownerUserId,
        name: "Discount accumulator",
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as unknown as object,
            definitionHash,
          },
        },
      },
      include: { versions: true },
    });
    strategyId = strategy.id;
    strategyVersionId = strategy.versions[0]?.id ?? "";

    const otherStrategy = await prisma.strategy.create({
      data: {
        userId: otherUserId,
        name: "Not yours",
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as unknown as object,
            definitionHash,
          },
        },
      },
    });
    otherStrategyId = otherStrategy.id;

    const list = await prisma.stockList.create({
      data: { userId: ownerUserId, name: "Core universe" },
    });
    stockListId = list.id;
    for (const letter of ["C", "A", "B"]) {
      const securityId = securityIdsBySymbol.get(symbolOf(letter)) ?? "";
      await prisma.stockListItem.create({
        data: {
          stockListId,
          securityId,
          buyWindowMode: letter === "A" ? "CUSTOM" : "FULL",
          // Two adjacent ranges, written past the API on purpose: the snapshot must carry the
          // canonical merged form, proving submission normalizes rather than copying rows.
          ...(letter === "A"
            ? {
                buyWindows: {
                  create: [
                    {
                      startDate: new Date("2020-07-01T00:00:00.000Z"),
                      endDate: new Date("2020-12-31T00:00:00.000Z"),
                    },
                    {
                      startDate: new Date("2020-01-01T00:00:00.000Z"),
                      endDate: new Date("2020-06-30T00:00:00.000Z"),
                    },
                  ],
                },
              }
            : {}),
        },
      });
    }

    const emptyList = await prisma.stockList.create({
      data: { userId: ownerUserId, name: "Nothing in here" },
    });
    emptyListId = emptyList.id;

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
      // Runs, jobs, progress, trades, equity and positions all cascade from the users. Trades and
      // positions hold `onDelete: Restrict` references to Security, so the users must go first.
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, otherEmail] } },
      });
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: providerSymbols } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  it("requires authentication on every route", async () => {
    const anonymous = request(app.getHttpServer());
    await anonymous.get("/benchmarks").expect(401);
    await anonymous.get("/backtests").expect(401);
    await anonymous.post("/backtests").send(submission()).expect(401);
    await anonymous.get(`/backtests/${randomUUID()}`).expect(401);
    await anonymous.get(`/backtests/${randomUUID()}/progress`).expect(401);
    await anonymous.get(`/backtests/${randomUUID()}/strategy`).expect(401);
  });

  it("publishes the reconciled benchmark catalog without leaking the provider symbol", async () => {
    const response = await owner.get("/benchmarks").expect(200);
    const benchmarks = response.body as BenchmarkResponse[];
    const sp500 = benchmarks.find((row) => row.code === DEFAULT_BENCHMARK_CODE);
    expect(sp500).toBeDefined();
    expect(sp500?.name).toBe("S&P 500");
    expect(sp500?.currency).toBe("USD");
    // Which series backs the code is a server-side sourcing decision: the browser gets the
    // contract's fields and nothing else. (The catalog *description* explains the sourcing in
    // prose, which is product copy, not a machine-readable provider identifier.)
    expect(Object.keys(sp500 ?? {}).sort()).toEqual([
      "code",
      "currency",
      "description",
      "id",
      "name",
    ]);
    expect(sp500).not.toHaveProperty("providerSymbol");
    expect(sp500).not.toHaveProperty("sourceKind");
  });

  it("freezes every result-affecting input into an immutable snapshot", async () => {
    const run = await submit();

    const stored = await prisma.backtestRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    const snapshot = stored.snapshot as unknown as BacktestRunSnapshot;

    expect(snapshot.snapshotVersion).toBe(BACKTEST_SNAPSHOT_VERSION);
    expect(snapshot.strategy).toMatchObject({
      strategyId,
      name: "Discount accumulator",
      versionId: strategyVersionId,
      versionNumber: 1,
      definitionHash,
    });
    expect(snapshot.strategy.definition).toEqual(definition);
    expect(snapshot.stockList).toEqual({ stockListId, name: "Core universe" });

    // Canonical ordering, and the two adjacent windows merged by the domain normalizer.
    expect(snapshot.securities.map((row) => row.symbol)).toEqual([
      symbolOf("A"),
      symbolOf("B"),
      symbolOf("C"),
    ]);
    expect(snapshot.securities[0]).toEqual({
      securityId: securityIdsBySymbol.get(symbolOf("A")),
      symbol: symbolOf("A"),
      name: "Backtest Security A",
      exchangeCode: "NASDAQ",
      currency: "USD",
      buyWindowMode: "CUSTOM",
      buyWindows: [{ startDate: "2020-01-01", endDate: "2020-12-31" }],
    });
    expect(snapshot.securities[1]?.buyWindowMode).toBe("FULL");
    expect(snapshot.securities[1]?.buyWindows).toEqual([]);

    expect(snapshot.period).toEqual({
      startDate: "2020-01-01",
      endDate: "2020-12-31",
    });
    expect(snapshot.capital).toEqual({
      initialCapital: 100_000,
      monthlyContribution: 500,
    });
    expect(snapshot.allocation).toEqual({
      maximumPositions: 10,
      fullPositionFraction: 0.1,
    });
    expect(snapshot.benchmark).toEqual({
      benchmarkId: expect.any(String),
      // The exact immutable series, not just the code: this is what execution resolves. The
      // version *number* is not the contract — a database that has seen a re-sourcing is at a
      // higher one — so what matters is that a concrete version is pinned, asserted against the
      // catalog's current series below.
      seriesId: expect.any(String),
      seriesVersion: expect.any(Number),
      code: "SP500",
      name: "S&P 500",
      sourceKind: "FMP_SYMBOL",
      providerSymbol: "SPY",
      methodologyVersion: 1,
      currency: "USD",
    });
    // The dates the run simulates come from a series the engine names, pinned the same way and
    // recorded separately from the comparison above.
    expect(snapshot.executionCalendar).toEqual({
      referenceCode: "SP500",
      seriesId: expect.any(String),
      seriesVersion: expect.any(Number),
    });

    // Pinned to the definition actually in force at submission — the highest version, by id.
    const currentSeries = await prisma.benchmarkSeries.findFirstOrThrow({
      where: { benchmark: { code: "SP500" } },
      orderBy: { version: "desc" },
    });
    expect(snapshot.benchmark.seriesId).toBe(currentSeries.id);
    expect(snapshot.benchmark.seriesVersion).toBe(currentSeries.version);
    expect(snapshot.executionCalendar.seriesId).toBe(currentSeries.id);
    expect(snapshot.methodology).toEqual({ ...BACKTEST_METHODOLOGY });
    expect(snapshot.dataRevisions.priceDatasetVersion).toBeTypeOf("number");
    expect(snapshot.dataRevisions.derivedStateRevision).toBeTypeOf("number");

    // The digest is verifiable against what PostgreSQL actually holds: it is taken over the
    // canonical serialization, which sorts keys — `jsonb` does not preserve their order — and
    // excludes `submittedAt`, so the hash identifies the inputs rather than the moment.
    expect(stored.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.snapshotHash).toBe(
      createHash("sha256")
        .update(
          canonicalBacktestSnapshotDocument(
            stored.snapshot as unknown as BacktestRunSnapshot,
          ),
        )
        .digest("hex"),
    );

    // The submission response projects that same document, never the current rows.
    expect(run.status).toBe("QUEUED");
    expect(run.configuration).toEqual({
      strategyId,
      strategyName: "Discount accumulator",
      strategyVersionNumber: 1,
      stockListId,
      stockListName: "Core universe",
      securityCount: 3,
      startDate: "2020-01-01",
      endDate: "2020-12-31",
      initialCapital: 100_000,
      monthlyContribution: 500,
      maximumPositions: 10,
      fullPositionPercent: 10,
      benchmark: {
        benchmarkId: expect.any(String),
        code: "SP500",
        name: "S&P 500",
        sourceKind: "FMP_SYMBOL",
        methodologyVersion: 1,
      },
      methodology: { ...BACKTEST_METHODOLOGY },
    });
    expect(run.progress).toEqual({
      percent: 0,
      message: "Queued",
      simulatedThrough: null,
      sequence: 0,
      updatedAt: expect.any(String),
    });
    expect(run.live).toBeNull();
    expect(run.result).toBeNull();
    expect(run.failure).toBeNull();
  });

  it("creates exactly one queued job together with the run", async () => {
    const run = await submit();

    const jobs = await prisma.backtestJob.findMany({
      where: { runId: run.id },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("QUEUED");
    expect(jobs[0]?.attempts).toBe(0);
    expect(jobs[0]?.availableAt.valueOf()).toBeLessThanOrEqual(Date.now());

    const progress = await prisma.backtestRunProgress.findUnique({
      where: { runId: run.id },
    });
    expect(progress).toMatchObject({
      percent: 0,
      message: "Queued",
      sequence: 0,
    });
  });

  it("keeps a submitted run unchanged when the strategy or the list is edited", async () => {
    const run = await submit();

    const changed: StrategyDefinition = {
      ...definition,
      buyLevels: definition.buyLevels.map((level) => ({
        ...level,
        percentage: 100 as const,
      })),
    };
    await prisma.strategyVersion.create({
      data: {
        strategyId,
        versionNumber: 2,
        definition: changed as unknown as object,
        definitionHash: createHash("sha256")
          .update(strategyDefinitionFingerprint(changed))
          .digest("hex"),
      },
    });
    await prisma.strategy.update({
      where: { id: strategyId },
      data: { name: "Renamed after submission" },
    });
    await prisma.stockList.update({
      where: { id: stockListId },
      data: { name: "Renamed list" },
    });
    await prisma.stockListItem.deleteMany({
      where: {
        stockListId,
        securityId: securityIdsBySymbol.get(symbolOf("C")),
      },
    });

    const after = await owner.get(`/backtests/${run.id}`).expect(200);
    const detail = after.body as BacktestRunDetailResponse;
    expect(detail.configuration.strategyName).toBe("Discount accumulator");
    expect(detail.configuration.strategyVersionNumber).toBe(1);
    expect(detail.configuration.stockListName).toBe("Core universe");
    expect(detail.configuration.securityCount).toBe(3);

    const strategyResponse = await owner
      .get(`/backtests/${run.id}/strategy`)
      .expect(200);
    const runStrategy = strategyResponse.body as BacktestRunStrategyResponse;
    expect(runStrategy).toEqual({
      strategyName: "Discount accumulator",
      versionNumber: 1,
      definition,
    });

    // Restore the fixture for the tests that follow.
    await prisma.strategy.update({
      where: { id: strategyId },
      data: { name: "Discount accumulator" },
    });
    await prisma.stockList.update({
      where: { id: stockListId },
      data: { name: "Core universe" },
    });
    await prisma.stockListItem.create({
      data: {
        stockListId,
        securityId: securityIdsBySymbol.get(symbolOf("C")) ?? "",
        buyWindowMode: "FULL",
      },
    });
  });

  it("lists only the caller's runs, newest queued first", async () => {
    const first = await submit();
    const second = await submit();

    const response = await owner.get("/backtests").expect(200);
    const rows = response.body as BacktestRunSummaryResponse[];
    const ids = rows.map((row) => row.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(rows.every((row) => row.status === "QUEUED")).toBe(true);
    expect(rows[0]).toMatchObject({
      strategyName: "Discount accumulator",
      stockListName: "Core universe",
      benchmarkCode: "SP500",
      benchmarkName: "S&P 500",
      startDate: "2020-01-01",
      endDate: "2020-12-31",
      initialCapital: 100_000,
      maximumPositions: 10,
      progressPercent: 0,
      progressMessage: "Queued",
      portfolioReturnPercent: null,
      benchmarkReturnPercent: null,
      alphaPercent: null,
    });

    const foreign = await other.get("/backtests").expect(200);
    expect(foreign.body).toEqual([]);
  });

  it("answers a foreign run exactly like one that does not exist", async () => {
    const run = await submit();
    const missingId = randomUUID();

    for (const path of ["", "/progress", "/strategy"]) {
      const foreign = await other
        .get(`/backtests/${run.id}${path}`)
        .expect(404);
      const missing = await other
        .get(`/backtests/${missingId}${path}`)
        .expect(404);
      expect(foreign.body).toEqual(missing.body);
    }

    // The owner still sees it.
    await owner.get(`/backtests/${run.id}`).expect(200);
  });

  it("rejects a configuration it cannot run", async () => {
    const unknownStrategy = await expectRejected(
      submission({ strategyId: randomUUID() }),
      "strategy was not found",
    );
    const foreignStrategy = await expectRejected(
      submission({ strategyId: otherStrategyId }),
      "strategy was not found",
    );
    // A strategy that belongs to someone else must be indistinguishable from a missing one.
    expect(foreignStrategy).toEqual(unknownStrategy);

    await expectRejected(
      submission({ stockListId: randomUUID() }),
      "stock list was not found",
    );
    await expectRejected(
      submission({ stockListId: emptyListId }),
      "stock list is empty",
    );
    await expectRejected(
      submission({ benchmarkCode: "NIKKEI_225" }),
      "not a selectable benchmark",
    );
  });

  it("rejects an unusable period", async () => {
    await expectRejected(
      submission({ startDate: "2020-12-31", endDate: "2020-01-01" }),
      "must start before it ends",
    );
    await expectRejected(
      submission({ startDate: "2020-01-01", endDate: "2020-01-01" }),
      "must start before it ends",
    );
    await expectRejected(
      submission({ startDate: "2023-02-01", endDate: "2023-02-31" }),
      "valid end date",
    );
    const nextYear = new Date();
    nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
    await expectRejected(
      submission({ endDate: nextYear.toISOString().slice(0, 10) }),
      "cannot end in the future",
    );
    await expectRejected(
      submission({ startDate: "1980-01-01", endDate: "2020-12-31" }),
      `at most ${BACKTEST_MAX_PERIOD_YEARS} years`,
    );
  });

  it("rejects capital, contribution and position bounds outside the shared limits", async () => {
    await expectRejected(submission({ initialCapital: 0 }), "initial capital");
    await expectRejected(
      submission({ initialCapital: 1_000_000_001 }),
      "initial capital",
    );
    await expectRejected(
      submission({ initialCapital: "100000" }),
      "initial capital",
    );
    await expectRejected(
      submission({ monthlyContribution: -1 }),
      "monthly contribution",
    );
    await expectRejected(
      submission({ monthlyContribution: 10_000_001 }),
      "monthly contribution",
    );
    await expectRejected(
      submission({ maximumPositions: 0 }),
      "Maximum positions",
    );
    await expectRejected(
      submission({ maximumPositions: 101 }),
      "Maximum positions",
    );
    await expectRejected(
      submission({ maximumPositions: 2.5 }),
      "Maximum positions",
    );
  });

  it("rejects request keys that are not part of a backtest configuration", async () => {
    for (const key of ["maxAllocationPercent", "definition", "userId"]) {
      await expectRejected(
        { ...submission(), [key]: "x" },
        "is not part of a backtest configuration",
      );
    }
  });

  it("reports the live snapshot a worker wrote, and nothing when it is malformed", async () => {
    const run = await submit();
    const live: BacktestLiveSnapshotResponse = {
      simulatedThrough: "2020-06-30",
      completedDays: 126,
      totalDays: 253,
      cash: 12_500.5,
      positionsValue: 91_000.25,
      totalValue: 103_500.75,
      investedCapital: 103_000,
      netProfit: 500.75,
      portfolioReturnPercent: 3.5,
      benchmarkReturnPercent: 2.25,
      alphaPercent: 1.25,
      maxDrawdownPercent: 4.75,
      benchmarkValue: 105_100.5,
      cashBaselineValue: 103_000,
      tradeCount: 7,
      openPositions: 2,
      curve: [
        {
          date: "2020-01-02",
          portfolioReturnPercent: 0,
          benchmarkReturnPercent: 0,
          strategyValue: 100_000,
          benchmarkValue: 100_000,
          cashBaselineValue: 100_000,
        },
        {
          date: "2020-06-30",
          portfolioReturnPercent: 3.5,
          benchmarkReturnPercent: null,
          strategyValue: 103_500.75,
          benchmarkValue: null,
          cashBaselineValue: 103_000,
        },
      ],
      holdings: [
        {
          symbol: symbolOf("A"),
          name: "Backtest Security A",
          shares: 12.5,
          averageCost: 100,
          lastPrice: 110,
          lastPriceDate: "2020-06-30",
          marketValue: 1_375,
          unrealizedPnlPercent: 10,
          allocationPercent: 1.33,
        },
      ],
      recentTrades: [
        {
          sequence: 7,
          date: "2020-06-15",
          symbol: symbolOf("A"),
          name: "Backtest Security A",
          action: "BUY",
          levelPercentage: 25,
          shares: 12.5,
          price: 100,
          amount: 1_250,
          realizedPnl: null,
          realizedPnlPercent: null,
        },
      ],
    };

    const startedAt = new Date();
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: { status: "RUNNING", startedAt },
    });
    await prisma.backtestRunProgress.update({
      where: { runId: run.id },
      data: {
        percent: 50,
        message: "Simulating",
        simulatedThrough: new Date("2020-06-30T00:00:00.000Z"),
        sequence: 12,
        snapshot: live as unknown as object,
      },
    });

    const response = await owner
      .get(`/backtests/${run.id}/progress`)
      .expect(200);
    const progress = response.body as BacktestProgressResponse;
    expect(progress).toMatchObject({
      runId: run.id,
      status: "RUNNING",
      percent: 50,
      message: "Simulating",
      simulatedThrough: "2020-06-30",
      sequence: 12,
      startedAt: startedAt.toISOString(),
      completedAt: null,
      failure: null,
    });
    expect(progress.live).toEqual(live);
    expect(progress.updatedAt).toEqual(expect.any(String));

    // The polling payload never carries a completed result or the configuration.
    expect(progress).not.toHaveProperty("result");
    expect(progress).not.toHaveProperty("configuration");

    // A snapshot written by an older or drifted worker is reported as "no live state yet".
    await prisma.backtestRunProgress.update({
      where: { runId: run.id },
      data: { snapshot: { simulatedThrough: "2020-06-30" } },
    });
    const degraded = await owner
      .get(`/backtests/${run.id}/progress`)
      .expect(200);
    expect((degraded.body as BacktestProgressResponse).live).toBeNull();
    expect((degraded.body as BacktestProgressResponse).percent).toBe(50);
  });

  it("renders a completed run's durable result", async () => {
    const run = await submit({
      startDate: "2015-01-01",
      endDate: "2020-12-31",
    });
    const equityDayCount = BACKTEST_RESULT_MAX_CURVE_POINTS + 100;
    const lastIndex = equityDayCount - 1;

    await prisma.backtestDailyEquity.createMany({
      data: Array.from({ length: equityDayCount }, (_unused, index) => ({
        runId: run.id,
        date: new Date(`${isoDate(index)}T00:00:00.000Z`),
        cash: 1_000,
        positionsValue: 99_000 + index,
        totalValue: 100_000 + index,
        investedCapital: 100_000,
        returnIndex: 1 + index / 10_000,
        benchmarkIndex: index === 0 ? null : 1 + index / 20_000,
        // A funded benchmark scenario the worker wrote, absent on the day it could not be priced.
        benchmarkValue: index === 0 ? null : 100_000 + index / 2,
        cashBaselineValue: 100_000,
        openPositions: 2,
      })),
    });

    const securityA = securityIdsBySymbol.get(symbolOf("A")) ?? "";
    const securityB = securityIdsBySymbol.get(symbolOf("B")) ?? "";
    await prisma.backtestTrade.createMany({
      data: [
        {
          runId: run.id,
          sequence: 1,
          date: new Date("2015-01-02T00:00:00.000Z"),
          securityId: securityA,
          symbol: symbolOf("A"),
          name: "Backtest Security A",
          action: "BUY",
          levelId: "buy-1",
          levelPercentage: 25,
          shares: 10,
          price: 100,
          amount: 1_000,
          fees: 0,
          cashAfter: 99_000,
          sharesAfter: 10,
          averageCostAfter: 100,
        },
        {
          runId: run.id,
          sequence: 2,
          date: new Date("2016-03-04T00:00:00.000Z"),
          securityId: securityB,
          symbol: symbolOf("B"),
          name: "Backtest Security B",
          action: "BUY",
          levelId: "buy-1",
          levelPercentage: 25,
          shares: 5,
          price: 200,
          amount: 1_000,
          fees: 0,
          cashAfter: 98_000,
          sharesAfter: 5,
          averageCostAfter: 200,
        },
        {
          runId: run.id,
          sequence: 3,
          date: new Date("2018-09-10T00:00:00.000Z"),
          securityId: securityA,
          symbol: symbolOf("A"),
          name: "Backtest Security A",
          action: "SELL",
          levelPercentage: 50,
          shares: 5,
          price: 150,
          amount: 750,
          fees: 0,
          realizedPnl: 250,
          realizedPnlPercent: 50,
          cashAfter: 98_750,
          sharesAfter: 5,
          averageCostAfter: 100,
        },
      ],
    });

    await prisma.backtestPosition.createMany({
      data: [
        {
          runId: run.id,
          securityId: securityA,
          symbol: symbolOf("A"),
          name: "Backtest Security A",
          openedDate: new Date("2015-01-02T00:00:00.000Z"),
          shares: 5,
          averageCost: 100,
          lastPrice: 180,
          lastPriceDate: new Date("2020-12-31T00:00:00.000Z"),
          marketValue: 900,
          unrealizedPnl: 400,
          unrealizedPnlPercent: 80,
          allocationPercent: 0.9,
        },
        {
          runId: run.id,
          securityId: securityB,
          symbol: symbolOf("B"),
          name: "Backtest Security B",
          openedDate: new Date("2016-03-04T00:00:00.000Z"),
          shares: 5,
          averageCost: 200,
          lastPrice: 260,
          lastPriceDate: new Date("2020-12-31T00:00:00.000Z"),
          marketValue: 1_300,
          unrealizedPnl: 300,
          unrealizedPnlPercent: 30,
          allocationPercent: 1.3,
        },
      ],
    });

    const completedAt = new Date();
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: { status: "COMPLETED", startedAt: completedAt, completedAt },
    });
    await prisma.backtestRunSummary.create({
      data: {
        runId: run.id,
        firstSimulatedDate: new Date(`${isoDate(0)}T00:00:00.000Z`),
        lastSimulatedDate: new Date(`${isoDate(lastIndex)}T00:00:00.000Z`),
        tradingDays: equityDayCount,
        investedCapital: 100_000,
        finalCash: 1_000,
        finalPositionsValue: 2_200,
        finalValue: 103_200,
        netProfit: 3_200,
        portfolioReturnPercent: 3.2,
        benchmarkReturnPercent: 1.6,
        alphaPercent: 1.6,
        portfolioCagrPercent: 0.53,
        maxDrawdownPercent: 2.5,
        benchmarkMaxDrawdownPercent: 3.5,
        realizedPnl: 250,
        unrealizedPnl: 700,
        totalTrades: 3,
        buyTrades: 2,
        sellTrades: 1,
        finalExitTrades: 0,
        winningTrades: 1,
        losingTrades: 0,
        openPositions: 2,
      },
    });

    const response = await owner.get(`/backtests/${run.id}`).expect(200);
    const detail = response.body as BacktestRunDetailResponse;
    expect(detail.status).toBe("COMPLETED");
    expect(detail.failure).toBeNull();
    // A completed run reports its durable result, not the in-flight projection.
    expect(detail.live).toBeNull();

    const result = detail.result;
    expect(result).not.toBeNull();
    expect(result?.summary).toEqual({
      firstSimulatedDate: isoDate(0),
      lastSimulatedDate: isoDate(lastIndex),
      tradingDays: equityDayCount,
      investedCapital: 100_000,
      finalCash: 1_000,
      finalPositionsValue: 2_200,
      finalValue: 103_200,
      netProfit: 3_200,
      portfolioReturnPercent: 3.2,
      benchmarkReturnPercent: 1.6,
      alphaPercent: 1.6,
      portfolioCagrPercent: 0.53,
      maxDrawdownPercent: 2.5,
      benchmarkMaxDrawdownPercent: 3.5,
      realizedPnl: 250,
      unrealizedPnl: 700,
      totalTrades: 3,
      buyTrades: 2,
      sellTrades: 1,
      finalExitTrades: 0,
      winningTrades: 1,
      losingTrades: 0,
      openPositions: 2,
    });

    // Downsampled to the shared bound, keeping the true first and last point.
    const curve = result?.curve ?? [];
    expect(curve).toHaveLength(BACKTEST_RESULT_MAX_CURVE_POINTS);
    expect(curve[0]).toEqual({
      date: isoDate(0),
      portfolioReturnPercent: 0,
      benchmarkReturnPercent: null,
      // The absolute scenarios ride the same points: the Strategy line is the run's own total
      // value, and the benchmark is absent on a date it had no close, exactly as its percentage
      // reading is.
      strategyValue: 100_000,
      benchmarkValue: null,
      cashBaselineValue: 100_000,
    });
    const last = curve[curve.length - 1];
    expect(last?.date).toBe(isoDate(lastIndex));
    expect(last?.portfolioReturnPercent).toBeCloseTo(
      (lastIndex / 10_000) * 100,
      8,
    );
    expect(last?.benchmarkReturnPercent).toBeCloseTo(
      (lastIndex / 20_000) * 100,
      8,
    );
    expect(last?.strategyValue).toBe(100_000 + lastIndex);
    expect(last?.benchmarkValue).toBe(100_000 + lastIndex / 2);
    expect(last?.cashBaselineValue).toBe(100_000);
    expect(curve.map((point) => point.date)).toEqual(
      [...curve.map((point) => point.date)].sort(),
    );

    // Most recent first, by deterministic execution sequence.
    expect(result?.trades.map((trade) => trade.sequence)).toEqual([3, 2, 1]);
    expect(result?.trades[0]).toEqual({
      sequence: 3,
      date: "2018-09-10",
      symbol: symbolOf("A"),
      name: "Backtest Security A",
      action: "SELL",
      levelPercentage: 50,
      shares: 5,
      price: 150,
      amount: 750,
      realizedPnl: 250,
      realizedPnlPercent: 50,
    });
    expect(result?.trades[2]?.realizedPnl).toBeNull();

    expect(result?.holdings.map((holding) => holding.symbol)).toEqual([
      symbolOf("B"),
      symbolOf("A"),
    ]);
    expect(result?.holdings[0]).toEqual({
      symbol: symbolOf("B"),
      name: "Backtest Security B",
      shares: 5,
      averageCost: 200,
      lastPrice: 260,
      lastPriceDate: "2020-12-31",
      marketValue: 1_300,
      unrealizedPnlPercent: 30,
      allocationPercent: 1.3,
    });

    // The trade log is bounded, but the run's own count stays truthful.
    expect(result?.summary.totalTrades).toBe(3);
  });

  it("still renders a run completed before the funded benchmark scenario existed", async () => {
    const run = await submit({
      startDate: "2015-01-01",
      endDate: "2015-01-31",
    });
    // Exactly the shape the migration leaves behind: `cashBaselineValue` projected from the
    // `investedCapital` those rows already held, and `benchmarkValue` absent because a funded
    // portfolio is not derivable from a growth index once a run has contributions.
    await prisma.backtestDailyEquity.createMany({
      data: [0, 1, 2].map((index) => ({
        runId: run.id,
        date: new Date(`${isoDate(index)}T00:00:00.000Z`),
        cash: 500,
        positionsValue: 99_500 + index,
        totalValue: 100_000 + index,
        investedCapital: 100_000 + index * 10,
        returnIndex: 1 + index / 10_000,
        benchmarkIndex: 1 + index / 20_000,
        benchmarkValue: null,
        cashBaselineValue: 100_000 + index * 10,
        openPositions: 1,
      })),
    });
    const completedAt = new Date();
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: { status: "COMPLETED", startedAt: completedAt, completedAt },
    });
    await prisma.backtestRunSummary.create({
      data: {
        runId: run.id,
        firstSimulatedDate: new Date(`${isoDate(0)}T00:00:00.000Z`),
        lastSimulatedDate: new Date(`${isoDate(2)}T00:00:00.000Z`),
        tradingDays: 3,
        investedCapital: 100_020,
        finalCash: 500,
        finalPositionsValue: 99_502,
        finalValue: 100_002,
        netProfit: -18,
        portfolioReturnPercent: 0.02,
        benchmarkReturnPercent: 0.01,
        alphaPercent: 0.01,
        portfolioCagrPercent: null,
        maxDrawdownPercent: 0,
        benchmarkMaxDrawdownPercent: 0,
        realizedPnl: 0,
        unrealizedPnl: -18,
        totalTrades: 0,
        buyTrades: 0,
        sellTrades: 0,
        finalExitTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        openPositions: 1,
      },
    });

    const response = await owner.get(`/backtests/${run.id}`).expect(200);
    const curve = (response.body as BacktestRunDetailResponse).result?.curve;

    expect(curve).toHaveLength(3);
    // Strategy and Cash are real for such a run; the benchmark scenario is reported as absent
    // rather than reconstructed from a number that cannot produce it.
    const point = curve?.[2];
    expect(point?.date).toBe(isoDate(2));
    expect(point?.portfolioReturnPercent).toBeCloseTo((2 / 10_000) * 100, 8);
    expect(point?.benchmarkReturnPercent).toBeCloseTo((2 / 20_000) * 100, 8);
    expect(point?.strategyValue).toBe(100_002);
    expect(point?.benchmarkValue).toBeNull();
    expect(point?.cashBaselineValue).toBe(100_020);
  });

  it("exposes a failure's product code and message, never its developer detail", async () => {
    const run = await submit();
    // The dead attempt left a live snapshot behind. A FAILED run must not present it: a partial
    // curve, metrics and trade log beside a failure banner would read as that run's outcome.
    await prisma.backtestRunProgress.update({
      where: { runId: run.id },
      data: {
        percent: 62,
        message: "Running backtest — simulated through 2019-06-14",
        sequence: 41,
        snapshot: {
          simulatedThrough: "2019-06-14",
          completedDays: 400,
          totalDays: 640,
          cash: 1,
          positionsValue: 2,
          totalValue: 3,
          investedCapital: 4,
          netProfit: 5,
          portfolioReturnPercent: 6,
          benchmarkReturnPercent: 7,
          alphaPercent: 8,
          maxDrawdownPercent: 9,
          tradeCount: 3,
          openPositions: 1,
          curve: [
            {
              date: "2019-06-14",
              portfolioReturnPercent: 6,
              benchmarkReturnPercent: 7,
            },
          ],
          holdings: [],
          recentTrades: [],
        },
      },
    });
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        startedAt: new Date(),
        completedAt: new Date(),
        failureCode: "DATA_UNAVAILABLE",
        failurePhase: "PREPARING_DATA",
        failureMessage:
          "Price history is not available for the requested period",
        failureDetail: {
          provider: "fmp",
          endpoint: `https://example.invalid/api?apikey=${suffix}`,
          stack: "Error: connect ECONNREFUSED",
        },
      },
    });

    const detail = await owner.get(`/backtests/${run.id}`).expect(200);
    const detailBody = detail.body as BacktestRunDetailResponse;
    expect(detailBody.failure).toEqual({
      code: "DATA_UNAVAILABLE",
      phase: "PREPARING_DATA",
      message: "Price history is not available for the requested period",
    });
    expect(detailBody.result).toBeNull();
    // Terminal means terminal: the in-flight projection is dropped for FAILED as it is for
    // COMPLETED, so nothing renders the dead attempt's partial numbers as a result.
    expect(detailBody.live).toBeNull();

    const progress = await owner
      .get(`/backtests/${run.id}/progress`)
      .expect(200);
    const progressBody = progress.body as BacktestProgressResponse;
    expect(progressBody.failure).toEqual({
      code: "DATA_UNAVAILABLE",
      phase: "PREPARING_DATA",
      message: "Price history is not available for the requested period",
    });
    expect(progressBody.live).toBeNull();

    for (const body of [detail.body, progress.body]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("failureDetail");
      expect(serialized).not.toContain("ECONNREFUSED");
      expect(serialized).not.toContain("example.invalid");
      expect(serialized).not.toContain(suffix);
    }
  });

  it("serves the years a run has finished, in order, on both surfaces", async () => {
    const run = await submit();
    await prisma.backtestRunMilestone.createMany({
      data: ["2015", "2016", "2017"].map((year, index) => ({
        runId: run.id,
        sequence: index + 1,
        year,
        simulatedThrough: new Date(`${year}-12-31T00:00:00.000Z`),
        percent: (index + 1) * 30,
        completedDays: (index + 1) * 252,
        totalDays: 756,
        cash: 1_000,
        totalValue: 11_000 + index,
        investedCapital: 10_000,
        portfolioReturnPercent: index * 5,
        benchmarkReturnPercent: index * 4,
        alphaPercent: index,
        maxDrawdownPercent: 6,
        tradeCount: index * 3,
        openPositions: 2,
      })),
    });

    for (const path of [
      `/backtests/${run.id}`,
      `/backtests/${run.id}/progress`,
    ]) {
      const response = await owner.get(path).expect(200);
      const body = response.body as
        BacktestRunDetailResponse | BacktestProgressResponse;
      expect(body.milestones.map((entry) => entry.year)).toEqual([
        "2015",
        "2016",
        "2017",
      ]);
      expect(body.milestones.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
      expect(body.milestones[0]?.simulatedThrough).toBe("2015-12-31");
      expect(body.milestones[2]?.portfolioReturnPercent).toBe(10);
      // Compact by design: a milestone is a scalar snapshot, never a copy of the curve.
      expect(Object.keys(body.milestones[0] ?? {})).not.toContain("curve");
    }
  });

  it("keeps a queued run bound to the benchmark series it was submitted against", async () => {
    // A benchmark of this test's own, so advancing a definition cannot disturb `SP500` for the
    // suites around it. The invariant is about versioning, not about which code carries it.
    const store = new PrismaBenchmarkDataStore(prisma);
    const code = `PINNED_${suffix.slice(0, 8).toUpperCase()}`;
    const definition = {
      code,
      name: "Pinned Fixture",
      sourceKind: "FMP_SYMBOL" as const,
      providerSymbol: "OLDSYM",
      currency: "USD",
      methodologyVersion: 1,
      isActive: true,
      displayOrder: 50,
    };
    await store.reconcileBenchmarkCatalog([definition]);

    const run = await submit({ benchmarkCode: code });
    const before = await prisma.backtestRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { benchmarkSeriesId: true, snapshot: true },
    });

    // The catalog advances: re-sourced under a new methodology. This is the moment the old design
    // lost reproducibility — the row every historical bar hung off was edited in place, and a run
    // that had not started yet would have executed against a definition it never chose.
    await store.reconcileBenchmarkCatalog([
      { ...definition, providerSymbol: "NEWSYM", methodologyVersion: 2 },
    ]);
    const versions = await prisma.benchmarkSeries.findMany({
      where: { benchmark: { code } },
      orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions[1]?.providerSymbol).toBe("NEWSYM");

    // The run still points at v1, and its snapshot still describes v1.
    const after = await prisma.backtestRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { benchmarkSeriesId: true, snapshot: true },
    });
    expect(after.benchmarkSeriesId).toBe(before.benchmarkSeriesId);
    expect(after.benchmarkSeriesId).toBe(versions[0]?.id);
    const snapshot = after.snapshot as unknown as BacktestRunSnapshot;
    expect(snapshot.benchmark.seriesId).toBe(versions[0]?.id);
    expect(snapshot.benchmark.seriesVersion).toBe(1);
    expect(snapshot.benchmark.providerSymbol).toBe("OLDSYM");

    const detail = await owner.get(`/backtests/${run.id}`).expect(200);
    const body = detail.body as BacktestRunDetailResponse;
    expect(body.configuration.benchmark.methodologyVersion).toBe(1);
    // And the browser still never learns which ticker backs the code.
    expect(JSON.stringify(body)).not.toContain("NEWSYM");
    expect(JSON.stringify(body)).not.toContain("OLDSYM");

    // Returning the catalog to its earlier definition is a *new* version, not a resurrection of
    // the old one: its data would be fetched fresh, and v1 keeps everything already stored for it.
    await store.reconcileBenchmarkCatalog([definition]);
    const restored = await prisma.benchmarkSeries.findMany({
      where: { benchmark: { code } },
      orderBy: { version: "asc" },
    });
    expect(restored).toHaveLength(3);
    expect(restored[2]?.providerSymbol).toBe("OLDSYM");
    expect(restored[2]?.id).not.toBe(versions[0]?.id);

    // Reconciling the same catalog twice appends nothing.
    await store.reconcileBenchmarkCatalog([definition]);
    expect(
      await prisma.benchmarkSeries.count({ where: { benchmark: { code } } }),
    ).toBe(3);
  });

  it("pins the system execution calendar on every submitted run", async () => {
    const run = await submit();
    const stored = await prisma.backtestRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { executionCalendarSeriesId: true, benchmarkSeriesId: true },
    });
    const reference = await prisma.benchmarkSeries.findFirstOrThrow({
      where: { benchmark: { code: "SP500" } },
      orderBy: { version: "desc" },
    });
    expect(stored.executionCalendarSeriesId).toBe(reference.id);

    // Restrict, not Cascade: the series a run's calendar points at cannot be deleted out from
    // under it, so no catalog operation can leave a run unable to reproduce its own dates.
    await expect(
      prisma.benchmarkSeries.delete({ where: { id: reference.id } }),
    ).rejects.toThrow();
    expect(
      await prisma.benchmarkSeries.count({ where: { id: reference.id } }),
    ).toBe(1);
  });

  it("refuses to accept a run when the system execution calendar is not registered", async () => {
    const runsBeforeRefusal = await prisma.backtestRun.count({
      where: { userId: ownerUserId },
    });

    // A second app, wired to a reference code that is not in the catalog.
    //
    // Deliberately *not* by renaming the canonical `SP500` row: that row is global, and another
    // suite's module boot reconciles the catalog at any moment — recreating `SP500` while it is
    // parked, so restoring it collides on the unique code. A test that has to vandalize shared
    // state to reach a local behaviour is testing the wrong seam.
    const isolated = await Test.createTestingModule({
      imports: [
        ConfigurationModule,
        DatabaseModule,
        AuthModule,
        BacktestsModule,
        BenchmarksModule,
      ],
    })
      .overrideProvider(EXECUTION_CALENDAR_REFERENCE)
      .useValue(`ABSENT_${suffix.slice(0, 8).toUpperCase()}`)
      .compile();
    const isolatedApp = isolated.createNestApplication();
    await isolatedApp.init();

    try {
      const client = request.agent(isolatedApp.getHttpServer());
      await client
        .post("/auth/login")
        .send({ email: ownerEmail, password })
        .expect(200);

      // 503, not 400: nothing about the submission is wrong, and retrying it later is right.
      const response = await client
        .post("/backtests")
        .send(submission())
        .expect(503);
      expect((response.body as { message: string }).message).toContain(
        "market calendar",
      );

      // And no half-created run: the refusal happens before the row exists.
      const runsAfter = await prisma.backtestRun.count({
        where: { userId: ownerUserId },
      });
      expect(runsAfter).toBe(runsBeforeRefusal);
    } finally {
      await isolatedApp.close();
    }

    // The canonical catalog is untouched, which is the whole point of the seam.
    const reference = await prisma.benchmark.findUnique({
      where: { code: "SP500" },
    });
    expect(reference).not.toBeNull();
  });

  it("keeps engine-methodology diagnostics server-side", async () => {
    const run = await submit();
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        failureCode: "ENGINE_VERSION_MISMATCH",
        failurePhase: "PREPARING_DATA",
        failureMessage:
          "This backtest was queued under an older execution methodology. Run it again to use " +
          "the current version.",
        failureDetail: {
          phase: "PREPARING_DATA",
          name: "BacktestRunFailure",
          methodologyMismatches: [
            "execution: snapshot=same-day-close/internal@2 worker=same-day-close/internal@3",
          ],
          stack: "Error: at BacktestProcessor.assertMethodologySupported",
        },
      },
    });

    for (const path of [
      `/backtests/${run.id}`,
      `/backtests/${run.id}/progress`,
    ]) {
      const response = await owner.get(path).expect(200);
      const serialized = JSON.stringify(response.body);
      // The user learns the run is stale and what to do; which internal revisions disagreed is
      // developer detail and would mean nothing to them.
      expect(serialized).toContain("Run it again");
      expect(serialized).not.toContain("methodologyMismatches");
      expect(serialized).not.toContain("internal@2");
      expect(serialized).not.toContain("assertMethodologySupported");
    }
  });

  it("reports no phase rather than one the browser cannot label", async () => {
    const run = await submit();
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        // A phase written by an older or newer worker than this API. Labelling is the browser's
        // job and it only knows the contract's values, so an unknown one is reported as none.
        failurePhase: "DECOMMISSIONING_THE_UNIVERSE",
      },
    });

    const detail = await owner.get(`/backtests/${run.id}`).expect(200);
    const body = detail.body as BacktestRunDetailResponse;
    expect(body.failure?.phase).toBeNull();
    expect(body.failure?.code).toBe("EXECUTION_FAILED");
  });
});
