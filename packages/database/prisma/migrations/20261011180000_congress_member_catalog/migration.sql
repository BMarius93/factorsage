-- AlterTable
ALTER TABLE "AlternativeDataActor" ADD COLUMN     "profileName" TEXT;

-- CreateTable
CREATE TABLE "CongressMemberCatalogSync" (
    "id" TEXT NOT NULL,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "runSequence" INTEGER NOT NULL DEFAULT 0,
    "lastStartedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastSummary" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CongressMemberCatalogSync_pkey" PRIMARY KEY ("id")
);

