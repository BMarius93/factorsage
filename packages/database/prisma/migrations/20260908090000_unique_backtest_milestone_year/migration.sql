-- A run completes each calendar year once. Without this, a re-delivered checkpoint would append a
-- second row for the same year under the next sequence number instead of being skipped.
CREATE UNIQUE INDEX "BacktestRunMilestone_runId_year_key" ON "BacktestRunMilestone"("runId", "year");
