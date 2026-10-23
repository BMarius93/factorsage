-- Per-user Run IDs for backtests (`Run #0001`, `Run #0002`, ...).
--
-- * `BacktestRun.runNumber` — the run's user-facing identity, sequential per owner, unique per
--   owner, written once and never again. `BacktestRun.id` (the UUID) is unchanged and stays the
--   identity every reference, URL and job uses.
-- * `BacktestRunNumberCounter` — one row per user holding the highest number ever allocated to
--   them. New runs are numbered from it with one atomic upsert inside the submission transaction
--   (`allocateBacktestRunNumber` in `@intrinsic/database`), never with `MAX(runNumber) + 1`, and
--   because it is a high-water mark a deleted run's number is never handed out again.
--
-- Backfill: every existing run is numbered per owner in creation order — `queuedAt`, then
-- `createdAt`, then `id` as the final, stable tie-breaker for runs submitted in the same instant —
-- so re-running the backfill on the same rows always gives the same answer. Each owner's counter
-- starts at the highest number assigned. Nothing else in a run (its snapshot, results or
-- `snapshotHash`) is read or written.
--
-- Rollback: the previous release does not know either object; dropping `runNumber` and the table
-- restores it. Deploy the migration before the release that writes `runNumber`: a process still
-- running the previous release cannot create a run once the column is NOT NULL.

-- AlterTable: nullable first, so existing rows can be numbered before the constraint applies.
ALTER TABLE "BacktestRun" ADD COLUMN     "runNumber" INTEGER;

-- Backfill: deterministic per-user numbering in creation order.
WITH "numbered" AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId"
      ORDER BY "queuedAt" ASC, "createdAt" ASC, "id" ASC
    ) AS "runNumber"
  FROM "BacktestRun"
)
UPDATE "BacktestRun" AS "run"
SET "runNumber" = "numbered"."runNumber"
FROM "numbered"
WHERE "run"."id" = "numbered"."id";

ALTER TABLE "BacktestRun" ALTER COLUMN "runNumber" SET NOT NULL;

ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_runNumber_positive" CHECK ("runNumber" >= 1);

-- CreateTable
CREATE TABLE "BacktestRunNumberCounter" (
    "userId" TEXT NOT NULL,
    "lastRunNumber" INTEGER NOT NULL,

    CONSTRAINT "BacktestRunNumberCounter_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "BacktestRunNumberCounter_lastRunNumber_positive" CHECK ("lastRunNumber" >= 1)
);

-- Backfill: each owner's counter continues after the highest number the backfill assigned.
INSERT INTO "BacktestRunNumberCounter" ("userId", "lastRunNumber")
SELECT "userId", MAX("runNumber")
FROM "BacktestRun"
GROUP BY "userId";

-- CreateIndex
CREATE UNIQUE INDEX "BacktestRun_userId_runNumber_key" ON "BacktestRun"("userId", "runNumber");

-- AddForeignKey
ALTER TABLE "BacktestRunNumberCounter" ADD CONSTRAINT "BacktestRunNumberCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
