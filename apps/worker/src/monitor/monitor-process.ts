import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  getMonitorWorkerConfig,
  getWorkerConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";
import { createMonitorRuntime } from "./composition.js";
import { MonitorCycle } from "./monitor-cycle.js";
import { MonitorWorkerLoop } from "./monitor-loop.js";

/**
 * One monitor worker child.
 *
 * It claims at most one scan cycle at a time. Unlike a backtest child, extra monitor children buy
 * availability rather than throughput: the cycle is a singleton claim, so a second process is the
 * one that picks scanning up when the first dies, never a second scanner running beside it.
 *
 * The supervisor in `../index.ts` is what starts and restarts these.
 */
loadRootEnv();
const appConfig = getWorkerConfig();
const config = getMonitorWorkerConfig();

/**
 * Stable per-process identity, written as `MonitorScanSchedule.claimedBy`.
 *
 * Host and pid make a claim traceable back to a process; the random suffix keeps two children that
 * reuse a pid after a restart from looking like the same claimant.
 */
const workerId = `monitor-${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;

const logger = createLogger({
  service: "worker",
  level: appConfig.logLevel,
  environment: appConfig.environment,
  base: { component: "monitor", workerId },
});

/**
 * A rejection or exception nothing caught ends this child — Node exits on it and the supervisor
 * restarts the child, while the claim it held expires and is recovered. Without these handlers the
 * only record would be an unstructured stack trace; the supervisor sees an exit code and nothing
 * else. Logging it here keeps the failure searchable beside the claim it interrupted.
 */
process.on("unhandledRejection", (reason: unknown) => {
  logger.fatal({ event: "monitor.child.unhandled-rejection", err: reason });
  process.exit(1);
});
process.on("uncaughtException", (err: unknown) => {
  logger.fatal({ event: "monitor.child.uncaught-exception", err });
  process.exit(1);
});

const runtime = createMonitorRuntime(logger);

const loop = new MonitorWorkerLoop(
  runtime.scans,
  new MonitorCycle(runtime.monitors, runtime.data, runtime.calendar, logger, {
    symbolConcurrency: config.symbolConcurrency,
    quoteMaxAgeMs: config.quoteMaxAgeMs,
  }),
  logger,
  {
    workerId,
    scanIntervalMs: config.scanIntervalMs,
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
  logger.info({ event: "monitor.child.stopping", signal });
  // The loop stops claiming immediately and asks a cycle in flight to stop at its next Monitor
  // boundary. Stopping there is safe because every transition is decided from durable state and
  // persisted history, so the next cycle re-evaluates whatever this one did not reach and reaches
  // the same conclusions — whereas running to completion could outlive the supervisor's kill grace,
  // which is the one way to actually be cut off mid-write.
  loop.stop();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const startedAt = Date.now();
logger.info({
  event: "monitor.child.ready",
  scanIntervalMs: config.scanIntervalMs,
});

try {
  await loop.run();
} catch (err) {
  logger.fatal({ event: "monitor.child.failed", err });
  process.exitCode = 1;
} finally {
  await runtime.close();
  logger.info({
    event: "monitor.child.stopped",
    durationMs: Date.now() - startedAt,
  });
}
