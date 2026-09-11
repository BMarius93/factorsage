import type { PrismaClient } from "@intrinsic/database";

/**
 * The durable Monitor scan schedule, as the worker sees it.
 *
 * It follows `BacktestJobRepository` deliberately: PostgreSQL is the only coordination mechanism,
 * `SELECT ... FOR UPDATE SKIP LOCKED` is what makes two processes never run one cycle twice, and a
 * renewable lease is what makes a crashed worker self-healing. Redis is not involved, and no queue
 * library is added — `AGENTS.md` invariant 14 and `ai/architecture/api-worker.md` already settled
 * that for durable work, and a scan cycle is durable work.
 *
 * The difference from a backtest job is only where the work comes from. A backtest job is created
 * by a user submission; a scan cycle is periodic, so the row reschedules itself: whoever finishes a
 * cycle sets the next `dueAt`. That keeps cadence an application decision with no cron, no external
 * scheduler and no in-memory timer that a restart would lose.
 */

/** The singleton row's id. One row is what serializes the cycle across processes. */
export const MONITOR_SCAN_SCHEDULE_ID = "GLOBAL";

export type ClaimedMonitorScan = {
  /** Monotonic cycle number this claim consumed. */
  cycleSequence: number;
  claimedAt: Date;
};

export interface MonitorScanRepository {
  /** Creates the singleton row if it does not exist yet. Idempotent and safe to race. */
  ensureSchedule(now: Date): Promise<void>;
  /** Takes the cycle if it is due and unclaimed, or nothing. */
  claimDueScan(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimedMonitorScan | null>;
  /** Renews the lease; false means this worker no longer owns the cycle. */
  heartbeat(workerId: string, now: Date, leaseMs: number): Promise<boolean>;
  /** Records a completed cycle and schedules the next one. */
  completeScan(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
  }): Promise<boolean>;
  /**
   * Hands a claim back without recording an outcome.
   *
   * A worker that claimed in the same tick as a stop signal never ran the cycle, so it must not
   * stamp `lastCompletedAt` or clear the failure history: that would report a success that did not
   * happen and erase the record of one that failed.
   */
  releaseScan(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
  }): Promise<boolean>;
  /** Records a failed cycle and schedules a retry after the backoff. */
  failScan(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
    error: string;
  }): Promise<boolean>;
  /**
   * Returns a cycle whose lease expired to the schedule so another process can take it.
   *
   * A crashed worker leaves a claim behind. Without this the singleton row would stay claimed
   * forever and scanning would stop silently — the one failure mode a singleton has that a queue of
   * independent jobs does not.
   */
  recoverExpiredScan(now: Date): Promise<boolean>;
}

export class PrismaMonitorScanRepository implements MonitorScanRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureSchedule(now: Date): Promise<void> {
    // `ON CONFLICT DO NOTHING` rather than a read-then-write: several workers start at once, and
    // the loser of that race must be a no-op, not an error.
    await this.prisma.$executeRaw`
      INSERT INTO "MonitorScanSchedule" ("id", "dueAt", "updatedAt")
      VALUES (${MONITOR_SCAN_SCHEDULE_ID}, ${now}, ${now})
      ON CONFLICT ("id") DO NOTHING
    `;
  }

  /**
   * Takes the cycle, or nothing.
   *
   * The candidate query is what enforces both rules at once: the cycle is due (`dueAt <= now`) and
   * nobody holds a live lease on it. `FOR UPDATE SKIP LOCKED` means a second worker running this in
   * the same millisecond skips the locked row and idles instead of blocking or duplicating.
   */
  async claimDueScan(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimedMonitorScan | null> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "MonitorScanSchedule"
        WHERE "id" = ${MONITOR_SCAN_SCHEDULE_ID}
          AND "dueAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now})
        FOR UPDATE SKIP LOCKED
      `;
      if (!candidates[0]) {
        return null;
      }

      const claimed = await tx.$queryRaw<{ cycleSequence: number }[]>`
        UPDATE "MonitorScanSchedule"
        SET "claimedBy" = ${workerId},
            "claimedAt" = ${now},
            "heartbeatAt" = ${now},
            "leaseExpiresAt" = ${leaseExpiresAt},
            "lastStartedAt" = ${now},
            "cycleSequence" = "cycleSequence" + 1,
            "updatedAt" = ${now}
        WHERE "id" = ${MONITOR_SCAN_SCHEDULE_ID}
        RETURNING "cycleSequence"
      `;

      const row = claimed[0];
      return row ? { cycleSequence: row.cycleSequence, claimedAt: now } : null;
    });
  }

  async heartbeat(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<boolean> {
    const updated = await this.prisma.monitorScanSchedule.updateMany({
      where: { id: MONITOR_SCAN_SCHEDULE_ID, claimedBy: workerId },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
    });
    return updated.count === 1;
  }

  /**
   * Releases the claim and schedules the next cycle.
   *
   * Ownership-guarded on `claimedBy`, exactly like every write after a backtest claim: a worker
   * whose lease was recovered while it was still running cannot push the next cycle out from under
   * the process that took over.
   */
  async completeScan(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
  }): Promise<boolean> {
    const updated = await this.prisma.monitorScanSchedule.updateMany({
      where: { id: MONITOR_SCAN_SCHEDULE_ID, claimedBy: input.workerId },
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

  /**
   * Clears the claim and nothing else.
   *
   * Ownership-guarded like every other write after a claim. `dueAt` is set so the next process can
   * take the cycle immediately rather than waiting out a lease that nobody is holding.
   */
  async releaseScan(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
  }): Promise<boolean> {
    const released = await this.prisma.monitorScanSchedule.updateMany({
      where: { id: MONITOR_SCAN_SCHEDULE_ID, claimedBy: input.workerId },
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

  async failScan(input: {
    workerId: string;
    now: Date;
    nextDueAt: Date;
    error: string;
  }): Promise<boolean> {
    const updated = await this.prisma.monitorScanSchedule.updateMany({
      where: { id: MONITOR_SCAN_SCHEDULE_ID, claimedBy: input.workerId },
      data: {
        dueAt: input.nextDueAt,
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        consecutiveFailures: { increment: 1 },
        lastError: input.error,
      },
    });
    return updated.count === 1;
  }

  /**
   * Frees a cycle whose holder stopped reporting.
   *
   * `dueAt` is deliberately left alone: the cycle was already due when it was claimed, so it stays
   * due and the next poll picks it up immediately. Only the claim is cleared.
   */
  async recoverExpiredScan(now: Date): Promise<boolean> {
    const recovered = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "MonitorScanSchedule"
      SET "claimedBy" = NULL,
          "claimedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "heartbeatAt" = NULL,
          "lastError" = 'Lease expired before the worker completed the scan cycle',
          "consecutiveFailures" = "consecutiveFailures" + 1,
          "updatedAt" = ${now}
      WHERE "id" = ${MONITOR_SCAN_SCHEDULE_ID}
        AND "claimedBy" IS NOT NULL
        AND "leaseExpiresAt" < ${now}
      RETURNING "id"
    `;
    return recovered.length === 1;
  }
}
