import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Per-user backtest Run IDs (`Run #0001`, `Run #0002`, ...).
 *
 * A run's number is its user-facing identity: sequential per owner, unique per owner, allocated
 * once and never changed. `BacktestRun.id` stays the technical identity.
 *
 * The number comes from the owner's `BacktestRunNumberCounter` row — a high-water mark, not a
 * count of existing runs — advanced by one atomic upsert. Two submissions for the same user at the
 * same instant serialize on that row: the second waits for the first transaction to finish and
 * then increments the value it committed, so they cannot read the same number. `MAX(runNumber) + 1`
 * would not be safe here, and would also hand a deleted run's number to the next run.
 *
 * Every path that creates a `BacktestRun` takes its number from here, which is why this lives in
 * `@intrinsic/database` rather than in one application.
 */

/** The subset of a Prisma client this needs; satisfied by the client and by a transaction client. */
export type BacktestRunNumberClient = Pick<PrismaClient, "$queryRaw"> &
  Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Allocates the next Run ID for `userId` and returns it.
 *
 * **Call it inside the transaction that creates the run.** The counter then moves only if the run
 * is committed: a submission refused or failed after this call rolls the allocation back with it,
 * so numbers are not burnt by attempts that never produced a run.
 */
export async function allocateBacktestRunNumber(
  tx: BacktestRunNumberClient,
  userId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ lastRunNumber: number }[]>`
    INSERT INTO "BacktestRunNumberCounter" ("userId", "lastRunNumber")
    VALUES (${userId}, 1)
    ON CONFLICT ("userId") DO UPDATE
      SET "lastRunNumber" = "BacktestRunNumberCounter"."lastRunNumber" + 1
    RETURNING "lastRunNumber"`;
  const allocated = rows[0]?.lastRunNumber;
  if (
    allocated === undefined ||
    !Number.isInteger(allocated) ||
    allocated < 1
  ) {
    throw new Error("Could not allocate a backtest run number");
  }
  return allocated;
}
