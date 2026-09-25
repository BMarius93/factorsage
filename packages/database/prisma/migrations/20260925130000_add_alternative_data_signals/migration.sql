-- Alternative Data Signals — Insider Activity, Congressional Trading and Institutional 13F.
--
-- Migration note
-- ==============
-- Purely additive. Eight new tables, eight new enums and three new `StockDataset` values; no
-- existing column, constraint or row is altered or removed, so it applies to a populated database
-- without touching market history, strategies, backtest runs or monitors.
--
-- `StockDataset` gains `INSIDER_TRADE`, `CONGRESS_TRADE` and `INSTITUTIONAL_HOLDING` so the three
-- new domains reuse the existing `StockDatasetState` / `StockDatasetCoverage` freshness and coverage
-- bookkeeping rather than growing a parallel one. The new values are added but never used by DDL in
-- this migration, which is what keeps the `ALTER TYPE ... ADD VALUE` statements safe inside Prisma's
-- transaction.
--
-- `ActorGroup` follows `StockList`'s ownership model exactly, including the CHECK constraint at the
-- end of this file: ownership is an invariant of the row, not a convention.
--
-- Nothing here backfills. The three domains are ingested lazily on the first read that needs them,
-- under the same coverage rules every other provider dataset follows, so an empty table simply means
-- "not ingested yet" and every alternative-data metric reads NOT_EVALUABLE until it is.

-- CreateEnum
CREATE TYPE "AlternativeActorType" AS ENUM ('INSTITUTION', 'CONGRESS_PERSON');

-- CreateEnum
CREATE TYPE "CongressChamber" AS ENUM ('HOUSE', 'SENATE');

-- CreateEnum
CREATE TYPE "InsiderTransactionCategory" AS ENUM ('OPEN_MARKET_PURCHASE', 'OPEN_MARKET_SALE', 'AWARD', 'GIFT', 'OPTION_EXERCISE', 'CONVERSION', 'DISPOSITION_TO_ISSUER', 'OTHER');

-- CreateEnum
CREATE TYPE "InsiderRole" AS ENUM ('CEO', 'CFO', 'COO', 'PRESIDENT', 'CHAIRMAN', 'DIRECTOR', 'OFFICER', 'TEN_PERCENT_OWNER', 'OTHER');

-- CreateEnum
CREATE TYPE "CongressTransactionKind" AS ENUM ('PURCHASE', 'SALE', 'EXCHANGE', 'OTHER');

-- CreateEnum
CREATE TYPE "CongressOwner" AS ENUM ('SELF', 'SPOUSE', 'JOINT', 'CHILD', 'DEPENDENT', 'OTHER', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "CongressAssetClass" AS ENUM ('STOCK', 'STOCK_OPTION', 'BOND', 'FUND', 'CRYPTO', 'OTHER');

-- CreateEnum
CREATE TYPE "InstitutionalPositionChange" AS ENUM ('NEW', 'INCREASED', 'REDUCED', 'EXITED', 'UNCHANGED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockDataset" ADD VALUE 'INSIDER_TRADE';
ALTER TYPE "StockDataset" ADD VALUE 'CONGRESS_TRADE';
ALTER TYPE "StockDataset" ADD VALUE 'INSTITUTIONAL_HOLDING';

-- CreateTable
CREATE TABLE "AlternativeDataActor" (
    "id" TEXT NOT NULL,
    "type" "AlternativeActorType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "chamber" "CongressChamber",
    "state" TEXT,
    "district" TEXT,
    "cik" TEXT,
    "metadata" JSONB,
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlternativeDataActor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActorGroup" (
    "id" TEXT NOT NULL,
    "ownership" "ContentOwnership" NOT NULL DEFAULT 'USER',
    "userId" TEXT,
    "systemKey" TEXT,
    "actorType" "AlternativeActorType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "displayOrder" INTEGER,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActorGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActorGroupMember" (
    "groupId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActorGroupMember_pkey" PRIMARY KEY ("groupId","actorId")
);

-- CreateTable
CREATE TABLE "InsiderTransaction" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "transactionDate" DATE NOT NULL,
    "filingDate" DATE NOT NULL,
    "availableFromDate" DATE NOT NULL,
    "reportingCik" TEXT NOT NULL,
    "reportingName" TEXT NOT NULL,
    "companyCik" TEXT,
    "typeOfOwner" TEXT,
    "roles" "InsiderRole"[],
    "transactionCode" TEXT,
    "transactionTypeRaw" TEXT NOT NULL,
    "category" "InsiderTransactionCategory" NOT NULL,
    "acquisitionOrDisposition" TEXT,
    "directOrIndirect" TEXT,
    "formType" TEXT,
    "securityName" TEXT,
    "securitiesTransacted" DECIMAL(24,6),
    "securitiesOwned" DECIMAL(24,6),
    "price" DECIMAL(20,8),
    "transactionValue" DECIMAL(24,4),
    "sourceUrl" TEXT,
    "raw" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsiderTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CongressTrade" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "chamber" "CongressChamber" NOT NULL,
    "transactionDate" DATE NOT NULL,
    "disclosureDate" DATE NOT NULL,
    "availableFromDate" DATE NOT NULL,
    "kind" "CongressTransactionKind" NOT NULL,
    "transactionTypeRaw" TEXT NOT NULL,
    "owner" "CongressOwner" NOT NULL,
    "ownerRaw" TEXT,
    "assetClass" "CongressAssetClass" NOT NULL,
    "assetTypeRaw" TEXT,
    "assetDescription" TEXT,
    "amountRangeRaw" TEXT,
    "amountLowerBound" DECIMAL(24,2),
    "amountUpperBound" DECIMAL(24,2),
    "capitalGainsOver200Usd" BOOLEAN,
    "comment" TEXT,
    "sourceUrl" TEXT,
    "raw" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CongressTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstitutionalFiling" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reportPeriod" DATE NOT NULL,
    "filingDate" DATE NOT NULL,
    "availableFromDate" DATE NOT NULL,
    "amendmentType" TEXT,
    "providerFilingId" TEXT,
    "raw" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstitutionalFiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstitutionalHolding" (
    "id" TEXT NOT NULL,
    "filingId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "shares" DECIMAL(24,6) NOT NULL,
    "marketValue" DECIMAL(24,2),
    "portfolioWeightPercent" DECIMAL(12,6),
    "raw" JSONB NOT NULL,

    CONSTRAINT "InstitutionalHolding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstitutionalPositionEvent" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reportPeriod" DATE NOT NULL,
    "previousReportPeriod" DATE,
    "availableFromDate" DATE NOT NULL,
    "change" "InstitutionalPositionChange" NOT NULL,
    "shares" DECIMAL(24,6) NOT NULL,
    "previousShares" DECIMAL(24,6),
    "changePercent" DECIMAL(18,6),
    "portfolioWeightPercent" DECIMAL(12,6),
    "previousPortfolioWeightPercent" DECIMAL(12,6),
    "derivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstitutionalPositionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlternativeDataActor_type_displayName_idx" ON "AlternativeDataActor"("type", "displayName");

-- CreateIndex
CREATE UNIQUE INDEX "AlternativeDataActor_type_externalId_key" ON "AlternativeDataActor"("type", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ActorGroup_systemKey_key" ON "ActorGroup"("systemKey");

-- CreateIndex
CREATE INDEX "ActorGroup_userId_idx" ON "ActorGroup"("userId");

-- CreateIndex
CREATE INDEX "ActorGroup_ownership_idx" ON "ActorGroup"("ownership");

-- CreateIndex
CREATE INDEX "ActorGroup_userId_actorType_idx" ON "ActorGroup"("userId", "actorType");

-- CreateIndex
CREATE INDEX "ActorGroupMember_actorId_idx" ON "ActorGroupMember"("actorId");

-- CreateIndex
CREATE INDEX "InsiderTransaction_securityId_availableFromDate_idx" ON "InsiderTransaction"("securityId", "availableFromDate");

-- CreateIndex
CREATE INDEX "InsiderTransaction_securityId_category_availableFromDate_idx" ON "InsiderTransaction"("securityId", "category", "availableFromDate");

-- CreateIndex
CREATE INDEX "InsiderTransaction_reportingCik_idx" ON "InsiderTransaction"("reportingCik");

-- CreateIndex
CREATE UNIQUE INDEX "InsiderTransaction_securityId_contentHash_key" ON "InsiderTransaction"("securityId", "contentHash");

-- CreateIndex
CREATE INDEX "CongressTrade_securityId_availableFromDate_idx" ON "CongressTrade"("securityId", "availableFromDate");

-- CreateIndex
CREATE INDEX "CongressTrade_securityId_kind_availableFromDate_idx" ON "CongressTrade"("securityId", "kind", "availableFromDate");

-- CreateIndex
CREATE INDEX "CongressTrade_actorId_availableFromDate_idx" ON "CongressTrade"("actorId", "availableFromDate");

-- CreateIndex
CREATE UNIQUE INDEX "CongressTrade_securityId_contentHash_key" ON "CongressTrade"("securityId", "contentHash");

-- CreateIndex
CREATE INDEX "InstitutionalFiling_actorId_availableFromDate_idx" ON "InstitutionalFiling"("actorId", "availableFromDate");

-- CreateIndex
CREATE INDEX "InstitutionalFiling_reportPeriod_idx" ON "InstitutionalFiling"("reportPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "InstitutionalFiling_actorId_reportPeriod_contentHash_key" ON "InstitutionalFiling"("actorId", "reportPeriod", "contentHash");

-- CreateIndex
CREATE INDEX "InstitutionalHolding_securityId_idx" ON "InstitutionalHolding"("securityId");

-- CreateIndex
CREATE UNIQUE INDEX "InstitutionalHolding_filingId_securityId_key" ON "InstitutionalHolding"("filingId", "securityId");

-- CreateIndex
CREATE INDEX "InstitutionalPositionEvent_securityId_availableFromDate_idx" ON "InstitutionalPositionEvent"("securityId", "availableFromDate");

-- CreateIndex
CREATE INDEX "InstitutionalPositionEvent_securityId_change_availableFromD_idx" ON "InstitutionalPositionEvent"("securityId", "change", "availableFromDate");

-- CreateIndex
CREATE INDEX "InstitutionalPositionEvent_actorId_availableFromDate_idx" ON "InstitutionalPositionEvent"("actorId", "availableFromDate");

-- CreateIndex
CREATE UNIQUE INDEX "InstitutionalPositionEvent_securityId_actorId_reportPeriod_key" ON "InstitutionalPositionEvent"("securityId", "actorId", "reportPeriod");

-- AddForeignKey
ALTER TABLE "ActorGroup" ADD CONSTRAINT "ActorGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActorGroup" ADD CONSTRAINT "ActorGroup_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActorGroupMember" ADD CONSTRAINT "ActorGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ActorGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActorGroupMember" ADD CONSTRAINT "ActorGroupMember_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AlternativeDataActor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsiderTransaction" ADD CONSTRAINT "InsiderTransaction_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CongressTrade" ADD CONSTRAINT "CongressTrade_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CongressTrade" ADD CONSTRAINT "CongressTrade_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AlternativeDataActor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstitutionalFiling" ADD CONSTRAINT "InstitutionalFiling_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AlternativeDataActor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstitutionalHolding" ADD CONSTRAINT "InstitutionalHolding_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "InstitutionalFiling"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstitutionalHolding" ADD CONSTRAINT "InstitutionalHolding_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstitutionalPositionEvent" ADD CONSTRAINT "InstitutionalPositionEvent_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstitutionalPositionEvent" ADD CONSTRAINT "InstitutionalPositionEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AlternativeDataActor"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Ownership is an invariant of the row, not a convention: a USER group has an owner and no system
-- key, a SYSTEM group has a system key and no owner. The same constraint `StockList`, `Strategy` and
-- `Monitor` carry.
ALTER TABLE "ActorGroup" ADD CONSTRAINT "ActorGroup_ownership_check" CHECK (
  ("ownership" = 'USER' AND "userId" IS NOT NULL AND "systemKey" IS NULL)
  OR ("ownership" = 'SYSTEM' AND "userId" IS NULL AND "systemKey" IS NOT NULL)
);
