-- CreateEnum
CREATE TYPE "ContentOwnership" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MonitorLifecycleState" AS ENUM ('INACTIVE', 'PENDING_TRIGGER', 'ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "MonitorTransitionReason" AS ENUM ('CONDITIONS_MET', 'SETUP_STARTED', 'TRIGGER_FIRED', 'CONDITIONS_ENDED', 'EVENT_SESSION_ENDED', 'BUY_WINDOW_CLOSED', 'LOGIC_CHANGED', 'LEVEL_REMOVED', 'MEMBER_REMOVED', 'MONITOR_REBOUND', 'RECONSTRUCTED');

-- AlterTable
ALTER TABLE "Monitor" ADD COLUMN     "displayOrder" INTEGER,
ADD COLUMN     "isGloballyEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isPublished" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ownership" "ContentOwnership" NOT NULL DEFAULT 'USER',
ADD COLUMN     "systemKey" TEXT,
ADD COLUMN     "updatedByUserId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MonitorSignal" ADD COLUMN     "reconstructed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resolutionReason" "MonitorTransitionReason",
ADD COLUMN     "resolvedObservationDate" DATE,
ADD COLUMN     "signalFingerprint" TEXT;

-- AlterTable
ALTER TABLE "MonitorSignalState" ADD COLUMN     "lifecycleSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lifecycleSinceDate" DATE,
ADD COLUMN     "lifecycleSincePrice" DECIMAL(20,8),
ADD COLUMN     "lifecycleState" "MonitorLifecycleState" NOT NULL DEFAULT 'INACTIVE',
ADD COLUMN     "ruleStates" JSONB NOT NULL DEFAULT '{}';

-- Backfill the lifecycle from the pre-lifecycle latch. A row carrying an active Signal is ACTIVE
-- since that Signal's activation; every other row is INACTIVE. A trigger Signal's fire date was its
-- own observation date, so `lifecycleSinceDate` carries it forward: rule-local state inherits it
-- (`inheritedRule` in @intrinsic/strategy) until the first observation writes `ruleStates`.
UPDATE "MonitorSignalState" AS state
SET "lifecycleState" = 'ACTIVE',
    "lifecycleSince" = signal."detectedAt",
    "lifecycleSinceDate" = signal."observationDate",
    "lifecycleSincePrice" = signal."observationPrice"
FROM "MonitorSignal" AS signal
WHERE signal."id" = state."activeSignalId";

UPDATE "MonitorSignalState"
SET "lifecycleSince" = "lastEvaluableAt"
WHERE "activeSignalId" IS NULL;

UPDATE "MonitorSignal" AS signal
SET "signalFingerprint" = state."signalFingerprint"
FROM "MonitorSignalState" AS state
WHERE state."activeSignalId" = signal."id";

-- Superseded by `ruleStates[*].triggerDate`, now backfilled through `lifecycleSinceDate`.
ALTER TABLE "MonitorSignalState" DROP COLUMN "lastTriggerSignalDate";

-- AlterTable
ALTER TABLE "StockList" ADD COLUMN     "displayOrder" INTEGER,
ADD COLUMN     "ownership" "ContentOwnership" NOT NULL DEFAULT 'USER',
ADD COLUMN     "systemKey" TEXT,
ADD COLUMN     "updatedByUserId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Strategy" ADD COLUMN     "displayOrder" INTEGER,
ADD COLUMN     "ownership" "ContentOwnership" NOT NULL DEFAULT 'USER',
ADD COLUMN     "systemKey" TEXT,
ADD COLUMN     "updatedByUserId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "MonitorStateTransition" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "monitorId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "levelKind" "MonitorLevelKind" NOT NULL,
    "exitRuleId" TEXT,
    "signalFingerprint" TEXT NOT NULL,
    "fromState" "MonitorLifecycleState" NOT NULL,
    "toState" "MonitorLifecycleState" NOT NULL,
    "reason" "MonitorTransitionReason" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observationDate" DATE,
    "signalId" TEXT,

    CONSTRAINT "MonitorStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBuiltInMonitorPreference" (
    "userId" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBuiltInMonitorPreference_pkey" PRIMARY KEY ("userId","monitorId")
);

-- CreateIndex
CREATE INDEX "MonitorStateTransition_identity_idx" ON "MonitorStateTransition"("monitorId", "securityId", "levelId", "sequence");

-- CreateIndex
CREATE INDEX "MonitorStateTransition_monitorId_sequence_idx" ON "MonitorStateTransition"("monitorId", "sequence");

-- CreateIndex
CREATE INDEX "MonitorStateTransition_securityId_idx" ON "MonitorStateTransition"("securityId");

-- CreateIndex
CREATE INDEX "MonitorStateTransition_signalId_idx" ON "MonitorStateTransition"("signalId");

-- CreateIndex
CREATE INDEX "UserBuiltInMonitorPreference_monitorId_idx" ON "UserBuiltInMonitorPreference"("monitorId");

-- CreateIndex
CREATE UNIQUE INDEX "Monitor_systemKey_key" ON "Monitor"("systemKey");

-- CreateIndex
CREATE INDEX "Monitor_ownership_isGloballyEnabled_idx" ON "Monitor"("ownership", "isGloballyEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "StockList_systemKey_key" ON "StockList"("systemKey");

-- CreateIndex
CREATE INDEX "StockList_ownership_idx" ON "StockList"("ownership");

-- CreateIndex
CREATE UNIQUE INDEX "Strategy_systemKey_key" ON "Strategy"("systemKey");

-- CreateIndex
CREATE INDEX "Strategy_ownership_idx" ON "Strategy"("ownership");

-- AddForeignKey
ALTER TABLE "StockList" ADD CONSTRAINT "StockList_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Monitor" ADD CONSTRAINT "Monitor_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorStateTransition" ADD CONSTRAINT "MonitorStateTransition_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorStateTransition" ADD CONSTRAINT "MonitorStateTransition_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorStateTransition" ADD CONSTRAINT "MonitorStateTransition_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "MonitorSignal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBuiltInMonitorPreference" ADD CONSTRAINT "UserBuiltInMonitorPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBuiltInMonitorPreference" ADD CONSTRAINT "UserBuiltInMonitorPreference_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Ownership is an invariant of the row, not a convention: a USER row has an owner and no system
-- key, a SYSTEM row has a system key and no owner.
ALTER TABLE "StockList" ADD CONSTRAINT "StockList_ownership_check" CHECK (
  ("ownership" = 'USER' AND "userId" IS NOT NULL AND "systemKey" IS NULL)
  OR ("ownership" = 'SYSTEM' AND "userId" IS NULL AND "systemKey" IS NOT NULL)
);

ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_ownership_check" CHECK (
  ("ownership" = 'USER' AND "userId" IS NOT NULL AND "systemKey" IS NULL)
  OR ("ownership" = 'SYSTEM' AND "userId" IS NULL AND "systemKey" IS NOT NULL)
);

-- A USER Monitor is never hidden or globally paused: its own `enabled` is its switch.
ALTER TABLE "Monitor" ADD CONSTRAINT "Monitor_ownership_check" CHECK (
  ("ownership" = 'USER' AND "userId" IS NOT NULL AND "systemKey" IS NULL
    AND "isPublished" AND "isGloballyEnabled")
  OR ("ownership" = 'SYSTEM' AND "userId" IS NULL AND "systemKey" IS NOT NULL)
);
