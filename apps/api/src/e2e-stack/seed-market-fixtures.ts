import type { PrismaClient } from "@intrinsic/database";
import type {
  RedisBenchmarkDataCache,
  RedisStockDataCache,
} from "@intrinsic/stock-data";
import {
  seedQaBenchmarkData,
  seedQaMarketReferenceData,
} from "../benchmarks/seed-qa-benchmark-data";
import {
  ENTITLEMENT_FIXTURE_SECURITY_COUNT,
  entitlementFixtureSymbol,
} from "../entitlements/seed-entitlement-fixtures";
import { QA_SECURITIES, seedQaSecurities } from "../stocks/seed-qa-securities";
import {
  seedEmptyStockCoverage,
  seedQaStockData,
} from "../stocks/seed-qa-stock-data";
import { e2eFixtureBenchmarkCodes } from "./fixture-boundary";
import {
  resetE2eFixtureBenchmarkSeries,
  resetE2eFixtureSecurityData,
} from "./fixture-data";

/**
 * The market-data half of `pnpm test:personas:seed`, as two reusable steps.
 *
 * Each step is **reset, then write, then evict**: the fixture scope is emptied of whatever is there
 * (seeded or provider-written), the deterministic rows and coverage claims are written through the
 * production store, and the Redis projections that described the old rows are dropped so the next
 * read rebuilds from PostgreSQL. Running a step twice leaves the same rows, coverage intervals and
 * watermarks as running it once — only the sync timestamps move — which is what makes a reseed the
 * reset. The entry scripts call these; so does the integration test that proves it.
 */

type StockCache = Pick<RedisStockDataCache, "evict">;
type BenchmarkCache = Pick<RedisBenchmarkDataCache, "invalidateManifest">;

export type SeededSeries = {
  code: string;
  seriesId: string;
  from: string;
  to: string;
  tradingDays: number;
};

export type QaMarketFixtureSummary = {
  securities: { symbol: string; id: string }[];
  stockData: { symbol: string; from: string; to: string; tradingDays: number };
  benchmark: SeededSeries;
  marketReferences: SeededSeries[];
};

/**
 * `QATEST1`/`QATEST2`, `SP500` and the market references: `pnpm test:securities:seed`.
 *
 * Pruning orphaned non-catalog benchmarks is the entry script's separate first step, not part of
 * this: it deletes rows other integration suites create while they run, so it must never run from
 * inside a test suite.
 */
export async function seedQaMarketFixtures(input: {
  prisma: PrismaClient;
  cache: StockCache;
  benchmarkCache: BenchmarkCache;
  today?: string;
}): Promise<QaMarketFixtureSummary> {
  const { prisma, cache, benchmarkCache } = input;
  const today = input.today ?? new Date().toISOString().slice(0, 10);

  const securities = await seedQaSecurities(prisma);
  await resetE2eFixtureSecurityData(
    prisma,
    QA_SECURITIES.map((security) => security.symbol),
  );
  // Only the first QA security carries market data. The second has none — the lists suite still
  // exercises a catalog row with nothing behind it — but it is declared complete and empty, exactly
  // like the ENTF universe, so opening it answers "no data" without asking any provider.
  const [withMarketData, ...withoutMarketData] = securities;
  if (!withMarketData) {
    throw new Error("QA security seed produced no securities");
  }
  const stockData = await seedQaStockData(prisma, withMarketData.id, today);
  for (const security of withoutMarketData) {
    await seedEmptyStockCoverage(prisma, security.id, today);
  }
  for (const security of securities) {
    await cache.evict(security.id);
  }

  const reset = await resetE2eFixtureBenchmarkSeries(
    prisma,
    e2eFixtureBenchmarkCodes(),
  );
  for (const series of reset) {
    await benchmarkCache.invalidateManifest(series.seriesId);
  }
  const benchmark = await seedQaBenchmarkData(prisma, today);
  await benchmarkCache.invalidateManifest(benchmark.seriesId);
  // The Dashboard's market references, through the same store and the same invalidation. Without
  // them the overview would ask the provider for `^GSPC`, `^DJI` and `^VIX` during an E2E run, and
  // the numbers a screenshot recorded would change with the real market.
  const marketReferences = await seedQaMarketReferenceData(prisma, today);
  for (const reference of marketReferences) {
    await benchmarkCache.invalidateManifest(reference.seriesId);
  }

  return {
    securities,
    stockData: { symbol: withMarketData.symbol, ...stockData },
    benchmark,
    marketReferences,
  };
}

/** The `ENTF` universe's complete, empty coverage: the market-data part of `test:entitlements:seed`. */
export async function seedEntitlementMarketFixtures(input: {
  prisma: PrismaClient;
  cache: StockCache;
  today?: string;
}): Promise<{ securities: number }> {
  const { prisma, cache } = input;
  const symbols = Array.from(
    { length: ENTITLEMENT_FIXTURE_SECURITY_COUNT },
    (_, index) => entitlementFixtureSymbol(index),
  );
  const cleared = await resetE2eFixtureSecurityData(prisma, symbols);
  if (cleared.length !== symbols.length) {
    throw new Error(
      `Entitlement fixture securities are missing (${cleared.length} of ${symbols.length}); ` +
        "seed the entitlement catalog before its market data",
    );
  }
  for (const { id } of cleared) {
    await seedEmptyStockCoverage(prisma, id, input.today);
    await cache.evict(id);
  }
  return { securities: cleared.length };
}
