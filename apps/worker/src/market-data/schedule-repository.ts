import type { PrismaClient } from "@intrinsic/database";

/**
 * The durable market-data refresh schedule (`docs/decisions/etf-market-data-v1.md`).
 *
 * The third instance of the claim idiom `BacktestJob` and `MonitorScanSchedule` already use
 * (`AGENTS.md` invariant 15), and it matches them rather than adding a queue, a cron or a Redis
 * lock: one singleton row, `SELECT … FOR UPDATE SKIP LOCKED` so two processes never run one refresh
 * twice, a renewable lease so a crashed child is replaced, and every write after the claim guarded
 * on `claimedBy`. Like the Monitor scan, the work is periodic: whoever finishes a run sets the next
 * `dueAt`, so cadence survives restarts and does not drift with deployments.
 *
 * It is its own row in its own table — not a second row in `MonitorScanSchedule` — because the two
 * schedules are independent by design: a slow or failing refresh must never hold, delay or back off
 * the Monitor cycle.
 */

/** The singleton row's id. One row is what serializes the refresh across processes. */
export const MARKET_DATA_REFRESH_SCHEDULE_ID = "ETF_MARKET_DATA";

/**
 * The stock EOD preparation's own singleton row in the same table
 * (`docs/decisions/monitor-eod-v2-proposal.md` §3.3). A second row, not a second table: the
 * columns and the protocol are identical, and the two claims never contend — each child claims
 * only its own id, so a slow ETF refresh cannot hold the stock preparation, nor the reverse.
 */
export const STOCK_EOD_REFRESH_SCHEDULE_ID = "STOCK_EOD";

export type ClaimedMarketDataRefresh = {
  runSequence: number;
  claimedAt: Date;
  /** The worker whose expired lease this claim took over, when the run was still marked as held. */
  takenOverFrom?: string;
};

export interface MarketDataRefreshScheduleRepository {
  ensureSchedule(now: Date): Promise<void>;
  claimDueRun(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimedMarketDataRefresh | null>;
  heartbeat(workerId: string, now: Date, leaseMs: number): Promise<boolean>;
  completeRun(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
  }): Promise<boolean>;
  /** Hands a claim back without recording an outcome: the run never ran, or did not finish. */
  releaseRun(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
  }): Promise<boolean>;
  /** Records a failed run and schedules the retry, doubling the delay up to `maxBackoffMs`. */
  failRun(input: {
    workerId: string;
    now: Date;
    backoffMs: number;
    maxBackoffMs: number;
    error: string;
  }): Promise<boolean>;
  /** Frees a run whose holder stopped heartbeating, so refreshing never silently stops. */
  recoverExpiredRun(now: Date): Promise<boolean>;
  /** Makes the next run due now — an operator action, never a user-facing control. */
  requestImmediateRun(now: Date): Promise<void>;
}

export class PrismaMarketDataRefreshScheduleRepository implements MarketDataRefreshScheduleRepository {
  constructor(
    private readonly prisma: PrismaClient,
    /** Which singleton row this repository claims. Every statement is scoped to it. */
    private readonly scheduleId: string = MARKET_DATA_REFRESH_SCHEDULE_ID,
  ) {}

  async ensureSchedule(now: Date): Promise<void> {
    // `ON CONFLICT DO NOTHING`: several children start at once, and the loser of that race must be
    // a no-op, not an error.
    await this.prisma.$executeRaw`
      INSERT INTO "MarketDataRefreshSchedule" ("id", "dueAt", "updatedAt")
      VALUES (${this.scheduleId}, ${now}, ${now})
      ON CONFLICT ("id") DO NOTHING
    `;
  }

  async requestImmediateRun(now: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "MarketDataRefreshSchedule"
      SET "dueAt" = LEAST("dueAt", ${now}), "updatedAt" = ${now}
      WHERE "id" = ${this.scheduleId}
    `;
  }

  async claimDueRun(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimedMarketDataRefresh | null> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<
        { id: string; claimedBy: string | null }[]
      >`
        SELECT "id", "claimedBy"
        FROM "MarketDataRefreshSchedule"
        WHERE "id" = ${this.scheduleId}
          AND "dueAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now})
        FOR UPDATE SKIP LOCKED
      `;
      if (!candidates[0]) {
        return null;
      }
      const claimed = await tx.$queryRaw<{ runSequence: number }[]>`
        UPDATE "MarketDataRefreshSchedule"
        SET "claimedBy" = ${workerId},
            "claimedAt" = ${now},
            "heartbeatAt" = ${now},
            "leaseExpiresAt" = ${leaseExpiresAt},
            "lastStartedAt" = ${now},
            "runSequence" = "runSequence" + 1,
            "updatedAt" = ${now}
        WHERE "id" = ${this.scheduleId}
        RETURNING "runSequence"
      `;
      const row = claimed[0];
      if (!row) {
        return null;
      }
      const previousHolder = candidates[0].claimedBy;
      return {
        runSequence: row.runSequence,
        claimedAt: now,
        ...(previousHolder ? { takenOverFrom: previousHolder } : {}),
      };
    });
  }

  async heartbeat(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<boolean> {
    const updated = await this.prisma.marketDataRefreshSchedule.updateMany({
      where: { id: this.scheduleId, claimedBy: workerId },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
    });
    return updated.count === 1;
  }

  async completeRun(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
  }): Promise<boolean> {
    const updated = await this.prisma.marketDataRefreshSchedule.updateMany({
      where: { id: this.scheduleId, claimedBy: input.workerId },
      data: {
        dueAt: input.nextDueAt,
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastCompletedAt: input.now,
        consecutiveFailures: 0,
        lastError: null,
      },
    });
    return updated.count === 1;
  }

  async releaseRun(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
  }): Promise<boolean> {
    const released = await this.prisma.marketDataRefreshSchedule.updateMany({
      where: { id: this.scheduleId, claimedBy: input.workerId },
      data: {
        dueAt: input.nextDueAt,
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      },
    });
    return released.count === 1;
  }

  async failRun(input: {
    workerId: string;
    now: Date;
    backoffMs: number;
    maxBackoffMs: number;
    error: string;
  }): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "MarketDataRefreshSchedule"
      SET "consecutiveFailures" = "consecutiveFailures" + 1,
          "dueAt" = ${input.now} + make_interval(secs =>
            LEAST(
              ${input.backoffMs}::double precision
                * POWER(2, LEAST("consecutiveFailures", 16)),
              ${input.maxBackoffMs}::double precision
            ) / 1000),
          "claimedBy" = NULL,
          "claimedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "heartbeatAt" = NULL,
          "lastError" = ${input.error},
          "updatedAt" = ${input.now}
      WHERE "id" = ${this.scheduleId}
        AND "claimedBy" = ${input.workerId}
    `;
    return updated === 1;
  }

  async recoverExpiredRun(now: Date): Promise<boolean> {
    const recovered = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "MarketDataRefreshSchedule"
      SET "claimedBy" = NULL,
          "claimedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "heartbeatAt" = NULL,
          "lastError" = 'Lease expired before the worker completed the refresh run',
          "consecutiveFailures" = "consecutiveFailures" + 1,
          "updatedAt" = ${now}
      WHERE "id" = ${this.scheduleId}
        AND "claimedBy" IS NOT NULL
        AND "leaseExpiresAt" < ${now}
      RETURNING "id"
    `;
    return recovered.length === 1;
  }
}
