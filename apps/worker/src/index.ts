import { fork, type ChildProcess } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBacktestWorkerConfig,
  getWorkerConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";

/**
 * The worker supervisor.
 *
 * It owns no business logic: it forks `BACKTEST_WORKER_PROCESSES` children, each of which claims
 * and executes at most one backtest at a time. One backtest is never split across processes — the
 * day loop is sequential in time and stays deterministic — so these processes buy throughput
 * across independent runs, never speed on a single run.
 *
 * Supervision is what makes the deployment self-healing: a child that dies is replaced with a
 * bounded backoff, and any run it was holding is recovered through its expired lease. A signal is
 * forwarded to every child and the supervisor waits for them, so a graceful stop releases claims
 * instead of stranding runs.
 */
loadRootEnv();
const appConfig = getWorkerConfig();
const config = getBacktestWorkerConfig();

const logger = createLogger({
  service: "worker",
  level: appConfig.logLevel,
  environment: appConfig.environment,
  base: { component: "worker-supervisor" },
});

/**
 * Resolved beside this module and with its own extension, so the supervisor forks `.ts` under
 * `tsx watch` in development and `.js` from `dist` in a deployment without a build-time switch.
 */
const supervisorPath = fileURLToPath(import.meta.url);
const childModulePath = join(
  dirname(supervisorPath),
  "backtest",
  `worker-process${extname(supervisorPath)}`,
);

/** Restart backoff. A child that fails immediately must not become a fork loop. */
const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;
/** How long a child must run before its restart counter is considered healthy again. */
const HEALTHY_RUNTIME_MS = 60_000;
/** How long a stopping child is given to release its claim before it is killed outright. */
const SHUTDOWN_GRACE_MS = 30_000;

type SupervisedChild = {
  index: number;
  child: ChildProcess;
  startedAt: number;
  failures: number;
};

const children = new Map<number, SupervisedChild>();
const restartTimers = new Set<NodeJS.Timeout>();
let stopping = false;
let forceKillTimer: NodeJS.Timeout | null = null;

function spawnChild(index: number, failures: number): void {
  const child = fork(childModulePath);
  children.set(index, { index, child, startedAt: Date.now(), failures });

  logger.info({
    event: "worker.child.started",
    childIndex: index,
    pid: child.pid,
  });

  child.on("exit", (code, signal) => {
    const supervised = children.get(index);
    const ranForMs = supervised ? Date.now() - supervised.startedAt : 0;
    children.delete(index);
    logger.info({
      event: "worker.child.exited",
      childIndex: index,
      pid: child.pid,
      exitCode: code,
      signal,
    });

    if (stopping) {
      finishWhenAllChildrenExited();
      return;
    }
    // A child that ran healthily before dying starts its backoff fresh; only a child that keeps
    // failing on startup is slowed down.
    scheduleRestart(index, ranForMs >= HEALTHY_RUNTIME_MS ? 0 : failures);
  });

  child.on("error", (err) => {
    logger.error({ event: "worker.child.error", childIndex: index, err });
  });
}

function scheduleRestart(index: number, previousFailures: number): void {
  const failures = previousFailures + 1;
  const delayMs = Math.min(
    RESTART_BASE_DELAY_MS * 2 ** (failures - 1),
    RESTART_MAX_DELAY_MS,
  );

  logger.warn({
    event: "worker.child.restarting",
    childIndex: index,
    failures,
    delayMs,
  });

  const timer = setTimeout(() => {
    restartTimers.delete(timer);
    if (!stopping) {
      spawnChild(index, failures);
    }
  }, delayMs);
  restartTimers.add(timer);
}

function finishWhenAllChildrenExited(): void {
  if (children.size > 0) {
    return;
  }
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }
  clearInterval(keepAlive);
  logger.info({ event: "worker.stopped" });
  process.exitCode = 0;
}

function shutdown(signal: string): void {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ event: "worker.stopping", signal });

  for (const timer of restartTimers) {
    clearTimeout(timer);
  }
  restartTimers.clear();

  for (const supervised of children.values()) {
    supervised.child.kill("SIGTERM");
  }

  // A child releasing a claim only has to finish its current checkpoint. If it cannot, the lease
  // expires and stale recovery requeues the run, so waiting forever would buy nothing.
  forceKillTimer = setTimeout(() => {
    for (const supervised of children.values()) {
      logger.warn({
        event: "worker.child.killed",
        childIndex: supervised.index,
        pid: supervised.child.pid,
      });
      supervised.child.kill("SIGKILL");
    }
  }, SHUTDOWN_GRACE_MS);

  finishWhenAllChildrenExited();
}

const keepAlive = setInterval(() => {
  logger.debug({ event: "worker.heartbeat", children: children.size });
}, 60_000);

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

for (let index = 0; index < config.processes; index += 1) {
  spawnChild(index, 0);
}

logger.info(
  { event: "worker.supervisor.started", processes: config.processes },
  "backtest workers started",
);
