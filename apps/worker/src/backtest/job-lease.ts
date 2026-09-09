import type { StructuredLogger } from "@intrinsic/observability";
import type { BacktestJobRepository } from "./job-repository.js";

/** Why a claimed execution must stop before it finished. */
export type BacktestInterruption = "SHUTDOWN" | "LEASE_LOST";

export class BacktestInterruptedError extends Error {
  constructor(readonly reason: BacktestInterruption) {
    super(
      reason === "SHUTDOWN"
        ? "The worker is shutting down"
        : "The worker no longer holds the job lease",
    );
    this.name = "BacktestInterruptedError";
  }
}

/**
 * The claim a run executes under.
 *
 * A worker may write to a run only while it holds the lease. Losing it is not an error condition
 * to recover from — another worker has already been handed the run — so the only correct response
 * is to stop writing immediately, which is what `interruption()` tells the processor at every
 * checkpoint.
 */
export interface BacktestJobLease {
  readonly jobId: string;
  readonly runId: string;
  interruption(): BacktestInterruption | null;
  /** Records that an ownership-guarded write matched no row, so the claim is gone. */
  markLost(): void;
}

export type RenewableJobLeaseOptions = {
  jobId: string;
  runId: string;
  workerId: string;
  leaseMs: number;
  heartbeatIntervalMs: number;
  now?: () => Date;
};

/**
 * Keeps one claim alive while its run executes.
 *
 * Data preparation can run for minutes without producing a checkpoint, so the lease is renewed on
 * its own timer as well as by every progress write. The timer is unreferenced: it must never be
 * the reason the process stays alive once the loop has finished.
 */
export class RenewableJobLease implements BacktestJobLease {
  readonly jobId: string;
  readonly runId: string;

  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private renewing = false;
  private lost = false;
  private shutdownRequested = false;

  constructor(
    private readonly repository: BacktestJobRepository,
    private readonly logger: StructuredLogger,
    private readonly options: RenewableJobLeaseOptions,
  ) {
    this.jobId = options.jobId;
    this.runId = options.runId;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.renew();
    }, this.options.heartbeatIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  markLost(): void {
    this.lost = true;
  }

  interruption(): BacktestInterruption | null {
    // A lost lease outranks a shutdown: the run belongs to another worker, so releasing it here
    // would hand back a claim this process no longer holds.
    if (this.lost) {
      return "LEASE_LOST";
    }
    return this.shutdownRequested ? "SHUTDOWN" : null;
  }

  private async renew(): Promise<void> {
    if (this.renewing || this.lost) {
      return;
    }
    this.renewing = true;
    try {
      const held = await this.repository.heartbeat(
        this.options.jobId,
        this.options.workerId,
        this.now(),
        this.options.leaseMs,
      );
      if (!held) {
        this.lost = true;
        this.logger.warn({
          event: "backtest.lease.lost",
          runId: this.runId,
          jobId: this.jobId,
        });
      }
    } catch (err) {
      // A transient database error is not proof the claim is gone; the next tick decides, and the
      // lease expires on its own if the database stays unreachable.
      this.logger.warn({
        event: "backtest.lease.renewal.failed",
        runId: this.runId,
        jobId: this.jobId,
        err,
      });
    } finally {
      this.renewing = false;
    }
  }
}
