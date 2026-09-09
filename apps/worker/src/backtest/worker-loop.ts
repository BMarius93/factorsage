import {
  runWithLogContext,
  type StructuredLogger,
} from "@intrinsic/observability";
import {
  BacktestInterruptedError,
  RenewableJobLease,
  type BacktestJobLease,
} from "./job-lease.js";
import type {
  BacktestJobRepository,
  ClaimedBacktestJob,
} from "./job-repository.js";

/** Executes one claimed run. Only a `BacktestInterruptedError` may escape it. */
export interface BacktestJobProcessor {
  process(claim: ClaimedBacktestJob, lease: BacktestJobLease): Promise<void>;
}

export type BacktestWorkerLoopOptions = {
  /** Stable identity of this process, written as `claimedBy` on every claim it takes. */
  workerId: string;
  pollIntervalMs: number;
  leaseMs: number;
  heartbeatIntervalMs: number;
  retryBackoffMs: number;
  now?: () => Date;
};

/**
 * One worker process's claim loop: recover, claim, execute, repeat.
 *
 * It executes at most one backtest at a time and never splits a simulation — parallelism comes
 * from independent processes taking different jobs, which is what keeps every run deterministic.
 *
 * Shutdown is the interesting case. The loop stops claiming immediately, and a run in flight is
 * interrupted at its next checkpoint and handed back to the queue, so no run is left permanently
 * `RUNNING` with nobody executing it. If the process dies before it can release, the lease simply
 * expires and `recoverStaleJobs` does the same thing from the outside.
 */
export class BacktestWorkerLoop {
  private readonly now: () => Date;
  private stopping = false;
  private activeLease: RenewableJobLease | null = null;
  private wake: (() => void) | null = null;
  private lastRecoveryAt = 0;

  constructor(
    private readonly repository: BacktestJobRepository,
    private readonly processor: BacktestJobProcessor,
    private readonly logger: StructuredLogger,
    private readonly options: BacktestWorkerLoopOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async run(): Promise<void> {
    while (!this.stopping) {
      await this.recoverStaleJobs();

      const claim = await this.claimNextJob();
      if (this.stopping) {
        // A claim taken in the same tick as the stop signal is handed straight back rather than
        // started, so shutting down never delays a run behind a full execution.
        if (claim) {
          await this.releaseClaim(claim);
        }
        break;
      }
      if (!claim) {
        await this.idle();
        continue;
      }

      await this.execute(claim);
    }
  }

  /** Stops claiming and asks a run in flight to stop at its next checkpoint. */
  stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.activeLease?.requestShutdown();
    this.wake?.();
  }

  private async execute(claim: ClaimedBacktestJob): Promise<void> {
    const lease = new RenewableJobLease(this.repository, this.logger, {
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: this.options.workerId,
      leaseMs: this.options.leaseMs,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      now: this.now,
    });
    this.activeLease = lease;
    if (this.stopping) {
      lease.requestShutdown();
    }
    lease.start();

    this.logger.info({
      event: "backtest.claimed",
      runId: claim.runId,
      jobId: claim.jobId,
      actorUserId: claim.actorUserId,
      attempt: claim.attempt,
    });

    try {
      // Correlation does not cross a process boundary on its own: the claim carries the ids and
      // the worker recreates the context here, for every log line the run produces.
      await runWithLogContext(
        {
          runId: claim.runId,
          jobId: claim.jobId,
          actorUserId: claim.actorUserId,
          component: "backtest",
        },
        () => this.processor.process(claim, lease),
      );
    } catch (err) {
      await this.handleExecutionError(claim, err);
    } finally {
      lease.stop();
      this.activeLease = null;
    }
  }

  private async handleExecutionError(
    claim: ClaimedBacktestJob,
    err: unknown,
  ): Promise<void> {
    if (err instanceof BacktestInterruptedError && err.reason === "SHUTDOWN") {
      await this.releaseClaim(claim);
      return;
    }
    if (err instanceof BacktestInterruptedError) {
      // The job was recovered and is executing elsewhere. Writing anything here would corrupt the
      // other worker's run, so this process only records that it stood down.
      this.logger.warn({
        event: "backtest.abandoned",
        runId: claim.runId,
        jobId: claim.jobId,
      });
      return;
    }

    // The processor records its own failures; reaching here means even that could not be written.
    // The lease is left to expire so the job is recovered rather than silently dropped.
    this.logger.error({
      event: "backtest.failed",
      runId: claim.runId,
      jobId: claim.jobId,
      actorUserId: claim.actorUserId,
      err,
    });
  }

  private async releaseClaim(claim: ClaimedBacktestJob): Promise<void> {
    try {
      const released = await this.repository.releaseJob(
        claim.jobId,
        claim.runId,
        this.options.workerId,
        this.now(),
      );
      this.logger.info({
        event: "backtest.job.released",
        runId: claim.runId,
        jobId: claim.jobId,
        released,
      });
    } catch (err) {
      // Not fatal: the lease expires and recovery requeues the job from the outside.
      this.logger.error({
        event: "backtest.job.release.failed",
        runId: claim.runId,
        jobId: claim.jobId,
        err,
      });
    }
  }

  private async claimNextJob(): Promise<ClaimedBacktestJob | null> {
    try {
      return await this.repository.claimNextJob(
        this.options.workerId,
        this.now(),
        this.options.leaseMs,
      );
    } catch (err) {
      this.logger.error({ event: "backtest.claim.failed", err });
      return null;
    }
  }

  /**
   * Reclaims work from workers that stopped reporting.
   *
   * Every worker recovers, so a single crashed process does not need an operator. It runs on the
   * heartbeat cadence rather than on every poll: a lease cannot expire faster than that, and a
   * cluster of idle workers should not spend a query per second per process saying so.
   */
  private async recoverStaleJobs(): Promise<void> {
    const now = this.now().getTime();
    if (now - this.lastRecoveryAt < this.options.heartbeatIntervalMs) {
      return;
    }
    this.lastRecoveryAt = now;

    try {
      const recovery = await this.repository.recoverStaleJobs(
        this.now(),
        this.options.retryBackoffMs,
      );
      if (recovery.requeued > 0 || recovery.abandoned > 0) {
        this.logger.warn({
          event: "backtest.job.recovered",
          requeued: recovery.requeued,
          abandoned: recovery.abandoned,
        });
      }
    } catch (err) {
      this.logger.error({ event: "backtest.job.recovery.failed", err });
    }
  }

  /** Waits for the next poll, or returns immediately once shutdown is requested. */
  private idle(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopping) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.options.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
