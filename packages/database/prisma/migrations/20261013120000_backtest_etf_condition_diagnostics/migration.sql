-- Strategy ETF Conditions V1 (`docs/decisions/strategy-etf-conditions-v1.md`,
-- `ai/architecture/strategy-etf-conditions.md` §7).
--
-- One nullable JSONB column on the completed-run summary: the per-ETF availability of the run's
-- ETF condition sources (`BacktestEtfConditionDiagnosticsResponse[]` in `@intrinsic/contracts`),
-- written by the worker with the rest of the result so the detail page can say why an ETF
-- condition could not evaluate — not bootstrapped, not synchronized, no finalized session, or a
-- failed read. NULL for every run whose strategy reads no ETF, which is every run that existed
-- before the feature. Additive only; no backfill, no new table, no index.
ALTER TABLE "BacktestRunSummary" ADD COLUMN "etfConditionDiagnostics" JSONB;
