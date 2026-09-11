import { fork, type ChildProcess } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBacktestWorkerConfig,
  getMonitorWorkerConfig,
  getWorkerConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";

/**
 * The worker supervisor.
 *
 * It owns no business logic: it forks children of two kinds and keeps them alive.
 *
 * `BACKTEST_WORKER_PROCESSES` backtest children each claim and execute at most one backtest at a
 * time. One backtest is never split across processes — the day loop is sequential in time and stays
 * deterministic — so these processes buy throughput across independent runs, never speed on a
 * single run.
 *
 * `MONITOR_WORKER_PROCESSES` monitor children each claim at most one Monitor evaluation cycle. The
 * cycle is a singleton durable claim, so a second monitor child buys availability rather than
 * throughput: it is what picks scanning up when the first one dies. `0` disables monitoring in this
 * process entirely, which is what a deployment that runs backtests elsewhere — or the QA matrix,
 * whose provider-request assertions must see only its own traffic — sets.
 *
 * Supervision is what makes the deployment self-healing: a child that dies is replaced with a
 * bounded backoff, and any work it was holding is recovered through its expired lease. A signal is
 * forwarded to every child and the supervisor waits for them, so a graceful stop releases claims
 * instead of stranding work.
 */
loadRootEnv();
const appConfig = getWorkerConfig();
const backtestConfig = getBacktestWorkerConfig();
const monitorConfig = getMonitorWorkerConfig();

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
const childExtension = extname(supervisorPath);

/** The child kinds this supervisor runs, each with its own entry point and process count. */
const CHILD_KINDS = [
  {
    kind: "backtest",
    processes: backtestConfig.processes,
    module: join(
      dirname(supervisorPath),
      "backtest",
      `worker-process${childExtension}`,
    ),
  },
  {
    kind: "monitor",
    processes: monitorConfig.processes,
    module: join(
      dirname(supervisorPath),
      "monitor",
      `monitor-process${childExtension}`,
    ),
  },
] as const;

type ChildKind = (typeof CHILD_KINDS)[number];

/** Restart backoff. A child that fails immediately must not become a fork loop. */
const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;
/** How long a child must run before its restart counter is considered healthy again. */
const HEALTHY_RUNTIME_MS = 60_000;
/** How long a stopping child is given to release its claim before it is killed outright. */
const SHUTDOWN_GRACE_MS = 30_000;

type SupervisedChild = {
  id: string;
  spec: ChildKind;
  index: number;
  child: ChildProcess;
  startedAt: number;
  failures: number;
};

/** Keyed by `<kind>-<index>`, so the two kinds cannot collide on a bare ordinal. */
const children = new Map<string, SupervisedChild>();
const restartTimers = new Set<NodeJS.Timeout>();
let stopping = false;
let forceKillTimer: NodeJS.Timeout | null = null;

function childId(spec: ChildKind, index: number): string {
  return `${spec.kind}-${index}`;
}

function spawnChild(spec: ChildKind, index: number, failures: number): void {
  const id = childId(spec, index);
  const child = fork(spec.module);
  children.set(id, { id, spec, index, child, startedAt: Date.now(), failures });

  logger.info({
    event: "worker.child.started",
    childKind: spec.kind,
    childIndex: index,
    pid: child.pid,
  });

  child.on("exit", (code, signal) => {
    const supervised = children.get(id);
    const ranForMs = supervised ? Date.now() - supervised.startedAt : 0;
    children.delete(id);
    logger.info({
      event: "worker.child.exited",
      childKind: spec.kind,
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
    scheduleRestart(spec, index, ranForMs >= HEALTHY_RUNTIME_MS ? 0 : failures);
  });

  child.on("error", (err) => {
    logger.error({
      event: "worker.child.error",
      childKind: spec.kind,
      childIndex: index,
      err,
    });
  });
}

function scheduleRestart(
  spec: ChildKind,
  index: number,
  previousFailures: number,
): void {
  const failures = previousFailures + 1;
  const delayMs = Math.min(
    RESTART_BASE_DELAY_MS * 2 ** (failures - 1),
    RESTART_MAX_DELAY_MS,
  );

  logger.warn({
    event: "worker.child.restarting",
    childKind: spec.kind,
    childIndex: index,
    failures,
    delayMs,
  });

  const timer = setTimeout(() => {
    restartTimers.delete(timer);
    if (!stopping) {
      spawnChild(spec, index, failures);
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
        childKind: supervised.spec.kind,
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

for (const spec of CHILD_KINDS) {
  for (let index = 0; index < spec.processes; index += 1) {
    spawnChild(spec, index, 0);
  }
}

logger.info(
  {
    event: "worker.supervisor.started",
    backtestProcesses: backtestConfig.processes,
    monitorProcesses: monitorConfig.processes,
  },
  "workers started",
);
