-- Monitor window completeness (`docs/decisions/monitor-eod-v2.md` §12.2, §12.3).
--
-- 1. `MonitorScanSchedule.latestSession`, `latestSessionCalendar`, `latestSessionAt`: the newest
--    finalized session the Monitor pass's canonical end-of-day policy found (venue schedule, or the
--    weekday fallback), and when it asked. The Dashboard anchors its rolling 30-day window on it
--    rather than on a calendar day, so a weekend or an exchange holiday never moves the window.
-- 2. `MonitorEvaluationCheckpoint.coverageBlockedFrom`: the window start a coverage back-fill could
--    not reconcile with the member's recorded decisions. Nothing is rewritten to make it fit; the
--    member reports partial history and the back-fill is tried again only once the window start
--    has moved past it.
--
-- Additive. No existing row changes.

ALTER TABLE "MonitorScanSchedule"
  ADD COLUMN "latestSession" DATE,
  ADD COLUMN "latestSessionCalendar" TEXT,
  ADD COLUMN "latestSessionAt" TIMESTAMP(3);

ALTER TABLE "MonitorEvaluationCheckpoint" ADD COLUMN "coverageBlockedFrom" DATE;
