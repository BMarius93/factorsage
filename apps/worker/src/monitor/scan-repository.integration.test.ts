import { PrismaClient } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@intrinsic/observability";
import type { MonitorCycle } from "./monitor-cycle.js";
import { MonitorWorkerLoop } from "./monitor-loop.js";
import {
  MONITOR_SCAN_SCHEDULE_ID,
  PrismaMonitorScanRepository,
} from "./scan-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * The durable scan schedule against real PostgreSQL.
 *
 * The concurrency guarantees here are the whole reason cadence is a table rather than a timer:
 * `FOR UPDATE SKIP LOCKED`, a renewable lease and ownership-guarded writes only mean something when
 * a real transaction manager enforces them, so none of it is faked.
 *
 * The schedule is a singleton row, so these tests share it and each one sets it to the state it
 * needs — which is also how the production row behaves across deployments.
 */

const prisma = new PrismaClient();
const repository = new PrismaMonitorScanRepository(prisma);
const LEASE_MS = 60_000;
const workerA = "monitor-worker-a";
const workerB = "monitor-worker-b";

/** Puts the singleton row into a known state, since every test shares it. */
async function resetSchedule(dueAt: Date): Promise<void> {
  await repository.ensureSchedule(dueAt);
  await prisma.monitorScanSchedule.update({
    where: { id: MONITOR_SCAN_SCHEDULE_ID },
    data: {
      dueAt,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastCompletedAt: null,
      consecutiveFailures: 0,
      lastError: null,
    },
  });
}

async function readSchedule() {
  return prisma.monitorScanSchedule.findUniqueOrThrow({
    where: { id: MONITOR_SCAN_SCHEDULE_ID },
  });
}

const now = new Date("2026-03-02T12:00:00.000Z");

afterAll(async () => {
  await prisma.$disconnect();
});

describe("monitor scan schedule", () => {
  beforeEach(async () => {
    await resetSchedule(new Date(now.getTime() - 1_000));
  });

  it("creates the singleton row idempotently", async () => {
    await repository.ensureSchedule(now);
    await repository.ensureSchedule(now);
    expect(await prisma.monitorScanSchedule.count()).toBe(1);
  });

  it("lets exactly one of two workers claim the same due cycle", async () => {
    const [first, second] = await Promise.all([
      repository.claimDueScan(workerA, now, LEASE_MS),
      repository.claimDueScan(workerB, now, LEASE_MS),
    ]);

    const claims = [first, second].filter(Boolean);
    expect(claims).toHaveLength(1);

    const row = await readSchedule();
    expect([workerA, workerB]).toContain(row.claimedBy);
    expect(row.leaseExpiresAt).not.toBeNull();
  });

  it("does not claim a cycle that is not due yet", async () => {
    await resetSchedule(new Date(now.getTime() + 60_000));
    expect(await repository.claimDueScan(workerA, now, LEASE_MS)).toBeNull();
  });

  it("does not claim a cycle another worker still holds a live lease on", async () => {
    expect(await repository.claimDueScan(workerA, now, LEASE_MS)).not.toBeNull();
    expect(await repository.claimDueScan(workerB, now, LEASE_MS)).toBeNull();
  });

  it("advances the cycle sequence on every claim", async () => {
    const first = await repository.claimDueScan(workerA, now, LEASE_MS);
    await repository.completeScan({
      workerId: workerA,
      now,
      nextDueAt: new Date(now.getTime() - 1),
    });
    const second = await repository.claimDueScan(workerA, now, LEASE_MS);

    expect(second!.cycleSequence).toBe(first!.cycleSequence + 1);
  });

  it("schedules the next cycle when one completes", async () => {
    await repository.claimDueScan(workerA, now, LEASE_MS);
    const nextDueAt = new Date(now.getTime() + 300_000);

    expect(
      await repository.completeScan({ workerId: workerA, now, nextDueAt }),
    ).toBe(true);

    const row = await readSchedule();
    expect(row.claimedBy).toBeNull();
    expect(row.dueAt.toISOString()).toBe(nextDueAt.toISOString());
    expect(row.lastCompletedAt?.toISOString()).toBe(now.toISOString());
    expect(row.consecutiveFailures).toBe(0);
    // Released, and not claimable again until it is due.
    expect(await repository.claimDueScan(workerB, now, LEASE_MS)).toBeNull();
  });

  it("hands back an unstarted claim without recording a completion", async () => {
    await prisma.monitorScanSchedule.update({
      where: { id: MONITOR_SCAN_SCHEDULE_ID },
      data: { consecutiveFailures: 3, lastError: "earlier failure" },
    });
    await repository.claimDueScan(workerA, now, LEASE_MS);

    const nextDueAt = new Date(now.getTime() + 1_000);
    expect(
      await repository.releaseScan({ workerId: workerA, now, nextDueAt }),
    ).toBe(true);

    const row = await readSchedule();
    expect(row.claimedBy).toBeNull();
    expect(row.dueAt.toISOString()).toBe(nextDueAt.toISOString());
    // A cycle that never ran reported no outcome: claiming success here would erase the record of
    // the failures that came before it.
    expect(row.lastCompletedAt).toBeNull();
    expect(row.consecutiveFailures).toBe(3);
    expect(row.lastError).toBe("earlier failure");
  });

  it("refuses an unstarted release from a worker that does not hold the claim", async () => {
    await repository.claimDueScan(workerA, now, LEASE_MS);
    expect(
      await repository.releaseScan({
        workerId: workerB,
        now,
        nextDueAt: new Date(now.getTime() + 1_000),
      }),
    ).toBe(false);
    expect((await readSchedule()).claimedBy).toBe(workerA);
  });

  it("refuses a release from a worker that does not hold the claim", async () => {
    await repository.claimDueScan(workerA, now, LEASE_MS);

    // Ownership guard: a worker whose lease was recovered cannot push the next cycle out from
    // under the process that took over.
    expect(
      await repository.completeScan({
        workerId: workerB,
        now,
        nextDueAt: new Date(now.getTime() + 300_000),
      }),
    ).toBe(false);
    expect((await readSchedule()).claimedBy).toBe(workerA);
  });

  it("records a failure and backs the next cycle off", async () => {
    await repository.claimDueScan(workerA, now, LEASE_MS);

    expect(
      await repository.failScan({
        workerId: workerA,
        now,
        backoffMs: 60_000,
        maxBackoffMs: 300_000,
        error: "provider unavailable",
      }),
    ).toBe(true);

    const row = await readSchedule();
    expect(row.claimedBy).toBeNull();
    expect(row.consecutiveFailures).toBe(1);
    expect(row.lastError).toBe("provider unavailable");
    // First failure waits the base backoff, so a transient blip is retried promptly.
    expect(row.dueAt.getTime()).toBe(now.getTime() + 60_000);
  });

  it("doubles the retry delay as failures repeat, up to the ceiling", async () => {
    // A persistent provider outage must not re-issue the whole universe's quote request on the
    // short retry interval forever — that is more often than a healthy cycle would run at all.
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await repository.claimDueScan(workerA, now, LEASE_MS);
      await repository.failScan({
        workerId: workerA,
        now,
        backoffMs: 60_000,
        maxBackoffMs: 300_000,
        error: "provider unavailable",
      });
      const row = await readSchedule();
      delays.push(row.dueAt.getTime() - now.getTime());
      // Make it claimable again for the next attempt without touching the failure counter.
      await prisma.monitorScanSchedule.update({
        where: { id: MONITOR_SCAN_SCHEDULE_ID },
        data: { dueAt: new Date(now.getTime() - 1_000) },
      });
    }

    expect(delays).toEqual([60_000, 120_000, 240_000, 300_000]);
    expect((await readSchedule()).consecutiveFailures).toBe(4);
  });

  it("renews a lease only for the worker holding the claim", async () => {
    await repository.claimDueScan(workerA, now, LEASE_MS);

    const later = new Date(now.getTime() + 30_000);
    expect(await repository.heartbeat(workerA, later, LEASE_MS)).toBe(true);
    expect(await repository.heartbeat(workerB, later, LEASE_MS)).toBe(false);

    const row = await readSchedule();
    expect(row.leaseExpiresAt?.toISOString()).toBe(
      new Date(later.getTime() + LEASE_MS).toISOString(),
    );
  });

  it("recovers a cycle whose holder stopped reporting", async () => {
    await repository.claimDueScan(workerA, now, LEASE_MS);
    const afterLease = new Date(now.getTime() + LEASE_MS + 1_000);

    // Without recovery the singleton row would stay claimed forever and scanning would stop
    // silently — the one failure mode a singleton has that a queue of independent jobs does not.
    expect(await repository.recoverExpiredScan(afterLease)).toBe(true);

    const row = await readSchedule();
    expect(row.claimedBy).toBeNull();
    expect(row.consecutiveFailures).toBe(1);
    // Still due, so the next poll picks it up immediately rather than waiting a whole interval.
    expect(await repository.claimDueScan(workerB, afterLease, LEASE_MS)).not.toBeNull();
  });

  it("does not recover a cycle whose lease is still live", async () => {
    await repository.claimDueScan(workerA, now, LEASE_MS);
    expect(
      await repository.recoverExpiredScan(new Date(now.getTime() + 1_000)),
    ).toBe(false);
    expect((await readSchedule()).claimedBy).toBe(workerA);
  });

  it("does not recover an unclaimed schedule", async () => {
    expect(await repository.recoverExpiredScan(now)).toBe(false);
  });

  /**
   * A cycle that throws — a failed current-data read is the case that matters — must take the
   * failure and retry path, not be recorded as a scan that happened.
   *
   * The loop is driven for exactly one iteration: the cycle stops it, then throws.
   */
  it("records a thrown cycle as a failure and backs the next one off", async () => {
    await resetSchedule(new Date(Date.now() - 1_000));

    const failing = {
      run: async () => {
        loop.stop();
        throw new Error("provider unavailable");
      },
    } as unknown as MonitorCycle;

    const loop = new MonitorWorkerLoop(
      repository,
      failing,
      createLogger({ service: "worker", level: "silent" }),
      {
        workerId: "monitor-loop-test",
        scanIntervalMs: 300_000,
        pollIntervalMs: 10,
        leaseMs: LEASE_MS,
        heartbeatIntervalMs: 60_000,
        retryBackoffMs: 60_000,
      },
    );

    const before = Date.now();
    await loop.run();
    const row = await readSchedule();

    // Failed, not completed: the claim is released, the failure is recorded and counted, and the
    // next cycle waits out the retry backoff instead of the normal interval.
    expect(row.claimedBy).toBeNull();
    expect(row.consecutiveFailures).toBe(1);
    expect(row.lastError).toBe("provider unavailable");
    expect(row.lastCompletedAt).toBeNull();
    expect(row.dueAt.getTime()).toBeGreaterThan(before);
    expect(row.dueAt.getTime()).toBeLessThanOrEqual(before + 60_000 + 5_000);
  });
});
