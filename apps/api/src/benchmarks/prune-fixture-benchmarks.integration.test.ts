import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { BENCHMARK_CATALOG } from "@intrinsic/domain";
import { PrismaBenchmarkDataStore } from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileBenchmarkCatalog } from "./benchmark-catalog.service";
import { pruneOrphanedFixtureBenchmarks } from "./seed-qa-benchmark-data";

loadRootEnv();
useTestDatabase();

/**
 * The canonical QA seed restores a clean benchmark catalog without touching product rows.
 *
 * The rule under test is structural — "not in `BENCHMARK_CATALOG` and referenced by nothing" —
 * so the fixture here is an arbitrary code, not one of the prefixes the old leaks used.
 */
describe("pruneOrphanedFixtureBenchmarks", () => {
  const prisma = new PrismaClient();
  const store = new PrismaBenchmarkDataStore(prisma);
  const orphanCode = `ORPHAN_${randomUUID().slice(0, 8).toUpperCase()}`;

  beforeAll(async () => {
    await reconcileBenchmarkCatalog(prisma);
    await store.reconcileBenchmarkCatalog([
      {
        code: orphanCode,
        name: "Leaked Fixture",
        sourceKind: "FMP_SYMBOL",
        seriesType: "ETF_PROXY",
        providerSymbol: "LEAKED",
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        // Deliberately selectable: this is the shape that polluted `GET /benchmarks`.
        isBacktestSelectable: true,
        displayOrder: 60,
      },
    ]);
  });

  afterAll(async () => {
    await prisma.benchmark.deleteMany({ where: { code: orphanCode } });
    await prisma.$disconnect();
  });

  it("removes an orphaned non-catalog benchmark and keeps every catalog row", async () => {
    const catalogBefore = await prisma.benchmark.findMany({
      where: { code: { in: BENCHMARK_CATALOG.map((entry) => entry.code) } },
      include: { series: true },
      orderBy: { code: "asc" },
    });

    const pruned = await pruneOrphanedFixtureBenchmarks(prisma);

    expect(pruned).toContain(orphanCode);
    expect(await prisma.benchmark.count({ where: { code: orphanCode } })).toBe(
      0,
    );
    // Product rows — the SPY benchmark and the three market references — are untouched, series
    // ids included, so no pinned run and no cached projection is disturbed.
    const catalogAfter = await prisma.benchmark.findMany({
      where: { code: { in: BENCHMARK_CATALOG.map((entry) => entry.code) } },
      include: { series: true },
      orderBy: { code: "asc" },
    });
    expect(catalogAfter).toEqual(catalogBefore);
    expect(pruned).not.toContain("SP500");
  });

  it("leaves exactly the product catalog selectable", async () => {
    await pruneOrphanedFixtureBenchmarks(prisma);

    const selectable = await prisma.benchmark.findMany({
      where: { isActive: true, isBacktestSelectable: true },
      select: { code: true },
    });
    const expected = BENCHMARK_CATALOG.filter(
      (entry) => entry.isActive && entry.isBacktestSelectable,
    ).map((entry) => entry.code);
    // Other suites may run concurrently, but every one of them now registers its fixtures as
    // non-selectable or deletes them in the same test, so the selectable set is the product's.
    expect(selectable.map((row) => row.code).sort()).toEqual(expected.sort());
    expect(expected).toEqual(["SP500"]);
  });

  it("never removes a benchmark a run still references", async () => {
    const referenced = await prisma.benchmark.findMany({
      where: {
        code: { notIn: BENCHMARK_CATALOG.map((entry) => entry.code) },
        backtestRuns: { some: {} },
      },
      select: { code: true },
    });

    const pruned = await pruneOrphanedFixtureBenchmarks(prisma);

    for (const row of referenced) {
      expect(pruned).not.toContain(row.code);
      expect(await prisma.benchmark.count({ where: { code: row.code } })).toBe(
        1,
      );
    }
  });
});
