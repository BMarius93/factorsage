-- CreateEnum
CREATE TYPE "HistoricalUniverseStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "HistoricalUniverseGenerationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MarketIndexKey" ADD VALUE 'NASDAQ100';
ALTER TYPE "MarketIndexKey" ADD VALUE 'DOW30';

-- CreateTable
CREATE TABLE "DividendEvent" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "exDate" DATE NOT NULL,
    "recordDate" DATE,
    "paymentDate" DATE,
    "declarationDate" DATE,
    "amount" DECIMAL(24,12) NOT NULL,
    "adjustedAmount" DECIMAL(24,12) NOT NULL,
    "frequency" TEXT,
    "contentHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DividendEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalUniverse" (
    "key" TEXT NOT NULL,
    "status" "HistoricalUniverseStatus" NOT NULL DEFAULT 'DRAFT',
    "methodologyVersion" INTEGER NOT NULL,
    "latestGenerationId" TEXT,
    "publishedGenerationId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "statusReasons" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalUniverse_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "HistoricalUniverseGeneration" (
    "id" TEXT NOT NULL,
    "universeKey" TEXT NOT NULL,
    "methodologyVersion" INTEGER NOT NULL,
    "engineVersion" INTEGER NOT NULL,
    "status" "HistoricalUniverseGenerationStatus" NOT NULL DEFAULT 'RUNNING',
    "inputDigest" TEXT,
    "outputDigest" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "firstReconstitution" DATE,
    "lastReconstitution" DATE,
    "summary" JSONB,
    "diagnostics" JSONB,
    "validation" JSONB,
    "error" TEXT,

    CONSTRAINT "HistoricalUniverseGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalUniverseSelection" (
    "generationId" TEXT NOT NULL,
    "reconstitutionDate" DATE NOT NULL,
    "securityId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "metricValue" DECIMAL(30,12),
    "effectiveDate" DATE NOT NULL,

    CONSTRAINT "HistoricalUniverseSelection_pkey" PRIMARY KEY ("generationId","reconstitutionDate","securityId")
);

-- CreateTable
CREATE TABLE "HistoricalUniverseMembershipPeriod" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,

    CONSTRAINT "HistoricalUniverseMembershipPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DividendEvent_securityId_exDate_idx" ON "DividendEvent"("securityId", "exDate");

-- CreateIndex
CREATE UNIQUE INDEX "DividendEvent_securityId_contentHash_key" ON "DividendEvent"("securityId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalUniverse_latestGenerationId_key" ON "HistoricalUniverse"("latestGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalUniverse_publishedGenerationId_key" ON "HistoricalUniverse"("publishedGenerationId");

-- CreateIndex
CREATE INDEX "HistoricalUniverseGeneration_universeKey_startedAt_idx" ON "HistoricalUniverseGeneration"("universeKey", "startedAt");

-- CreateIndex
CREATE INDEX "HistoricalUniverseSelection_generationId_securityId_idx" ON "HistoricalUniverseSelection"("generationId", "securityId");

-- CreateIndex
CREATE INDEX "HistoricalUniverseMembershipPeriod_generationId_securityId_idx" ON "HistoricalUniverseMembershipPeriod"("generationId", "securityId");

-- AddForeignKey
ALTER TABLE "DividendEvent" ADD CONSTRAINT "DividendEvent_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalUniverse" ADD CONSTRAINT "HistoricalUniverse_latestGenerationId_fkey" FOREIGN KEY ("latestGenerationId") REFERENCES "HistoricalUniverseGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalUniverse" ADD CONSTRAINT "HistoricalUniverse_publishedGenerationId_fkey" FOREIGN KEY ("publishedGenerationId") REFERENCES "HistoricalUniverseGeneration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalUniverseSelection" ADD CONSTRAINT "HistoricalUniverseSelection_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "HistoricalUniverseGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalUniverseSelection" ADD CONSTRAINT "HistoricalUniverseSelection_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalUniverseMembershipPeriod" ADD CONSTRAINT "HistoricalUniverseMembershipPeriod_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "HistoricalUniverseGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalUniverseMembershipPeriod" ADD CONSTRAINT "HistoricalUniverseMembershipPeriod_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
