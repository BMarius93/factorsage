-- Unify daily materialized derived state.
--
-- Sparse/per-family derived tables and every calculation-version history dimension are removed.
-- Exactly one row per (securityId, date) holds the current methodology; a methodology change
-- rebuilds those rows instead of storing parallel versions. Pre-production: derived data is fully
-- recalculable from canonical prices and PIT financial statements, so it is dropped, not migrated.

-- DropTable
DROP TABLE "IntrinsicValueBlend";
DROP TABLE "IntrinsicValue";
DROP TABLE "WeeklyTechnical";
DROP TABLE "DailyTechnical";

-- DropEnum
DROP TYPE "IntrinsicValueBlendId";
DROP TYPE "IntrinsicValueModel";
DROP TYPE "MovingAverageType";

-- DropIndex
-- The DailyPrice composite primary key already provides the (securityId, date) B-tree path.
DROP INDEX "DailyPrice_securityId_date_idx";

-- AlterTable
ALTER TABLE "StockDatasetState" DROP COLUMN "calculationVersion";

-- AlterTable
-- One current completed-week aggregate per week; no coexisting calculation versions.
DELETE FROM "WeeklyPrice" a
  USING "WeeklyPrice" b
  WHERE a."securityId" = b."securityId"
    AND a."weekStartDate" = b."weekStartDate"
    AND a."calculationVersion" < b."calculationVersion";
ALTER TABLE "WeeklyPrice" DROP CONSTRAINT "WeeklyPrice_pkey";
ALTER TABLE "WeeklyPrice" DROP COLUMN "calculationVersion";
ALTER TABLE "WeeklyPrice" ADD CONSTRAINT "WeeklyPrice_pkey" PRIMARY KEY ("securityId", "weekStartDate");

-- AlterEnum
DELETE FROM "StockDatasetCoverage"
  WHERE "dataset" IN ('DAILY_TECHNICAL', 'WEEKLY_TECHNICAL', 'INTRINSIC_VALUE', 'INTRINSIC_VALUE_BLEND');
DELETE FROM "StockDatasetState"
  WHERE "dataset" IN ('DAILY_TECHNICAL', 'WEEKLY_TECHNICAL', 'INTRINSIC_VALUE', 'INTRINSIC_VALUE_BLEND');
ALTER TYPE "StockDataset" RENAME TO "StockDataset_old";
CREATE TYPE "StockDataset" AS ENUM ('SECURITY_PROFILE', 'DAILY_PRICE', 'WEEKLY_PRICE', 'DAILY_DERIVED_STATE', 'INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW', 'DIVIDEND', 'STOCK_SPLIT');
ALTER TABLE "StockDatasetState" ALTER COLUMN "dataset" TYPE "StockDataset" USING ("dataset"::text::"StockDataset");
ALTER TABLE "StockDatasetCoverage" ALTER COLUMN "dataset" TYPE "StockDataset" USING ("dataset"::text::"StockDataset");
DROP TYPE "StockDataset_old";

-- CreateTable
CREATE TABLE "DailyDerivedState" (
    "securityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sma20d" DECIMAL(20,8),
    "sma50d" DECIMAL(20,8),
    "sma100d" DECIMAL(20,8),
    "sma200d" DECIMAL(20,8),
    "ema20d" DECIMAL(20,8),
    "ema50d" DECIMAL(20,8),
    "ema200d" DECIMAL(20,8),
    "weeklySourceWeekStart" DATE,
    "dcfFcff" DECIMAL(20,8),
    "residualIncome" DECIMAL(20,8),
    "ddm" DECIMAL(20,8),
    "graham" DECIMAL(20,8),
    "blendBalanced" DECIMAL(20,8),
    "blendConservative" DECIMAL(20,8),
    "blendDividend" DECIMAL(20,8),
    "intrinsicSourceDataAsOf" TIMESTAMP(3),
    "intrinsicCurrency" TEXT,

    CONSTRAINT "DailyDerivedState_pkey" PRIMARY KEY ("securityId","date")
);

-- AddForeignKey
ALTER TABLE "DailyDerivedState" ADD CONSTRAINT "DailyDerivedState_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;
