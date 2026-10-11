import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  getMarketDataWorkerConfig,
  getWorkerConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";
import {
  createMarketDataRuntime,
  logRedisEvictionPolicy,
} from "./composition.js";
import { MarketDataRefreshLoop } from "./refresh-loop.js";
import { MarketDataRefreshRun } from "./refresh-run.js";

/**
 * `pnpm market-data:refresh-once` — run one market-data refresh now, through the normal claim.
 *
 * An operator command, used after the bootstrap to verify the incremental path and the Redis
 * projection immediately rather than on the next scheduled run. It takes the same singleton claim a
 * worker child does, so it never runs beside a refresh already in flight: if one is, that refresh is
 * the run and this exits saying so. It never bootstraps a series.
 */
loadRootEnv();
const appConfig = getWorkerConfig();
const config = getMarketDataWorkerConfig();
const workerId = `market-data-cli-${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
const logger = createLogger({
  service: "worker",
  level: appConfig.logLevel,
  environment: appConfig.environment,
  base: { component: "market-data", workerId },
});

const runtime = createMarketDataRuntime(logger);
try {
  await logRedisEvictionPolicy(logger, runtime.inspectEvictionPolicy);
  await runtime.schedule.ensureSchedule(new Date());
  await runtime.schedule.requestImmediateRun(new Date());
  const loop = new MarketDataRefreshLoop(
    runtime.schedule,
    new MarketDataRefreshRun(runtime.benchmarks, runtime.calendar, logger, {
      publicationDelayMs: config.publicationDelayMs,
      seriesRetryMs: config.seriesRetryMs,
      runBudgetMs: config.runBudgetMs,
    }),
    logger,
    {
      workerId,
      refreshIntervalMs: config.refreshIntervalMs,
      pollIntervalMs: config.pollIntervalMs,
      leaseMs: config.leaseMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      retryBackoffMs: config.retryBackoffMs,
    },
  );
  const ran = await loop.runOnce();
  logger.info({
    event: ran
      ? "market-data.refresh-once.completed"
      : "market-data.refresh-once.busy",
  });
} catch (err) {
  logger.fatal({ event: "market-data.refresh-once.failed", err });
  process.exitCode = 1;
} finally {
  await runtime.close();
}
