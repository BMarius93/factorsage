-- Monitor EOD V2, step 6 (`docs/decisions/monitor-eod-v2.md` §6): the Monitor Activity feed reads a
-- Monitor's transitions newest session first, in insertion order. Index only; no data changes.

-- CreateIndex
CREATE INDEX "MonitorStateTransition_monitorId_observationDate_sequence_idx" ON "MonitorStateTransition"("monitorId", "observationDate", "sequence");
