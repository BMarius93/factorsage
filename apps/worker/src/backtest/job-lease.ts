import type { StructuredLogger } from "@intrinsic/observability";
import type { BacktestJobRepository } from "./job-repository.js";

/** Why a claimed execution must stop before it finished. */
export type BacktestInterruption = "SHUTDOWN" | "LEASE_LOST" | "CANCELLED";

const INTERRUPTION_MESSAGES: Readonly<Record<BacktestInterruption, string>> = {
  SHUTDOWN: "The worker is shutting down",
  LEASE_LOST: "The worker no longer holds the job lease",
  CANCELLED: "The run's owner cancelled it",
};

export class BacktestInterruptedError extends Error {
  constructor(readonly reason: BacktestInterruption) {
    super(INTERRUPTION_MESSAGES[reason]);
    this.name = "BacktestInterruptedError";
  }
}

/**
 * How often a running job looks for its owner's cancellation, independently of the lease renewal.
 * A primary-key read; frequent enough that a cancelled run frees its slot within a few seconds.
 */
export const CANCELLATION_POLL_INTERVAL_MS = 2_000;

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
  /** Defaults to {@link CANCELLATION_POLL_INTERVAL_MS}. */
  cancellationPollIntervalMs?: number;
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
  private cancellationTimer: NodeJS.Timeout | null = null;
  private renewing = false;
  private checkingCancellation = false;
  private lost = false;
  private shutdownRequested = false;
  private cancelRequested = false;

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
    this.cancellationTimer = setInterval(() => {
      void this.checkCancellation();
    }, this.options.cancellationPollIntervalMs ?? CANCELLATION_POLL_INTERVAL_MS);
    this.cancellationTimer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cancellationTimer) {
      clearInterval(this.cancellationTimer);
      this.cancellationTimer = null;
    }
  }

  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  markLost(): void {
    this.lost = true;
  }

  interruption(): BacktestInterruption | null {
    // A lost lease outranks everything: the run belongs to another worker, so neither cancelling
    // nor releasing it here may touch it. A cancellation outranks a shutdown, because handing a run
    // its owner stopped back to the queue would only run it again.
    if (this.lost) {
      return "LEASE_LOST";
    }
    if (this.cancelRequested) {
      return "CANCELLED";
    }
    return this.shutdownRequested ? "SHUTDOWN" : null;
  }

  private async checkCancellation(): Promise<void> {
    if (this.checkingCancellation || this.lost || this.cancelRequested) {
      return;
    }
    this.checkingCancellation = true;
    try {
      if (
        await this.repository.isCancelRequested(
          this.options.jobId,
          this.options.workerId,
        )
      ) {
        this.noteCancellation();
      }
    } catch (err) {
      // Not proof of anything; the next tick, or the next renewal, decides.
      this.logger.debug({
        event: "backtest.cancellation.check.failed",
        runId: this.runId,
        jobId: this.jobId,
        err,
      });
    } finally {
      this.checkingCancellation = false;
    }
  }

  private noteCancellation(): void {
    if (this.cancelRequested) {
      return;
    }
    this.cancelRequested = true;
    this.logger.info({
      event: "backtest.cancellation.requested",
      runId: this.runId,
      jobId: this.jobId,
    });
  }

  private async renew(): Promise<void> {
    if (this.renewing || this.lost) {
      return;
    }
    this.renewing = true;
    try {
      const renewal = await this.repository.heartbeat(
        this.options.jobId,
        this.options.workerId,
        this.now(),
        this.options.leaseMs,
      );
      if (renewal === "LOST") {
        this.lost = true;
        this.logger.warn({
          event: "backtest.lease.lost",
          runId: this.runId,
          jobId: this.jobId,
        });
      } else if (renewal === "CANCEL_REQUESTED") {
        this.noteCancellation();
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
