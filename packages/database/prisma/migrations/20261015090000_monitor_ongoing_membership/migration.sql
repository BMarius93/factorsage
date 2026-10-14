-- Monitor EOD V2, step 4 (`docs/decisions/monitor-eod-v2.md` §4): ongoing List membership.
--
-- Additive only:
--
-- * `MonitorTransitionReason.MEMBERSHIP_CHANGED` — the administrative ending recorded when a
--   security still in the List stops being a current member there (its open-ended period was
--   closed, moved or removed). Existing `BUY_WINDOW_CLOSED` rows stay exactly as recorded: they are
--   what the V1 Monitor observed under its BUY-window rule.
-- * `MonitorEvaluationCheckpoint.membershipRecorded` / `membershipStart` — which ongoing membership
--   a member's progress belongs to. Existing rows are `membershipRecorded = false` and are adopted
--   under the member's current membership on the next evaluation, never reset for it.
--
-- The new enum value is not used in this migration, so adding it inside the migration transaction
-- is safe. Rollback: the previous release never writes the value and ignores the columns.

-- AlterEnum
ALTER TYPE "MonitorTransitionReason" ADD VALUE 'MEMBERSHIP_CHANGED';

-- AlterTable
ALTER TABLE "MonitorEvaluationCheckpoint" ADD COLUMN     "membershipRecorded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "membershipStart" DATE;
