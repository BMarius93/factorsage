-- The backtest collection is read a page at a time (`GET /backtests?page=`), searched and ordered in
-- the database, and never opens a run's snapshot to do it.
--
-- `benchmarkName` stores the benchmark name the snapshot recorded at submission, alongside the
-- strategy and stock list names already stored the same way. Existing runs are backfilled from their
-- own snapshot; the benchmark's current name is only a fallback for a snapshot that lacks one (none
-- written by the API does).
ALTER TABLE "BacktestRun" ADD COLUMN "benchmarkName" TEXT;

UPDATE "BacktestRun" AS "run"
SET "benchmarkName" = COALESCE("run"."snapshot" -> 'benchmark' ->> 'name', "benchmark"."name")
FROM "Benchmark" AS "benchmark"
WHERE "benchmark"."id" = "run"."benchmarkId";

ALTER TABLE "BacktestRun" ALTER COLUMN "benchmarkName" SET NOT NULL;

-- The default order, newest first with the id breaking same-tick ties, as one index range per page.
DROP INDEX "BacktestRun_userId_queuedAt_idx";

CREATE INDEX "BacktestRun_userId_queuedAt_id_idx" ON "BacktestRun"("userId", "queuedAt" DESC, "id" DESC);
