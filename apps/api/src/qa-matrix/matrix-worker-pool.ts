import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { MatrixEnvironment } from "./matrix-environment";

/**
 * The real backtest worker, running against the matrix environment.
 *
 * This spawns `apps/worker`'s own supervisor — the same process a deployment runs — with the matrix
 * database and Redis in its environment. Nothing about execution is reimplemented here: the
 * supervisor forks its children, each child claims a job with `FOR UPDATE SKIP LOCKED`, renews its
 * lease, executes the run and persists the result exactly as it does in production. The runner's
 * only privilege is choosing where that happens.
 *
 * Concurrency is `BACKTEST_WORKER_PROCESSES`, because that is what concurrency *is* in this
 * architecture: one backtest is never internally parallelized, so throughput comes from independent
 * OS processes taking different jobs. There is deliberately no second concurrency mechanism.
 *
 * The pool also reads the worker's structured log stream, which is the only place provider traffic
 * is observable. `stock-data.provider.request` is emitted at `debug` by the worker's composition
 * root for every FMP request, carrying the worker id; `backtest.claimed` and the terminal events
 * carry the run id. A child executes at most one backtest at a time, so associating the two by
 * worker id attributes each request to the run that caused it — which is what makes "this sweep hit
 * the provider 0 times" a measurement rather than a hope.
 */

export type WorkerPoolOptions = {
  readonly environment: MatrixEnvironment;
  readonly repositoryRoot: string;
  /** `BACKTEST_WORKER_PROCESSES`: how many runs may execute at once. */
  readonly processes: number;
  /** Forensic archives, for the golden set and for failure replay. */
  readonly debugArchive: "off" | "full";
  readonly debugArchiveDir?: string;
  /** Receives every parsed log record, for a caller that wants to tee them to a file. */
  readonly onLogRecord?: (record: Record<string, unknown>) => void;
  /**
   * The process to spawn instead of the built worker supervisor.
   *
   * A seam for the lifecycle tests only: proving that a child which ignores SIGTERM and outlives
   * its parent is still gone after {@link MatrixWorkerPool.stop} requires a process that
   * deliberately behaves that way, and the real worker deliberately does not.
   */
  readonly entryPointOverride?: string;
};

/**
 * Pins the canonical dataset for the duration of the sweep.
 *
 * The matrix database is a copy of already-durable history, so its freshness watermarks are as old
 * as the copy. With the ordinary six-hour freshness window, the loader would decide the recent tail
 * of every security is stale and refresh thirty-three of them from FMP in the middle of a timed run
 * — traffic the matrix is explicitly designed not to depend on, and which would make two sweeps of
 * the same clock read different data.
 *
 * Widening the freshness window is configuration the product already exposes, not a change to what
 * a backtest computes: it decides whether to *ask* for a newer tail, never how an existing bar is
 * interpreted. Coverage gaps still reach the provider, which is why the preflight proves there are
 * none and the report counts every request that happens anyway.
 */
const PINNED_DATASET_FRESHNESS_MS = String(10 * 365 * 24 * 60 * 60 * 1000);

export type ProviderRequestLedger = {
  /** Requests attributed to one run id. */
  readonly byRunId: ReadonlyMap<string, number>;
  /** Requests observed while no run was claimed by that worker. */
  readonly unattributed: number;
  readonly total: number;
};

/**
 * The pool that is currently running, if any.
 *
 * Two pools drawing from the same PostgreSQL queue is never correct, and it is not a theoretical
 * concern: a refactor left a second main-phase pool running with capture off, and it quietly took
 * four of the six golden reruns — producing two archives where six were planned, twice, with
 * every case otherwise green. Nothing detected it except counting the files afterwards.
 *
 * So starting a second pool while one is live now throws where the mistake is, rather than
 * changing which runs get archived and saying nothing.
 */
let runningPoolId: symbol | null = null;

export class MatrixWorkerPool {
  private readonly id = Symbol("matrix-worker-pool");
  private child: ChildProcess | null = null;
  private readonly runByWorker = new Map<string, string>();
  private readonly requestsByRun = new Map<string, number>();
  private unattributedRequests = 0;
  private stopped = false;

  constructor(private readonly options: WorkerPoolOptions) {}

  /** The worker entry point, built. A source-only run would be a different process to production. */
  private workerEntryPoint(): string {
    if (this.options.entryPointOverride) {
      return this.options.entryPointOverride;
    }
    const entry = join(
      this.options.repositoryRoot,
      "apps/worker/dist/index.js",
    );
    if (!existsSync(entry)) {
      throw new Error(
        `The backtest worker is not built (${entry} does not exist). The matrix executes runs ` +
          "through the real worker process, so build it first:\n" +
          "  pnpm --filter @intrinsic/worker build",
      );
    }
    return entry;
  }

  start(): void {
    if (this.child) {
      throw new Error("The matrix worker pool is already running.");
    }
    if (runningPoolId !== null && runningPoolId !== this.id) {
      throw new Error(
        "Another matrix worker pool is already running. Two pools claim from the same job queue, " +
          "so whichever one happens to win decides which runs are executed with forensic capture " +
          "on — which is how a sweep produced two archives where six were planned. Stop the first " +
          "pool before starting the second.",
      );
    }
    runningPoolId = this.id;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: this.options.environment.databaseUrl,
      REDIS_URL: this.options.environment.redisUrl,
      BACKTEST_WORKER_PROCESSES: String(this.options.processes),
      // Provider requests are logged at debug; without this the sweep cannot count them.
      LOG_LEVEL: "debug",
      STOCK_RECENT_PRICE_FRESHNESS_MS: PINNED_DATASET_FRESHNESS_MS,
      STOCK_FUNDAMENTALS_FRESHNESS_MS: PINNED_DATASET_FRESHNESS_MS,
      BACKTEST_DEBUG_ARCHIVE: this.options.debugArchive,
      ...(this.options.debugArchiveDir
        ? { BACKTEST_DEBUG_ARCHIVE_DIR: this.options.debugArchiveDir }
        : {}),
    };

    // `detached` makes the supervisor a **process-group leader**, so its forked children join
    // that group and a signal sent to the group reaches all of them. Without it the pool can only
    // signal the supervisor, and a child that outlives its parent keeps claiming from the same
    // PostgreSQL queue — see {@link stop}.
    this.child = spawn(process.execPath, [this.workerEntryPoint()], {
      cwd: this.options.repositoryRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    for (const stream of [this.child.stdout, this.child.stderr]) {
      if (!stream) {
        continue;
      }
      const lines = createInterface({ input: stream });
      lines.on("line", (line) => this.observe(line));
    }
  }

  /**
   * Attributes one structured log line.
   *
   * Anything unparseable is ignored rather than reported: the worker's stream is observation, and a
   * runner that failed a sweep because a log line was not JSON would be measuring the wrong thing.
   */
  private observe(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    this.options.onLogRecord?.(record);

    const workerId =
      typeof record.workerId === "string" ? record.workerId : null;
    const event = typeof record.event === "string" ? record.event : null;
    if (!workerId || !event) {
      return;
    }

    if (event === "backtest.claimed" && typeof record.runId === "string") {
      this.runByWorker.set(workerId, record.runId);
      return;
    }
    if (event === "backtest.completed" || event === "backtest.failed") {
      this.runByWorker.delete(workerId);
      return;
    }
    if (event === "stock-data.provider.request") {
      const runId = this.runByWorker.get(workerId);
      if (runId) {
        this.requestsByRun.set(runId, (this.requestsByRun.get(runId) ?? 0) + 1);
      } else {
        this.unattributedRequests += 1;
      }
    }
  }

  providerRequests(): ProviderRequestLedger {
    let total = this.unattributedRequests;
    for (const count of this.requestsByRun.values()) {
      total += count;
    }
    return {
      byRunId: new Map(this.requestsByRun),
      unattributed: this.unattributedRequests,
      total,
    };
  }

  providerRequestsFor(runId: string): number {
    return this.requestsByRun.get(runId) ?? 0;
  }

  /** Stops the supervisor, letting it release claims before it is killed. */
  /**
   * Signals the whole pool — supervisor and every worker child — rather than the supervisor alone.
   *
   * `process.kill(-pid)` addresses the process group, which the `detached` spawn made this
   * supervisor the leader of. Failures are swallowed because the only ones that occur are ESRCH,
   * meaning the group is already gone.
   */
  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (pid === undefined) {
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  }

  /** Whether any process in the pool's group still exists. */
  private groupIsAlive(): boolean {
    const pid = this.child?.pid;
    if (pid === undefined) {
      return false;
    }
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stops the pool, and does not return until nothing in it is running.
   *
   * "Stopped" has to mean *nothing from this pool can claim another job*, because the archive
   * choreography depends on it: the sweep pool and the golden-rerun pool draw from the same
   * PostgreSQL queue with different capture settings, so a single surviving child of the wrong
   * pool silently takes a rerun's job and produces no archive for it.
   *
   * That is not hypothetical. A sweep whose pool reported itself stopped left three children alive
   * and claiming; they took four of the six golden reruns, and the run ended with two archives
   * where six were planned. The supervisor had logged `worker.stopped` and then kept running.
   *
   * So this no longer trusts the supervisor's own shutdown to be complete. It asks the group to
   * stop, waits for the supervisor to exit — with a grace window **longer** than the supervisor's
   * own child-kill timer, so the ordinary path is still a clean shutdown — and then kills anything
   * left in the group and confirms the group is gone before returning.
   */
  async stop(graceMs = 45_000): Promise<void> {
    const child = this.child;
    if (!child || this.stopped) {
      return;
    }
    this.stopped = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.signalGroup("SIGTERM");
    });

    // Whatever survived the graceful path — an orphaned child, or a supervisor that reported
    // itself stopped without reaping — goes now.
    for (let attempt = 0; attempt < 50 && this.groupIsAlive(); attempt += 1) {
      this.signalGroup("SIGKILL");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (this.groupIsAlive()) {
      throw new Error(
        `The matrix worker pool (process group ${child.pid}) is still running after SIGKILL. ` +
          "Refusing to continue: a surviving worker claims jobs from the same queue as the next " +
          "pool, which silently changes which runs are archived.",
      );
    }
    this.child = null;
    if (runningPoolId === this.id) {
      runningPoolId = null;
    }
  }
}
