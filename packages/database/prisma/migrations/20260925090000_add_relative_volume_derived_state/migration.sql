-- Relative Volume (RVOL) over canonical daily session volumes, one column per supported period.
--
-- Additive and nullable, leaving every existing row NULL. Nothing is back-filled in SQL: the
-- canonical rebuild is the only calculation path for a derived series, and `DERIVED_STATE_REVISION`
-- is bumped to 6 in the same change so existing coverage and cache manifests report nothing for
-- the current variant. That is what makes `CanonicalStockDataService` recalculate and replace the
-- affected rows on next access; without the bump these columns would read NULL indefinitely, which
-- is indistinguishable from warm-up.
--
-- `DailyPrice.volume` already exists and is already populated from the same FMP historical EOD
-- payload the OHLC values come from, so no price backfill and no new provider request is involved.
ALTER TABLE "DailyDerivedState" ADD COLUMN "rvol10" DECIMAL(20,8);
ALTER TABLE "DailyDerivedState" ADD COLUMN "rvol20" DECIMAL(20,8);
ALTER TABLE "DailyDerivedState" ADD COLUMN "rvol50" DECIMAL(20,8);
