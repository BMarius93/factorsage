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
 * One market-data worker child (`docs/decisions/etf-market-data-v1.md`).
 *
 * It keeps the market-overview ETF histories current and their Redis projection complete. It is a
 * process of its own, beside the backtest and Monitor children, so its provider reads, its
 * PostgreSQL work and its failures can never delay a Monitor cycle: the two share nothing but the
 * provider gate's budget, which a sequential refresh draws on one request at a time.
 *
 * The refresh is a singleton claim, so a second child buys availability rather than throughput.
 * The supervisor in `../index.ts` starts and restarts these.
 */
loadRootEnv();
const appConfig = getWorkerConfig();
const config = getMarketDataWorkerConfig();
const workerId = `market-data-${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;

const logger = createLogger({
  service: "worker",
  level: appConfig.logLevel,
  environment: appConfig.environment,
  base: { component: "market-data", workerId },
});

process.on("unhandledRejection", (reason: unknown) => {
  logger.fatal({ event: "market-data.child.unhandled-rejection", err: reason });
  process.exit(1);
});
process.on("uncaughtException", (err: unknown) => {
  logger.fatal({ event: "market-data.child.uncaught-exception", err });
  process.exit(1);
});

const runtime = createMarketDataRuntime(logger);
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

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ event: "market-data.child.stopping", signal });
  // The run stops at its next series boundary; every write before it is committed and the rest is
  // simply what the next run does.
  loop.stop();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const startedAt = Date.now();
await logRedisEvictionPolicy(logger, runtime.inspectEvictionPolicy);
logger.info({
  event: "market-data.child.ready",
  refreshIntervalMs: config.refreshIntervalMs,
  publicationDelayMs: config.publicationDelayMs,
});

try {
  await loop.run();
} catch (err) {
  logger.fatal({ event: "market-data.child.failed", err });
  process.exitCode = 1;
} finally {
  await runtime.close();
  logger.info({
    event: "market-data.child.stopped",
    durationMs: Date.now() - startedAt,
  });
}
