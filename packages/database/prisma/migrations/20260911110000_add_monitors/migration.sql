-- CreateEnum
CREATE TYPE "MonitorEvaluationOutcome" AS ENUM ('MATCHED', 'NOT_MATCHED', 'NOT_EVALUABLE');

-- CreateEnum
CREATE TYPE "MonitorEvaluableResult" AS ENUM ('MATCHED', 'NOT_MATCHED');

-- CreateEnum
CREATE TYPE "MonitorLevelKind" AS ENUM ('BUY', 'SELL', 'FINAL_EXIT');

-- CreateTable
CREATE TABLE "Monitor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "stockListId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Monitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorSignalState" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "levelKind" "MonitorLevelKind" NOT NULL,
    "signalFingerprint" TEXT NOT NULL,
    "lastEvaluableResult" "MonitorEvaluableResult" NOT NULL,
    "lastEvaluableDate" DATE NOT NULL,
    "lastEvaluableAt" TIMESTAMP(3) NOT NULL,
    "lastOutcome" "MonitorEvaluationOutcome" NOT NULL,
    "lastOutcomeAt" TIMESTAMP(3) NOT NULL,
    "activeSignalId" TEXT,
    "lastTriggerSignalDate" DATE,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitorSignalState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorSignal" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "levelKind" "MonitorLevelKind" NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "hasTrigger" BOOLEAN NOT NULL,
    "observationDate" DATE NOT NULL,
    "observationPrice" DECIMAL(20,8) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MonitorSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorScanSchedule" (
    "id" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "cycleSequence" INTEGER NOT NULL DEFAULT 0,
    "lastStartedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitorScanSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Monitor_userId_idx" ON "Monitor"("userId");

-- CreateIndex
CREATE INDEX "Monitor_userId_updatedAt_idx" ON "Monitor"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Monitor_enabled_idx" ON "Monitor"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorSignalState_activeSignalId_key" ON "MonitorSignalState"("activeSignalId");

-- CreateIndex
CREATE INDEX "MonitorSignalState_monitorId_idx" ON "MonitorSignalState"("monitorId");

-- CreateIndex
CREATE INDEX "MonitorSignalState_securityId_idx" ON "MonitorSignalState"("securityId");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorSignalState_identity_key" ON "MonitorSignalState"("monitorId", "securityId", "levelId");

-- CreateIndex
CREATE INDEX "MonitorSignal_monitorId_detectedAt_idx" ON "MonitorSignal"("monitorId", "detectedAt");

-- CreateIndex
CREATE INDEX "MonitorSignal_securityId_idx" ON "MonitorSignal"("securityId");

-- CreateIndex
CREATE INDEX "MonitorSignal_monitorId_resolvedAt_detectedAt_idx" ON "MonitorSignal"("monitorId", "resolvedAt", "detectedAt");

-- CreateIndex
CREATE INDEX "MonitorScanSchedule_dueAt_idx" ON "MonitorScanSchedule"("dueAt");

-- AddForeignKey
ALTER TABLE "Monitor" ADD CONSTRAINT "Monitor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Monitor" ADD CONSTRAINT "Monitor_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Monitor" ADD CONSTRAINT "Monitor_stockListId_fkey" FOREIGN KEY ("stockListId") REFERENCES "StockList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorSignalState" ADD CONSTRAINT "MonitorSignalState_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorSignalState" ADD CONSTRAINT "MonitorSignalState_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorSignalState" ADD CONSTRAINT "MonitorSignalState_activeSignalId_fkey" FOREIGN KEY ("activeSignalId") REFERENCES "MonitorSignal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorSignal" ADD CONSTRAINT "MonitorSignal_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorSignal" ADD CONSTRAINT "MonitorSignal_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

