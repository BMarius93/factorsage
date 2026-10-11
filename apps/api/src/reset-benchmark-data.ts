import { getRedisConfig, loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
  RedisBenchmarkDataCache,
} from "@intrinsic/stock-data";

/**
 * Discards a benchmark's stored market data so the next read re-hydrates it from the provider.
 *
 * Benchmark bars are a durable projection of provider data, never user-owned state: deleting them
 * loses nothing that cannot be fetched again, and completed runs are untouched because their
 * results are already persisted as their own rows.
 *
 * It exists because a QA seed used to write synthetic bars into the real `SP500` series. That can
 * no longer happen — deterministic fixtures only reach `TEST_DATABASE_URL` — but a database seeded
 * before that fix still holds them, and there is no way to tell a synthetic bar from a real one by
 * looking at it. Clearing the series and letting the loader rebuild is the honest repair.
 *
 * The Redis projection of each reset series is discarded too — its head and chunks, keyed by series,
 * and nothing else. A projection is always a complete image of what PostgreSQL held when it was
 * published, so one left behind would keep answering historical reads with bars that no longer
 * exist. Redis is never flushed.
 *
 * Usage: `pnpm db:benchmarks:reset [CODE ...]` (defaults to every benchmark).
 */
async function reset(): Promise<void> {
  loadRootEnv();
  const codes = process.argv.slice(2).filter((value) => value.trim() !== "");
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url);
  const cache = new RedisBenchmarkDataCache(new IoredisCacheClient(redis));

  try {
    const benchmarks = await prisma.benchmark.findMany({
      ...(codes.length > 0 ? { where: { code: { in: codes } } } : {}),
      include: { series: true },
    });
    if (benchmarks.length === 0) {
      console.log("No matching benchmark. Nothing to reset.");
      return;
    }

    for (const benchmark of benchmarks) {
      const seriesIds = benchmark.series.map((series) => series.id);
      // The series rows themselves stay: a run pins one, and deleting it would either break that
      // reference or silently re-key history a completed run already read.
      const [prices, coverage, state] = await prisma.$transaction([
        prisma.benchmarkDailyPrice.deleteMany({
          where: { seriesId: { in: seriesIds } },
        }),
        prisma.benchmarkDatasetCoverage.deleteMany({
          where: { seriesId: { in: seriesIds } },
        }),
        prisma.benchmarkDatasetState.deleteMany({
          where: { seriesId: { in: seriesIds } },
        }),
      ]);
      let chunks = 0;
      for (const seriesId of seriesIds) {
        chunks += await cache.discardProjection(seriesId);
      }
      console.log(
        `${benchmark.code}: cleared ${prices.count} bars, ${coverage.count} coverage ` +
          `intervals and ${state.count} watermarks across ${seriesIds.length} series, and ` +
          `discarded the Redis projection (${chunks} chunk(s)). ` +
          "The next read re-hydrates it from the provider.",
      );
    }
  } finally {
    redis.disconnect();
    await prisma.$disconnect();
  }
}

reset().catch((error: unknown) => {
  console.error(
    "Benchmark reset failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
