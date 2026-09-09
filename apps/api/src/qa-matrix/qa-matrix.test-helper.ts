import type { PrismaClient } from "@intrinsic/database";
import { EXECUTION_CALENDAR_REFERENCE_CODE } from "@intrinsic/domain";
import { seedQaBenchmarkData } from "../benchmarks/seed-qa-benchmark-data";
import { loadQaMatrixExecutionCalendar } from "./seed-qa-matrix";

/**
 * Test-suite setup: guarantees the pinned execution-calendar series has bars, then reads them.
 *
 * **Why this exists.** `loadQaMatrixExecutionCalendar` is strict on purpose — the matrix's buy-window
 * boundaries name real execution dates, so seeding against a database with no authoritative calendar
 * would produce fixtures cut against nothing. That strictness is production semantics and stays
 * exactly as it is. What it also means is that a suite exercising the seeder cannot assume a
 * calendar exists: a freshly migrated CI database has migrations and nothing else, and the suite
 * failed there while passing locally purely because a developer's test database had been seeded
 * weeks earlier. A test whose result depends on invisible leftover state is not a test.
 *
 * So the suite provisions its own precondition, through the **canonical** QA benchmark seed —
 * `seedQaBenchmarkData`, the same helper `pnpm test:securities:seed` uses, which registers `SP500`
 * through the real catalog reconciliation and writes deterministic bars with their coverage and
 * freshness watermarks. No second definition of the benchmark, no invented calendar, and no holiday
 * logic anywhere.
 *
 * Idempotent: with bars already present it seeds nothing and simply reads. That matters because the
 * `SP500` row is global state shared with every other suite in the run — this helper only ever adds
 * the precondition, and never deletes or rewrites what is already there.
 */
export async function ensureQaMatrixExecutionCalendar(
  prisma: PrismaClient,
  seed: (client: PrismaClient) => Promise<unknown> = seedQaBenchmarkData,
): Promise<{ dates: string[]; seeded: boolean }> {
  if (await hasExecutionCalendarBars(prisma)) {
    return {
      dates: await loadQaMatrixExecutionCalendar(prisma),
      seeded: false,
    };
  }
  await seed(prisma);
  // Deliberately through the strict loader, so the suite fails loudly here if the seed did not
  // actually produce a calendar rather than somewhere further along with a stranger message.
  return { dates: await loadQaMatrixExecutionCalendar(prisma), seeded: true };
}

/** Whether the pinned execution-calendar series already has bars to read. */
export async function hasExecutionCalendarBars(
  prisma: PrismaClient,
): Promise<boolean> {
  const series = (
    await prisma.benchmark.findFirst({
      where: { code: EXECUTION_CALENDAR_REFERENCE_CODE },
      include: { series: { orderBy: { version: "desc" }, take: 1 } },
    })
  )?.series[0];
  if (!series) {
    return false;
  }
  const bar = await prisma.benchmarkDailyPrice.findFirst({
    where: { seriesId: series.id },
    select: { date: true },
  });
  return bar !== null;
}
