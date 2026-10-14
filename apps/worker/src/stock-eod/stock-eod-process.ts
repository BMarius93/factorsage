import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  getStockEodWorkerConfig,
  getWorkerConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";
import { MarketDataRefreshLoop } from "../market-data/refresh-loop.js";
import { createStockEodRuntime } from "./composition.js";
import { StockEodRefreshRun } from "./refresh-run.js";

/**
 * One stock EOD worker child (`docs/decisions/monitor-eod-v2-proposal.md` §3.3).
 *
 * It keeps every security a running Monitor watches current for the newest finalized session,
 * through the canonical loader. It is a process of its own beside the backtest, Monitor and
 * market-data children, so its provider reads and its failures can never delay a Monitor
 * evaluation or the ETF refresh: they share nothing but the provider gate's budget.
 *
 * The preparation is a singleton claim — its own row in `MarketDataRefreshSchedule` — so a second
 * child buys availability rather than throughput. The supervisor in `../index.ts` starts and
 * restarts these.
 */
loadRootEnv();
const appConfig = getWorkerConfig();
const config = getStockEodWorkerConfig();
const workerId = `stock-eod-${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;

const logger = createLogger({
  service: "worker",
  level: appConfig.logLevel,
  environment: appConfig.environment,
  base: { component: "stock-eod", workerId },
});

process.on("unhandledRejection", (reason: unknown) => {
  logger.fatal({ event: "stock-eod.child.unhandled-rejection", err: reason });
  process.exit(1);
});
process.on("uncaughtException", (err: unknown) => {
  logger.fatal({ event: "stock-eod.child.uncaught-exception", err });
  process.exit(1);
});

const runtime = createStockEodRuntime(logger);
const work = new StockEodRefreshRun(runtime.stockData, runtime.monitors, logger, {
  policy: runtime.policy,
  runBudgetMs: config.runBudgetMs,
  securityConcurrency: config.securityConcurrency,
  followUpMs: config.followUpMs,
  providerRequests: runtime.providerRequests,
});
const loop = new MarketDataRefreshLoop(
  runtime.schedule,
  {
    run: (runSequence, aborted) => work.run(runSequence, aborted),
    followUpMs: (summary) => work.followUpMs(summary),
  },
  logger,
  {
    workerId,
    refreshIntervalMs: config.refreshIntervalMs,
    pollIntervalMs: config.pollIntervalMs,
    leaseMs: config.leaseMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    retryBackoffMs: config.retryBackoffMs,
    events: "stock-eod.refresh",
    component: "stock-eod",
    jobIdPrefix: "stock-eod",
  },
);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ event: "stock-eod.child.stopping", signal });
  // The run stops at its next security boundary; every write before it is committed and the rest
  // is simply what the next run does.
  loop.stop();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const startedAt = Date.now();
logger.info({
  event: "stock-eod.child.ready",
  refreshIntervalMs: config.refreshIntervalMs,
  securityConcurrency: config.securityConcurrency,
});

try {
  await loop.run();
} catch (err) {
  logger.fatal({ event: "stock-eod.child.failed", err });
  process.exitCode = 1;
} finally {
  await runtime.close();
  logger.info({
    event: "stock-eod.child.stopped",
    durationMs: Date.now() - startedAt,
  });
}
