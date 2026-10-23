-- Monitor rolling 30-day activity window (`docs/decisions/monitor-eod-v2.md` §12).
--
-- 1. `MonitorEvaluationCheckpoint.coverageStart`: where each member's recorded evaluation begins.
-- 2. `Monitor.initialReplayRequested` becomes `windowReplay`: a member a Monitor has never evaluated
--    is evaluated over the rolling 30-day window rather than reconstructed at its newest session.
-- 3. `MonitorScanSchedule.scanRequested`: a Monitor that started running asks for its catch-up now.
--
-- Additive apart from the rename. No Signal, transition, state or price is rewritten.

-- 1. Coverage. Nothing recorded where a checkpoint's evaluation began, so every existing row first
--    receives a bound it can prove: the session it has already reached. From there on every session
--    is stepped in order, so nothing earlier is claimed.
ALTER TABLE "MonitorEvaluationCheckpoint" ADD COLUMN "coverageStart" DATE;

UPDATE "MonitorEvaluationCheckpoint" SET "coverageStart" = "evaluatedThrough";

-- A member of a Monitor's initial universe that the retired 90-day replay evaluated is covered from
-- that window (or its membership's later start): the replay stepped every session of it and recorded
-- every change. Claimed only where every durable fact says that replay is still the member's
-- evaluation — the replay window is fixed, the Monitor was never rebound since, the member was listed
-- and its membership last edited before the window was fixed, and no administrative ending
-- (a removal, a membership change, a rebind) was ever recorded for it. Anything else keeps the bound
-- above.
UPDATE "MonitorEvaluationCheckpoint" AS c
SET "coverageStart" = GREATEST(m."replayWindowStart", COALESCE(c."membershipStart", m."replayWindowStart"))
FROM "Monitor" AS m, "StockListItem" AS i
WHERE c."monitorId" = m."id"
  AND i."stockListId" = m."stockListId"
  AND i."securityId" = c."securityId"
  AND m."initialReplayRequested"
  AND m."replayWindowStart" IS NOT NULL
  AND m."replayWindowFixedAt" IS NOT NULL
  AND c."configVersion" = m."configVersion"
  AND c."membershipRecorded"
  AND i."createdAt" <= m."replayWindowFixedAt"
  AND i."updatedAt" <= m."replayWindowFixedAt"
  AND GREATEST(m."replayWindowStart", COALESCE(c."membershipStart", m."replayWindowStart")) <= c."evaluatedThrough"
  AND NOT EXISTS (
    SELECT 1
    FROM "MonitorStateTransition" AS t
    WHERE t."monitorId" = c."monitorId"
      AND t."securityId" = c."securityId"
      AND t."reason" IN ('MEMBERSHIP_CHANGED', 'MEMBER_REMOVED', 'MONITOR_REBOUND')
  );

-- 2. The window replay. Every Monitor the product holds asks for it from now on: its members with a
--    checkpoint are unaffected (they catch up from it), and a member never evaluated — one added later,
--    one whose data had not arrived — is evaluated over the rolling window. The 90-day columns stay
--    as the record of what that replay fixed.
ALTER TABLE "Monitor" RENAME COLUMN "initialReplayRequested" TO "windowReplay";
ALTER TABLE "Monitor" ALTER COLUMN "windowReplay" SET DEFAULT true;
UPDATE "Monitor" SET "windowReplay" = true WHERE NOT "windowReplay";

-- 3. The catch-up request.
ALTER TABLE "MonitorScanSchedule" ADD COLUMN "scanRequested" BOOLEAN NOT NULL DEFAULT false;
