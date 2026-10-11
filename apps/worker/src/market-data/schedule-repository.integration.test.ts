import { PrismaClient } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MONITOR_SCAN_SCHEDULE_ID } from "../monitor/scan-repository.js";
import {
  MARKET_DATA_REFRESH_SCHEDULE_ID,
  PrismaMarketDataRefreshScheduleRepository,
} from "./schedule-repository.js";

useTestDatabase();

/**
 * The market-data refresh schedule against real PostgreSQL: the same claim protocol as the Monitor
 * scan, on a row of its own. A singleton row shared by these tests, reset by each.
 */
const prisma = new PrismaClient();
const repository = new PrismaMarketDataRefreshScheduleRepository(prisma);
const LEASE_MS = 60_000;
const now = new Date("2026-10-09T22:00:00.000Z");

async function reset(dueAt: Date): Promise<void> {
  await repository.ensureSchedule(dueAt);
  await prisma.marketDataRefreshSchedule.update({
    where: { id: MARKET_DATA_REFRESH_SCHEDULE_ID },
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

async function row() {
  return prisma.marketDataRefreshSchedule.findUniqueOrThrow({
    where: { id: MARKET_DATA_REFRESH_SCHEDULE_ID },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("market-data refresh schedule", () => {
  beforeEach(async () => {
    await reset(now);
  });

  it("creates the singleton row idempotently, however many children race to", async () => {
    await Promise.all([
      repository.ensureSchedule(now),
      repository.ensureSchedule(now),
      repository.ensureSchedule(now),
    ]);
    expect(
      await prisma.marketDataRefreshSchedule.count({
        where: { id: MARKET_DATA_REFRESH_SCHEDULE_ID },
      }),
    ).toBe(1);
  });

  it("gives a due run to exactly one of two concurrent claimants", async () => {
    const [first, second] = await Promise.all([
      repository.claimDueRun("worker-a", now, LEASE_MS),
      repository.claimDueRun("worker-b", now, LEASE_MS),
    ]);
    const claimed = [first, second].filter((claim) => claim !== null);
    expect(claimed).toHaveLength(1);
  });

  it("does not hand out a run that is not due, or one whose lease is live", async () => {
    await reset(new Date(now.getTime() + 60_000));
    await expect(
      repository.claimDueRun("worker-a", now, LEASE_MS),
    ).resolves.toBeNull();

    await reset(now);
    await repository.claimDueRun("worker-a", now, LEASE_MS);
    await expect(
      repository.claimDueRun("worker-b", now, LEASE_MS),
    ).resolves.toBeNull();
  });

  it("guards every write after the claim on its owner", async () => {
    await repository.claimDueRun("worker-a", now, LEASE_MS);
    await expect(repository.heartbeat("worker-b", now, LEASE_MS)).resolves.toBe(
      false,
    );
    await expect(
      repository.completeRun({ workerId: "worker-b", now, nextDueAt: now }),
    ).resolves.toBe(false);
    await expect(
      repository.completeRun({
        workerId: "worker-a",
        now,
        nextDueAt: new Date(now.getTime() + 600_000),
      }),
    ).resolves.toBe(true);
    const completed = await row();
    expect(completed.claimedBy).toBeNull();
    expect(completed.lastCompletedAt).toEqual(now);
    expect(completed.dueAt).toEqual(new Date(now.getTime() + 600_000));
  });

  it("backs off a failed run, doubling up to the ceiling", async () => {
    for (const expectedSeconds of [5, 10, 20, 20]) {
      await prisma.marketDataRefreshSchedule.update({
        where: { id: MARKET_DATA_REFRESH_SCHEDULE_ID },
        data: { dueAt: now },
      });
      await repository.claimDueRun("worker-a", now, LEASE_MS);
      await repository.failRun({
        workerId: "worker-a",
        now,
        backoffMs: 5_000,
        maxBackoffMs: 20_000,
        error: "provider unavailable",
      });
      const failed = await row();
      expect((failed.dueAt.getTime() - now.getTime()) / 1000).toBe(
        expectedSeconds,
      );
      expect(failed.lastError).toBe("provider unavailable");
    }
  });

  it("recovers a run whose holder stopped heartbeating", async () => {
    await repository.claimDueRun("worker-a", now, LEASE_MS);
    const later = new Date(now.getTime() + LEASE_MS + 1);
    await expect(repository.recoverExpiredRun(later)).resolves.toBe(true);
    const recovered = await repository.claimDueRun("worker-b", later, LEASE_MS);
    expect(recovered?.runSequence).toBeGreaterThan(0);
  });

  it("never touches the Monitor scan schedule, so a refresh can never delay a Monitor cycle", async () => {
    const monitorBefore = await prisma.monitorScanSchedule.findUnique({
      where: { id: MONITOR_SCAN_SCHEDULE_ID },
    });
    await repository.claimDueRun("worker-a", now, LEASE_MS);
    await repository.failRun({
      workerId: "worker-a",
      now,
      backoffMs: 5_000,
      maxBackoffMs: 20_000,
      error: "refresh failed",
    });
    await repository.requestImmediateRun(now);
    const monitorAfter = await prisma.monitorScanSchedule.findUnique({
      where: { id: MONITOR_SCAN_SCHEDULE_ID },
    });
    expect(monitorAfter).toEqual(monitorBefore);
  });
});
