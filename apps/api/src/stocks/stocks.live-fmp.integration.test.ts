/**
 * Live FMP smoke suite for the stock API.
 *
 * Runs the real production wiring end to end: real HTTP routes, real Nest application,
 * real PostgreSQL, real Redis (randomized namespace), and the real FMP client with the
 * real Redis request gate. It asserts sanity and architectural invariants only, never
 * exact FMP numeric values.
 *
 * This suite NEVER runs by default and is excluded from normal CI. It requires all of:
 *   RUN_LIVE_FMP_TESTS=1
 *   FMP_API_KEY=<key>                 (never printed)
 *   TEST_DATABASE_URL=<dedicated DB>  (the normal DATABASE_URL is deliberately refused
 *                                      so live AAPL data never lands in a dev database)
 *
 * Run it with:
 *   RUN_LIVE_FMP_TESTS=1 TEST_DATABASE_URL=postgresql://...:5432/intrinsic_value_test \
 *     pnpm --filter @intrinsic/api test:live
 */
import { randomUUID } from "node:crypto";
import { getFmpConfig, getFmpTrafficConfig, loadRootEnv } from "@intrinsic/config";
import {
  INTRINSIC_VALUE_BLENDS,
  type DailyPrice,
  type DateRange,
  type FinancialStatementCadence,
  type FinancialStatementDraft,
  type FinancialStatementType,
} from "@intrinsic/domain";
import { FmpClient, type FmpStockProviderPort, type MappedFmpProfile } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalStockDataService,
  IoredisCacheClient,
  RedisFmpRequestGate,
  RedisStockDataCache,
  createStockDataRedisClient,
} from "@intrinsic/stock-data";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { LoggedStockDataService } from "./logged-stock-data.service";
import {
  STOCK_DATA_CACHE,
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
  STOCK_DATA_REDIS,
  STOCK_DATA_SERVICE,
  STOCK_DATA_STORE,
} from "./stock-data.tokens";

loadRootEnv();
const enabled = process.env.RUN_LIVE_FMP_TESTS === "1";
const describeLive = enabled ? describe : describe.skip;

const SYMBOL = "AAPL";
const HISTORY_YEARS = 8;
const SLOW = 300_000;
/** Refresh limits from the canonical service; a backfill asks for far more than these. */
const FUNDAMENTALS_REFRESH_MAX_LIMIT = 12;

type ProviderCall =
  | { kind: "profile" }
  | { kind: "prices"; from?: string; to?: string }
  | {
      kind: "statements";
      statementType: FinancialStatementType;
      cadence: FinancialStatementCadence;
      limit: number;
    };

/**
 * Records what was asked of the real FMP client, so "no second historical backfill" is an
 * assertion about actual provider traffic rather than about unchanged row counts, which a
 * repeated backfill returning identical rows would also satisfy.
 *
 * It captures only the request shape already present in the port signature — never the
 * credential, a URL, or a response body.
 */
class CountingFmpProvider implements FmpStockProviderPort {
  readonly calls: ProviderCall[] = [];

  constructor(private readonly delegate: FmpStockProviderPort) {}

  getProfile(symbol: string): Promise<MappedFmpProfile | null> {
    this.calls.push({ kind: "profile" });
    return this.delegate.getProfile(symbol);
  }

  getDailyPrices(
    symbol: string,
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]> {
    this.calls.push({ kind: "prices", from: range.from, to: range.to });
    return this.delegate.getDailyPrices(symbol, securityId, range);
  }

  getFinancialStatements(
    symbol: string,
    securityId: string,
    statementType: FinancialStatementType,
    cadence: FinancialStatementCadence,
    limit: number,
  ): Promise<FinancialStatementDraft[]> {
    this.calls.push({ kind: "statements", statementType, cadence, limit });
    return this.delegate.getFinancialStatements(
      symbol,
      securityId,
      statementType,
      cadence,
      limit,
    );
  }
}

function spanDays(from?: string, to?: string): number {
  if (!from || !to) {
    return Number.POSITIVE_INFINITY;
  }
  return (
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000 +
    1
  );
}

describeLive("live FMP stock API smoke", () => {
  const namespace = `stock-data:v2:test:live:${randomUUID()}`;
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: ReturnType<typeof createStockDataRedisClient>;
  let securityId: string;
  let liveProvider: CountingFmpProvider;

  beforeAll(async () => {
    if (!process.env.FMP_API_KEY?.trim()) {
      throw new Error(
        "RUN_LIVE_FMP_TESTS=1 requires FMP_API_KEY to be set in the environment.",
      );
    }
    const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
    if (!databaseUrl || databaseUrl === process.env.DATABASE_URL?.trim()) {
      throw new Error(
        "The live FMP suite refuses to run against the development database. Set " +
          "TEST_DATABASE_URL to a dedicated, migrated test database that differs from " +
          "DATABASE_URL (see `pnpm db:test:prepare`).",
      );
    }
    const redisUrl = process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
    if (!redisUrl) {
      throw new Error("The live FMP suite requires TEST_REDIS_URL or REDIS_URL.");
    }
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;

    redis = createStockDataRedisClient(redisUrl);
    await redis.ping();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STOCK_DATA_PROVIDER)
      .useFactory({
        inject: [STOCK_DATA_REDIS],
        factory: (client: ReturnType<typeof createStockDataRedisClient>) => {
          const traffic = getFmpTrafficConfig();
          liveProvider = new CountingFmpProvider(
            new FmpClient(() => getFmpConfig(), fetch, {
              gate: new RedisFmpRequestGate(client, {
                namespace: `${namespace}:fmp`,
                maxConcurrentRequests: traffic.maxConcurrentRequests,
                rateLimitPerWindow: traffic.rateLimitPerWindow,
                rateWindowMs: traffic.rateWindowMs,
                maxQueueDepth: traffic.maxQueueDepth,
                maxQueueWaitMs: traffic.maxQueueWaitMs,
                requestLeaseMs: traffic.timeoutMs * 2,
              }),
            }),
          );
          return liveProvider;
        },
      })
      .overrideProvider(STOCK_DATA_CACHE)
      .useFactory({
        inject: [STOCK_DATA_REDIS],
        factory: (client: ReturnType<typeof createStockDataRedisClient>) =>
          new RedisStockDataCache(new IoredisCacheClient(client), 100, namespace),
      })
      .overrideProvider(STOCK_DATA_SERVICE)
      .useFactory({
        inject: [
          STOCK_DATA_STORE,
          STOCK_DATA_PROVIDER,
          STOCK_DATA_CACHE,
          STOCK_DATA_COORDINATOR,
        ],
        factory: (store, provider, cache, coordinator) =>
          new LoggedStockDataService(
            new CanonicalStockDataService(store, provider, cache, coordinator, {
              historyYears: HISTORY_YEARS,
            }),
            createLogger({
              service: "api",
              level: "silent",
              environment: "test",
              base: { component: "stock-data" },
            }),
          ),
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  }, SLOW);

  afterAll(async () => {
    if (prisma) {
      await prisma.security.deleteMany({ where: { providerSymbol: SYMBOL } });
    }
    if (app) {
      await app.close();
    }
    if (redis) {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${namespace}*`,
          "COUNT",
          500,
        );
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== "0");
      redis.disconnect();
    }
  }, SLOW);

  it(
    "hydrates a real stock and satisfies the cross-layer invariants",
    async () => {
      const response = await request(app.getHttpServer())
        .get(`/stocks/${SYMBOL}`)
        .expect(200);

      expect(response.body.security.symbol).toBe(SYMBOL);
      expect(response.body.profile).toBeDefined();
      expect(response.body.prices.length).toBeGreaterThan(0);
      const dates = response.body.prices.map((row: { date: string }) => row.date);
      expect([...dates].sort()).toEqual(dates);

      const security = await prisma.security.findFirst({
        where: { providerSymbol: SYMBOL },
      });
      expect(security).not.toBeNull();
      securityId = security!.id;
      expect(
        await prisma.dailyPrice.count({ where: { securityId } }),
      ).toBeGreaterThan(250);
      expect(
        await prisma.dailyDerivedState.count({ where: { securityId } }),
      ).toBeGreaterThan(250);
      expect(
        await prisma.financialStatement.count({ where: { securityId } }),
      ).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "serves finite, positive, PIT-correct intrinsic values and weighted blends",
    async () => {
      const from = new Date();
      from.setUTCFullYear(from.getUTCFullYear() - 2);
      const range = `from=${from.toISOString().slice(0, 10)}&to=${new Date()
        .toISOString()
        .slice(0, 10)}`;
      const values = await request(app.getHttpServer())
        .get(`/stocks/${SYMBOL}/intrinsic-values?${range}`)
        .expect(200);
      const blends = await request(app.getHttpServer())
        .get(`/stocks/${SYMBOL}/intrinsic-value-blends?${range}`)
        .expect(200);

      expect(values.body.length).toBeGreaterThan(0);
      const currencies = new Set<string>();
      for (const point of values.body as Array<{
        valuationDate: string;
        sourceDataAsOf: string;
        valuePerShare: number;
        currency: string;
      }>) {
        expect(Number.isFinite(point.valuePerShare)).toBe(true);
        expect(point.valuePerShare).toBeGreaterThan(0);
        // No look-ahead: provenance never postdates the valuation day.
        expect(point.sourceDataAsOf <= `${point.valuationDate}T23:59:59.999Z`).toBe(true);
        currencies.add(point.currency);
      }
      expect(currencies.size).toBe(1);

      const modelsByDate = new Map<string, Record<string, number>>();
      for (const point of values.body as Array<{
        valuationDate: string;
        model: string;
        valuePerShare: number;
      }>) {
        const row = modelsByDate.get(point.valuationDate) ?? {};
        row[point.model] = point.valuePerShare;
        modelsByDate.set(point.valuationDate, row);
      }
      expect(blends.body.length).toBeGreaterThan(0);
      for (const point of blends.body as Array<{
        valuationDate: string;
        blendId: keyof typeof INTRINSIC_VALUE_BLENDS;
        valuePerShare: number;
      }>) {
        const models = modelsByDate.get(point.valuationDate) ?? {};
        const expected = INTRINSIC_VALUE_BLENDS[point.blendId].components.reduce(
          (sum, component) => {
            const value = models[component.model];
            expect(value, `${point.blendId} ${component.model} ${point.valuationDate}`).toBeDefined();
            return sum + component.weight * (value as number);
          },
          0,
        );
        expect(Math.abs(point.valuePerShare - expected)).toBeLessThan(1e-4);
      }
    },
    SLOW,
  );

  it(
    "keeps the PostgreSQL latest daily state aligned with Redis",
    async () => {
      const latestDb = await prisma.dailyDerivedState.findFirst({
        where: { securityId },
        orderBy: { date: "desc" },
      });
      expect(latestDb).not.toBeNull();
      const year = latestDb!.date.getUTCFullYear();
      const chunk = await redis.get(
        `${namespace}:security:${securityId}:daily-state:${year}`,
      );
      expect(chunk).not.toBeNull();
      const cachedLatest = (
        JSON.parse(chunk as string) as Array<{
          date: string;
          sma20d?: number;
          intrinsicValues?: Record<string, number>;
        }>
      ).at(-1);
      expect(cachedLatest?.date).toBe(latestDb!.date.toISOString().slice(0, 10));
      expect(cachedLatest?.sma20d).toBe(
        latestDb!.sma20d === null ? undefined : Number(latestDb!.sma20d),
      );
      expect(cachedLatest?.intrinsicValues?.DCF_FCFF).toBe(
        latestDb!.dcfFcff === null ? undefined : Number(latestDb!.dcfFcff),
      );
    },
    SLOW,
  );

  it(
    "does not repeat the historical backfill on a second request",
    async () => {
      const priceCount = await prisma.dailyPrice.count({ where: { securityId } });
      const statementCount = await prisma.financialStatement.count({
        where: { securityId },
      });
      const boundary = liveProvider.calls.length;
      // The counter observed the initial backfill, so "no calls below" is evidence rather
      // than an unwired counter passing vacuously.
      expect(boundary).toBeGreaterThan(0);

      await request(app.getHttpServer()).get(`/stocks/${SYMBOL}`).expect(200);

      // Provider traffic, not row counts, is what proves this: a repeated backfill
      // returning identical rows would leave the counts unchanged too.
      const second = liveProvider.calls.slice(boundary);
      // The security identity is resolved once and then read from durable state.
      expect(second.filter((call) => call.kind === "profile")).toEqual([]);
      // Any price request is a bounded recent tail, never the multi-year canonical horizon.
      for (const call of second) {
        if (call.kind === "prices") {
          expect(spanDays(call.from, call.to)).toBeLessThanOrEqual(31);
        }
        // Any fundamentals request uses the small refresh limits, never backfill limits.
        if (call.kind === "statements") {
          expect(call.limit).toBeLessThanOrEqual(FUNDAMENTALS_REFRESH_MAX_LIMIT);
        }
      }
      // The durable history is projected, not re-persisted.
      expect(await prisma.dailyPrice.count({ where: { securityId } })).toBe(priceCount);
      expect(
        await prisma.financialStatement.count({ where: { securityId } }),
      ).toBe(statementCount);
    },
    SLOW,
  );
});
