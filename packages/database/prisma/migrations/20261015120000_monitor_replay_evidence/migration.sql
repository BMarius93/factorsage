-- Monitor EOD V2, step 5 (`docs/decisions/monitor-eod-v2.md` §5): the initial replay and the
-- evidence behind each transition.
--
-- Additive only:
--
-- * `Monitor.initialReplayRequested` / `replayWindowStart` / `replayWindowFixedAt` — a new Monitor's
--   first evaluation replays the 90 calendar days ending at the newest finalized session. Existing
--   Monitors default to `false`: the cutover replays nothing for them.
-- * `MonitorStateTransition.strategyVersionId` / `evidence` — the version whose logic decided a
--   change and what it read that session. Existing rows stay null and are explained by their reason.
--
-- Rollback: the previous release ignores the columns.

-- AlterTable
ALTER TABLE "Monitor" ADD COLUMN     "initialReplayRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replayWindowFixedAt" TIMESTAMP(3),
ADD COLUMN     "replayWindowStart" DATE;

-- AlterTable
ALTER TABLE "MonitorStateTransition" ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "strategyVersionId" TEXT;
