import type { PrismaClient } from "@intrinsic/database";
import { assertQaSecuritySeedingAllowed } from "../stocks/seed-qa-securities";
import {
  e2eFixtureBenchmarkCodes,
  e2eFixtureSecuritySymbols,
} from "./fixture-boundary";

/**
 * The reseed half of the fixture boundary (E2E-002): before a seed writes its deterministic rows,
 * everything else in the fixture scope — including anything a provider wrote there — is removed.
 *
 * Seeding used to be additive. `saveDailyPriceSync` replaces the dates it is given and nothing
 * else, so rows a provider had written *outside* the seeded window survived every reseed; that is
 * how the test database's `SP500` series kept real closes (757.39, 760.88) after synthetic ones
 * near 470, and how an E2E backtest reported a fake +78% benchmark return. Deleting the scope first
 * makes "reseed" mean "exactly the seeded rows", whatever ran against the database in between.
 *
 * The scope is the documented namespace and nothing wider. A symbol or benchmark code outside
 * `fixture-boundary.ts` is refused before any statement runs, and the rows themselves — the
 * `Security` and `Benchmark` catalog entries, lists that reference them, backtest runs — are never
 * touched: only market data, coverage and dataset state keyed by a fixture id. Refuses production
 * and the development database exactly like every QA seed.
 */

/**
 * Deletes every provider-derived row of the named fixture securities, in one transaction.
 *
 * Prices, weekly bars, derived state, financial statements, the descriptive profile, and the
 * coverage and dataset-state watermarks that describe them. Returns the ids it cleared, in the
 * order the symbols were given; a symbol with no catalog row yet is skipped.
 */
export async function resetE2eFixtureSecurityData(
  prisma: PrismaClient,
  symbols: readonly string[],
): Promise<{ symbol: string; id: string }[]> {
  assertQaSecuritySeedingAllowed();
  const allowed = new Set(e2eFixtureSecuritySymbols());
  const foreign = symbols.filter((symbol) => !allowed.has(symbol));
  if (foreign.length > 0) {
    throw new Error(
      `Refusing to reset market data outside the E2E fixture namespace: ${foreign.join(", ")}`,
    );
  }

  const rows = await prisma.security.findMany({
    where: {
      symbol: { in: [...symbols] },
      providerSymbol: { in: [...symbols] },
    },
    select: { id: true, symbol: true },
  });
  const bySymbol = new Map(rows.map((row) => [row.symbol, row.id]));
  const cleared = symbols.flatMap((symbol) => {
    const id = bySymbol.get(symbol);
    return id === undefined ? [] : [{ symbol, id }];
  });
  const securityId = { in: cleared.map((row) => row.id) };
  if (cleared.length > 0) {
    await prisma.$transaction([
      prisma.dailyPrice.deleteMany({ where: { securityId } }),
      prisma.weeklyPrice.deleteMany({ where: { securityId } }),
      prisma.dailyDerivedState.deleteMany({ where: { securityId } }),
      prisma.financialStatement.deleteMany({ where: { securityId } }),
      prisma.securityProfile.deleteMany({ where: { securityId } }),
      prisma.stockDatasetCoverage.deleteMany({ where: { securityId } }),
      prisma.stockDatasetState.deleteMany({ where: { securityId } }),
    ]);
  }
  return cleared;
}

/**
 * Deletes every bar, coverage interval and watermark of the named fixture benchmarks' **current**
 * series, in one transaction — the series the QA seed writes and the loader reads. Earlier series
 * versions are immutable history that completed runs may reference, and are left alone.
 */
export async function resetE2eFixtureBenchmarkSeries(
  prisma: PrismaClient,
  codes: readonly string[],
): Promise<{ code: string; seriesId: string }[]> {
  assertQaSecuritySeedingAllowed();
  const allowed = new Set(e2eFixtureBenchmarkCodes());
  const foreign = codes.filter((code) => !allowed.has(code));
  if (foreign.length > 0) {
    throw new Error(
      `Refusing to reset benchmark data outside the E2E fixture namespace: ${foreign.join(", ")}`,
    );
  }

  const benchmarks = await prisma.benchmark.findMany({
    where: { code: { in: [...codes] } },
    select: {
      code: true,
      series: { orderBy: { version: "desc" }, take: 1, select: { id: true } },
    },
  });
  const cleared = benchmarks.flatMap((benchmark) => {
    const seriesId = benchmark.series[0]?.id;
    return seriesId === undefined ? [] : [{ code: benchmark.code, seriesId }];
  });
  const seriesId = { in: cleared.map((row) => row.seriesId) };
  if (cleared.length > 0) {
    await prisma.$transaction([
      prisma.benchmarkDailyPrice.deleteMany({ where: { seriesId } }),
      prisma.benchmarkDatasetCoverage.deleteMany({ where: { seriesId } }),
      prisma.benchmarkDatasetState.deleteMany({ where: { seriesId } }),
    ]);
  }
  return cleared;
}
