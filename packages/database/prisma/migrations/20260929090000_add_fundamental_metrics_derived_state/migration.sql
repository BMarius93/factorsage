-- Fundamental Metrics V1 on the unified daily derived state.
--
-- `docs/decisions/fundamental-metrics-v1.md` locks fifteen statement-derived metrics and
-- `docs/decisions/fundamental-metrics-storage-and-evaluation.md` stores them exactly like every other
-- calculated series: one nullable DECIMAL(20,8) column per metric on `DailyDerivedState`, keyed by
-- (securityId, date) with no calculation-version dimension. No new table, no JSONB, no EAV and no
-- per-metric cache key.
--
-- Percent metrics (growth, margins, ROIC, ROE, ROA) are stored in percentage points: 15.42 means
-- 15.42%. Debt / Equity, Current Ratio, Net Debt / EBITDA, Interest Coverage and Asset Turnover are
-- raw multiples. NULL means the metric is unavailable on that trading day and is never written as a
-- stand-in zero.
--
-- The columns are additive and left NULL on every existing row on purpose. Nothing is back-filled
-- in SQL: the canonical rebuild, which materializes the metrics from point-in-time
-- `FinancialStatement` revisions onto the `DailyPrice` trading days, is the only calculation path.
-- `DERIVED_STATE_REVISION` moves 6 -> 7 in the same change, so existing r6 coverage rows and Redis
-- manifests report nothing for the current variant and each security's history is recalculated and
-- replaced on its next access — one global, lazy rebuild, one bump for all fifteen metrics. Without
-- that bump these columns would read NULL indefinitely, indistinguishable from "unavailable".

-- AlterTable
ALTER TABLE "DailyDerivedState" ADD COLUMN     "assetTurnoverTtm" DECIMAL(20,8),
ADD COLUMN     "currentRatio" DECIMAL(20,8),
ADD COLUMN     "debtToEquity" DECIMAL(20,8),
ADD COLUMN     "epsGrowthTtmYoy" DECIMAL(20,8),
ADD COLUMN     "fcfGrowthTtmYoy" DECIMAL(20,8),
ADD COLUMN     "fcfMarginTtm" DECIMAL(20,8),
ADD COLUMN     "grossMarginTtm" DECIMAL(20,8),
ADD COLUMN     "interestCoverageTtm" DECIMAL(20,8),
ADD COLUMN     "netDebtToEbitdaTtm" DECIMAL(20,8),
ADD COLUMN     "netMarginTtm" DECIMAL(20,8),
ADD COLUMN     "operatingMarginTtm" DECIMAL(20,8),
ADD COLUMN     "revenueGrowthTtmYoy" DECIMAL(20,8),
ADD COLUMN     "roaTtm" DECIMAL(20,8),
ADD COLUMN     "roeTtm" DECIMAL(20,8),
ADD COLUMN     "roicTtm" DECIMAL(20,8);

