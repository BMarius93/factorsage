import {
  getApiConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  getStockDataConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { FmpClient } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
  RedisFmpRequestGate,
  RedlockLoadCoordinator,
} from "@intrinsic/stock-data";
import { createBenchmarkDataService } from "./benchmark-data.composition";

/**
 * Materializes a benchmark's history over an explicit range, through the ordinary loader.
 *
 * It exists because the product's reads are deliberately lazy and narrow: the Dashboard's market
 * overview asks for the few weeks it actually draws, and a backtest asks for the period it
 * simulates. That is right for a request path — nothing should download decades at boot, and API
 * startup must never block on a 1927→today index download — but it leaves no way to say "we intend
 * to study `SP500_INDEX` back to 1950, fetch it now, once, off the request path".
 *
 * This is that way, and it is deliberately *only* that: it resolves a code and calls
 * `ensureBenchmarkHydrated`. Coverage subtraction, the hydration lock, the provider gate, retries,
 * PostgreSQL persistence and the Redis projection are all the canonical implementations, so a
 * prewarmed range is indistinguishable from one a page read happened to materialize, and rerunning
 * it costs nothing because durable coverage already says asking again is pointless.
 *
 * It does not decide how much history exists. There is no baked-in start date anywhere: give it the
 * range you want, and a series whose own history begins later simply returns fewer bars.
 *
 * Usage:
 *
 * ```bash
 * pnpm benchmarks:prewarm --code SP500_INDEX --from 1990-01-01
 * pnpm benchmarks:prewarm --code SP500_INDEX --code DJIA_INDEX --code VIX_INDEX --from 2006-01-01
 * pnpm benchmarks:prewarm --code SP500 --from 2000-01-01 --to 2009-12-31
 * ```
 */

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

type PrewarmArguments = {
  readonly codes: readonly string[];
  readonly from: string;
  readonly to: string;
};

export function parsePrewarmArguments(
  argv: readonly string[],
  today: string,
): PrewarmArguments {
  const codes: string[] = [];
  let from: string | undefined;
  let to: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--code":
        if (!value) {
          throw new Error("--code needs a benchmark code, e.g. SP500_INDEX");
        }
        codes.push(value);
        index += 1;
        break;
      case "--from":
        from = value;
        index += 1;
        break;
      case "--to":
        to = value;
        index += 1;
        break;
      default:
        throw new Error(
          `Unknown argument '${String(flag)}'. Usage: --code CODE [--code CODE ...] --from YYYY-MM-DD [--to YYYY-MM-DD]`,
        );
    }
  }

  if (codes.length === 0) {
    throw new Error("At least one --code is required, e.g. --code SP500_INDEX");
  }
  if (!from || !LOCAL_DATE.test(from)) {
    throw new Error("--from is required and must be YYYY-MM-DD");
  }
  // Defaulted rather than required: "everything you have, up to now" is the common intent, and the
  // end of a prewarm is the one bound the caller is least likely to care about.
  const resolvedTo = to ?? today;
  if (!LOCAL_DATE.test(resolvedTo)) {
    throw new Error("--to must be YYYY-MM-DD");
  }
  if (from > resolvedTo) {
    throw new Error(`--from ${from} is after --to ${resolvedTo}`);
  }

  return { codes, from, to: resolvedTo };
}

async function prewarm(): Promise<void> {
  loadRootEnv();
  const apiConfig = getApiConfig();
  const logger = createLogger({
    service: "api",
    level: apiConfig.logLevel,
    environment: apiConfig.environment,
    base: { component: "benchmark-prewarm" },
  });

  const { codes, from, to } = parsePrewarmArguments(
    process.argv.slice(2),
    new Date().toISOString().slice(0, 10),
  );

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url, (err) => {
    logger.warn({ event: "stock-data.redis.error", err });
  });
  const traffic = getFmpTrafficConfig();
  const stockData = getStockDataConfig();
  const benchmarks = createBenchmarkDataService({
    prisma,
    cache: new IoredisCacheClient(redis),
    provider: new FmpClient(() => getFmpConfig(), fetch, {
      // The shared gate, not a private one: a prewarm of thirty years of index history is exactly
      // the job that would otherwise starve a live Stock Details read of its provider budget.
      gate: new RedisFmpRequestGate(redis, {
        maxConcurrentRequests: traffic.maxConcurrentRequests,
        rateLimitPerWindow: traffic.rateLimitPerWindow,
        rateWindowMs: traffic.rateWindowMs,
        maxQueueDepth: traffic.maxQueueDepth,
        maxQueueWaitMs: traffic.maxQueueWaitMs,
        requestLeaseMs: traffic.timeoutMs * 2,
      }),
    }),
    coordinator: new RedlockLoadCoordinator(redis, {
      lockDurationMs: stockData.loadLockDurationMs,
      lockWaitMs: stockData.loadLockWaitMs,
    }),
    onProviderRequest: (request) => {
      logger.info({ event: "benchmark.prewarm.provider.request", ...request });
    },
  });

  let failures = 0;
  try {
    for (const code of codes) {
      const startedAt = Date.now();
      logger.info({ event: "benchmark.prewarm.started", code, from, to });
      try {
        const benchmark = await benchmarks.getBenchmark(code);
        await benchmarks.ensureBenchmarkHydrated(benchmark.series, {
          from,
          to,
        });
        // Reported rather than assumed: the honest outcome of a prewarm is what coverage now says,
        // and a series whose own history starts later legitimately leaves a leading gap.
        const missing = await benchmarks.missingBenchmarkCoverage(
          benchmark.series,
          { from, to },
        );
        logger.info({
          event: "benchmark.prewarm.completed",
          code,
          seriesId: benchmark.series.id,
          seriesVersion: benchmark.series.version,
          from,
          to,
          missingRanges: missing.length,
          durationMs: Date.now() - startedAt,
        });
        console.log(
          `${code}: hydrated ${from} → ${to} into series v${benchmark.series.version}` +
            (missing.length === 0
              ? "; coverage is complete."
              : `; ${missing.length} range(s) still uncovered — the provider has no data there.`),
        );
      } catch (error) {
        failures += 1;
        logger.error({
          event: "benchmark.prewarm.failed",
          code,
          from,
          to,
          durationMs: Date.now() - startedAt,
          err: error,
        });
        console.error(
          `${code}: prewarm failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    redis.disconnect();
    await prisma.$disconnect();
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void prewarm();
}
