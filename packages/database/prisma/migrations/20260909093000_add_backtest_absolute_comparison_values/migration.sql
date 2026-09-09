-- The backtest result gains the two absolute comparison scenarios the chart now shows beside the
-- Strategy: a passive benchmark portfolio funded by the run's own cash flows, and the capital that
-- was never invested.
--
-- `totalValue` already *is* the Strategy line, so only these two are new. Nothing existing is
-- redefined: `returnIndex`, `benchmarkIndex` and every metric built on them — return, alpha, CAGR,
-- both drawdowns — keep the `time-weighted-index@1` meaning they were written under. The new
-- semantics are recorded as their own methodology version, `comparisonScenarios`, so a run cannot
-- be executed under one set of rules and stamped with another.
--
-- Backfill, and why the two columns are treated differently:
--
--   cashBaselineValue = initialCapital + cumulative contributions through the date.
--   `investedCapital` on the same row is already exactly that quantity — the loader has written it
--   since the first backtest — so copying it is a projection of a value these rows already hold
--   under a name that cannot be confused with the Strategy's uninvested `cash`. It is not a
--   reinterpretation, and a completed run's Cash line is therefore the true one.
--
--   benchmarkValue is NOT backfilled, and stays nullable forever.
--   A funded benchmark portfolio buys fractional shares at the price in effect on each contribution
--   date, so its value depends on prices this table never stored. `initialCapital × benchmarkIndex`
--   would only equal it for a run with no contributions at all, and guessing it for the rest would
--   put a fabricated number on a completed run's chart. A run that predates the scenario simply has
--   no S&P 500 line; its percentage benchmark return is unaffected.

ALTER TABLE "BacktestDailyEquity" ADD COLUMN "benchmarkValue" DECIMAL(20,2);
ALTER TABLE "BacktestDailyEquity" ADD COLUMN "cashBaselineValue" DECIMAL(20,2);

UPDATE "BacktestDailyEquity" SET "cashBaselineValue" = "investedCapital"
WHERE "cashBaselineValue" IS NULL;

ALTER TABLE "BacktestDailyEquity" ALTER COLUMN "cashBaselineValue" SET NOT NULL;
