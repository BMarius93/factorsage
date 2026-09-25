import type { PrismaClient } from "@intrinsic/database";
import { QA_MATRIX_NAME_PREFIX } from "@intrinsic/testing";

/**
 * Retention for matrix runs.
 *
 * Strategies and Stock Lists are persistent fixtures; their runs must not be. A thousand runs per
 * sweep would otherwise accumulate forever in the QA account, each carrying its own trades, equity
 * curve, positions and summary — a thirty-year run alone writes some 7,500 equity rows.
 *
 * The predicate is deliberately narrow, and both halves matter:
 *
 * - **owner** — every statement is scoped to the ids of the **test personas**, so another account's
 *   data is not merely spared, it is never selected;
 * - **namespace** — the run's own denormalized `strategyName` *and* `stockListName` must both be in
 *   the reserved `QA-MATRIX-` namespace.
 *
 * The owner half is a *set* rather than the single account that currently owns the fixtures, and
 * that is a correction rather than a widening. The matrix fixtures moved from `QA_USER` to
 * `ADMIN_USER` when the runner began submitting through the real entitlement-enforcing service, and
 * a predicate pinned to the *current* owner cannot see the sweeps that ran under the previous one:
 * 1,006 runs from an earlier sweep were still resident in the matrix database, carrying 3.5 million
 * equity rows and — with their deleted predecessors' dead tuples — 1,982 MB in one table. A sweep
 * then inserts several million rows into a table autovacuum cannot keep up with, and the five-second
 * interactive transaction that writes a progress checkpoint starts expiring: runs that computed
 * everything correctly fail in `RUNNING` with a Prisma transaction timeout. Every persona is a known
 * account from one registry, so naming the set keeps the "never selects a real user's data" property
 * exactly as strong.
 *
 * Those two columns are the right key because they survive everything. A `BacktestRun` snapshot is
 * immutable and `strategyId` / `stockListId` are nulled when a fixture is deleted, so neither
 * foreign key can be trusted to identify an old matrix run. Requiring both names means an ordinary
 * backtest can never match — and neither can a developer's own run that happened to use a matrix
 * Strategy against a personal list.
 *
 * Deleting a run cascades to that run's own progress, milestones, trades, equity points, positions
 * and summary, and to nothing else.
 */

/**
 * The reserved namespace a matrix run's Strategy name carries.
 *
 * The whole prefix rather than `QA-MATRIX-S`, so the audit strategy variant (`QA-MATRIX-A01` …) is
 * retained by the same rule. It stays exactly as narrow: the list half below still pins its own
 * namespace, and requiring **both** denormalized names to be reserved is what makes an ordinary
 * backtest — or a developer's run of a matrix Strategy against a personal list — impossible to match.
 */
export const MATRIX_STRATEGY_NAME_PREFIX = QA_MATRIX_NAME_PREFIX;
export const MATRIX_LIST_NAME_PREFIX = `${QA_MATRIX_NAME_PREFIX}L`;

export type MatrixCleanupResult = {
  readonly deleted: number;
  readonly retained: number;
};

/** Runs this predicate matches, and only these, are ever deleted. */
export function matrixRunFilter(ownerUserIds: readonly string[]) {
  return {
    userId: { in: [...ownerUserIds] as string[] },
    strategyName: { startsWith: MATRIX_STRATEGY_NAME_PREFIX },
    stockListName: { startsWith: MATRIX_LIST_NAME_PREFIX },
  };
}

/**
 * Deletes the QA account's previous matrix runs.
 *
 * `keepRunIds` is how a sweep's own output survives its own cleanup when cleanup runs late — a
 * failed execution has to stay inspectable until its report is written, so the runner cleans
 * *before* it executes and never after.
 */
export async function cleanupMatrixRuns(
  prisma: PrismaClient,
  ownerUserIds: readonly string[],
  keepRunIds: readonly string[] = [],
): Promise<MatrixCleanupResult> {
  const keep = new Set(keepRunIds);
  const candidates = await prisma.backtestRun.findMany({
    where: matrixRunFilter(ownerUserIds),
    select: { id: true },
  });
  const removable = candidates
    .map((row) => row.id)
    .filter((id) => !keep.has(id));

  if (removable.length === 0) {
    return { deleted: 0, retained: candidates.length };
  }

  // Re-stated on the delete rather than trusting the ids the select returned: the guarantee that
  // nothing outside the namespace is removable must hold on the statement that actually deletes.
  const result = await prisma.backtestRun.deleteMany({
    where: { ...matrixRunFilter(ownerUserIds), id: { in: removable } },
  });
  return {
    deleted: result.count,
    retained: candidates.length - result.count,
  };
}

/** How many matrix runs the QA account currently holds; used by the report and by the tests. */
export async function countMatrixRuns(
  prisma: PrismaClient,
  ownerUserIds: readonly string[],
): Promise<number> {
  return prisma.backtestRun.count({ where: matrixRunFilter(ownerUserIds) });
}

/**
 * The result tables a matrix sweep writes, reclaimed after a cleanup deleted the previous sweep's rows.
 *
 * `DELETE` leaves dead tuples behind, and a sweep's own inserts then land in a table whose free space
 * autovacuum has not yet reclaimed. At matrix scale that is millions of tuples in
 * `BacktestDailyEquity`, and the cost is not merely disk: the five-second interactive transaction
 * that writes a progress checkpoint begins to expire, and a run with nothing wrong with it fails in
 * `RUNNING`. Reclaiming once, before the timed sweep, is cheap and makes the measurement a
 * measurement of the engine rather than of table bloat.
 *
 * `VACUUM (ANALYZE)` rather than `VACUUM FULL`: it takes no exclusive lock and returns the space to
 * the table for reuse, which is exactly what the inserts that follow need. It cannot run inside a
 * transaction, so each statement is issued on its own.
 */
export async function reclaimMatrixResultTables(
  prisma: PrismaClient,
): Promise<readonly string[]> {
  const tables = [
    "BacktestDailyEquity",
    "BacktestTrade",
    "BacktestPosition",
    "BacktestRunSummary",
    "BacktestRunMilestone",
    "BacktestRunProgress",
    "BacktestRun",
    "BacktestJob",
  ] as const;
  const reclaimed: string[] = [];
  for (const table of tables) {
    // The table names are literals from this module, never input, so there is nothing to inject.
    await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) "${table}"`);
    reclaimed.push(table);
  }
  return reclaimed;
}
