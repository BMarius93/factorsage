import type {
  BacktestFailureCode,
  BacktestFailurePhase,
  BacktestLiveSnapshotResponse,
} from "@intrinsic/contracts";
import {
  BacktestJobStatus,
  BacktestRunStatus,
  type Prisma,
  type PrismaClient,
} from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";
import type { BacktestResult } from "@intrinsic/strategy";

/**
 * The durable queue, as the worker sees it.
 *
 * PostgreSQL is the only coordination mechanism here: `SELECT ... FOR UPDATE SKIP LOCKED` is what
 * makes two processes claiming at the same instant take disjoint jobs, and the renewable lease is
 * what makes a crashed worker self-healing. Redis is deliberately not involved — a claim, a
 * progress row and a result must survive a cache flush.
 *
 * Every write after the claim is ownership-guarded on `claimedBy` and `CLAIMED`. A worker that
 * lost its lease (its job was recovered and is executing elsewhere) therefore cannot overwrite the
 * new owner's progress or results: its writes match no row and report `false`.
 */

export type ClaimedBacktestJob = {
  jobId: string;
  runId: string;
  /** Attempt this claim consumed, starting at 1. */
  attempt: number;
  /** The run's owner, recreated as `actorUserId` in the worker's log context. */
  actorUserId: string;
  /** The immutable submission document, still unparsed: the processor validates it. */
  snapshot: unknown;
};

export type StaleJobRecovery = {
  /** Runs whose expired lease returned them to the queue for another attempt. */
  requeued: number;
  /** Runs failed terminally because they had no attempt left. */
  abandoned: number;
};

export type BacktestProgressWrite = {
  jobId: string;
  runId: string;
  workerId: string;
  now: Date;
  leaseMs: number;
  /** Set only when the phase changes; a checkpoint inside a phase leaves the status alone. */
  status?: BacktestRunStatus;
  percent: number;
  message: string;
  simulatedThrough?: LocalDate;
  snapshot?: BacktestLiveSnapshotResponse;
  /**
   * A completed calendar year, written alongside the progress row and never overwritten.
   *
   * The progress snapshot is a replacement, so a browser polling more slowly than the worker
   * simulates would otherwise lose every intermediate state. A V1 run is capped at thirty years,
   * so keeping the whole progression costs at most about thirty small rows.
   */
  milestone?: BacktestMilestoneWrite;
};

export type BacktestMilestoneWrite = {
  year: string;
  simulatedThrough: LocalDate;
  percent: number;
  completedDays: number;
  totalDays: number;
  cash: number;
  totalValue: number;
  investedCapital: number;
  portfolioReturnPercent: number;
  benchmarkReturnPercent: number | null;
  alphaPercent: number | null;
  maxDrawdownPercent: number;
  tradeCount: number;
  openPositions: number;
};

export type BacktestResultWrite = {
  jobId: string;
  runId: string;
  workerId: string;
  now: Date;
  result: BacktestResult;
};

export type BacktestFailureWrite = {
  jobId: string;
  runId: string;
  workerId: string;
  now: Date;
  /** Stable machine-readable code from the contract. */
  code: BacktestFailureCode;
  /** Sanitized product prose. Never carries provider names, URLs, credentials or a stack. */
  message: string;
  /** Product-safe phase label, shown to the user beside the reason. */
  phase: BacktestFailurePhase | null;
  /** Developer diagnostics, never exposed by any API contract. */
  detail: {
    phase: string;
    name: string;
    message: string;
    stack?: string;
  };
};

export interface BacktestJobRepository {
  claimNextJob(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimedBacktestJob | null>;
  heartbeat(
    jobId: string,
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<boolean>;
  recoverStaleJobs(
    now: Date,
    retryBackoffMs: number,
  ): Promise<StaleJobRecovery>;
  updateProgress(write: BacktestProgressWrite): Promise<boolean>;
  persistResult(write: BacktestResultWrite): Promise<boolean>;
  failJob(write: BacktestFailureWrite): Promise<boolean>;
  releaseJob(
    jobId: string,
    runId: string,
    workerId: string,
    now: Date,
  ): Promise<boolean>;
}

/** What a user is told when a worker died holding the run and had no attempt left. */
export const ABANDONED_FAILURE_MESSAGE =
  "The backtest stopped unexpectedly and could not be recovered. Run it again to retry.";

/** PostgreSQL rejects very large parameter counts, so bulk result rows go in chunks. */
const INSERT_CHUNK_SIZE = 1_000;

/**
 * How long the result write may hold its transaction.
 *
 * Prisma's default interactive-transaction timeout is five seconds, which a long run exceeds: a
 * thirty-year backtest writes roughly 7,500 equity rows plus its trades, and measured against this
 * database that pair passes five seconds once the trade count reaches the low thousands. Exceeding
 * it aborts with P2028, rolls the whole result back and leaves the run mid-flight until its lease
 * expires — so the longest runs would be exactly the ones that could never finish. The budget is
 * generous rather than tuned: this transaction runs once per run, and a slow disk must not decide
 * whether a completed simulation is allowed to be recorded.
 */
const RESULT_TRANSACTION_TIMEOUT_MS = 120_000;
/** How long to wait for a connection before starting it; a busy pool must not fail the write. */
const RESULT_TRANSACTION_MAX_WAIT_MS = 30_000;

export class PrismaBacktestJobRepository implements BacktestJobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Takes exactly one queued job, or nothing.
   *
   * `FOR UPDATE SKIP LOCKED` is the whole concurrency design: a second worker running this query
   * in the same millisecond skips the row the first one locked and takes the next job instead of
   * blocking on it or duplicating it. The claim, the attempt increment and the run's move into
   * `PREPARING_DATA` commit together, so a queued run is never observable as claimed-but-idle.
   */
  async claimNextJob(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimedBacktestJob | null> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<
        { id: string; runId: string; attempts: number }[]
      >`
        SELECT "id", "runId", "attempts"
        FROM "BacktestJob"
        WHERE "status" = 'QUEUED'
          AND "availableAt" <= ${now}
          AND "attempts" < "maxAttempts"
        ORDER BY "availableAt" ASC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      const candidate = candidates[0];
      if (!candidate) {
        return null;
      }

      await tx.$executeRaw`
        UPDATE "BacktestJob"
        SET "status" = 'CLAIMED',
            "claimedBy" = ${workerId},
            "claimedAt" = ${now},
            "heartbeatAt" = ${now},
            "leaseExpiresAt" = ${leaseExpiresAt},
            "attempts" = "attempts" + 1,
            "updatedAt" = ${now}
        WHERE "id" = ${candidate.id}
      `;

      // `startedAt` is the first attempt's start: a retry continues one run, it does not begin a
      // new one, and the collection page reports queue latency from the original start.
      const runs = await tx.$queryRaw<{ userId: string; snapshot: unknown }[]>`
        UPDATE "BacktestRun"
        SET "status" = 'PREPARING_DATA',
            "startedAt" = COALESCE("startedAt", ${now}),
            "updatedAt" = ${now}
        WHERE "id" = ${candidate.runId}
        RETURNING "userId", "snapshot"
      `;

      const run = runs[0];
      if (!run) {
        return null;
      }

      return {
        jobId: candidate.id,
        runId: candidate.runId,
        attempt: candidate.attempts + 1,
        actorUserId: run.userId,
        snapshot: run.snapshot,
      };
    });
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<boolean> {
    const updated = await this.prisma.backtestJob.updateMany({
      where: {
        id: jobId,
        claimedBy: workerId,
        status: BacktestJobStatus.CLAIMED,
      },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
    });
    return updated.count === 1;
  }

  /**
   * Returns work abandoned by a dead worker, or fails it when it has no attempt left.
   *
   * Both statements are single self-contained SQL statements so a job and its run always move
   * together, and both lock with `SKIP LOCKED` so several workers may run recovery concurrently
   * without blocking each other. A job whose run already reached a terminal state is left alone:
   * recovery must never reopen a finished run.
   */
  async recoverStaleJobs(
    now: Date,
    retryBackoffMs: number,
  ): Promise<StaleJobRecovery> {
    const availableAt = new Date(now.getTime() + retryBackoffMs);

    const requeued = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH stale AS (
        SELECT j."id", j."runId"
        FROM "BacktestJob" j
        JOIN "BacktestRun" r ON r."id" = j."runId"
        WHERE j."status" = 'CLAIMED'
          AND j."leaseExpiresAt" < ${now}
          AND j."attempts" < j."maxAttempts"
          AND r."status" NOT IN ('COMPLETED', 'FAILED')
        FOR UPDATE OF j SKIP LOCKED
      ),
      released AS (
        UPDATE "BacktestJob" j
        SET "status" = 'QUEUED',
            "availableAt" = ${availableAt},
            "claimedBy" = NULL,
            "claimedAt" = NULL,
            "leaseExpiresAt" = NULL,
            "heartbeatAt" = NULL,
            "lastError" = 'Lease expired before the worker reported progress',
            "updatedAt" = ${now}
        FROM stale
        WHERE j."id" = stale."id"
        RETURNING j."runId"
      ),
      discarded AS (
        -- The dead attempt's milestones go with it. A retry re-simulates from the first day, so
        -- keeping them would append a second copy of every year to the progression.
        DELETE FROM "BacktestRunMilestone" m
        USING released
        WHERE m."runId" = released."runId"
        RETURNING m."runId"
      ),
      cleared AS (
        -- The dead attempt's progress must not survive it: a QUEUED run advertising 94% and a live
        -- curve that no process is producing is worse than no progress at all. This is a sibling
        -- CTE rather than the final statement so the recovery count still reports jobs requeued
        -- even for a run whose progress row is somehow missing.
        UPDATE "BacktestRunProgress" p
        SET "percent" = 0,
            "message" = 'Queued',
            "simulatedThrough" = NULL,
            "snapshot" = NULL,
            "sequence" = p."sequence" + 1,
            "updatedAt" = ${now}
        FROM released
        WHERE p."runId" = released."runId"
        RETURNING p."runId"
      )
      UPDATE "BacktestRun" r
      SET "status" = 'QUEUED',
          "updatedAt" = ${now}
      FROM released
      WHERE r."id" = released."runId"
      RETURNING r."id"
    `;

    const abandoned = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH exhausted AS (
        SELECT j."id", j."runId"
        FROM "BacktestJob" j
        JOIN "BacktestRun" r ON r."id" = j."runId"
        WHERE j."attempts" >= j."maxAttempts"
          AND r."status" NOT IN ('COMPLETED', 'FAILED')
          AND (
            (j."status" = 'CLAIMED' AND j."leaseExpiresAt" < ${now})
            -- A graceful shutdown releases the claim without refunding the attempt, which bounds a
            -- restart loop. Without this arm a job released on its last attempt would match neither
            -- the claim query (attempts < maxAttempts) nor lease recovery (status = CLAIMED), and
            -- would sit QUEUED forever with nothing able to move it.
            OR j."status" = 'QUEUED'
          )
        FOR UPDATE OF j SKIP LOCKED
      ),
      closed AS (
        UPDATE "BacktestJob" j
        SET "status" = 'FAILED',
            "claimedBy" = NULL,
            "leaseExpiresAt" = NULL,
            "lastError" = ${ABANDONED_FAILURE_MESSAGE},
            "updatedAt" = ${now}
        FROM exhausted
        WHERE j."id" = exhausted."id"
        RETURNING j."runId"
      )
      UPDATE "BacktestRun" r
      SET "status" = 'FAILED',
          "failureCode" = 'ABANDONED',
          "failureMessage" = ${ABANDONED_FAILURE_MESSAGE},
          "completedAt" = ${now},
          "updatedAt" = ${now}
      FROM closed
      WHERE r."id" = closed."runId"
      RETURNING r."id"
    `;

    return { requeued: requeued.length, abandoned: abandoned.length };
  }

  /**
   * Publishes one progress checkpoint and renews the lease in the same transaction.
   *
   * They belong together: a checkpoint proves the worker is alive, so paying for two round trips
   * to say the same thing would only widen the window in which a working run looks abandoned.
   * `sequence` increments in the database, which is what lets a poller order snapshots without
   * comparing clocks across processes.
   */
  async updateProgress(write: BacktestProgressWrite): Promise<boolean> {
    const simulatedThrough = write.simulatedThrough
      ? { simulatedThrough: toDate(write.simulatedThrough) }
      : {};
    const snapshot = write.snapshot
      ? { snapshot: jsonDocument(write.snapshot) }
      : {};

    return this.prisma.$transaction(async (tx) => {
      if (!(await claimHeld(tx, write, write.leaseMs))) {
        return false;
      }

      await tx.backtestRunProgress.upsert({
        where: { runId: write.runId },
        create: {
          runId: write.runId,
          percent: write.percent,
          message: write.message,
          sequence: 1,
          ...simulatedThrough,
          ...snapshot,
        },
        update: {
          percent: write.percent,
          message: write.message,
          sequence: { increment: 1 },
          ...simulatedThrough,
          ...snapshot,
        },
      });

      if (write.milestone) {
        // Ordered by completion and never updated. A year is unique per run, so `skipDuplicates`
        // makes a re-delivered checkpoint a no-op rather than a second row for the same year under
        // the next sequence; a retried attempt re-simulates from the first day, and its predecessor's
        // milestones were already discarded when the run was requeued.
        const previous = await tx.backtestRunMilestone.count({
          where: { runId: write.runId },
        });
        await tx.backtestRunMilestone.createMany({
          data: [
            {
              runId: write.runId,
              sequence: previous + 1,
              year: write.milestone.year,
              simulatedThrough: toDate(write.milestone.simulatedThrough),
              percent: write.milestone.percent,
              completedDays: write.milestone.completedDays,
              totalDays: write.milestone.totalDays,
              cash: write.milestone.cash,
              totalValue: write.milestone.totalValue,
              investedCapital: write.milestone.investedCapital,
              portfolioReturnPercent: write.milestone.portfolioReturnPercent,
              benchmarkReturnPercent: write.milestone.benchmarkReturnPercent,
              alphaPercent: write.milestone.alphaPercent,
              maxDrawdownPercent: write.milestone.maxDrawdownPercent,
              tradeCount: write.milestone.tradeCount,
              openPositions: write.milestone.openPositions,
            },
          ],
          skipDuplicates: true,
        });
      }

      if (write.status) {
        await tx.backtestRun.updateMany({
          where: { id: write.runId },
          data: { status: write.status },
        });
      }

      return true;
    });
  }

  /**
   * Writes the complete result and completes the run and its job together.
   *
   * There is deliberately no way to complete a run without its results: a `COMPLETED` run whose
   * summary insert failed separately would be a run the detail page cannot render. The existing
   * rows are cleared first so a retried attempt cannot merge two executions into one result.
   */
  async persistResult(write: BacktestResultWrite): Promise<boolean> {
    const { runId, result } = write;
    const summary = result.summary;

    return this.prisma.$transaction(
      async (tx) => {
        const owned = await tx.backtestJob.updateMany({
          where: {
            id: write.jobId,
            claimedBy: write.workerId,
            status: BacktestJobStatus.CLAIMED,
          },
          data: {
            status: BacktestJobStatus.COMPLETED,
            heartbeatAt: write.now,
            leaseExpiresAt: null,
          },
        });
        if (owned.count !== 1) {
          return false;
        }

        await tx.backtestTrade.deleteMany({ where: { runId } });
        await tx.backtestDailyEquity.deleteMany({ where: { runId } });
        await tx.backtestPosition.deleteMany({ where: { runId } });
        await tx.backtestRunSummary.deleteMany({ where: { runId } });

        await tx.backtestRunSummary.create({
          data: {
            runId,
            firstSimulatedDate: toDate(summary.firstSimulatedDate),
            lastSimulatedDate: toDate(summary.lastSimulatedDate),
            tradingDays: summary.tradingDays,
            investedCapital: summary.investedCapital,
            finalCash: summary.finalCash,
            finalPositionsValue: summary.finalPositionsValue,
            finalValue: summary.finalValue,
            netProfit: summary.netProfit,
            portfolioReturnPercent: summary.portfolioReturnPercent,
            benchmarkReturnPercent: summary.benchmarkReturnPercent,
            alphaPercent: summary.alphaPercent,
            portfolioCagrPercent: summary.portfolioCagrPercent,
            maxDrawdownPercent: summary.maxDrawdownPercent,
            benchmarkMaxDrawdownPercent: summary.benchmarkMaxDrawdownPercent,
            realizedPnl: summary.realizedPnl,
            unrealizedPnl: summary.unrealizedPnl,
            totalTrades: summary.totalTrades,
            buyTrades: summary.buyTrades,
            sellTrades: summary.sellTrades,
            finalExitTrades: summary.finalExitTrades,
            winningTrades: summary.winningTrades,
            losingTrades: summary.losingTrades,
            openPositions: summary.openPositions,
          },
        });

        for (const chunk of chunked(result.equity, INSERT_CHUNK_SIZE)) {
          await tx.backtestDailyEquity.createMany({
            data: chunk.map((point) => ({
              runId,
              date: toDate(point.date),
              cash: point.cash,
              positionsValue: point.positionsValue,
              totalValue: point.totalValue,
              investedCapital: point.investedCapital,
              returnIndex: point.returnIndex,
              benchmarkIndex: point.benchmarkIndex,
              openPositions: point.openPositions,
            })),
          });
        }

        for (const chunk of chunked(result.trades, INSERT_CHUNK_SIZE)) {
          await tx.backtestTrade.createMany({
            data: chunk.map((trade) => ({
              runId,
              sequence: trade.sequence,
              date: toDate(trade.date),
              securityId: trade.securityId,
              symbol: trade.symbol,
              name: trade.name,
              action: trade.action,
              levelId: trade.levelId,
              levelPercentage: trade.levelPercentage,
              shares: trade.shares,
              price: trade.price,
              amount: trade.amount,
              fees: trade.fees,
              realizedPnl: trade.realizedPnl,
              realizedPnlPercent: trade.realizedPnlPercent,
              cashAfter: trade.cashAfter,
              sharesAfter: trade.sharesAfter,
              averageCostAfter: trade.averageCostAfter,
            })),
          });
        }

        if (result.positions.length > 0) {
          await tx.backtestPosition.createMany({
            data: result.positions.map((position) => ({
              runId,
              securityId: position.securityId,
              symbol: position.symbol,
              name: position.name,
              openedDate: toDate(position.openedDate),
              shares: position.shares,
              averageCost: position.averageCost,
              lastPrice: position.lastPrice,
              lastPriceDate: toDate(position.lastPriceDate),
              marketValue: position.marketValue,
              unrealizedPnl: position.unrealizedPnl,
              unrealizedPnlPercent: position.unrealizedPnlPercent,
              allocationPercent: position.allocationPercent,
            })),
          });
        }

        // 100% is reachable only here, so a client never sees a complete-looking run it cannot read.
        await tx.backtestRunProgress.upsert({
          where: { runId },
          create: {
            runId,
            percent: 100,
            message: "Backtest complete",
            simulatedThrough: toDate(summary.lastSimulatedDate),
            sequence: 1,
          },
          update: {
            percent: 100,
            message: "Backtest complete",
            simulatedThrough: toDate(summary.lastSimulatedDate),
            sequence: { increment: 1 },
          },
        });

        await tx.backtestRun.updateMany({
          where: { id: runId },
          data: {
            status: BacktestRunStatus.COMPLETED,
            completedAt: write.now,
            failureCode: null,
            failureMessage: null,
          },
        });

        return true;
      },
      {
        timeout: RESULT_TRANSACTION_TIMEOUT_MS,
        maxWait: RESULT_TRANSACTION_MAX_WAIT_MS,
      },
    );
  }

  /**
   * Fails the run and closes its job terminally.
   *
   * A failure the processor caught is deliberately not retried: it already ran to the point of
   * failure once, and repeating it would repeat the same provider and data conditions three times
   * before telling the user anything. Attempts exist for the case a worker cannot report at all —
   * a crash — which `recoverStaleJobs` handles.
   */
  async failJob(write: BacktestFailureWrite): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.backtestJob.updateMany({
        where: {
          id: write.jobId,
          claimedBy: write.workerId,
          status: BacktestJobStatus.CLAIMED,
        },
        data: {
          status: BacktestJobStatus.FAILED,
          leaseExpiresAt: null,
          lastError: write.message,
        },
      });
      if (owned.count !== 1) {
        return false;
      }

      await tx.backtestRun.updateMany({
        where: { id: write.runId },
        data: {
          status: BacktestRunStatus.FAILED,
          completedAt: write.now,
          failureCode: write.code,
          failureMessage: write.message,
          failurePhase: write.phase,
          failureDetail: jsonDocument(write.detail),
        },
      });

      return true;
    });
  }

  /**
   * Hands a claimed job back to the queue during a graceful shutdown.
   *
   * The attempt this claim consumed is not refunded: a worker that restarts in a crash loop would
   * otherwise re-claim the same run forever, and `maxAttempts` is the only bound that stops it.
   */
  async releaseJob(
    jobId: string,
    runId: string,
    workerId: string,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const released = await tx.backtestJob.updateMany({
        where: {
          id: jobId,
          claimedBy: workerId,
          status: BacktestJobStatus.CLAIMED,
        },
        data: {
          status: BacktestJobStatus.QUEUED,
          availableAt: now,
          claimedBy: null,
          claimedAt: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          lastError: "Released by a worker shutting down",
        },
      });
      if (released.count !== 1) {
        return false;
      }

      await tx.backtestRun.updateMany({
        where: {
          id: runId,
          status: {
            in: [
              BacktestRunStatus.PREPARING_DATA,
              BacktestRunStatus.RUNNING,
              BacktestRunStatus.FINALIZING,
            ],
          },
        },
        data: { status: BacktestRunStatus.QUEUED },
      });

      // The abandoned attempt's progress goes back with it, for the same reason lease recovery
      // clears it: a queued run must not advertise a percentage and a live curve that nothing is
      // producing, and the next attempt re-simulates from the first day anyway. Raw SQL because
      // clearing a Json column through the query builder needs the Prisma namespace as a runtime
      // value, and `@intrinsic/database` deliberately exports it as a type only.
      await tx.backtestRunMilestone.deleteMany({ where: { runId } });
      await tx.$executeRaw`
        UPDATE "BacktestRunProgress"
        SET "percent" = 0,
            "message" = 'Queued',
            "simulatedThrough" = NULL,
            "snapshot" = NULL,
            "sequence" = "sequence" + 1,
            "updatedAt" = ${now}
        WHERE "runId" = ${runId}
      `;

      return true;
    });
  }
}

/** Renews the lease and reports whether this worker still owns the claim. */
async function claimHeld(
  tx: Prisma.TransactionClient,
  write: { jobId: string; workerId: string; now: Date },
  leaseMs: number,
): Promise<boolean> {
  const updated = await tx.backtestJob.updateMany({
    where: {
      id: write.jobId,
      claimedBy: write.workerId,
      status: BacktestJobStatus.CLAIMED,
    },
    data: {
      heartbeatAt: write.now,
      leaseExpiresAt: new Date(write.now.getTime() + leaseMs),
    },
  });
  return updated.count === 1;
}

/** A `YYYY-MM-DD` product date as the UTC midnight PostgreSQL stores in a `date` column. */
function toDate(date: LocalDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * Prisma types its `Json` columns structurally, and a contract type is a JSON document by
 * construction. The cast is confined here so no caller reaches for `any`.
 */
function jsonDocument(value: object): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
