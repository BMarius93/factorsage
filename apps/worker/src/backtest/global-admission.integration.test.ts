import { randomUUID } from "node:crypto";
import {
  allocateBacktestRunNumber,
  BacktestJobStatus,
  BacktestRunStatus,
  BenchmarkSeriesType,
  BenchmarkSourceKind,
  ENTITLEMENT_LOCK_NAMESPACE,
  PrismaClient,
  type UserPlan,
} from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaBacktestJobRepository } from "./job-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

const LEASE_MS = 60_000;

/**
 * Deployment-wide backtest admission and cancellation, against real PostgreSQL
 * (`ai/architecture/backtest-execution.md`, "Global admission" and "Cancellation").
 *
 * The cap is a property of the deployment, not of a process, so the claims here come from several
 * independent Prisma clients — separate connection pools, as separate worker processes on separate
 * hosts would have — and race each other with `Promise.all`.
 *
 * The test database is shared with every other worker suite, so each test sizes its cap relative
 * to the live claims it finds already present, and every job it creates is dated far in the past
 * so it is the oldest claimable work.
 */
describe("backtest global admission", () => {
  const prisma = new PrismaClient();
  /** Independent pools standing in for independent worker processes. */
  const workers = [new PrismaClient(), new PrismaClient(), new PrismaClient()];
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const ancient = new Date("2000-01-01T00:00:00.000Z");

  const userIds = new Map<string, string>();
  let benchmarkId = "";
  let benchmarkSeriesId = "";

  function userIdOf(name: string): string {
    const found = userIds.get(name);
    if (!found) {
      throw new Error(`Unknown fixture user ${name}`);
    }
    return found;
  }

  async function liveClaimsElsewhere(): Promise<number> {
    return prisma.backtestJob.count({
      where: {
        status: BacktestJobStatus.CLAIMED,
        leaseExpiresAt: { gt: new Date() },
        run: { userId: { notIn: [...userIds.values()] } },
      },
    });
  }

  /** Repositories over the independent pools, all holding the same cap. */
  async function repositoriesWithRoomFor(slots: number) {
    const globalMaxRunning = (await liveClaimsElsewhere()) + slots;
    return workers.map(
      (client) => new PrismaBacktestJobRepository(client, { globalMaxRunning }),
    );
  }

  async function createUser(name: string, plan: UserPlan): Promise<void> {
    const user = await prisma.user.create({
      data: { email: `admission-${name}-${suffix}@example.test`, plan },
      select: { id: true },
    });
    userIds.set(name, user.id);
  }

  /** One queued run and its job, owned by the named fixture user, `offsetMs` after the epoch. */
  async function seedQueuedJob(owner: string, offsetMs = 0): Promise<string> {
    const at = new Date(ancient.getTime() + offsetMs);
    const run = await prisma.backtestRun.create({
      data: {
        userId: userIdOf(owner),
        runNumber: await allocateBacktestRunNumber(prisma, userIdOf(owner)),
        benchmarkId,
        benchmarkSeriesId,
        executionCalendarSeriesId: benchmarkSeriesId,
        status: "QUEUED",
        startDate: new Date("2015-01-01T00:00:00.000Z"),
        endDate: new Date("2016-01-01T00:00:00.000Z"),
        initialCapital: 10_000,
        monthlyContribution: 0,
        maximumPositions: 10,
        strategyName: "Admission Strategy",
        stockListName: "Admission List",
        benchmarkName: "Admission Benchmark",
        securityCount: 1,
        snapshot: { snapshotVersion: 1, marker: suffix },
        snapshotHash: `hash-${randomUUID()}`,
        progress: { create: { percent: 0, message: "Queued", sequence: 0 } },
        job: {
          create: {
            status: BacktestJobStatus.QUEUED,
            availableAt: at,
            createdAt: at,
            attempts: 0,
            maxAttempts: 3,
          },
        },
      },
      select: { id: true },
    });
    return run.id;
  }

  async function jobOf(runId: string) {
    const job = await prisma.backtestJob.findUnique({ where: { runId } });
    if (!job) {
      throw new Error(`No job for run ${runId}`);
    }
    return job;
  }

  beforeAll(async () => {
    for (let index = 0; index < 8; index += 1) {
      await createUser(`free-${index}`, "FREE");
    }
    await createUser("proplus-a", "PRO_PLUS");
    await createUser("other-b", "FREE");
    await createUser("other-c", "FREE");

    const benchmark = await prisma.benchmark.create({
      data: {
        code: `ADMIT_${suffix.toUpperCase()}`,
        name: "Admission Benchmark",
        isBacktestSelectable: false,
        series: {
          create: {
            version: 1,
            sourceKind: BenchmarkSourceKind.FMP_SYMBOL,
            seriesType: BenchmarkSeriesType.ETF_PROXY,
            providerSymbol: "SPY",
            currency: "USD",
            methodologyVersion: 1,
          },
        },
      },
      include: { series: true },
    });
    benchmarkId = benchmark.id;
    benchmarkSeriesId = benchmark.series[0]?.id ?? "";
  });

  afterEach(async () => {
    await prisma.backtestRun.deleteMany({
      where: { userId: { in: [...userIds.values()] } },
    });
  });

  afterAll(async () => {
    await prisma.backtestRun.deleteMany({
      where: { userId: { in: [...userIds.values()] } },
    });
    if (benchmarkId) {
      await prisma.benchmark.delete({ where: { id: benchmarkId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [...userIds.values()] } } });
    await Promise.all([prisma, ...workers].map((client) => client.$disconnect()));
  });

  it("never executes more than the deployment-wide cap, however many workers claim at once", async () => {
    for (let index = 0; index < 8; index += 1) {
      await seedQueuedJob(`free-${index}`, index);
    }
    const repositories = await repositoriesWithRoomFor(4);

    // Twelve claims from three pools in the same instant, four times what the cap allows.
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repositories[index % repositories.length]!.claimNextJob(
          `worker-${index}-${suffix}`,
          new Date(),
          LEASE_MS,
        ),
      ),
    );
    const claimed = claims.filter((claim) => claim !== null);

    expect(claimed).toHaveLength(4);
    expect(new Set(claimed.map((claim) => claim.runId)).size).toBe(4);
    expect(
      await prisma.backtestJob.count({
        where: {
          status: BacktestJobStatus.CLAIMED,
          run: { userId: { in: [...userIds.values()] } },
        },
      }),
    ).toBe(4);
    // The rest wait: still QUEUED, not failed and not deleted.
    expect(
      await prisma.backtestJob.count({
        where: {
          status: BacktestJobStatus.QUEUED,
          run: { userId: { in: [...userIds.values()] } },
        },
      }),
    ).toBe(4);
  });

  it("frees a slot when a worker's lease lapses, without waiting for recovery", async () => {
    await seedQueuedJob("free-0", 0);
    await seedQueuedJob("free-1", 1);
    const [repository] = await repositoriesWithRoomFor(1);

    const first = await repository!.claimNextJob(`w1-${suffix}`, new Date(), LEASE_MS);
    expect(first).not.toBeNull();
    expect(await repository!.claimNextJob(`w2-${suffix}`, new Date(), LEASE_MS)).toBeNull();

    // The worker holding the slot died; its lease lapses and stops counting.
    await prisma.backtestJob.update({
      where: { id: first!.jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await repository!.claimNextJob(`w3-${suffix}`, new Date(), LEASE_MS)).not.toBeNull();
  });

  it("starts every waiting owner's first run before any owner's second", async () => {
    // A Pro+ owner queued two runs first; another owner queued one after them.
    const a1 = await seedQueuedJob("proplus-a", 0);
    const a2 = await seedQueuedJob("proplus-a", 1);
    const b1 = await seedQueuedJob("other-b", 2);
    const [repository] = await repositoriesWithRoomFor(2);

    const first = await repository!.claimNextJob(`w1-${suffix}`, new Date(), LEASE_MS);
    const second = await repository!.claimNextJob(`w2-${suffix}`, new Date(), LEASE_MS);

    expect(first?.runId).toBe(a1);
    // FIFO alone would take a2 next; the fair order takes the owner with nothing running.
    expect(second?.runId).toBe(b1);
    expect((await jobOf(a2)).status).toBe(BacktestJobStatus.QUEUED);
  });

  it("runs both of a Pro+ owner's backtests at once while capacity is free", async () => {
    await seedQueuedJob("proplus-a", 0);
    await seedQueuedJob("proplus-a", 1);
    const [repository] = await repositoriesWithRoomFor(4);

    const first = await repository!.claimNextJob(`w1-${suffix}`, new Date(), LEASE_MS);
    const second = await repository!.claimNextJob(`w2-${suffix}`, new Date(), LEASE_MS);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it("passes over an owner whose entitlement lock is held instead of waiting for it", async () => {
    await seedQueuedJob("other-b", 0);
    const c1 = await seedQueuedJob("other-c", 1);
    const [repository] = await repositoriesWithRoomFor(2);

    // Something — a submission, a billing reconciliation mid-Stripe-call — holds b's lock.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENTITLEMENT_LOCK_NAMESPACE}::int4, hashtext(${userIdOf("other-b")}))`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    try {
      const startedAt = Date.now();
      const claim = await repository!.claimNextJob(`w1-${suffix}`, new Date(), LEASE_MS);
      expect(claim?.runId).toBe(c1);
      // It did not wait for the holder.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      release();
      await holder;
    }
  });

  it("never claims a job whose owner asked to cancel it", async () => {
    const runId = await seedQueuedJob("free-0", 0);
    await prisma.backtestJob.update({
      where: { runId },
      data: { cancelRequestedAt: new Date() },
    });
    const [repository] = await repositoriesWithRoomFor(4);

    expect(await repository!.claimNextJob(`w1-${suffix}`, new Date(), LEASE_MS)).toBeNull();
  });

  it("keeps a cancelled run's slot until the worker acknowledges, then frees it", async () => {
    await seedQueuedJob("free-0", 0);
    const next = await seedQueuedJob("free-1", 1);
    const [repository] = await repositoriesWithRoomFor(1);
    const workerId = `w1-${suffix}`;

    const claim = await repository!.claimNextJob(workerId, new Date(), LEASE_MS);
    expect(claim).not.toBeNull();
    await prisma.backtestJob.update({
      where: { id: claim!.jobId },
      data: { cancelRequestedAt: new Date() },
    });

    // Requested but not yet acknowledged: the job still executes, so it still holds its slot.
    expect(await repository!.claimNextJob(`w2-${suffix}`, new Date(), LEASE_MS)).toBeNull();
    expect(await repository!.heartbeat(claim!.jobId, workerId, new Date(), LEASE_MS)).toBe(
      "CANCEL_REQUESTED",
    );
    expect(await repository!.isCancelRequested(claim!.jobId, workerId)).toBe(true);

    expect(await repository!.cancelJob(claim!.jobId, claim!.runId, workerId, new Date())).toBe(
      true,
    );
    const run = await prisma.backtestRun.findUnique({ where: { id: claim!.runId } });
    expect(run?.status).toBe(BacktestRunStatus.CANCELLED);
    expect(run?.completedAt).not.toBeNull();
    expect((await jobOf(claim!.runId)).status).toBe(BacktestJobStatus.CANCELLED);

    // Acknowledged: the slot is free for the next owner.
    const after = await repository!.claimNextJob(`w3-${suffix}`, new Date(), LEASE_MS);
    expect(after?.runId).toBe(next);
  });

  it("refuses a cancellation write from a worker that no longer holds the claim", async () => {
    await seedQueuedJob("free-0", 0);
    const [repository] = await repositoriesWithRoomFor(1);
    const claim = await repository!.claimNextJob(`w1-${suffix}`, new Date(), LEASE_MS);

    expect(
      await repository!.cancelJob(claim!.jobId, claim!.runId, `someone-else-${suffix}`, new Date()),
    ).toBe(false);
    expect((await jobOf(claim!.runId)).status).toBe(BacktestJobStatus.CLAIMED);
  });

  it("cancels, rather than requeues, a cancelled run whose worker died", async () => {
    await seedQueuedJob("free-0", 0);
    const [repository] = await repositoriesWithRoomFor(1);
    const claim = await repository!.claimNextJob(`w1-${suffix}`, new Date(), LEASE_MS);
    await prisma.backtestJob.update({
      where: { id: claim!.jobId },
      data: {
        cancelRequestedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    const recovery = await repository!.recoverStaleJobs(new Date(), 15_000);

    expect(recovery.cancelled).toBeGreaterThanOrEqual(1);
    expect((await jobOf(claim!.runId)).status).toBe(BacktestJobStatus.CANCELLED);
    expect(
      (await prisma.backtestRun.findUnique({ where: { id: claim!.runId } }))?.status,
    ).toBe(BacktestRunStatus.CANCELLED);
  });

  it("cancels, rather than releases, a cancelled run its worker hands back on shutdown", async () => {
    await seedQueuedJob("free-0", 0);
    const [repository] = await repositoriesWithRoomFor(1);
    const workerId = `w1-${suffix}`;
    const claim = await repository!.claimNextJob(workerId, new Date(), LEASE_MS);
    await prisma.backtestJob.update({
      where: { id: claim!.jobId },
      data: { cancelRequestedAt: new Date() },
    });

    expect(await repository!.releaseJob(claim!.jobId, claim!.runId, workerId, new Date())).toBe(
      true,
    );
    expect((await jobOf(claim!.runId)).status).toBe(BacktestJobStatus.CANCELLED);
  });
});
