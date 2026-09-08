-- Benchmark identity and benchmark *series* become separate things.
--
-- A benchmark's source, provider symbol, currency and methodology decide what its numbers are.
-- Editing them in place silently reinterpreted every bar already stored under that benchmark id,
-- and a queued run resolved its benchmark by code at execution time, so a catalog change between
-- submission and execution changed what the run compared against. Both are reproducibility bugs.
--
-- After this migration those fields live on an append-only `BenchmarkSeries`, market data is keyed
-- by the series, and a run pins the exact series id it was submitted against.

CREATE TABLE "BenchmarkSeries" (
    "id" TEXT NOT NULL,
    "benchmarkId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceKind" "BenchmarkSourceKind" NOT NULL,
    "providerSymbol" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "methodologyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BenchmarkSeries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BenchmarkSeries_benchmarkId_version_key" ON "BenchmarkSeries"("benchmarkId", "version");

ALTER TABLE "BenchmarkSeries" ADD CONSTRAINT "BenchmarkSeries_benchmarkId_fkey"
    FOREIGN KEY ("benchmarkId") REFERENCES "Benchmark"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every existing benchmark's current definition becomes its version 1.
INSERT INTO "BenchmarkSeries" ("id", "benchmarkId", "version", "sourceKind", "providerSymbol", "currency", "methodologyVersion")
SELECT gen_random_uuid(), b."id", 1, b."sourceKind", b."providerSymbol", b."currency", b."methodologyVersion"
FROM "Benchmark" b;

-- Repoint the market data at the series it was actually fetched for.
ALTER TABLE "BenchmarkDailyPrice" ADD COLUMN "seriesId" TEXT;
ALTER TABLE "BenchmarkDatasetState" ADD COLUMN "seriesId" TEXT;
ALTER TABLE "BenchmarkDatasetCoverage" ADD COLUMN "seriesId" TEXT;

UPDATE "BenchmarkDailyPrice" p SET "seriesId" = s."id"
FROM "BenchmarkSeries" s WHERE s."benchmarkId" = p."benchmarkId" AND s."version" = 1;
UPDATE "BenchmarkDatasetState" t SET "seriesId" = s."id"
FROM "BenchmarkSeries" s WHERE s."benchmarkId" = t."benchmarkId" AND s."version" = 1;
UPDATE "BenchmarkDatasetCoverage" c SET "seriesId" = s."id"
FROM "BenchmarkSeries" s WHERE s."benchmarkId" = c."benchmarkId" AND s."version" = 1;

ALTER TABLE "BenchmarkDailyPrice" DROP CONSTRAINT "BenchmarkDailyPrice_benchmarkId_fkey";
ALTER TABLE "BenchmarkDatasetState" DROP CONSTRAINT "BenchmarkDatasetState_benchmarkId_fkey";
ALTER TABLE "BenchmarkDatasetCoverage" DROP CONSTRAINT "BenchmarkDatasetCoverage_benchmarkId_fkey";

ALTER TABLE "BenchmarkDailyPrice" DROP CONSTRAINT "BenchmarkDailyPrice_pkey";
ALTER TABLE "BenchmarkDatasetState" DROP CONSTRAINT "BenchmarkDatasetState_pkey";
DROP INDEX IF EXISTS "BenchmarkDatasetCoverage_range_key";
DROP INDEX IF EXISTS "BenchmarkDatasetCoverage_lookup_idx";

ALTER TABLE "BenchmarkDailyPrice" DROP COLUMN "benchmarkId";
ALTER TABLE "BenchmarkDatasetState" DROP COLUMN "benchmarkId";
ALTER TABLE "BenchmarkDatasetCoverage" DROP COLUMN "benchmarkId";

ALTER TABLE "BenchmarkDailyPrice" ALTER COLUMN "seriesId" SET NOT NULL;
ALTER TABLE "BenchmarkDatasetState" ALTER COLUMN "seriesId" SET NOT NULL;
ALTER TABLE "BenchmarkDatasetCoverage" ALTER COLUMN "seriesId" SET NOT NULL;

ALTER TABLE "BenchmarkDailyPrice" ADD CONSTRAINT "BenchmarkDailyPrice_pkey" PRIMARY KEY ("seriesId", "date");
ALTER TABLE "BenchmarkDatasetState" ADD CONSTRAINT "BenchmarkDatasetState_pkey" PRIMARY KEY ("seriesId", "dataset", "variant");
CREATE UNIQUE INDEX "BenchmarkDatasetCoverage_range_key" ON "BenchmarkDatasetCoverage"("seriesId", "dataset", "variant", "fromDate", "toDate");
CREATE INDEX "BenchmarkDatasetCoverage_lookup_idx" ON "BenchmarkDatasetCoverage"("seriesId", "dataset", "variant", "fromDate", "toDate");

ALTER TABLE "BenchmarkDailyPrice" ADD CONSTRAINT "BenchmarkDailyPrice_seriesId_fkey"
    FOREIGN KEY ("seriesId") REFERENCES "BenchmarkSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BenchmarkDatasetState" ADD CONSTRAINT "BenchmarkDatasetState_seriesId_fkey"
    FOREIGN KEY ("seriesId") REFERENCES "BenchmarkSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BenchmarkDatasetCoverage" ADD CONSTRAINT "BenchmarkDatasetCoverage_seriesId_fkey"
    FOREIGN KEY ("seriesId") REFERENCES "BenchmarkSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The mutable columns are gone from the product row: they are the series' identity now.
ALTER TABLE "Benchmark" DROP COLUMN "sourceKind";
ALTER TABLE "Benchmark" DROP COLUMN "providerSymbol";
ALTER TABLE "Benchmark" DROP COLUMN "currency";
ALTER TABLE "Benchmark" DROP COLUMN "methodologyVersion";

-- A run pins the exact series it compares against and the one that supplied its execution calendar.
ALTER TABLE "BacktestRun" ADD COLUMN "benchmarkSeriesId" TEXT;
ALTER TABLE "BacktestRun" ADD COLUMN "executionCalendarSeriesId" TEXT;

UPDATE "BacktestRun" r SET "benchmarkSeriesId" = s."id"
FROM "BenchmarkSeries" s WHERE s."benchmarkId" = r."benchmarkId" AND s."version" = 1;

ALTER TABLE "BacktestRun" ALTER COLUMN "benchmarkSeriesId" SET NOT NULL;

ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_benchmarkSeriesId_fkey"
    FOREIGN KEY ("benchmarkSeriesId") REFERENCES "BenchmarkSeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
