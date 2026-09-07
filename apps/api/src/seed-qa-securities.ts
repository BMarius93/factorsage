import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { seedQaBenchmarkData } from "./benchmarks/seed-qa-benchmark-data";
import {
  assertQaSecuritySeedingAllowed,
  seedQaSecurities,
} from "./stocks/seed-qa-securities";
import { seedQaStockData } from "./stocks/seed-qa-stock-data";

/**
 * Seeds the deterministic fictional QA catalog rows the E2E suites use, plus the market data the
 * first of them needs so Stock Details can be exercised without a market-data provider, plus the
 * benchmark history a backtest compares against — the V1 benchmark is sourced from a real provider
 * symbol, so without it an E2E run would reach FMP.
 *
 * Targets DATABASE_URL — the database the running stack Playwright drives uses — and refuses to
 * run when NODE_ENV is production.
 */
async function seed(): Promise<void> {
  loadRootEnv();
  // Refuse before opening a connection to whatever DATABASE_URL points at.
  assertQaSecuritySeedingAllowed();
  const prisma = new PrismaClient();

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
      console.log(
        `${withMarketData.symbol} stock data ready: ${seededData.tradingDays} trading days, ` +
          `${seededData.from} to ${seededData.to}.`,
      );
    }
    const benchmark = await seedQaBenchmarkData(prisma);
    console.log(
      `${benchmark.code} benchmark data ready: ${benchmark.tradingDays} trading days, ` +
        `${benchmark.from} to ${benchmark.to}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA security seed failed: ${message}`);
  process.exitCode = 1;
});
