import { randomUUID } from "node:crypto";
import { PrismaClient } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaService } from "../database/prisma.service";
import { readMonitorSynchronization } from "./monitor-synchronization";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * The synchronization state against PostgreSQL (`docs/decisions/monitor-eod-v2.md` §12): what a
 * running Monitor's durable checkpoints say about its rolling 30-day activity window, on a fixed
 * date (Wednesday 2026-10-14, so the window is Sep 15 – Oct 14).
 */
describe("a running Monitor's synchronization", () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const today = "2026-10-14";
  const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
  const securities: string[] = [];
  let monitorId = "";
  let stockListId = "";
  let strategyId = "";

  beforeAll(async () => {
    for (const tag of ["SA", "SB", "SC", "SD", "SE"]) {
      const symbol = `${tag}${suffix.slice(0, 4)}`.toUpperCase();
      const row = await prisma.security.create({
        data: {
          providerSymbol: `${symbol}.${suffix}`,
          symbol,
          name: `${symbol} Sync`,
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securities.push(row.id);
    }
    const [a, b, c, d, e] = securities as [string, string, string, string, string];
    const strategy = await prisma.strategy.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `test-sync-strategy-${suffix}`,
        name: "Sync strategy",
      },
    });
    strategyId = strategy.id;
    const list = await prisma.stockList.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `test-sync-list-${suffix}`,
        name: "Sync list",
        items: {
          create: [
            { securityId: a },
            { securityId: b },
            { securityId: c },
            // A membership that began inside the window: covered from its own start.
            {
              securityId: d,
              buyWindowMode: "CUSTOM",
              buyWindows: { create: [{ startDate: day("2026-10-01") }] },
            },
            // A membership that has ended: not a current member, not counted.
            {
              securityId: e,
              buyWindowMode: "CUSTOM",
              buyWindows: {
                create: [
                  { startDate: day("2026-01-02"), endDate: day("2026-09-30") },
                ],
              },
            },
          ],
        },
      },
    });
    stockListId = list.id;
    const monitor = await prisma.monitor.create({
      data: {
        ownership: "SYSTEM",
        systemKey: `test-sync-monitor-${suffix}`,
        name: "Sync monitor",
        strategyId,
        stockListId,
      },
    });
    monitorId = monitor.id;
    await prisma.monitorEvaluationCheckpoint.createMany({
      data: [
        // Replayed over the window: covered.
        { securityId: a, coverageStart: day("2026-09-15") },
        // Recorded since Oct 6 only (reconstructed at its newest session): history before it is
        // missing and is not invented.
        { securityId: b, coverageStart: day("2026-10-06") },
        // Its membership began Oct 1, and it was replayed from then.
        { securityId: d, coverageStart: day("2026-10-01") },
      ].map((row) => ({
        ...row,
        monitorId,
        evaluatedThrough: day(today),
        configVersion: 0,
        basisGeneration: 0,
        membershipRecorded: true,
      })),
    });
  });

  afterAll(async () => {
    await prisma.monitor.deleteMany({ where: { id: monitorId } });
    await prisma.stockList.deleteMany({ where: { id: stockListId } });
    await prisma.strategy.deleteMany({ where: { id: strategyId } });
    await prisma.security.deleteMany({ where: { id: { in: securities } } });
    await prisma.$disconnect();
  });

  const read = async (subject: {
    watchingSince: Date | null;
    lastScanAt: Date | null;
    configVersion?: number;
  }) =>
    (
      await readMonitorSynchronization(
        prisma as unknown as PrismaService,
        [
          {
            id: monitorId,
            stockListId,
            configVersion: subject.configVersion ?? 0,
            watchingSince: subject.watchingSince,
            lastScanAt: subject.lastScanAt,
          },
        ],
        today,
      )
    ).get(monitorId)!;

  const watched = new Date("2026-10-14T22:00:00.000Z");

  it("is synchronizing until a pass has completed since the Monitor started running", async () => {
    // Just enabled: not picked up by a pass yet.
    expect((await read({ watchingSince: null, lastScanAt: null })).state).toBe(
      "SYNCHRONIZING",
    );
    // Re-enabled: the last scan is from before it started running again.
    expect(
      (
        await read({
          watchingSince: watched,
          lastScanAt: new Date("2026-10-01T22:00:00.000Z"),
        })
      ).state,
    ).toBe("SYNCHRONIZING");
    // Rebound: no scan of the new configuration yet.
    expect(
      (await read({ watchingSince: watched, lastScanAt: null })).state,
    ).toBe("SYNCHRONIZING");
  });

  it("says which current members are covered, awaiting data, or recorded only since a later day", async () => {
    const state = await read({ watchingSince: watched, lastScanAt: watched });
    expect(state).toEqual({
      state: "PARTIAL",
      windowStart: "2026-09-15",
      currentMembers: 4,
      coveredMembers: 2,
      awaitingMembers: 1,
      historyFrom: "2026-10-06",
    });
  });

  it("is synchronized once every current member covers the window", async () => {
    const [, b, c] = securities as [string, string, string];
    await prisma.monitorEvaluationCheckpoint.update({
      where: { monitorId_securityId: { monitorId, securityId: b } },
      data: { coverageStart: day("2026-07-17") },
    });
    await prisma.monitorEvaluationCheckpoint.create({
      data: {
        monitorId,
        securityId: c,
        evaluatedThrough: day("2026-10-13"),
        coverageStart: day("2026-09-15"),
        configVersion: 0,
        basisGeneration: 0,
      },
    });
    expect(await read({ watchingSince: watched, lastScanAt: watched })).toEqual({
      state: "SYNCHRONIZED",
      windowStart: "2026-09-15",
      currentMembers: 4,
      coveredMembers: 4,
      awaitingMembers: 0,
    });
    // Progress recorded under a previous binding is not progress under this one.
    expect(
      (
        await read({
          watchingSince: watched,
          lastScanAt: watched,
          configVersion: 1,
        })
      ).awaitingMembers,
    ).toBe(4);
  });
});
