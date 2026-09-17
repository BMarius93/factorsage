-- Benchmark: separate "the system maintains this" from "a user may pick this", and record what the
-- object behind a series actually is.
--
-- Both columns are additive and both are backfilled to the meaning the existing rows already had,
-- so nothing already stored changes interpretation:
--
--   * every benchmark that exists today IS selectable for a backtest, so `isBacktestSelectable`
--     defaults to true and the existing `SP500` row keeps exactly the behaviour it had;
--   * every series that exists today is the `SPY` ETF proxy behind `SP500`, so `seriesType` is
--     backfilled to `ETF_PROXY`. That is the fact, not a convenience: had any row genuinely been an
--     index, catalog reconciliation would append a new version rather than let this backfill decide
--     for it, because `seriesType` is part of the immutable series definition.
--
-- The column is added nullable, backfilled and only then made NOT NULL: adding a NOT NULL column
-- with no default to a populated table fails, and a DEFAULT left in place would let a future series
-- be created without stating what it is.

-- CreateEnum
CREATE TYPE "BenchmarkSeriesType" AS ENUM ('ETF_PROXY', 'INDEX');

-- AlterTable
ALTER TABLE "Benchmark" ADD COLUMN     "isBacktestSelectable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "BenchmarkSeries" ADD COLUMN     "seriesType" "BenchmarkSeriesType";

-- Backfill: every series written before this migration is the SPY-backed ETF proxy.
UPDATE "BenchmarkSeries" SET "seriesType" = 'ETF_PROXY' WHERE "seriesType" IS NULL;

ALTER TABLE "BenchmarkSeries" ALTER COLUMN "seriesType" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Benchmark_isActive_isBacktestSelectable_displayOrder_idx" ON "Benchmark"("isActive", "isBacktestSelectable", "displayOrder");
