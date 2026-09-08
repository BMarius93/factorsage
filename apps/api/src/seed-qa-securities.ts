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
import { seedQaBenchmarkData } from "./benchmarks/seed-qa-benchmark-data";
import {
  assertQaSecuritySeedingAllowed,
  qaSeedDatabaseUrl,
  seedQaSecurities,
} from "./stocks/seed-qa-securities";
import { seedQaStockData } from "./stocks/seed-qa-stock-data";

/**
 * Seeds the deterministic fictional QA catalog rows the E2E suites use, plus the market data the
 * first of them needs so Stock Details can be exercised without a market-data provider, plus the
 * benchmark history a backtest compares against — the V1 benchmark is sourced from a real provider
 * symbol, so without it an E2E run would reach FMP.
 *
 * Targets **TEST_DATABASE_URL**, explicitly and only. These are fictional catalog rows and
 * synthetic market data — including S&P 500 bars written into the real benchmark series — so
 * letting them reach the development database would leave a normal manual backtest comparing
 * against invented history. The deterministic Playwright stack points at the same test database
 * (`pnpm dev:api:e2e`, `pnpm dev:worker:e2e`). Refuses outright when NODE_ENV is production.
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
    const seeded = await seedQaSecurities(prisma);
    for (const security of seeded) {
      console.log(`${security.symbol} ready.`);
    }
    // Only the first QA security carries market data; the second stays identity-only so the lists
    // suite still exercises a catalog row with nothing hydrated behind it.
    const withMarketData = seeded[0];
    if (withMarketData) {
      const seededData = await seedQaStockData(prisma, withMarketData.id);
      // The seed writes PostgreSQL directly, so any Redis projection left by an earlier run of the
      // integration suites — which share this database — would still be served in preference to it.
      // Evicting is what makes "re-seed, then run Playwright" mean what it looks like it means.
      await cache.evict(withMarketData.id);
      console.log(
        `${withMarketData.symbol} stock data ready: ${seededData.tradingDays} trading days, ` +
          `${seededData.from} to ${seededData.to}.`,
      );
    }
    const benchmark = await seedQaBenchmarkData(prisma);
    await benchmarkCache.invalidateManifest(benchmark.seriesId);
    console.log(
      `${benchmark.code} benchmark data ready: ${benchmark.tradingDays} trading days, ` +
        `${benchmark.from} to ${benchmark.to}.`,
    );
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
