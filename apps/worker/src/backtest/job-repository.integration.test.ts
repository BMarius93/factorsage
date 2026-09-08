import { randomUUID } from "node:crypto";
import {
  BacktestJobStatus,
  BacktestRunStatus,
  type Prisma,
  BenchmarkSourceKind,
  PrismaClient,
} from "@intrinsic/database";
import type { BacktestResult } from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ABANDONED_FAILURE_MESSAGE,
  PrismaBacktestJobRepository,
} from "./job-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

const LEASE_MS = 60_000;

/**
 * Durable claiming against real PostgreSQL.
 *
 * The concurrency guarantees here are the whole reason the queue is a table rather than a library:
 * `FOR UPDATE SKIP LOCKED`, a renewable lease and ownership-guarded writes only mean something
 * when a real transaction manager enforces them, so none of it is faked.
 *
 * Seeded jobs are dated far in the past so they are always the oldest claimable rows, whatever
 * else the shared test database happens to hold.
 */
describe("backtest job claiming", () => {
  const prisma = new PrismaClient();
  const repository = new PrismaBacktestJobRepository(prisma);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const workerA = `worker-a-${suffix}`;
  const workerB = `worker-b-${suffix}`;
  const ancient = new Date("2000-01-01T00:00:00.000Z");
  const runIds: string[] = [];

  let userId = "";
  let benchmarkId = "";
  let benchmarkSeriesId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `worker-${suffix}@example.test` },
    });
    userId = user.id;

    const benchmark = await prisma.benchmark.create({
      data: {
        code: `TEST_${suffix.toUpperCase()}`,
        name: "Worker Suite Benchmark",
        series: {
          create: {
            version: 1,
            sourceKind: BenchmarkSourceKind.FMP_SYMBOL,
            providerSymbol: "SPY",
            currency: "USD",
          },
        },
      },
      include: { series: true },
    });
    benchmarkId = benchmark.id;
    benchmarkSeriesId = benchmark.series[0]?.id ?? "";
  });

  afterAll(async () => {
    // Runs cascade to their job, progress, equity, trades and summary.
    await prisma.backtestRun.deleteMany({ where: { id: { in: runIds } } });
    if (benchmarkId) {
      await prisma.benchmark.delete({ where: { id: benchmarkId } });
    }
    if (userId) {
      await prisma.user.delete({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  async function seedJob(
    options: {
      jobStatus?: BacktestJobStatus;
      runStatus?: BacktestRunStatus;
      attempts?: number;
      maxAttempts?: number;
      claimedBy?: string;
      leaseExpiresAt?: Date;
      progressPercent?: number;
      progressMessage?: string;
      progressSnapshot?: Prisma.InputJsonValue;
    } = {},
  ): Promise<{ runId: string; jobId: string }> {
    const run = await prisma.backtestRun.create({
      data: {
        userId,
        benchmarkId,
        benchmarkSeriesId,
        status: options.runStatus ?? BacktestRunStatus.QUEUED,
        startDate: new Date("2015-01-01T00:00:00.000Z"),
        endDate: new Date("2016-01-01T00:00:00.000Z"),
        initialCapital: 10_000,
        monthlyContribution: 0,
        maximumPositions: 10,
        strategyName: "Worker Suite Strategy",
        stockListName: "Worker Suite List",
        securityCount: 1,
        snapshot: { snapshotVersion: 1, marker: suffix },
        snapshotHash: `hash-${randomUUID()}`,
        progress: {
          create: {
            percent: options.progressPercent ?? 0,
            message: options.progressMessage ?? "Queued",
            sequence: 0,
            ...(options.progressSnapshot
              ? { snapshot: options.progressSnapshot }
              : {}),
          },
        },
        job: {
          create: {
            status: options.jobStatus ?? BacktestJobStatus.QUEUED,
            availableAt: ancient,
            createdAt: ancient,
            attempts: options.attempts ?? 0,
            maxAttempts: options.maxAttempts ?? 3,
            ...(options.claimedBy ? { claimedBy: options.claimedBy } : {}),
            ...(options.leaseExpiresAt
              ? { leaseExpiresAt: options.leaseExpiresAt }
              : {}),
          },
        },
      },
      include: { job: true, progress: true },
    });

    runIds.push(run.id);
    return { runId: run.id, jobId: run.job?.id ?? "" };
  }

  function job(jobId: string) {
    return prisma.backtestJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  function run(runId: string) {
    return prisma.backtestRun.findUniqueOrThrow({ where: { id: runId } });
  }

  function progressOf(runId: string) {
    return prisma.backtestRunProgress.findUniqueOrThrow({ where: { runId } });
  }

  it("gives one queued job to exactly one of two workers claiming at the same instant", async () => {
    const seeded = await seedJob();
    const now = new Date();

    const claims = await Promise.all([
      repository.claimNextJob(workerA, now, LEASE_MS),
      repository.claimNextJob(workerB, now, LEASE_MS),
    ]);

    const claimedIds = claims
      .filter((claim) => claim !== null)
      .map((claim) => claim.jobId);
    // `FOR UPDATE SKIP LOCKED` is what makes this true: the second worker skips the locked row
    // rather than blocking on it or taking it twice.
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.filter((id) => id === seeded.jobId)).toHaveLength(1);

    const claimed = claims.find((claim) => claim?.jobId === seeded.jobId);
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.actorUserId).toBe(userId);
    expect(claimed?.snapshot).toMatchObject({ snapshotVersion: 1 });

    const row = await job(seeded.jobId);
    expect(row.status).toBe(BacktestJobStatus.CLAIMED);
    expect(row.attempts).toBe(1);
    expect([workerA, workerB]).toContain(row.claimedBy);
    expect(row.leaseExpiresAt?.getTime()).toBe(now.getTime() + LEASE_MS);

    const runRow = await run(seeded.runId);
    expect(runRow.status).toBe(BacktestRunStatus.PREPARING_DATA);
    expect(runRow.startedAt).not.toBeNull();
  });

  it("lets two workers claim two queued jobs independently", async () => {
    const first = await seedJob();
    const second = await seedJob();
    const now = new Date();

    const claims = await Promise.all([
      repository.claimNextJob(workerA, now, LEASE_MS),
      repository.claimNextJob(workerB, now, LEASE_MS),
    ]);

    const claimedIds = claims
      .filter((claim) => claim !== null)
      .map((claim) => claim.jobId)
      .sort();
    expect(claimedIds).toEqual([first.jobId, second.jobId].sort());
  });

  it("clears the dead attempt's progress when it requeues a run", async () => {
    const seeded = await seedJob({
      progressPercent: 94,
      progressMessage: "Running backtest — simulated through 2019-06-14",
      progressSnapshot: { simulatedThrough: "2019-06-14", curve: [] },
    });
    const staleClaimedAt = new Date(Date.now() - 120_000);
    await repository.claimNextJob(workerA, staleClaimedAt, 1_000);

    await repository.recoverStaleJobs(new Date(), 0);

    // A queued run advertising 94% and a live curve nothing is producing would be worse than no
    // progress at all, so recovery resets what the dead attempt left behind.
    const reset = await progressOf(seeded.runId);
    expect(reset.percent).toBe(0);
    expect(reset.message).toBe("Queued");
    expect(reset.simulatedThrough).toBeNull();
    expect(reset.snapshot).toBeNull();
    expect(reset.sequence).toBeGreaterThan(0);
  });

  it("fails a job that a graceful shutdown released on its last attempt", async () => {
    // A graceful release deliberately does not refund the attempt, so this job matches neither the
    // claim query nor lease recovery. Without the abandon sweep it would sit QUEUED forever.
    const seeded = await seedJob({ attempts: 3, maxAttempts: 3 });

    const recovery = await repository.recoverStaleJobs(new Date(), 0);
    expect(recovery.abandoned).toBeGreaterThanOrEqual(1);

    expect((await job(seeded.jobId)).status).toBe(BacktestJobStatus.FAILED);
    const failed = await run(seeded.runId);
    expect(failed.status).toBe(BacktestRunStatus.FAILED);
    expect(failed.failureCode).toBe("ABANDONED");
    // And it stays unclaimable: a terminal job is never handed to a worker again.
    const claimed = await repository.claimNextJob(
      workerA,
      new Date(),
      LEASE_MS,
    );
    expect(claimed?.jobId).not.toBe(seeded.jobId);
  });

  it("returns a job whose lease expired to the queue and reclaims it as a new attempt", async () => {
    const seeded = await seedJob();
    // Claimed two minutes ago under a one-second lease: expired, with nothing left to renew it.
    const staleClaimedAt = new Date(Date.now() - 120_000);

    const first = await repository.claimNextJob(workerA, staleClaimedAt, 1_000);
    expect(first?.jobId).toBe(seeded.jobId);

    const recovery = await repository.recoverStaleJobs(new Date(), 0);
    expect(recovery.requeued).toBeGreaterThanOrEqual(1);

    const requeued = await job(seeded.jobId);
    expect(requeued.status).toBe(BacktestJobStatus.QUEUED);
    expect(requeued.claimedBy).toBeNull();
    expect(requeued.leaseExpiresAt).toBeNull();
    expect(requeued.attempts).toBe(1);
    expect((await run(seeded.runId)).status).toBe(BacktestRunStatus.QUEUED);

    const second = await repository.claimNextJob(workerB, new Date(), LEASE_MS);
    expect(second?.jobId).toBe(seeded.jobId);
    expect(second?.attempt).toBe(2);
    expect((await job(seeded.jobId)).claimedBy).toBe(workerB);
  });

  it("fails a job terminally once it has exhausted its attempts", async () => {
    const seeded = await seedJob({ maxAttempts: 1 });
    const staleClaimedAt = new Date(Date.now() - 120_000);

    const claim = await repository.claimNextJob(workerA, staleClaimedAt, 1_000);
    expect(claim?.jobId).toBe(seeded.jobId);

    const recovery = await repository.recoverStaleJobs(new Date(), 15_000);
    expect(recovery.abandoned).toBeGreaterThanOrEqual(1);

    const failed = await job(seeded.jobId);
    expect(failed.status).toBe(BacktestJobStatus.FAILED);

    const runRow = await run(seeded.runId);
    expect(runRow.status).toBe(BacktestRunStatus.FAILED);
    expect(runRow.failureCode).toBe("ABANDONED");
    expect(runRow.failureMessage).toBe(ABANDONED_FAILURE_MESSAGE);
    expect(runRow.completedAt).not.toBeNull();

    // A terminal job is never returned to the queue by a later recovery pass.
    await repository.recoverStaleJobs(new Date(), 15_000);
    expect((await job(seeded.jobId)).status).toBe(BacktestJobStatus.FAILED);
  });

  it("never claims or recovers a job that already reached a terminal state", async () => {
    const seeded = await seedJob({
      jobStatus: BacktestJobStatus.COMPLETED,
      runStatus: BacktestRunStatus.COMPLETED,
      attempts: 1,
      claimedBy: workerA,
      leaseExpiresAt: new Date(Date.now() - 120_000),
    });

    await repository.recoverStaleJobs(new Date(), 0);

    const untouched = await job(seeded.jobId);
    expect(untouched.status).toBe(BacktestJobStatus.COMPLETED);
    expect(untouched.claimedBy).toBe(workerA);
    expect((await run(seeded.runId)).status).toBe(BacktestRunStatus.COMPLETED);

    const claim = await repository.claimNextJob(workerB, new Date(), LEASE_MS);
    expect(claim?.jobId).not.toBe(seeded.jobId);
  });

  it("ignores every write from a worker that no longer holds the claim", async () => {
    const seeded = await seedJob();
    const claim = await repository.claimNextJob(workerA, new Date(), LEASE_MS);
    expect(claim?.jobId).toBe(seeded.jobId);

    expect(
      await repository.heartbeat(seeded.jobId, workerB, new Date(), LEASE_MS),
    ).toBe(false);
    expect(
      await repository.updateProgress({
        jobId: seeded.jobId,
        runId: seeded.runId,
        workerId: workerB,
        now: new Date(),
        leaseMs: LEASE_MS,
        percent: 50,
        message: "Written by the wrong worker",
      }),
    ).toBe(false);
    expect(
      await repository.failJob({
        jobId: seeded.jobId,
        runId: seeded.runId,
        workerId: workerB,
        now: new Date(),
        code: "EXECUTION_FAILED",
        message: "Written by the wrong worker",
        phase: "RUNNING",
        detail: { phase: "RUNNING", name: "Error", message: "nope" },
      }),
    ).toBe(false);

    // Nothing the losing worker attempted reached the run. The progress row exists because
    // submission creates it, so what matters is that it still holds its submitted state.
    const untouchedProgress = await progressOf(seeded.runId);
    expect(untouchedProgress.percent).toBe(0);
    expect(untouchedProgress.message).toBe("Queued");
    expect(untouchedProgress.sequence).toBe(0);
    const untouched = await run(seeded.runId);
    expect(untouched.status).toBe(BacktestRunStatus.PREPARING_DATA);
    expect(untouched.failureCode).toBeNull();

    // The worker that does hold the claim still writes, and can hand it back on shutdown.
    expect(
      await repository.updateProgress({
        jobId: seeded.jobId,
        runId: seeded.runId,
        workerId: workerA,
        now: new Date(),
        leaseMs: LEASE_MS,
        status: BacktestRunStatus.RUNNING,
        percent: 42,
        message: "Running backtest",
        simulatedThrough: "2015-06-30",
      }),
    ).toBe(true);

    const progress = await prisma.backtestRunProgress.findUniqueOrThrow({
      where: { runId: seeded.runId },
    });
    expect(progress.percent).toBe(42);
    expect(progress.sequence).toBe(1);
    expect(progress.simulatedThrough?.toISOString().slice(0, 10)).toBe(
      "2015-06-30",
    );
    expect((await run(seeded.runId)).status).toBe(BacktestRunStatus.RUNNING);

    expect(
      await repository.releaseJob(
        seeded.jobId,
        seeded.runId,
        workerA,
        new Date(),
      ),
    ).toBe(true);
    const released = await job(seeded.jobId);
    expect(released.status).toBe(BacktestJobStatus.QUEUED);
    expect(released.claimedBy).toBeNull();
    expect((await run(seeded.runId)).status).toBe(BacktestRunStatus.QUEUED);
  });

  it("records one milestone per completed year, in the order they finished", async () => {
    const seeded = await seedJob();
    await repository.claimNextJob(workerA, new Date(), LEASE_MS);

    for (const year of ["2015", "2016", "2017"]) {
      expect(
        await repository.updateProgress({
          jobId: seeded.jobId,
          runId: seeded.runId,
          workerId: workerA,
          now: new Date(),
          leaseMs: LEASE_MS,
          status: BacktestRunStatus.RUNNING,
          percent: 30,
          message: `Simulated through ${year}`,
          simulatedThrough: `${year}-12-31`,
          milestone: milestone(year),
        }),
      ).toBe(true);
    }

    const milestones = await prisma.backtestRunMilestone.findMany({
      where: { runId: seeded.runId },
      orderBy: { sequence: "asc" },
    });
    expect(milestones.map((row) => [row.sequence, row.year])).toEqual([
      [1, "2015"],
      [2, "2016"],
      [3, "2017"],
    ]);
    // The trail is what the run went through, so a milestone is written once and never updated.
    expect(
      milestones.map((row) => row.simulatedThrough.toISOString().slice(0, 10)),
    ).toEqual(["2015-12-31", "2016-12-31", "2017-12-31"]);

    // A re-delivered checkpoint is idempotent rather than a constraint error.
    expect(
      await repository.updateProgress({
        jobId: seeded.jobId,
        runId: seeded.runId,
        workerId: workerA,
        now: new Date(),
        leaseMs: LEASE_MS,
        percent: 30,
        message: "Redelivered",
        milestone: milestone("2017"),
      }),
    ).toBe(true);
    expect(
      await prisma.backtestRunMilestone.count({
        where: { runId: seeded.runId },
      }),
    ).toBe(3);
  });

  it("discards a dead attempt's milestones when the run is requeued", async () => {
    const seeded = await seedJob();
    // Claimed two minutes ago under a one-second lease: expired, with nothing left to renew it.
    const first = await repository.claimNextJob(
      workerA,
      new Date(Date.now() - 120_000),
      1_000,
    );
    expect(first?.jobId).toBe(seeded.jobId);
    await prisma.backtestRunMilestone.createMany({
      data: [
        milestoneRow(seeded.runId, 1, "2015"),
        milestoneRow(seeded.runId, 2, "2016"),
      ],
    });

    const recovery = await repository.recoverStaleJobs(new Date(), 0);
    expect(recovery.requeued).toBeGreaterThanOrEqual(1);

    // A retry re-simulates from the first day, so the dead attempt's years would otherwise be
    // replayed alongside the new ones.
    expect(
      await prisma.backtestRunMilestone.count({
        where: { runId: seeded.runId },
      }),
    ).toBe(0);
  });

  it("discards milestones when a graceful shutdown hands the run back", async () => {
    const seeded = await seedJob();
    await repository.claimNextJob(workerA, new Date(), LEASE_MS);
    await prisma.backtestRunMilestone.createMany({
      data: [milestoneRow(seeded.runId, 1, "2015")],
    });

    expect(
      await repository.releaseJob(
        seeded.jobId,
        seeded.runId,
        workerA,
        new Date(),
      ),
    ).toBe(true);
    expect(
      await prisma.backtestRunMilestone.count({
        where: { runId: seeded.runId },
      }),
    ).toBe(0);
  });

  it("completes the run and its job in one write when the result is persisted", async () => {
    const seeded = await seedJob();
    const claim = await repository.claimNextJob(workerA, new Date(), LEASE_MS);
    expect(claim?.jobId).toBe(seeded.jobId);

    const persisted = await repository.persistResult({
      jobId: seeded.jobId,
      runId: seeded.runId,
      workerId: workerA,
      now: new Date(),
      result: emptyResult(),
    });
    expect(persisted).toBe(true);

    const runRow = await run(seeded.runId);
    expect(runRow.status).toBe(BacktestRunStatus.COMPLETED);
    expect(runRow.completedAt).not.toBeNull();
    expect((await job(seeded.jobId)).status).toBe(BacktestJobStatus.COMPLETED);

    const progress = await prisma.backtestRunProgress.findUniqueOrThrow({
      where: { runId: seeded.runId },
    });
    expect(progress.percent).toBe(100);

    const summary = await prisma.backtestRunSummary.findUniqueOrThrow({
      where: { runId: seeded.runId },
    });
    expect(summary.tradingDays).toBe(2);
    expect(Number(summary.finalValue)).toBe(10_500);
    expect(
      await prisma.backtestDailyEquity.count({
        where: { runId: seeded.runId },
      }),
    ).toBe(2);
  });
});

/** A minimal completed run: no trades and no open positions, but a real equity curve. */
function milestone(year: string) {
  return {
    year,
    simulatedThrough: `${year}-12-31`,
    percent: 30,
    completedDays: 252,
    totalDays: 840,
    cash: 1_000,
    totalValue: 11_000,
    investedCapital: 10_000,
    portfolioReturnPercent: 10,
    benchmarkReturnPercent: 8,
    alphaPercent: 2,
    maxDrawdownPercent: 5,
    tradeCount: 4,
    openPositions: 2,
  };
}

function milestoneRow(runId: string, sequence: number, year: string) {
  const written = milestone(year);
  return {
    runId,
    sequence,
    ...written,
    simulatedThrough: new Date(`${written.simulatedThrough}T00:00:00.000Z`),
  };
}

function emptyResult(): BacktestResult {
  return {
    trades: [],
    positions: [],
    equity: [
      {
        date: "2015-01-02",
        cash: 10_000,
        positionsValue: 0,
        totalValue: 10_000,
        investedCapital: 10_000,
        returnIndex: 1,
        benchmarkIndex: 1,
        openPositions: 0,
      },
      {
        date: "2015-01-05",
        cash: 10_500,
        positionsValue: 0,
        totalValue: 10_500,
        investedCapital: 10_000,
        returnIndex: 1.05,
        benchmarkIndex: 1.01,
        openPositions: 0,
      },
    ],
    summary: {
      firstSimulatedDate: "2015-01-02",
      lastSimulatedDate: "2015-01-05",
      tradingDays: 2,
      investedCapital: 10_000,
      finalCash: 10_500,
      finalPositionsValue: 0,
      finalValue: 10_500,
      netProfit: 500,
      portfolioReturnPercent: 5,
      benchmarkReturnPercent: 1,
      alphaPercent: 4,
      portfolioCagrPercent: null,
      maxDrawdownPercent: 0,
      benchmarkMaxDrawdownPercent: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalTrades: 0,
      buyTrades: 0,
      sellTrades: 0,
      finalExitTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      openPositions: 0,
    },
  };
}
