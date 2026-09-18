import {
  getRedisConfig,
  getStockDataConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
  RedisBenchmarkDataCache,
  RedisStockDataCache,
} from "@intrinsic/stock-data";
import { pruneOrphanedFixtureBenchmarks } from "./benchmarks/seed-qa-benchmark-data";
import { seedQaMarketFixtures } from "./e2e-stack/seed-market-fixtures";
import {
  assertQaSecuritySeedingAllowed,
  qaSeedDatabaseUrl,
} from "./stocks/seed-qa-securities";

/**
 * Seeds the deterministic fictional QA catalog rows the E2E suites use, plus the market data the
 * first of them needs so Stock Details can be exercised without a market-data provider, plus the
 * benchmark history a backtest compares against — the V1 benchmark is sourced from a real provider
 * symbol, so without it an E2E run would reach FMP — plus the market-reference index history the
 * Dashboard's overview cards read.
 *
 * Targets **TEST_DATABASE_URL**, explicitly and only. These are fictional catalog rows and
 * synthetic market data — including S&P 500 bars written into the real benchmark series — so
 * letting them reach the development database would leave a normal manual backtest comparing
 * against invented history. The deterministic Playwright stack points at the same test database
 * (`pnpm dev:api:e2e`, `pnpm dev:worker:e2e`). Refuses outright when NODE_ENV is production.
 *
 * Rerunning is the reset: every fixture security and series is emptied first — whatever a provider
 * or an earlier run wrote there — and then holds exactly the seeded rows again.
 */
async function seed(): Promise<void> {
  loadRootEnv();
  // Refuse before opening any connection at all.
  assertQaSecuritySeedingAllowed();
  const prisma = new PrismaClient({
    datasources: { db: { url: qaSeedDatabaseUrl() } },
  });
  const redis = createStockDataRedisClient(getRedisConfig().url);
  const cache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    getStockDataConfig().maxResidentStocks,
  );
  const benchmarkCache = new RedisBenchmarkDataCache(
    new IoredisCacheClient(redis),
  );

  try {
    await prisma.$connect();
    // Before seeding: leftover fixture benchmarks from integration suites are real catalog rows,
    // and the Backtest picker must offer exactly the product catalog in a seeded environment.
    const pruned = await pruneOrphanedFixtureBenchmarks(prisma);
    console.log(
      pruned.length === 0
        ? "Benchmark catalog clean: no orphaned fixture benchmarks."
        : `Removed ${pruned.length} orphaned fixture benchmark(s) not in the product catalog.`,
    );
    // Reset, write, evict — see `seedQaMarketFixtures`. Rows a provider wrote into a fixture series
    // since the last seed are removed rather than left beside the synthetic ones (E2E-002).
    const seeded = await seedQaMarketFixtures({
      prisma,
      cache,
      benchmarkCache,
    });
    for (const security of seeded.securities) {
      console.log(`${security.symbol} ready.`);
    }
    console.log(
      `${seeded.stockData.symbol} stock data ready: ${seeded.stockData.tradingDays} trading days, ` +
        `${seeded.stockData.from} to ${seeded.stockData.to}.`,
    );
    for (const series of [seeded.benchmark, ...seeded.marketReferences]) {
      console.log(
        `${series.code} ready: ${series.tradingDays} sessions, ${series.from} to ${series.to}.`,
      );
    }
  } finally {
    redis.disconnect();
    await prisma.$disconnect();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA security seed failed: ${message}`);
  process.exitCode = 1;
});
