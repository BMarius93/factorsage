-- CreateEnum
CREATE TYPE "BenchmarkSourceKind" AS ENUM ('FMP_SYMBOL');

-- CreateEnum
CREATE TYPE "BenchmarkDataset" AS ENUM ('DAILY_PRICE');

-- CreateEnum
CREATE TYPE "BacktestRunStatus" AS ENUM ('QUEUED', 'PREPARING_DATA', 'RUNNING', 'FINALIZING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BacktestJobStatus" AS ENUM ('QUEUED', 'CLAIMED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BacktestTradeAction" AS ENUM ('BUY', 'SELL', 'FINAL_EXIT');

-- CreateTable
CREATE TABLE "Benchmark" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sourceKind" "BenchmarkSourceKind" NOT NULL,
    "providerSymbol" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "methodologyVersion" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Benchmark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkDailyPrice" (
    "benchmarkId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "open" DECIMAL(20,8) NOT NULL,
    "high" DECIMAL(20,8) NOT NULL,
    "low" DECIMAL(20,8) NOT NULL,
    "close" DECIMAL(20,8) NOT NULL,
    "volume" BIGINT NOT NULL,

    CONSTRAINT "BenchmarkDailyPrice_pkey" PRIMARY KEY ("benchmarkId","date")
);

-- CreateTable
CREATE TABLE "BenchmarkDatasetState" (
    "benchmarkId" TEXT NOT NULL,
    "dataset" "BenchmarkDataset" NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "earliestDate" DATE,
    "latestDate" DATE,
    "lastSuccessfulSyncAt" TIMESTAMP(3),

    CONSTRAINT "BenchmarkDatasetState_pkey" PRIMARY KEY ("benchmarkId","dataset","variant")
);

-- CreateTable
CREATE TABLE "BenchmarkDatasetCoverage" (
    "id" TEXT NOT NULL,
    "benchmarkId" TEXT NOT NULL,
    "dataset" "BenchmarkDataset" NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "lastSuccessfulSyncAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BenchmarkDatasetCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT,
    "strategyVersionId" TEXT,
    "stockListId" TEXT,
    "benchmarkId" TEXT NOT NULL,
    "status" "BacktestRunStatus" NOT NULL DEFAULT 'QUEUED',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "initialCapital" DECIMAL(20,2) NOT NULL,
    "monthlyContribution" DECIMAL(20,2) NOT NULL,
    "maximumPositions" INTEGER NOT NULL,
    "strategyName" TEXT NOT NULL,
    "stockListName" TEXT NOT NULL,
    "securityCount" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "failureDetail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestJob" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" "BacktestJobStatus" NOT NULL DEFAULT 'QUEUED',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BacktestJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRunProgress" (
    "runId" TEXT NOT NULL,
    "percent" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "simulatedThrough" DATE,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BacktestRunProgress_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "BacktestTrade" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "securityId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "action" "BacktestTradeAction" NOT NULL,
    "levelId" TEXT,
    "levelPercentage" INTEGER,
    "shares" DECIMAL(28,10) NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "fees" DECIMAL(20,2) NOT NULL,
    "realizedPnl" DECIMAL(20,2),
    "realizedPnlPercent" DECIMAL(20,8),
    "cashAfter" DECIMAL(20,2) NOT NULL,
    "sharesAfter" DECIMAL(28,10) NOT NULL,
    "averageCostAfter" DECIMAL(20,8),

    CONSTRAINT "BacktestTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestDailyEquity" (
    "runId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "cash" DECIMAL(20,2) NOT NULL,
    "positionsValue" DECIMAL(20,2) NOT NULL,
    "totalValue" DECIMAL(20,2) NOT NULL,
    "investedCapital" DECIMAL(20,2) NOT NULL,
    "returnIndex" DECIMAL(20,10) NOT NULL,
    "benchmarkIndex" DECIMAL(20,10),
    "openPositions" INTEGER NOT NULL,

    CONSTRAINT "BacktestDailyEquity_pkey" PRIMARY KEY ("runId","date")
);

-- CreateTable
CREATE TABLE "BacktestPosition" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "openedDate" DATE NOT NULL,
    "shares" DECIMAL(28,10) NOT NULL,
    "averageCost" DECIMAL(20,8) NOT NULL,
    "lastPrice" DECIMAL(20,8) NOT NULL,
    "lastPriceDate" DATE NOT NULL,
    "marketValue" DECIMAL(20,2) NOT NULL,
    "unrealizedPnl" DECIMAL(20,2) NOT NULL,
    "unrealizedPnlPercent" DECIMAL(20,8) NOT NULL,
    "allocationPercent" DECIMAL(20,8) NOT NULL,

    CONSTRAINT "BacktestPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRunSummary" (
    "runId" TEXT NOT NULL,
    "firstSimulatedDate" DATE NOT NULL,
    "lastSimulatedDate" DATE NOT NULL,
    "tradingDays" INTEGER NOT NULL,
    "investedCapital" DECIMAL(20,2) NOT NULL,
    "finalCash" DECIMAL(20,2) NOT NULL,
    "finalPositionsValue" DECIMAL(20,2) NOT NULL,
    "finalValue" DECIMAL(20,2) NOT NULL,
    "netProfit" DECIMAL(20,2) NOT NULL,
    "portfolioReturnPercent" DECIMAL(20,8) NOT NULL,
    "benchmarkReturnPercent" DECIMAL(20,8),
    "alphaPercent" DECIMAL(20,8),
    "portfolioCagrPercent" DECIMAL(20,8),
    "maxDrawdownPercent" DECIMAL(20,8) NOT NULL,
    "benchmarkMaxDrawdownPercent" DECIMAL(20,8),
    "realizedPnl" DECIMAL(20,2) NOT NULL,
    "unrealizedPnl" DECIMAL(20,2) NOT NULL,
    "totalTrades" INTEGER NOT NULL,
    "buyTrades" INTEGER NOT NULL,
    "sellTrades" INTEGER NOT NULL,
    "finalExitTrades" INTEGER NOT NULL,
    "winningTrades" INTEGER NOT NULL,
    "losingTrades" INTEGER NOT NULL,
    "openPositions" INTEGER NOT NULL,

    CONSTRAINT "BacktestRunSummary_pkey" PRIMARY KEY ("runId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Benchmark_code_key" ON "Benchmark"("code");

-- CreateIndex
CREATE INDEX "Benchmark_isActive_displayOrder_idx" ON "Benchmark"("isActive", "displayOrder");

-- CreateIndex
CREATE INDEX "BenchmarkDatasetCoverage_lookup_idx" ON "BenchmarkDatasetCoverage"("benchmarkId", "dataset", "variant", "fromDate", "toDate");

-- CreateIndex
CREATE UNIQUE INDEX "BenchmarkDatasetCoverage_range_key" ON "BenchmarkDatasetCoverage"("benchmarkId", "dataset", "variant", "fromDate", "toDate");

-- CreateIndex
CREATE INDEX "BacktestRun_userId_queuedAt_idx" ON "BacktestRun"("userId", "queuedAt");

-- CreateIndex
CREATE INDEX "BacktestRun_userId_status_idx" ON "BacktestRun"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BacktestJob_runId_key" ON "BacktestJob"("runId");

-- CreateIndex
CREATE INDEX "BacktestJob_status_availableAt_idx" ON "BacktestJob"("status", "availableAt");

-- CreateIndex
CREATE INDEX "BacktestJob_status_leaseExpiresAt_idx" ON "BacktestJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "BacktestTrade_runId_date_idx" ON "BacktestTrade"("runId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BacktestTrade_runId_sequence_key" ON "BacktestTrade"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "BacktestPosition_runId_securityId_key" ON "BacktestPosition"("runId", "securityId");

-- AddForeignKey
ALTER TABLE "BenchmarkDailyPrice" ADD CONSTRAINT "BenchmarkDailyPrice_benchmarkId_fkey" FOREIGN KEY ("benchmarkId") REFERENCES "Benchmark"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkDatasetState" ADD CONSTRAINT "BenchmarkDatasetState_benchmarkId_fkey" FOREIGN KEY ("benchmarkId") REFERENCES "Benchmark"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkDatasetCoverage" ADD CONSTRAINT "BenchmarkDatasetCoverage_benchmarkId_fkey" FOREIGN KEY ("benchmarkId") REFERENCES "Benchmark"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_stockListId_fkey" FOREIGN KEY ("stockListId") REFERENCES "StockList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_benchmarkId_fkey" FOREIGN KEY ("benchmarkId") REFERENCES "Benchmark"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestJob" ADD CONSTRAINT "BacktestJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRunProgress" ADD CONSTRAINT "BacktestRunProgress_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestDailyEquity" ADD CONSTRAINT "BacktestDailyEquity_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestPosition" ADD CONSTRAINT "BacktestPosition_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestPosition" ADD CONSTRAINT "BacktestPosition_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRunSummary" ADD CONSTRAINT "BacktestRunSummary_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
