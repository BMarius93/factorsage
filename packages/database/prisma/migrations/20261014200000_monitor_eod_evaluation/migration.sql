-- Monitor EOD V2, step 3 (`docs/decisions/monitor-eod-v2.md` §3): the per-session EOD evaluation.
--
-- Additive only. Nothing is deleted, rewritten or re-decided:
--
-- * `MonitorEvaluationCheckpoint` — one row per (Monitor, member): the newest session evaluated,
--   advanced in the same transaction as the Signals and transitions it produced. No backfill: a
--   member with state but no checkpoint is evaluated from the newest finalized session on.
-- * `MonitorSignal.observationBasis` — every existing occurrence was decided on a V1 provisional
--   intraday quote, so existing rows are tagged `LIVE_QUOTE` and their prices and decisions are kept
--   exactly as recorded; the column then defaults to `EOD_CLOSE` for the evaluation that follows.
-- * `MonitorStateTransition.origin` — existing rows are classified from their reason alone:
--   `RECONSTRUCTED` was replayed history, the configuration reasons observed no session, and every
--   other change was observed by the V1 cycle.
-- * `Monitor.watchingSince` — no backfill: the evaluation stamps every running Monitor on its first
--   pass, so a session that finalized before the deployment is never reported as newly observed.
--
-- Rollback: the previous release ignores the new columns and table. Dropping them loses only the
-- V2 progress records; the Signals and transitions written meanwhile are ordinary rows.

-- CreateEnum
CREATE TYPE "MonitorTransitionOrigin" AS ENUM ('OBSERVED', 'HISTORY', 'ADMINISTRATIVE');

-- CreateEnum
CREATE TYPE "MonitorObservationBasis" AS ENUM ('LIVE_QUOTE', 'EOD_CLOSE');

-- AlterTable
ALTER TABLE "Monitor" ADD COLUMN     "watchingSince" TIMESTAMP(3);

-- AlterTable: existing occurrences are V1 live-quote observations; new ones default to EOD closes.
ALTER TABLE "MonitorSignal" ADD COLUMN     "observationBasis" "MonitorObservationBasis" NOT NULL DEFAULT 'LIVE_QUOTE';
ALTER TABLE "MonitorSignal" ALTER COLUMN "observationBasis" SET DEFAULT 'EOD_CLOSE';

-- AlterTable: classify existing transitions by their reason.
ALTER TABLE "MonitorStateTransition" ADD COLUMN     "origin" "MonitorTransitionOrigin" NOT NULL DEFAULT 'OBSERVED';
UPDATE "MonitorStateTransition" SET "origin" = 'HISTORY' WHERE "reason" = 'RECONSTRUCTED';
UPDATE "MonitorStateTransition" SET "origin" = 'ADMINISTRATIVE'
  WHERE "reason" IN ('LOGIC_CHANGED', 'LEVEL_REMOVED', 'MEMBER_REMOVED', 'MONITOR_REBOUND');

-- CreateTable
CREATE TABLE "MonitorEvaluationCheckpoint" (
    "monitorId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "evaluatedThrough" DATE NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "basisGeneration" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitorEvaluationCheckpoint_pkey" PRIMARY KEY ("monitorId","securityId")
);

-- CreateIndex
CREATE INDEX "MonitorEvaluationCheckpoint_securityId_idx" ON "MonitorEvaluationCheckpoint"("securityId");

-- AddForeignKey
ALTER TABLE "MonitorEvaluationCheckpoint" ADD CONSTRAINT "MonitorEvaluationCheckpoint_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorEvaluationCheckpoint" ADD CONSTRAINT "MonitorEvaluationCheckpoint_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
