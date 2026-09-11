import {
  runWithLogContext,
  type StructuredLogger,
} from "@intrinsic/observability";
import type { MonitorCycle } from "./monitor-cycle.js";
import type { MonitorScanRepository } from "./scan-repository.js";

export type MonitorWorkerLoopOptions = {
  /** Stable identity of this process, written as `claimedBy` on every cycle it claims. */
  workerId: string;
  /** Gap between the end of one cycle and the earliest start of the next. */
  scanIntervalMs: number;
  pollIntervalMs: number;
  leaseMs: number;
  heartbeatIntervalMs: number;
  retryBackoffMs: number;
  now?: () => Date;
};

/**
 * One monitor worker process's claim loop: recover, claim, scan, reschedule, repeat.
 *
 * Cadence is a property of the durable schedule row, not of a timer in this process. A worker only
 * ever asks "is a cycle due and unclaimed?" and the answer survives a restart, so cadence does not
 * drift with deployments and two processes do not both scan. `ai/product/monitors.md` keeps cadence
 * an application decision, which is why nothing about it is user-facing.
 *
 * The interval is measured from the **end** of a cycle. A cycle that runs longer than the interval
 * delays the next one rather than overlapping with it, which is what keeps a slow universe from
 * queueing cycles behind each other.
 */
export class MonitorWorkerLoop {
  private readonly now: () => Date;
  private stopping = false;
  private wake: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private heartbeatInFlight = false;
  private leaseLost = false;
  private lastRecoveryAt = 0;

  constructor(
    private readonly repository: MonitorScanRepository,
    private readonly cycle: MonitorCycle,
    private readonly logger: StructuredLogger,
    private readonly options: MonitorWorkerLoopOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async run(): Promise<void> {
    await this.repository.ensureSchedule(this.now());

    while (!this.stopping) {
      await this.recoverExpiredScan();

      const claim = await this.claimDueScan();
      if (!claim || this.stopping) {
        if (claim) {
          // Claimed in the same tick as the stop signal, so the cycle never ran. The claim is
          // handed straight back — without recording an outcome, because there was none.
          await this.releaseUnstarted(claim.cycleSequence);
        }
        if (this.stopping) {
          break;
        }
        await this.idle();
        continue;
      }

      await this.executeCycle(claim.cycleSequence);
    }
  }

  /**
   * Stops claiming and asks a cycle in flight to stop at its next Monitor boundary.
   *
   * Stopping mid-cycle is safe precisely because evaluation is idempotent: every transition is
   * decided from durable state and persisted history, so the next cycle re-evaluates whatever this
   * one did not reach and reaches the same conclusions. Running to completion instead would risk
   * outliving the supervisor's kill grace, which is the one way to actually get a half-applied
   * cycle — a SIGKILL in the middle of one.
   */
  stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.wake?.();
  }

  private async executeCycle(cycleSequence: number): Promise<void> {
    this.leaseLost = false;
    this.startHeartbeat();
    const startedAt = Date.now();
    this.logger.info({ event: "monitor.cycle.claimed", cycleSequence });

    try {
      // Correlation does not cross a process boundary on its own; the cycle's own identity is
      // recreated here so every line the scan produces carries it.
      await runWithLogContext(
        { jobId: `monitor-cycle-${cycleSequence}`, component: "monitor" },
        () => this.cycle.run(cycleSequence, () => this.aborted()),
      );
      if (this.leaseLost) {
        // The cycle was recovered while it ran and another process owns it now. Writing a
        // completion here would push that owner's next cycle out from under it; the ownership
        // guard on `completeScan` refuses anyway, and this says why rather than logging a mystery.
        this.logger.warn({ event: "monitor.cycle.abandoned", cycleSequence });
        return;
      }
      if (this.stopping) {
        // Stopped early, so the cycle is incomplete. The claim goes back with no outcome recorded
        // and stays due, so the next process continues rather than waiting out an interval.
        await this.releaseUnstarted(cycleSequence);
        return;
      }
      await this.release(cycleSequence, this.nowPlus(this.options.scanIntervalMs));
    } catch (err) {
      this.logger.error({
        event: "monitor.cycle.failed",
        cycleSequence,
        durationMs: Date.now() - startedAt,
        err,
      });
      await this.failCycle(cycleSequence, err);
    } finally {
      this.stopHeartbeat();
    }
  }

  /** Whether the cycle in flight should stop: it was recovered elsewhere, or this process is stopping. */
  private aborted(): boolean {
    return this.leaseLost || this.stopping;
  }

  /**
   * Renews the lease while a cycle runs.
   *
   * A cycle can legitimately outlive one lease — a large universe, a slow provider — and without a
   * heartbeat another process would recover it mid-scan and both would write transitions.
   *
   * Losing the lease **stops** the cycle rather than only logging it. The optimistic state guard
   * already makes a double Signal impossible, but a recovered cycle keeps evaluating against an
   * older observation and every write it wins is one the new owner has to undo on its next pass.
   *
   * Only one heartbeat is ever in flight: piling them up is exactly the wrong response to a
   * database slow enough to have delayed the previous one.
   */
  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.heartbeatInFlight) {
        return;
      }
      this.heartbeatInFlight = true;
      void this.repository
        .heartbeat(this.options.workerId, this.now(), this.options.leaseMs)
        .then((held) => {
          if (!held) {
            this.leaseLost = true;
            this.logger.warn({ event: "monitor.cycle.lease-lost" });
          }
        })
        .catch((err: unknown) => {
          this.logger.error({ event: "monitor.cycle.heartbeat.failed", err });
        })
        .finally(() => {
          this.heartbeatInFlight = false;
        });
    }, this.options.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private async release(cycleSequence: number, nextDueAt: Date): Promise<void> {
    try {
      const released = await this.repository.completeScan({
        workerId: this.options.workerId,
        now: this.now(),
        nextDueAt,
      });
      this.logger.debug({
        event: "monitor.cycle.released",
        cycleSequence,
        released,
        nextDueAt: nextDueAt.toISOString(),
      });
    } catch (err) {
      // Not fatal: the lease expires and recovery frees the cycle from the outside.
      this.logger.error({
        event: "monitor.cycle.release.failed",
        cycleSequence,
        err,
      });
    }
  }

  /** Hands back a claim whose cycle did not run, or did not finish. Records no outcome. */
  private async releaseUnstarted(cycleSequence: number): Promise<void> {
    try {
      const released = await this.repository.releaseScan({
        workerId: this.options.workerId,
        now: this.now(),
        nextDueAt: this.now(),
      });
      this.logger.debug({
        event: "monitor.cycle.released",
        cycleSequence,
        released,
        completed: false,
      });
    } catch (err) {
      this.logger.error({
        event: "monitor.cycle.release.failed",
        cycleSequence,
        err,
      });
    }
  }

  private async failCycle(cycleSequence: number, err: unknown): Promise<void> {
    try {
      await this.repository.failScan({
        workerId: this.options.workerId,
        now: this.now(),
        nextDueAt: this.nowPlus(this.options.retryBackoffMs),
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (releaseError) {
      this.logger.error({
        event: "monitor.cycle.release.failed",
        cycleSequence,
        err: releaseError,
      });
    }
  }

  private async claimDueScan(): Promise<{ cycleSequence: number } | null> {
    try {
      return await this.repository.claimDueScan(
        this.options.workerId,
        this.now(),
        this.options.leaseMs,
      );
    } catch (err) {
      this.logger.error({ event: "monitor.cycle.claim.failed", err });
      return null;
    }
  }

  /**
   * Frees a cycle whose holder stopped reporting.
   *
   * The singleton schedule has a failure mode a queue of independent jobs does not: a crashed
   * holder would leave it claimed forever and scanning would stop silently. Every worker recovers,
   * on the heartbeat cadence rather than every poll — a lease cannot expire faster than that.
   */
  private async recoverExpiredScan(): Promise<void> {
    const now = this.now().getTime();
    if (now - this.lastRecoveryAt < this.options.heartbeatIntervalMs) {
      return;
    }
    this.lastRecoveryAt = now;

    try {
      if (await this.repository.recoverExpiredScan(this.now())) {
        this.logger.warn({ event: "monitor.cycle.recovered" });
      }
    } catch (err) {
      this.logger.error({ event: "monitor.cycle.recovery.failed", err });
    }
  }

  private nowPlus(milliseconds: number): Date {
    return new Date(this.now().getTime() + milliseconds);
  }

  /**
   * Sleeps until the next poll, or until `stop()` wakes it.
   *
   * The timer is deliberately **referenced**. It is the only thing holding the event loop open
   * between cycles — a claim is a database row, not an open handle — so unreferencing it lets Node
   * decide the program is finished and exit mid-wait, which a supervisor then sees as a crash and
   * restarts forever. The lease heartbeat is unreferenced for the opposite reason: it must never be
   * what keeps a process alive.
   */
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
