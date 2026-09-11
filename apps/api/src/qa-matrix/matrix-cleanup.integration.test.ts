import { randomUUID } from "node:crypto";
import { PrismaClient } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupMatrixRuns,
  countMatrixRuns,
  matrixRunFilter,
} from "./matrix-cleanup";
import { ensureQaMatrixExecutionCalendar } from "./qa-matrix.test-helper";

// Before anything constructs a Prisma client.
useTestDatabase();

/**
 * Retention, against real PostgreSQL.
 *
 * A sweep deletes a thousand rows from an account that also holds a developer's own work, so the
 * question this suite answers is not "does the delete work" but "what can it reach". The predicate
 * requires the QA owner **and** both reserved name prefixes, and every case below is one thing that
 * must survive it.
 */
describe("matrix run retention", () => {
  const suffix = randomUUID().slice(0, 8);
  const prisma = new PrismaClient();

  let qaUserId = "";
  let otherUserId = "";
  let benchmarkId = "";
  let seriesId = "";
  const runIds: string[] = [];

  const runNames = {
    matrix: {
      strategyName: `QA-MATRIX-S04-rsi-nested-buy-ladder`,
      stockListName: `QA-MATRIX-L09-overlapping-windows`,
    },
    ordinary: {
      strategyName: `My momentum strategy ${suffix}`,
      stockListName: `My watchlist ${suffix}`,
    },
    matrixStrategyPersonalList: {
      strategyName: `QA-MATRIX-S04-rsi-nested-buy-ladder`,
      stockListName: `My watchlist ${suffix}`,
    },
    personalStrategyMatrixList: {
      strategyName: `My momentum strategy ${suffix}`,
      stockListName: `QA-MATRIX-L09-overlapping-windows`,
    },
  };

  async function createRun(
    userId: string,
    names: { strategyName: string; stockListName: string },
  ): Promise<string> {
    const run = await prisma.backtestRun.create({
      data: {
        userId,
        benchmarkId,
        benchmarkSeriesId: seriesId,
        executionCalendarSeriesId: seriesId,
        status: "COMPLETED",
        startDate: new Date("2020-01-02T00:00:00.000Z"),
        endDate: new Date("2021-01-04T00:00:00.000Z"),
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 10,
        securityCount: 1,
        snapshot: {},
        snapshotHash: randomUUID(),
        ...names,
      },
      select: { id: true },
    });
    runIds.push(run.id);
    return run.id;
  }

  beforeAll(async () => {
    await prisma.$connect();
    await ensureQaMatrixExecutionCalendar(prisma);
    const benchmark = await prisma.benchmark.findFirst({
      where: { code: "SP500" },
      include: { series: { orderBy: { version: "desc" }, take: 1 } },
    });
    benchmarkId = benchmark?.id ?? "";
    seriesId = benchmark?.series[0]?.id ?? "";
    expect(seriesId).not.toBe("");

    const qaUser = await prisma.user.create({
      data: { email: `matrix-owner-${suffix}@example.test`, role: "USER" },
      select: { id: true },
    });
    const otherUser = await prisma.user.create({
      data: { email: `matrix-other-${suffix}@example.test`, role: "USER" },
      select: { id: true },
    });
    qaUserId = qaUser.id;
    otherUserId = otherUser.id;
  });

  afterAll(async () => {
    await prisma.backtestRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.user.deleteMany({
      where: { id: { in: [qaUserId, otherUserId].filter(Boolean) } },
    });
    await prisma.$disconnect();
  });

  it("deletes the QA account's matrix runs and nothing else", async () => {
    const matrixRun = await createRun(qaUserId, runNames.matrix);
    const ordinaryRun = await createRun(qaUserId, runNames.ordinary);
    const hybridA = await createRun(
      qaUserId,
      runNames.matrixStrategyPersonalList,
    );
    const hybridB = await createRun(
      qaUserId,
      runNames.personalStrategyMatrixList,
    );
    const otherUsersMatrixRun = await createRun(otherUserId, runNames.matrix);

    expect(await countMatrixRuns(prisma, qaUserId)).toBe(1);

    const result = await cleanupMatrixRuns(prisma, qaUserId);
    expect(result.deleted).toBe(1);

    const survivors = await prisma.backtestRun.findMany({
      where: { id: { in: runIds } },
      select: { id: true },
    });
    const surviving = new Set(survivors.map((row) => row.id));
    expect(surviving.has(matrixRun)).toBe(false);
    // An ordinary backtest is never a candidate.
    expect(surviving.has(ordinaryRun)).toBe(true);
    // Both names must be in the namespace, so a developer's own run that used a matrix Strategy
    // against a personal list survives — and so does the reverse.
    expect(surviving.has(hybridA)).toBe(true);
    expect(surviving.has(hybridB)).toBe(true);
    // Another account's identically named run is never selected, let alone deleted.
    expect(surviving.has(otherUsersMatrixRun)).toBe(true);
  });

  it("keeps the runs a caller asks it to keep, so a failed sweep stays inspectable", async () => {
    const keep = await createRun(qaUserId, runNames.matrix);
    const drop = await createRun(qaUserId, runNames.matrix);

    const result = await cleanupMatrixRuns(prisma, qaUserId, [keep]);
    expect(result.deleted).toBe(1);
    expect(
      await prisma.backtestRun.findUnique({
        where: { id: keep },
        select: { id: true },
      }),
    ).not.toBeNull();
    expect(
      await prisma.backtestRun.findUnique({
        where: { id: drop },
        select: { id: true },
      }),
    ).toBeNull();
  });

  it("cascades a deleted run's own results and nothing else", async () => {
    const runId = await createRun(qaUserId, runNames.matrix);
    const keptRunId = await createRun(qaUserId, runNames.ordinary);
    for (const id of [runId, keptRunId]) {
      await prisma.backtestDailyEquity.create({
        data: {
          runId: id,
          date: new Date("2020-01-02T00:00:00.000Z"),
          cash: 1,
          positionsValue: 0,
          totalValue: 1,
          investedCapital: 1,
          returnIndex: 1,
          cashBaselineValue: 1,
          openPositions: 0,
        },
      });
    }

    await cleanupMatrixRuns(prisma, qaUserId);
    expect(await prisma.backtestDailyEquity.count({ where: { runId } })).toBe(
      0,
    );
    expect(
      await prisma.backtestDailyEquity.count({ where: { runId: keptRunId } }),
    ).toBe(1);
  });

  it("is a no-op on an account with no matrix runs", async () => {
    const bystander = await prisma.user.create({
      data: { email: `matrix-bystander-${suffix}@example.test`, role: "USER" },
      select: { id: true },
    });
    try {
      await createRun(bystander.id, runNames.ordinary);
      expect(await cleanupMatrixRuns(prisma, bystander.id)).toEqual({
        deleted: 0,
        retained: 0,
      });
    } finally {
      await prisma.backtestRun.deleteMany({ where: { userId: bystander.id } });
      await prisma.user.delete({ where: { id: bystander.id } });
    }
  });

  it("scopes its predicate by owner and by both reserved prefixes", () => {
    const filter = matrixRunFilter("user-1");
    expect(filter.userId).toBe("user-1");
    expect(filter.strategyName.startsWith).toBe("QA-MATRIX-S");
    expect(filter.stockListName.startsWith).toBe("QA-MATRIX-L");
  });
});
