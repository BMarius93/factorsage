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
import { MarketDataRefreshRun, type EtfRefreshOutcome } from "./refresh-run.js";

/**
 * `pnpm market-data:refresh-once` — run one market-data refresh now, through the normal claim.
 *
 * An operator command, used after the bootstrap to verify the incremental path and the Redis
 * projection immediately rather than on the next scheduled run. It takes the same singleton claim a
 * worker child does, so it never runs beside a refresh already in flight: if one is, that refresh is
 * the run and this exits saying so. It never bootstraps a series.
 */
/**
 * Outcomes that mean a series is not current after the run, so the command exits non-zero: the
 * validation procedure in `docs/decisions/etf-market-data-v1.md` §6 relies on the exit status.
 */
const UNHEALTHY_OUTCOMES = new Set<EtfRefreshOutcome["outcome"]>([
  "FAILED",
  "REBASE_REFUSED",
  "NOT_BOOTSTRAPPED",
  "DEFERRED",
  "BACKING_OFF",
]);

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
  const result = await loop.runOnce();
  if (result === null) {
    // Another process holds the claim: its run is the refresh, and this one saw none of it.
    logger.warn({ event: "market-data.refresh-once.busy" });
    console.log(
      "A refresh run is already in flight; run this again once it finishes to see an outcome.",
    );
    process.exitCode = 1;
  } else if (result.outcome === "COMPLETED") {
    for (const item of result.summary.outcomes) {
      console.log(
        `${item.outcome.padEnd(20)} ${item.ticker.padEnd(5)} ${item.latestBar ?? "-"}` +
          (item.error ? ` — ${item.error}` : ""),
      );
    }
    const unhealthy = result.summary.outcomes.filter((item) =>
      UNHEALTHY_OUTCOMES.has(item.outcome),
    );
    logger.info({
      event: "market-data.refresh-once.completed",
      runSequence: result.summary.runSequence,
      providerReads: result.summary.providerReads,
      unhealthy: unhealthy.map((item) => `${item.ticker}:${item.outcome}`),
    });
    if (unhealthy.length > 0) {
      process.exitCode = 1;
    }
  } else {
    logger.error({ event: "market-data.refresh-once.failed", ...result });
    console.error(`The refresh run did not complete: ${result.outcome}`);
    process.exitCode = 1;
  }
} catch (err) {
  logger.fatal({ event: "market-data.refresh-once.failed", err });
  process.exitCode = 1;
} finally {
  await runtime.close();
}
