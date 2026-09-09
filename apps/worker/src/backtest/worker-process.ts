import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  getBacktestWorkerConfig,
  getWorkerConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";
import { BacktestProcessor } from "./backtest-processor.js";
import { createBacktestRuntime } from "./composition.js";
import { BacktestWorkerLoop } from "./worker-loop.js";

/**
 * One backtest worker child.
 *
 * It claims at most one run at a time and executes it in this process: the simulation is
 * sequential in time and must stay deterministic, so it is never spread across cores. The
 * supervisor in `../index.ts` is what turns that into throughput by running several of these.
 */
loadRootEnv();
const appConfig = getWorkerConfig();
const config = getBacktestWorkerConfig();

/**
 * Stable per-process identity, written as `BacktestJob.claimedBy`.
 *
 * Host and pid make a claim traceable back to a process; the random suffix keeps two children that
 * reuse a pid after a restart from looking like the same claimant.
 */
const workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;

const logger = createLogger({
  service: "worker",
  level: appConfig.logLevel,
  environment: appConfig.environment,
  base: { component: "backtest", workerId },
});

const runtime = createBacktestRuntime(logger);

const loop = new BacktestWorkerLoop(
  runtime.repository,
  new BacktestProcessor(
    {
      repository: runtime.repository,
      securities: runtime.securities,
      stockData: runtime.stockData,
      benchmarks: runtime.benchmarks,
      logger,
      ...(runtime.debugArchives
        ? { debugArchives: runtime.debugArchives }
        : {}),
      ...(runtime.providerRequests
        ? { providerRequests: runtime.providerRequests }
        : {}),
    },
    {
      workerId,
      frameConcurrency: config.frameConcurrency,
      checkpointEveryDays: config.checkpointEveryDays,
      checkpointMinIntervalMs: config.checkpointMinIntervalMs,
      leaseMs: config.leaseMs,
    },
  ),
  logger,
  {
    workerId,
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
  logger.info({ event: "worker.child.stopping", signal });
  // The loop stops claiming immediately and interrupts a run in flight at its next checkpoint, so
  // the job goes back to the queue instead of being stranded mid-execution.
  loop.stop();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const startedAt = Date.now();
logger.info({ event: "worker.child.ready" });

try {
  await loop.run();
} catch (err) {
  logger.fatal({ event: "worker.child.failed", err });
  process.exitCode = 1;
} finally {
  await runtime.close();
  logger.info({
    event: "worker.child.stopped",
    durationMs: Date.now() - startedAt,
  });
}
