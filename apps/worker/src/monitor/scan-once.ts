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
 * `pnpm monitors:scan-once` — run one Monitor evaluation cycle now, through the normal claim.
 *
 * An operator command, used after bootstrapping built-in content so its Monitors' state is
 * reconstructed immediately rather than on the next scheduled cycle. It takes the same singleton
 * claim a worker child does, so it can never run beside a cycle already in flight: if one is, that
 * cycle is the scan and this exits reporting it.
 */
loadRootEnv();
const appConfig = getWorkerConfig();
const config = getMonitorWorkerConfig();
const workerId = `monitor-cli-${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
const logger = createLogger({
  service: "worker",
  level: appConfig.logLevel,
  environment: appConfig.environment,
  base: { component: "monitor", workerId },
});

const runtime = createMonitorRuntime(logger);
try {
  const scans = runtime.scans;
  await scans.ensureSchedule(new Date());
  await scans.requestImmediateScan(new Date());
  const loop = new MonitorWorkerLoop(
    scans,
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
  const ran = await loop.runOnce();
  logger.info({
    event: ran ? "monitor.scan-once.completed" : "monitor.scan-once.busy",
  });
} catch (err) {
  logger.fatal({ event: "monitor.scan-once.failed", err });
  process.exitCode = 1;
} finally {
  await runtime.close();
}
