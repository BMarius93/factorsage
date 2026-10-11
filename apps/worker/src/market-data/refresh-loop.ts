import {
  runWithLogContext,
  type StructuredLogger,
} from "@intrinsic/observability";
import type { MarketDataRefreshSummary } from "./refresh-run.js";
import type {
  ClaimedMarketDataRefresh,
  MarketDataRefreshScheduleRepository,
} from "./schedule-repository.js";

/** What the loop runs once per claim. `MarketDataRefreshRun` in production. */
export type MarketDataRefreshWork = {
  run(
    runSequence: number,
    aborted: () => boolean,
  ): Promise<MarketDataRefreshSummary>;
};

export type MarketDataRefreshLoopOptions = {
  /** Stable identity of this process, written as `claimedBy` on every run it claims. */
  workerId: string;
  /** Gap between the end of one run and the earliest start of the next. */
  refreshIntervalMs: number;
  pollIntervalMs: number;
  leaseMs: number;
  heartbeatIntervalMs: number;
  retryBackoffMs: number;
  now?: () => Date;
};

/**
 * The market-data child's claim loop: recover, claim, refresh, reschedule, repeat.
 *
 * The same protocol as `MonitorWorkerLoop`, against its own schedule row, so the two never wait on
 * each other: cadence is a property of the durable row rather than of a timer in this process, the
 * interval is measured from the **end** of a run, a lease lost mid-run stops the run at the next
 * series, and a stop signal hands an unfinished claim straight back.
 */
export class MarketDataRefreshLoop {
  private readonly now: () => Date;
  private stopping = false;
  private wake: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private heartbeatInFlight = false;
  private leaseLost = false;
  private lastRecoveryAt = 0;

  constructor(
    private readonly repository: MarketDataRefreshScheduleRepository,
    private readonly work: MarketDataRefreshWork,
    private readonly logger: StructuredLogger,
    private readonly options: MarketDataRefreshLoopOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async run(): Promise<void> {
    await this.repository.ensureSchedule(this.now());
    while (!this.stopping) {
      await this.recoverExpiredRun();
      const claim = await this.claimDueRun();
      if (!claim || this.stopping) {
        if (claim) {
          await this.releaseUnfinished(claim.runSequence);
        }
        if (this.stopping) {
          break;
        }
        await this.idle();
        continue;
      }
      await this.execute(claim);
    }
  }

  /** Claims and runs at most one due run, then returns. `false`: nothing was due or claimable. */
  async runOnce(): Promise<boolean> {
    await this.repository.ensureSchedule(this.now());
    await this.recoverExpiredRun();
    const claim = await this.claimDueRun();
    if (!claim) {
      return false;
    }
    await this.execute(claim);
    return true;
  }

  stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.wake?.();
  }

  private async execute(claim: ClaimedMarketDataRefresh): Promise<void> {
    const { runSequence, takenOverFrom } = claim;
    this.leaseLost = false;
    this.startHeartbeat();
    const startedAt = Date.now();
    if (takenOverFrom) {
      this.logger.warn({
        event: "market-data.refresh.recovered",
        runSequence,
        takenOverFrom,
      });
    }
    this.logger.info({ event: "market-data.refresh.claimed", runSequence });
    try {
      const summary = await runWithLogContext(
        {
          jobId: `market-data-refresh-${runSequence}`,
          component: "market-data",
        },
        () => this.work.run(runSequence, () => this.leaseLost || this.stopping),
      );
      if (this.leaseLost) {
        this.logger.warn({
          event: "market-data.refresh.abandoned",
          runSequence,
        });
        return;
      }
      if (this.stopping) {
        await this.releaseUnfinished(runSequence);
        return;
      }
      this.logger.info({
        event: "market-data.refresh.completed",
        runSequence,
        durationMs: Date.now() - startedAt,
        providerReads: summary.providerReads,
        failed: summary.failed,
      });
      await this.complete(
        runSequence,
        new Date(this.now().getTime() + this.options.refreshIntervalMs),
      );
    } catch (err) {
      this.logger.error({
        event: "market-data.refresh.failed",
        runSequence,
        durationMs: Date.now() - startedAt,
        err,
      });
      await this.fail(runSequence, err);
    } finally {
      this.stopHeartbeat();
    }
  }

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
            this.logger.warn({ event: "market-data.refresh.lease-lost" });
          }
        })
        .catch((err: unknown) => {
          this.logger.error({
            event: "market-data.refresh.heartbeat.failed",
            err,
          });
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

  private async complete(runSequence: number, nextDueAt: Date): Promise<void> {
    try {
      await this.repository.completeRun({
        workerId: this.options.workerId,
        now: this.now(),
        nextDueAt,
      });
    } catch (err) {
      // Not fatal: the lease expires and recovery frees the run from the outside.
      this.logger.error({
        event: "market-data.refresh.release.failed",
        runSequence,
        err,
      });
    }
  }

  private async releaseUnfinished(runSequence: number): Promise<void> {
    try {
      await this.repository.releaseRun({
        workerId: this.options.workerId,
        now: this.now(),
        nextDueAt: this.now(),
      });
    } catch (err) {
      this.logger.error({
        event: "market-data.refresh.release.failed",
        runSequence,
        err,
      });
    }
  }

  private async fail(runSequence: number, err: unknown): Promise<void> {
    try {
      await this.repository.failRun({
        workerId: this.options.workerId,
        now: this.now(),
        backoffMs: this.options.retryBackoffMs,
        // A persistent outage settles at the normal cadence rather than retrying faster.
        maxBackoffMs: this.options.refreshIntervalMs,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (releaseError) {
      this.logger.error({
        event: "market-data.refresh.release.failed",
        runSequence,
        err: releaseError,
      });
    }
  }

  private async claimDueRun(): Promise<ClaimedMarketDataRefresh | null> {
    try {
      return await this.repository.claimDueRun(
        this.options.workerId,
        this.now(),
        this.options.leaseMs,
      );
    } catch (err) {
      this.logger.error({ event: "market-data.refresh.claim.failed", err });
      return null;
    }
  }

  private async recoverExpiredRun(): Promise<void> {
    const now = this.now().getTime();
    if (now - this.lastRecoveryAt < this.options.heartbeatIntervalMs) {
      return;
    }
    this.lastRecoveryAt = now;
    try {
      if (await this.repository.recoverExpiredRun(this.now())) {
        this.logger.warn({ event: "market-data.refresh.recovered" });
      }
    } catch (err) {
      this.logger.error({ event: "market-data.refresh.recovery.failed", err });
    }
  }

  /** Sleeps until the next poll, or until `stop()` wakes it. Referenced: it keeps the process alive. */
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
