import { randomUUID } from "node:crypto";
import { getRedisConfig, loadRootEnv } from "@intrinsic/config";
import type {
  BenchmarkResponse,
  MarketOverviewResponse,
} from "@intrinsic/contracts";
import { MARKET_REFERENCE_SERIES } from "@intrinsic/domain";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
  PrismaBenchmarkDataStore,
  RedisBenchmarkDataCache,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { seedQaMarketReferenceDataWith } from "../benchmarks/seed-qa-benchmark-data";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { MarketModule } from "./market.module";

useTestDatabase();

/**
 * `GET /market-overview` end to end, against seeded series.
 *
 * Deterministic on purpose: the series are the QA market-reference fixtures with complete coverage
 * and a current tail watermark, so the loader resolves entirely out of PostgreSQL and this suite
 * never touches FMP. The numbers asserted below are the fixture's, not today's market.
 */
describe("market overview", () => {
  const suffix = randomUUID().slice(0, 8);
  const password = "Local-test-password-42";
  const email = `market-${suffix}@example.test`;

  let app: INestApplication;
  let prisma: PrismaService;
  let guest: ReturnType<typeof request>;
  let user: ReturnType<typeof request.agent>;
  let redis: ReturnType<typeof createStockDataRedisClient>;

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
        BenchmarksModule,
        MarketModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);

    // Bars, coverage and the tail watermark, through the canonical store. Anything less and the
    // loader would decide the recent window is missing and go to the provider.
    const seeded = await seedQaMarketReferenceDataWith(
      new PrismaBenchmarkDataStore(prisma),
    );
    // The Redis projection is shared with every other suite on this machine; a manifest left by an
    // earlier run would be served in preference to what was just written.
    redis = createStockDataRedisClient(getRedisConfig().url);
    const cache = new RedisBenchmarkDataCache(new IoredisCacheClient(redis));
    for (const reference of seeded) {
      await cache.invalidateManifest(reference.seriesId);
    }

    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    await prisma.user.create({
      data: { email, passwordHash, emailVerifiedAt: new Date(), plan: "FREE" },
    });

    guest = request(app.getHttpServer());
    user = request.agent(app.getHttpServer());
    await user.post("/auth/login").send({ email, password }).expect(200);
  });

  afterAll(async () => {
    redis?.disconnect();
    if (prisma) {
      await prisma.user.deleteMany({ where: { email } });
    }
    await app?.close();
  });

  async function overview(
    agent: ReturnType<typeof request> | ReturnType<typeof request.agent>,
  ): Promise<MarketOverviewResponse> {
    const response = await agent.get("/market-overview").expect(200);
    return response.body as MarketOverviewResponse;
  }

  it("is readable without a session", async () => {
    const body = await overview(guest);

    expect(body.basis).toBe("END_OF_DAY");
    expect(body.items.map((item) => item.code)).toEqual(
      MARKET_REFERENCE_SERIES.map((reference) => reference.code),
    );
    expect(body.items.map((item) => item.label)).toEqual([
      "S&P 500",
      "DJIA",
      "VIX",
    ]);
  });

  it("serves a Guest and a signed-in customer the identical market data", async () => {
    const asGuest = await overview(guest);
    const asUser = await overview(user);

    // The market is not a per-account fact, and `generatedAt` is the only thing allowed to differ.
    expect(asUser.items).toEqual(asGuest.items);
    expect(asUser.basis).toBe(asGuest.basis);
  });

  it("reports the fixture's latest session, its change and its seven-session trend", async () => {
    const body = await overview(guest);
    const sp500 = body.items.find((item) => item.code === "SP500_INDEX");
    const vix = body.items.find((item) => item.code === "VIX_INDEX");

    expect(sp500?.status).toBe("AVAILABLE");
    expect(sp500?.value).toBe(7637.05);
    expect(sp500?.previousClose).toBe(7551.81);
    expect(sp500?.changePercent).toBeCloseTo(1.1287, 3);
    expect(sp500?.sparkline).toHaveLength(7);
    expect(sp500?.sparkline.at(-1)?.value).toBe(7637.05);
    // Sessions ascend and never repeat a date.
    const dates = sp500?.sparkline.map((point) => point.date) ?? [];
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);

    // VIX falls in the fixture, so the negative path is covered by data rather than by hope.
    expect(vix?.value).toBe(15.43);
    expect(vix?.changePercent).toBeLessThan(0);
  });

  it("reports the last trading session, never a weekend", async () => {
    const body = await overview(guest);

    for (const item of body.items) {
      expect(item.sessionDate).toBeDefined();
      const weekday = new Date(
        `${item.sessionDate as string}T00:00:00.000Z`,
      ).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
      // And never in the future.
      expect(
        (item.sessionDate as string) <= new Date().toISOString().slice(0, 10),
      ).toBe(true);
    }
  });

  it("never exposes a provider symbol to the browser", async () => {
    const body = JSON.stringify(await overview(guest));

    for (const symbol of ["^GSPC", "^DJI", "^VIX", "GSPC", "SPY"]) {
      expect(body).not.toContain(symbol);
    }
  });

  it("keeps the internal market references out of the backtest benchmark catalog", async () => {
    const response = await guest.get("/benchmarks");
    // `/benchmarks` needs a session; the market overview deliberately does not.
    expect(response.status).toBe(401);

    const listed = (await user.get("/benchmarks").expect(200))
      .body as BenchmarkResponse[];
    // Exactly the one product benchmark. Every suite that registers a fixture benchmark now either
    // makes it non-selectable or deletes it, so anything else here is a leak and must fail.
    expect(listed.map((benchmark) => benchmark.code)).toEqual(["SP500"]);
  });

  it("stores each reference under its own series, so nothing can collide with SPY", async () => {
    const rows = await prisma.benchmark.findMany({
      where: {
        code: {
          in: [
            "SP500",
            ...MARKET_REFERENCE_SERIES.map((reference) => reference.code),
          ],
        },
      },
      include: { series: { orderBy: { version: "desc" }, take: 1 } },
    });

    const byCode = new Map(rows.map((row) => [row.code, row]));
    const sp500 = byCode.get("SP500")?.series[0];
    expect(sp500?.providerSymbol).toBe("SPY");
    expect(sp500?.seriesType).toBe("ETF_PROXY");
    expect(byCode.get("SP500")?.isBacktestSelectable).toBe(true);

    for (const [code, symbol] of [
      ["SP500_INDEX", "^GSPC"],
      ["DJIA_INDEX", "^DJI"],
      ["VIX_INDEX", "^VIX"],
    ] as const) {
      const benchmark = byCode.get(code);
      expect(benchmark?.isActive).toBe(true);
      expect(benchmark?.isBacktestSelectable).toBe(false);
      expect(benchmark?.series[0]?.providerSymbol).toBe(symbol);
      expect(benchmark?.series[0]?.seriesType).toBe("INDEX");
    }

    // Four distinct series ids: PostgreSQL rows, coverage, watermarks and the Redis projection are
    // all keyed by one of these, so hydrating an index can never touch the SPY benchmark's bars.
    const seriesIds = rows.map((row) => row.series[0]?.id);
    expect(new Set(seriesIds).size).toBe(seriesIds.length);

    const spySeriesId = sp500?.id ?? "";
    const indexSeriesIds = rows
      .filter((row) => row.code !== "SP500")
      .map((row) => row.series[0]?.id ?? "");
    const spyBars = await prisma.benchmarkDailyPrice.count({
      where: { seriesId: spySeriesId },
    });
    const indexBarsUnderSpy = await prisma.benchmarkDailyPrice.count({
      where: {
        seriesId: spySeriesId,
        close: { in: [7637.05, 51778.04, 15.43] },
      },
    });
    expect(indexSeriesIds).not.toContain(spySeriesId);
    expect(indexBarsUnderSpy).toBe(0);
    expect(spyBars).toBeGreaterThanOrEqual(0);
  });
});
