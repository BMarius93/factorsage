import { randomUUID } from "node:crypto";
import {
  BacktestJobStatus,
  BenchmarkSourceKind,
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
 * The worker-side half of backtest concurrency, against real PostgreSQL.
 *
 * `docs/decisions/entitlements-v1.md` requires concurrency to be enforced on the server/worker
 * side rather than only where a run is submitted, and this is the suite that proves the worker
 * half. It matters because submission is not the only way a job becomes claimable: an expired
 * lease requeues one, a graceful shutdown releases one, and a plan can drop while the owner
 * already has runs queued. Those queued runs are never deleted — the rule is that a downgrade
 * destroys nothing — so something has to decide how many of them may execute at once, and that
 * decision can only be made where the work is claimed.
 *
 * Jobs are dated far in the past so they are always the oldest claimable rows, whatever else the
 * shared test database holds.
 */
describe("backtest claim entitlements", () => {
  const prisma = new PrismaClient();
  const repository = new PrismaBacktestJobRepository(prisma);
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

  async function setPlan(name: string, plan: UserPlan): Promise<void> {
    await prisma.user.update({ where: { id: userIdOf(name) }, data: { plan } });
  }

  /** One queued run and its job, owned by the named fixture user. */
  async function seedQueuedJob(owner: string): Promise<string> {
    const run = await prisma.backtestRun.create({
      data: {
        userId: userIdOf(owner),
        benchmarkId,
        benchmarkSeriesId,
        executionCalendarSeriesId: benchmarkSeriesId,
        status: "QUEUED",
        startDate: new Date("2015-01-01T00:00:00.000Z"),
        endDate: new Date("2016-01-01T00:00:00.000Z"),
        initialCapital: 10_000,
        monthlyContribution: 0,
        maximumPositions: 10,
        strategyName: "Claim Entitlement Strategy",
        stockListName: "Claim Entitlement List",
        securityCount: 1,
        snapshot: { snapshotVersion: 1, marker: suffix },
        snapshotHash: `hash-${randomUUID()}`,
        progress: { create: { percent: 0, message: "Queued", sequence: 0 } },
        job: {
          create: {
            status: BacktestJobStatus.QUEUED,
            availableAt: ancient,
            createdAt: ancient,
            attempts: 0,
            maxAttempts: 3,
          },
        },
      },
      select: { id: true },
    });
    return run.id;
  }

  /** Claims until the queue stops yielding, and reports which runs were taken. */
  async function drain(workerCount: number): Promise<string[]> {
    const claimed: string[] = [];
    for (let index = 0; index < workerCount; index += 1) {
      const claim = await repository.claimNextJob(
        `worker-${index}-${suffix}`,
        new Date(),
        LEASE_MS,
      );
      if (claim) {
        claimed.push(claim.runId);
      }
    }
    return claimed;
  }

  beforeAll(async () => {
    for (const name of ["free", "pro", "other", "admin"]) {
      const user = await prisma.user.create({
        data: {
          email: `claim-${name}-${suffix}@example.test`,
          plan: name === "pro" ? "PRO" : "FREE",
          role: name === "admin" ? "ADMIN" : "USER",
        },
        select: { id: true },
      });
      userIds.set(name, user.id);
    }

    const benchmark = await prisma.benchmark.create({
      data: {
        code: `CLAIM_${suffix.toUpperCase()}`,
        name: "Claim Entitlement Benchmark",
        series: {
          create: {
            version: 1,
            sourceKind: BenchmarkSourceKind.FMP_SYMBOL,
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
    await prisma.$disconnect();
  });

  it("executes one run at a time for a FREE owner, however many are queued", async () => {
    const queued = [
      await seedQueuedJob("free"),
      await seedQueuedJob("free"),
      await seedQueuedJob("free"),
    ];

    const claimed = await drain(3);

    expect(claimed).toHaveLength(1);
    expect(queued).toContain(claimed[0]);
    // The rest are left QUEUED — not failed, not deleted. They execute when a slot frees.
    const remaining = await prisma.backtestJob.findMany({
      where: { run: { userId: userIdOf("free") } },
      select: { status: true },
    });
    expect(remaining.filter((row) => row.status === "QUEUED")).toHaveLength(2);
    expect(remaining.filter((row) => row.status === "CLAIMED")).toHaveLength(1);
  });

  it("executes two at a time for a PRO owner", async () => {
    await seedQueuedJob("pro");
    await seedQueuedJob("pro");
    await seedQueuedJob("pro");

    expect(await drain(3)).toHaveLength(2);
    expect(
      await prisma.backtestJob.count({
        where: {
          run: { userId: userIdOf("pro") },
          status: BacktestJobStatus.CLAIMED,
        },
      }),
    ).toBe(2);
  });

  it("frees the slot as soon as the executing run finishes", async () => {
    await seedQueuedJob("free");
    await seedQueuedJob("free");

    const first = await drain(1);
    expect(first).toHaveLength(1);
    expect(await drain(1)).toHaveLength(0);

    await prisma.backtestJob.updateMany({
      where: { runId: first[0] },
      data: { status: BacktestJobStatus.COMPLETED, leaseExpiresAt: null },
    });

    expect(await drain(1)).toHaveLength(1);
  });

  it("stops a dead worker's expired lease from holding its owner at capacity", async () => {
    await seedQueuedJob("free");
    await seedQueuedJob("free");

    const claimed = await drain(1);
    expect(claimed).toHaveLength(1);
    // A worker that died holding the claim. Its lease lapses and stops counting as executing, so
    // the owner is not stuck until recovery happens to run — the same self-healing property the
    // lease already gives the job itself.
    await prisma.backtestJob.updateMany({
      where: { runId: claimed[0] },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    expect(await drain(1)).toHaveLength(1);
  });

  it("applies the owner's current plan to runs queued under a higher one", async () => {
    // The downgrade case. Two runs were legitimately submitted on PRO; the plan then dropped.
    await setPlan("pro", "PRO");
    const queued = [await seedQueuedJob("pro"), await seedQueuedJob("pro")];
    await setPlan("pro", "FREE");

    const claimed = await drain(2);

    expect(claimed).toHaveLength(1);
    // Neither run was destroyed by the downgrade; one simply waits.
    expect(
      await prisma.backtestRun.count({ where: { id: { in: queued } } }),
    ).toBe(2);
    await setPlan("pro", "PRO");
  });

  it("does not let one owner at capacity block another owner's queue", async () => {
    // Head-of-line blocking would be a real outage: the queue is global FIFO, so a user with a
    // backlog would stall everyone behind them.
    await seedQueuedJob("free");
    await seedQueuedJob("free");
    await seedQueuedJob("free");
    const otherRun = await seedQueuedJob("other");

    const claimed = await drain(4);

    expect(claimed).toContain(otherRun);
    expect(claimed).toHaveLength(2);
  });

  it("does not cap an administrator, whose entitlements are resolved from persisted role", async () => {
    await seedQueuedJob("admin");
    await seedQueuedJob("admin");
    await seedQueuedJob("admin");

    // `ADMIN_ENTITLEMENTS` is explicit and central, not a bypass at this call site: the claim
    // asks the same resolver for every owner and simply gets an unbounded answer for this one.
    expect(await drain(3)).toHaveLength(3);
  });
});
