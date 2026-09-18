import { randomUUID } from "node:crypto";
import {
  getRedisConfig,
  getStockDataConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import {
  addDays,
  createStockDataRedisClient,
  IoredisCacheClient,
  priceRetentionYears,
  RedisBenchmarkDataCache,
  RedisStockDataCache,
  subtractYears,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENTITLEMENT_FIXTURE_SECURITY_COUNT,
  entitlementFixtureSymbol,
} from "../entitlements/seed-entitlement-fixtures";
import {
  e2eFixtureBenchmarkCodes,
  e2eFixtureSecuritySymbols,
} from "./fixture-boundary";
import {
  seedEntitlementMarketFixtures,
  seedQaMarketFixtures,
} from "./seed-market-fixtures";

loadRootEnv();
useTestDatabase();

/**
 * Reseeding the E2E fixtures is a reset (E2E-002), and the ENTF universe is complete and empty
 * (E2E-005) — against the real test database and the real Redis, through the same functions
 * `pnpm test:securities:seed` and `pnpm test:entitlements:seed` run.
 *
 * The contamination staged here is the one the audit found: provider closes near 757 written into
 * the `SP500` series on the two sessions after the synthetic window ended, a seeded close
 * overwritten, provider-written coverage over years the seed never claimed, and provider rows on
 * the fictional securities. A reseed must remove every one of them and leave the fixture scope
 * byte-for-byte what a single seed leaves — while a security outside the namespace keeps its rows.
 *
 * This writes the shared fixture scope exactly as the seed does, with today's date, so the E2E
 * stack sees a freshly seeded database afterwards. Like every DB-backed suite it must not run while
 * the E2E stack does.
 */
describe("E2E fixture reseed", () => {
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url);
  const realCache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    getStockDataConfig().maxResidentStocks,
  );
  const realBenchmarkCache = new RedisBenchmarkDataCache(
    new IoredisCacheClient(redis),
  );
  const evicted: string[] = [];
  const invalidated: string[] = [];
  const cache = {
    evict: async (securityId: string) => {
      evicted.push(securityId);
      await realCache.evict(securityId);
    },
  };
  const benchmarkCache = {
    invalidateManifest: async (seriesId: string) => {
      invalidated.push(seriesId);
      await realBenchmarkCache.invalidateManifest(seriesId);
    },
  };
  const today = new Date().toISOString().slice(0, 10);
  const outsider = `RSD${randomUUID().slice(0, 8).toUpperCase()}`;

  /**
   * One seed of the whole fixture scope writes about a hundred securities' coverage through the
   * production store and takes a few seconds against a local PostgreSQL; a test here seeds up to
   * three times and snapshots the scope between. This bounds that work, not a wait on anything.
   */
  const SEEDING_TEST_TIMEOUT_MS = 120_000;

  async function seedAll(): Promise<void> {
    await seedQaMarketFixtures({ prisma, cache, benchmarkCache, today });
    await seedEntitlementMarketFixtures({ prisma, cache, today });
  }

  async function securityIds(): Promise<Map<string, string>> {
    const rows = await prisma.security.findMany({
      where: { symbol: { in: e2eFixtureSecuritySymbols() } },
      select: { id: true, symbol: true },
    });
    return new Map(rows.map((row) => [row.symbol, row.id]));
  }

  async function seriesIds(): Promise<Map<string, string>> {
    const rows = await prisma.benchmark.findMany({
      where: { code: { in: e2eFixtureBenchmarkCodes() } },
      select: {
        code: true,
        series: { orderBy: { version: "desc" }, take: 1, select: { id: true } },
      },
    });
    return new Map(rows.map((row) => [row.code, row.series[0]?.id ?? ""]));
  }

  const day = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;

  /**
   * Everything the fixture scope holds, with sync timestamps left out: those record *when* a seed
   * ran and are the only thing a second seed is allowed to change.
   */
  async function snapshot(): Promise<unknown> {
    const securities = await securityIds();
    const series = await seriesIds();
    const bySecurity: Record<string, unknown> = {};
    for (const [symbol, securityId] of [...securities].sort()) {
      const where = { securityId };
      bySecurity[symbol] = {
        prices: (
          await prisma.dailyPrice.findMany({ where, orderBy: { date: "asc" } })
        ).map((row) => [
          day(row.date),
          row.open.toString(),
          row.close.toString(),
          row.volume.toString(),
        ]),
        weekly: await prisma.weeklyPrice.count({ where }),
        derived: (
          await prisma.dailyDerivedState.findMany({
            where,
            orderBy: { date: "asc" },
            select: { date: true, sma50d: true, rsi14d: true },
          })
        ).map((row) => [
          day(row.date),
          row.sma50d?.toString() ?? null,
          row.rsi14d?.toString() ?? null,
        ]),
        statements: await prisma.financialStatement.count({ where }),
        profile: await prisma.securityProfile.count({ where }),
        coverage: (
          await prisma.stockDatasetCoverage.findMany({
            where,
            orderBy: [
              { dataset: "asc" },
              { variant: "asc" },
              { fromDate: "asc" },
            ],
          })
        ).map((row) => [
          row.dataset,
          row.variant,
          day(row.fromDate),
          day(row.toDate),
        ]),
        states: (
          await prisma.stockDatasetState.findMany({
            where,
            orderBy: [{ dataset: "asc" }, { variant: "asc" }],
          })
        ).map((row) => [
          row.dataset,
          row.variant,
          day(row.earliestDate),
          day(row.latestDate),
        ]),
      };
    }
    const bySeries: Record<string, unknown> = {};
    for (const [code, seriesId] of [...series].sort()) {
      const where = { seriesId };
      bySeries[code] = {
        prices: (
          await prisma.benchmarkDailyPrice.findMany({
            where,
            orderBy: { date: "asc" },
          })
        ).map((row) => [day(row.date), row.close.toString()]),
        coverage: (
          await prisma.benchmarkDatasetCoverage.findMany({
            where,
            orderBy: [{ variant: "asc" }, { fromDate: "asc" }],
          })
        ).map((row) => [row.variant, day(row.fromDate), day(row.toDate)]),
        states: (
          await prisma.benchmarkDatasetState.findMany({
            where,
            orderBy: { variant: "asc" },
          })
        ).map((row) => [
          row.variant,
          day(row.earliestDate),
          day(row.latestDate),
        ]),
      };
    }
    return { bySecurity, bySeries };
  }

  /** What a provider would have left behind, in every table the fixture scope covers. */
  async function contaminate(): Promise<void> {
    const securities = await securityIds();
    const series = await seriesIds();
    const sp500 = series.get("SP500") as string;
    const lastSeeded = await prisma.benchmarkDailyPrice.findFirstOrThrow({
      where: { seriesId: sp500 },
      orderBy: { date: "desc" },
    });
    const last = day(lastSeeded.date) as string;
    const bar = (seriesId: string, date: string, close: number) => ({
      seriesId,
      date: new Date(`${date}T00:00:00.000Z`),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1n,
    });
    // The audit's real closes, on the two sessions after the synthetic window.
    await prisma.benchmarkDailyPrice.createMany({
      data: [
        bar(sp500, addDays(last, 3), 757.39),
        bar(sp500, addDays(last, 4), 760.88),
        bar(series.get("SP500_INDEX") as string, addDays(today, -400), 4200),
      ],
      skipDuplicates: true,
    });
    await prisma.benchmarkDailyPrice.update({
      where: { seriesId_date: { seriesId: sp500, date: lastSeeded.date } },
      data: { close: 999 },
    });
    // What a thirty-year run's benchmark request writes for the years before the seeded window.
    await prisma.benchmarkDatasetCoverage.create({
      data: {
        seriesId: sp500,
        dataset: "DAILY_PRICE",
        variant: "contaminated",
        fromDate: new Date("1996-09-18T00:00:00.000Z"),
        toDate: new Date("2023-01-01T00:00:00.000Z"),
        lastSuccessfulSyncAt: new Date(),
      },
    });

    for (const symbol of ["QATEST1", "QATEST2", "ENTF001", "ENTF080"]) {
      const securityId = securities.get(symbol) as string;
      await prisma.dailyPrice.upsert({
        where: {
          securityId_date: {
            securityId,
            date: new Date(`${addDays(today, 1)}T00:00:00.000Z`),
          },
        },
        create: {
          securityId,
          date: new Date(`${addDays(today, 1)}T00:00:00.000Z`),
          open: 757.39,
          high: 757.39,
          low: 757.39,
          close: 757.39,
          volume: 1n,
        },
        update: { close: 757.39 },
      });
      await prisma.securityProfile.upsert({
        where: { securityId },
        create: { securityId, description: "provider profile" },
        update: { description: "provider profile" },
      });
      await prisma.stockDatasetCoverage.create({
        data: {
          securityId,
          dataset: "DAILY_PRICE",
          variant: "contaminated",
          fromDate: new Date(`${addDays(today, 1)}T00:00:00.000Z`),
          toDate: new Date(`${addDays(today, 1)}T00:00:00.000Z`),
          lastSuccessfulSyncAt: new Date(),
        },
      });
    }
  }

  beforeAll(async () => {
    await redis.ping();
    // The entitlement catalog rows, as `pnpm test:entitlements:seed` creates them. Created only
    // when absent and never deleted: persona lists reference them.
    for (
      let index = 0;
      index < ENTITLEMENT_FIXTURE_SECURITY_COUNT;
      index += 1
    ) {
      const symbol = entitlementFixtureSymbol(index);
      const existing = await prisma.security.findFirst({
        where: { symbol, exchangeCode: "NASDAQ" },
      });
      if (!existing) {
        await prisma.security.create({
          data: {
            providerSymbol: symbol,
            symbol,
            name: `Entitlement Fixture ${symbol}`,
            exchangeCode: "NASDAQ",
            exchangeName: "NASDAQ Global Select",
            currency: "USD",
            type: "STOCK",
            isAdr: false,
            isActivelyTrading: true,
          },
        });
      }
    }
    await prisma.security.create({
      data: {
        providerSymbol: outsider,
        symbol: outsider,
        name: "Outside the fixture namespace",
        exchangeCode: "NASDAQ",
        exchangeName: "NASDAQ Global Select",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
        dailyPrices: {
          create: {
            date: new Date(`${today}T00:00:00.000Z`),
            open: 10,
            high: 10,
            low: 10,
            close: 10,
            volume: 1n,
          },
        },
        datasetCoverage: {
          create: {
            dataset: "DAILY_PRICE",
            variant: "outsider",
            fromDate: new Date(`${today}T00:00:00.000Z`),
            toDate: new Date(`${today}T00:00:00.000Z`),
            lastSuccessfulSyncAt: new Date(),
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.security.deleteMany({ where: { providerSymbol: outsider } });
    redis.disconnect();
    await prisma.$disconnect();
  });

  it(
    "is idempotent: seeding twice leaves exactly what seeding once leaves",
    async () => {
      await seedAll();
      const once = await snapshot();
      await seedAll();
      expect(await snapshot()).toEqual(once);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "removes provider-written rows from every fixture series and security on reseed",
    async () => {
      await seedAll();
      const clean = await snapshot();

      await contaminate();
      expect(await snapshot()).not.toEqual(clean);

      evicted.length = 0;
      invalidated.length = 0;
      await seedAll();

      expect(await snapshot()).toEqual(clean);
      // The audit's manual check, as an assertion: the series ends where the seed ended it and
      // nothing near 750 survives.
      const sp500 = (await seriesIds()).get("SP500") as string;
      const latest = await prisma.benchmarkDailyPrice.findFirstOrThrow({
        where: { seriesId: sp500 },
        orderBy: { date: "desc" },
      });
      expect(Number(latest.close)).toBeLessThan(700);
      expect(
        await prisma.benchmarkDailyPrice.count({
          where: { seriesId: sp500, close: { gt: 700 } },
        }),
      ).toBe(0);
      // Every fixture projection that described the old rows was dropped.
      const securities = await securityIds();
      expect(new Set(evicted)).toEqual(new Set(securities.values()));
      expect(new Set(invalidated)).toEqual(
        new Set((await seriesIds()).values()),
      );
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "never touches a security outside the fixture namespace",
    async () => {
      await seedAll();
      const row = await prisma.security.findFirstOrThrow({
        where: { providerSymbol: outsider },
        include: { dailyPrices: true, datasetCoverage: true },
      });
      expect(row.dailyPrices).toHaveLength(1);
      expect(row.datasetCoverage).toHaveLength(1);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "declares every ENTF security and QATEST2 complete and empty over the retention horizon",
    async () => {
      await seedAll();
      const retentionStart = subtractYears(
        today,
        priceRetentionYears(getStockDataConfig().productHistoryYears),
      );
      const securities = await securityIds();
      const empty = [
        "QATEST2",
        ...Array.from(
          { length: ENTITLEMENT_FIXTURE_SECURITY_COUNT },
          (_, index) => entitlementFixtureSymbol(index),
        ),
      ];
      for (const symbol of empty) {
        const securityId = securities.get(symbol) as string;
        expect(
          await prisma.dailyPrice.count({ where: { securityId } }),
          symbol,
        ).toBe(0);
        const coverage = await prisma.stockDatasetCoverage.findMany({
          where: { securityId },
          orderBy: { dataset: "asc" },
        });
        expect(
          coverage
            .map(
              (row) =>
                `${row.dataset} ${day(row.fromDate)}..${day(row.toDate)}`,
            )
            .sort(),
          symbol,
        ).toEqual(
          ["DAILY_PRICE", "DAILY_DERIVED_STATE", "WEEKLY_PRICE"]
            .map((dataset) => `${dataset} ${retentionStart}..${today}`)
            .sort(),
        );
        const states = await prisma.stockDatasetState.findMany({
          where: { securityId },
          select: { dataset: true },
        });
        const datasets = new Set(states.map((state) => state.dataset));
        for (const dataset of [
          "DAILY_PRICE",
          "SECURITY_PROFILE",
          "INCOME_STATEMENT",
          "BALANCE_SHEET",
          "CASH_FLOW",
        ]) {
          expect(datasets.has(dataset as never), `${symbol} ${dataset}`).toBe(
            true,
          );
        }
      }
    },
    SEEDING_TEST_TIMEOUT_MS,
  );
});
