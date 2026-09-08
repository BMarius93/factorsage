-- CreateTable
CREATE TABLE "BacktestRunMilestone" (
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "year" TEXT NOT NULL,
    "simulatedThrough" DATE NOT NULL,
    "percent" INTEGER NOT NULL,
    "completedDays" INTEGER NOT NULL,
    "totalDays" INTEGER NOT NULL,
    "cash" DECIMAL(20,2) NOT NULL,
    "totalValue" DECIMAL(20,2) NOT NULL,
    "investedCapital" DECIMAL(20,2) NOT NULL,
    "portfolioReturnPercent" DECIMAL(20,8) NOT NULL,
    "benchmarkReturnPercent" DECIMAL(20,8),
    "alphaPercent" DECIMAL(20,8),
    "maxDrawdownPercent" DECIMAL(20,8) NOT NULL,
    "tradeCount" INTEGER NOT NULL,
    "openPositions" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestRunMilestone_pkey" PRIMARY KEY ("runId","sequence")
);

-- AddForeignKey
ALTER TABLE "BacktestRunMilestone" ADD CONSTRAINT "BacktestRunMilestone_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
