-- S&P 500 Historical PIT (`docs/decisions/sp500-historical-pit-v1.md`): the provider's index change log and
-- rename history (content-addressed, append-only), each membership synchronization, the reconstructed
-- constituents and their membership periods, and the durable progress of the universe's bulk history
-- ingestion. Additive only: no existing table, column or row changes.

-- CreateEnum
CREATE TYPE "MarketIndexKey" AS ENUM ('SP500');

-- CreateEnum
CREATE TYPE "IndexMembershipPeriodQuality" AS ENUM ('CONFIRMED', 'START_BEFORE_LOG', 'END_UNKNOWN');

-- CreateEnum
CREATE TYPE "IndexConstituentResolution" AS ENUM ('RESOLVED', 'RESOLVED_PARTIAL', 'NO_PROVIDER_DATA', 'IDENTITY_REJECTED', 'NOT_ADMISSIBLE', 'PENDING');

-- CreateEnum
CREATE TYPE "IndexMembershipSyncStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "IndexIngestionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "IndexConstituentChange" (
    "id" TEXT NOT NULL,
    "indexKey" "MarketIndexKey" NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "announcedDate" DATE,
    "changeType" TEXT NOT NULL,
    "addedTicker" TEXT,
    "addedName" TEXT,
    "removedTicker" TEXT,
    "removedName" TEXT,
    "reason" TEXT,
    "providerDateText" TEXT,
    "contentHash" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "inLatestSource" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "IndexConstituentChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymbolChangeRecord" (
    "id" TEXT NOT NULL,
    "changeDate" DATE NOT NULL,
    "oldSymbol" TEXT NOT NULL,
    "newSymbol" TEXT NOT NULL,
    "companyName" TEXT,
    "contentHash" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "inLatestSource" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SymbolChangeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexMembershipSync" (
    "id" TEXT NOT NULL,
    "indexKey" "MarketIndexKey" NOT NULL,
    "status" "IndexMembershipSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "algorithmVersion" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "sourceDigest" TEXT,
    "currentConstituents" JSONB,
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "IndexMembershipSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexConstituent" (
    "id" TEXT NOT NULL,
    "indexKey" "MarketIndexKey" NOT NULL,
    "constituentKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cik" TEXT,
    "tickerHistory" JSONB NOT NULL,
    "securityId" TEXT,
    "resolution" "IndexConstituentResolution" NOT NULL DEFAULT 'PENDING',
    "resolutionEvidence" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "syncId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexConstituent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexMembershipPeriod" (
    "id" TEXT NOT NULL,
    "constituentId" TEXT NOT NULL,
    "startDate" DATE,
    "startLogDate" DATE,
    "endDate" DATE,
    "endLogDate" DATE,
    "quality" "IndexMembershipPeriodQuality" NOT NULL,
    "startChangeHash" TEXT,
    "endChangeHash" TEXT,
    "startMatch" TEXT,

    CONSTRAINT "IndexMembershipPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexUniverseIngestion" (
    "indexKey" "MarketIndexKey" NOT NULL,
    "securityId" TEXT NOT NULL,
    "status" "IndexIngestionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastStartedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "providerRequests" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "stepOutcomes" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexUniverseIngestion_pkey" PRIMARY KEY ("indexKey","securityId")
);

-- CreateIndex
CREATE INDEX "IndexConstituentChange_indexKey_effectiveDate_idx" ON "IndexConstituentChange"("indexKey", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "IndexConstituentChange_indexKey_contentHash_key" ON "IndexConstituentChange"("indexKey", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "SymbolChangeRecord_contentHash_key" ON "SymbolChangeRecord"("contentHash");

-- CreateIndex
CREATE INDEX "SymbolChangeRecord_newSymbol_idx" ON "SymbolChangeRecord"("newSymbol");

-- CreateIndex
CREATE INDEX "SymbolChangeRecord_oldSymbol_idx" ON "SymbolChangeRecord"("oldSymbol");

-- CreateIndex
CREATE INDEX "IndexMembershipSync_indexKey_startedAt_idx" ON "IndexMembershipSync"("indexKey", "startedAt");

-- CreateIndex
CREATE INDEX "IndexConstituent_securityId_idx" ON "IndexConstituent"("securityId");

-- CreateIndex
CREATE INDEX "IndexConstituent_indexKey_resolution_idx" ON "IndexConstituent"("indexKey", "resolution");

-- CreateIndex
CREATE UNIQUE INDEX "IndexConstituent_indexKey_constituentKey_key" ON "IndexConstituent"("indexKey", "constituentKey");

-- CreateIndex
CREATE INDEX "IndexMembershipPeriod_constituentId_idx" ON "IndexMembershipPeriod"("constituentId");

-- CreateIndex
CREATE INDEX "IndexUniverseIngestion_indexKey_status_idx" ON "IndexUniverseIngestion"("indexKey", "status");

-- AddForeignKey
ALTER TABLE "IndexConstituent" ADD CONSTRAINT "IndexConstituent_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndexMembershipPeriod" ADD CONSTRAINT "IndexMembershipPeriod_constituentId_fkey" FOREIGN KEY ("constituentId") REFERENCES "IndexConstituent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndexUniverseIngestion" ADD CONSTRAINT "IndexUniverseIngestion_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

