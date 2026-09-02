-- Weekly moving averages on the unified daily derived state.
--
-- The selectable-series catalog fixes the weekly period set as SMA 20W/50W/100W/200W and
-- EMA 20W/50W/200W. Their values are calculated from completed weekly bars aggregated out of
-- `DailyPrice` and carried forward onto every trading day beside `weeklySourceWeekStart`, which
-- until now recorded only *which* completed week was effective and never its values.
--
-- No weekly-cadence indicator table is introduced: `WeeklyPrice` stays the completed-week
-- aggregate and `DailyDerivedState` stays the single daily-materialized derived representation,
-- keyed by (securityId, date) with no calculation-version dimension.
--
-- NULL keeps meaning "not eligible yet / insufficient warm-up". Zero is never a weekly value, and
-- no value is back-filled before the trading day it first became eligible on.

-- AlterTable
ALTER TABLE "DailyDerivedState" ADD COLUMN     "sma20w" DECIMAL(20,8),
ADD COLUMN     "sma50w" DECIMAL(20,8),
ADD COLUMN     "sma100w" DECIMAL(20,8),
ADD COLUMN     "sma200w" DECIMAL(20,8),
ADD COLUMN     "ema20w" DECIMAL(20,8),
ADD COLUMN     "ema50w" DECIMAL(20,8),
ADD COLUMN     "ema200w" DECIMAL(20,8);

-- The new columns are left NULL on existing rows on purpose: an existing row was materialized by
-- the r2 methodology, which had no weekly values at all. Back-filling them here would be a second
-- calculation path outside the canonical rebuild.
--
-- `DERIVED_STATE_REVISION` moves 2 -> 3 in the same change, so the derived dataset variant becomes
-- `daily-derived-state:r3`. Existing r2 coverage rows and r2 Redis manifests then report no
-- coverage for the current variant, and the canonical rebuild recalculates and replaces the
-- affected rows with complete weekly values. Stale r2 rows therefore cannot masquerade as complete
-- weekly coverage while these columns are NULL.
