-- The execution calendar becomes a required, foreign-keyed run input.
--
-- It decides which dates a run simulates, therefore when a monthly contribution lands, therefore
-- the return-index base and the numbers themselves. Leaving it nullable meant an execution could
-- silently switch methodology — simulating the securities' own union instead of the market's
-- calendar — because an auxiliary series happened to be unreadable during that worker attempt.
--
-- Backfill: rows predating the column recorded no calendar, and the implementation they ran under
-- took the axis from the comparison benchmark's own dates. Their comparison series is therefore
-- exactly the series that supplied their calendar, so pointing the new column at it preserves what
-- those pre-release rows actually executed rather than inventing a pin they never had.
UPDATE "BacktestRun"
SET "executionCalendarSeriesId" = "benchmarkSeriesId"
WHERE "executionCalendarSeriesId" IS NULL;

ALTER TABLE "BacktestRun" ALTER COLUMN "executionCalendarSeriesId" SET NOT NULL;

-- Restrict, not Cascade: a pinned series is never deleted out from under a run. Deleting a
-- benchmark that any run's calendar or comparison points at must fail loudly.
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_executionCalendarSeriesId_fkey"
    FOREIGN KEY ("executionCalendarSeriesId") REFERENCES "BenchmarkSeries"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "BacktestRun_executionCalendarSeriesId_idx" ON "BacktestRun"("executionCalendarSeriesId");
