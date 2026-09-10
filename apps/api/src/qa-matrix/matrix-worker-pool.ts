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

export class MatrixWorkerPool {
  private child: ChildProcess | null = null;
  private readonly runByWorker = new Map<string, string>();
  private readonly requestsByRun = new Map<string, number>();
  private unattributedRequests = 0;
  private stopped = false;

  constructor(private readonly options: WorkerPoolOptions) {}

  /** The worker entry point, built. A source-only run would be a different process to production. */
  private workerEntryPoint(): string {
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

    this.child = spawn(process.execPath, [this.workerEntryPoint()], {
      cwd: this.options.repositoryRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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
  async stop(graceMs = 20_000): Promise<void> {
    const child = this.child;
    if (!child || this.stopped) {
      return;
    }
    this.stopped = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.child = null;
  }
}
