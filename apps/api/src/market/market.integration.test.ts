import { randomUUID } from "node:crypto";
import { getRedisConfig, loadRootEnv } from "@intrinsic/config";
import type {
  BenchmarkResponse,
  MarketOverviewResponse,
} from "@intrinsic/contracts";
import {
  MARKET_OVERVIEW_ETF_GROUPS,
  marketOverviewEtfs,
} from "@intrinsic/domain";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import {
  seedQaBenchmarkDataWith,
  seedQaMarketOverviewEtfDataWith,
} from "../benchmarks/seed-qa-benchmark-data";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { STOCK_DATA_PROVIDER } from "../stocks/stock-data.tokens";
import { periodAnchorDate } from "./market-overview";
import { MarketModule } from "./market.module";

useTestDatabase();

const NOT_PROVIDER_CALLS = new Set([
  "then",
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
]);

/**
 * `GET /market-overview` end to end: a compiled application, the real benchmark store in
 * PostgreSQL and the real resident projection in Redis, against the deterministic QA fixtures for
 * all twenty ETFs (`SP500` for `SPY`, nineteen `ETF_*` series).
 *
 * The provider is replaced by a spy whose every method fails the test: a Dashboard read must never
 * reach it, and this proves it on the production composition rather than on a fake service.
 */
describe("market overview", () => {
  const suffix = randomUUID().slice(0, 8);
  const password = "Local-test-password-42";
  const email = `market-${suffix}@example.test`;
  const providerCalls: string[] = [];
  const provider = new Proxy(
    {},
    {
      get(_target, property) {
        // Not provider calls: how Nest and promises probe an object they were handed.
        if (typeof property === "symbol" || NOT_PROVIDER_CALLS.has(property)) {
          return undefined;
        }
        return vi.fn(() => {
          providerCalls.push(String(property));
          throw new Error(
            `the market overview reached the provider: ${String(property)}`,
          );
        });
      },
    },
  );

  let app: INestApplication;
  let prisma: PrismaService;
  let guest: ReturnType<typeof request>;
  let user: ReturnType<typeof request.agent>;
  let redis: ReturnType<typeof createStockDataRedisClient>;
  let store: PrismaBenchmarkDataStore;
  const seriesByCode = new Map<string, string>();

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
    })
      .overrideProvider(STOCK_DATA_PROVIDER)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);

    // Bars, coverage and the tail watermark for all twenty, through the canonical store.
    store = new PrismaBenchmarkDataStore(prisma);
    const spy = await seedQaBenchmarkDataWith(store);
    const etfs = await seedQaMarketOverviewEtfDataWith(store);
    for (const series of [spy, ...etfs]) {
      seriesByCode.set(series.code, series.seriesId);
    }
    // The projection is shared with every other suite on this machine; a head left by an earlier
    // run would be served in preference to what was just written. Dropping it also makes the first
    // read below rebuild every projection from PostgreSQL — the Redis-loss path, provider-free.
    redis = createStockDataRedisClient(getRedisConfig().url);
    const cache = new RedisBenchmarkDataCache(new IoredisCacheClient(redis));
    for (const seriesId of seriesByCode.values()) {
      await cache.invalidateManifest(seriesId);
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

  it("is readable without a session, and never asks the provider", async () => {
    const response = await guest.get("/market-overview").expect(200);
    const body = response.body as MarketOverviewResponse;

    expect(body.basis).toBe("END_OF_DAY");
    expect(body.returnBasis).toBe("PRICE_RETURN");
    expect(providerCalls).toEqual([]);
    // Shared caches must not store it: the body is everybody's, the rate-limit headers are not.
    expect(response.headers["cache-control"]).toBe("private, max-age=60");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("answers exactly twenty ETFs in three groups of 5, 11 and 4, each with six returns", async () => {
    const body = await overview(guest);

    expect(body.groups.map((group) => group.id)).toEqual([
      "BENCHMARKS",
      "US_SECTORS",
      "MACRO_ALTERNATIVES",
    ]);
    expect(body.groups.map((group) => group.instruments.length)).toEqual([
      5, 11, 4,
    ]);
    expect(
      body.groups.map((group) => group.instruments.map((one) => one.ticker)),
    ).toEqual(
      MARKET_OVERVIEW_ETF_GROUPS.map((group) =>
        group.etfs.map((etf) => etf.ticker),
      ),
    );
    expect(body.status).toBe("AVAILABLE");

    for (const instrument of body.groups.flatMap(
      (group) => group.instruments,
    )) {
      expect(instrument.status).toBe("AVAILABLE");
      expect(instrument.sessionDate).toBe(body.asOf);
      for (const value of Object.values(instrument.returns)) {
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(instrument.sparkline?.values.length).toBeGreaterThanOrEqual(52);
      expect(instrument.sparkline?.endDate).toBe(body.asOf);
    }
  });

  it("measures each return from the stored close on or before its anchor", async () => {
    const body = await overview(guest);
    const xlk = body.groups[1]?.instruments.find((one) => one.ticker === "XLK");
    const asOf = body.asOf as string;
    const rows = await store.getDailyPrices(
      seriesByCode.get("ETF_XLK") as string,
      {
        from: "1990-01-01",
        to: asOf,
      },
    );
    const closeOnOrBefore = (date: string) =>
      [...rows].reverse().find((row) => row.date <= date)?.close as number;
    const latest = closeOnOrBefore(asOf);

    for (const period of ["1W", "1M", "3M", "6M", "YTD", "1Y"] as const) {
      const anchor = closeOnOrBefore(periodAnchorDate(period, asOf));
      expect(xlk?.returns[period]).toBeCloseTo((latest / anchor - 1) * 100, 10);
    }
    // The fixture pins XLK rising and XLE falling over every period.
    expect(
      Object.values(xlk?.returns ?? {}).every((value) => (value as number) > 0),
    ).toBe(true);
    const xle = body.groups[1]?.instruments.find((one) => one.ticker === "XLE");
    expect(
      Object.values(xle?.returns ?? {}).every((value) => (value as number) < 0),
    ).toBe(true);
  });

  it("serves a Guest and a signed-in customer the identical summary", async () => {
    const asGuest = await overview(guest);
    const asUser = await overview(user);

    expect(asUser).toEqual(asGuest);
  });

  it("carries no provider symbol, no storage identifier, no price and nothing about the viewer", async () => {
    const serialized = JSON.stringify(await overview(user));

    for (const forbidden of [
      ...seriesByCode.values(),
      "ETF_",
      "SP500",
      "providerSymbol",
      "seriesId",
      "close",
      email,
      "plan",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized.length).toBeLessThan(60_000);
  });

  it("keeps the twenty ETFs out of the backtest benchmark catalog", async () => {
    const listed = (await user.get("/benchmarks").expect(200))
      .body as BenchmarkResponse[];
    expect(listed.map((benchmark) => benchmark.code)).toEqual(["SP500"]);
    expect(marketOverviewEtfs()).toHaveLength(20);
    expect(providerCalls).toEqual([]);
  });
});
