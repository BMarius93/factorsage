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

const runtime = createMonitorRuntime(logger);

const loop = new MonitorWorkerLoop(
  runtime.scans,
  new MonitorCycle(runtime.monitors, runtime.data, logger, {
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
  // The loop stops claiming immediately. A cycle in flight finishes rather than being abandoned
  // mid-way: it is bounded by the monitored universe, and a half-applied cycle would leave some
  // Monitors evaluated against this cycle's observation and some against the next one's.
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
