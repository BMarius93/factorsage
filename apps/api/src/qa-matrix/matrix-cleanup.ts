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
 * - **owner** — every statement is scoped to the QA persona's `userId`, so another account's data
 *   is not merely spared, it is never selected;
 * - **namespace** — the run's own denormalized `strategyName` *and* `stockListName` must both be in
 *   the reserved `QA-MATRIX-` namespace.
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

export const MATRIX_STRATEGY_NAME_PREFIX = `${QA_MATRIX_NAME_PREFIX}S`;
export const MATRIX_LIST_NAME_PREFIX = `${QA_MATRIX_NAME_PREFIX}L`;

export type MatrixCleanupResult = {
  readonly deleted: number;
  readonly retained: number;
};

/** Runs this predicate matches, and only these, are ever deleted. */
export function matrixRunFilter(ownerUserId: string) {
  return {
    userId: ownerUserId,
    strategyName: { startsWith: MATRIX_STRATEGY_NAME_PREFIX },
    stockListName: { startsWith: MATRIX_LIST_NAME_PREFIX },
  } as const;
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
  ownerUserId: string,
  keepRunIds: readonly string[] = [],
): Promise<MatrixCleanupResult> {
  const keep = new Set(keepRunIds);
  const candidates = await prisma.backtestRun.findMany({
    where: matrixRunFilter(ownerUserId),
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
    where: { ...matrixRunFilter(ownerUserId), id: { in: removable } },
  });
  return {
    deleted: result.count,
    retained: candidates.length - result.count,
  };
}

/** How many matrix runs the QA account currently holds; used by the report and by the tests. */
export async function countMatrixRuns(
  prisma: PrismaClient,
  ownerUserId: string,
): Promise<number> {
  return prisma.backtestRun.count({ where: matrixRunFilter(ownerUserId) });
}
