-- Daily RSI oscillators on the unified daily derived state.
--
-- The selectable-series catalog adds the OSCILLATORS family with RSI 7D/14D/21D. All three are
-- one Wilder methodology parameterized by period, calculated per trading day from the same
-- canonical completed daily closes the daily moving averages consume. Values are unitless and lie
-- in [0, 100]; the period counts trading-day observations, so RSI 14D first materializes on the
-- fifteenth close regardless of weekends and holidays.
--
-- The wide-column model is unchanged: one nullable DECIMAL(20,8) column per series on
-- `DailyDerivedState`, keyed by (securityId, date) with no calculation-version dimension. No
-- JSONB, no long-form table, no per-series cache key.
--
-- NULL keeps meaning "not eligible yet / insufficient warm-up". Zero is a real RSI value (an
-- only-losses window) and is never written as a stand-in for absence, and no value is back-filled
-- before the trading day it first became eligible on.

-- AlterTable
ALTER TABLE "DailyDerivedState" ADD COLUMN     "rsi7d" DECIMAL(20,8),
ADD COLUMN     "rsi14d" DECIMAL(20,8),
ADD COLUMN     "rsi21d" DECIMAL(20,8);

-- The new columns are left NULL on existing rows on purpose: an existing row was materialized by
-- the r3 methodology, which had no oscillators at all. Back-filling them here would be a second
-- calculation path outside the canonical rebuild.
--
-- `DERIVED_STATE_REVISION` moves 3 -> 4 in the same change, so the derived dataset variant becomes
-- `daily-derived-state:r4`. Existing r3 coverage rows and r3 Redis manifests then report no
-- coverage for the current variant, and the canonical rebuild recalculates and replaces the
-- affected rows — one global, lazy rebuild for the whole family, exactly one revision bump for all
-- three periods.
