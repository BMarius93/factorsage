-- Monetary backtest *results* move from numeric(20,2) to numeric(24,6).
--
-- Two decimals cannot hold the values this product produces. At the contract minimum initial
-- capital of 1 a BUY legitimately spends 0.025 and was stored as 0.03 — a 20% error that then
-- propagated into average cost — while a real profit of 0.004 was stored as 0.00 and still counted
-- as a winning trade, so `BacktestRunSummary` and `BacktestTrade` were not mutually reconcilable.
-- In the 1,000-case validation matrix 1,708 of 3,648 minimum-capital exits were in that state.
--
-- Six decimals rather than eight or ten: six is the largest scale that is still meaningful at the
-- contract maximum initial capital of 1e9 and at the largest transaction observed ($2.6bn), where
-- one float64 ULP is 1.19e-7 and 4.77e-7 respectively. Twenty-four digits leaves eighteen for the
-- integer part, comfortably above the largest observed portfolio of $334,310,721,745.96.
--
-- Only columns that participate in a reconciliation identity change. User-entered initial capital
-- and monthly contribution stay at two decimals because they are inputs, never derived.
-- `BacktestRunMilestone` stays because it is observational progress, dropped on a terminal status.
-- Prices, percentages, ratios and share quantities are untouched.
--
-- Existing rows are widened in place. That is not a backfill and does not recover anything: a value
-- already rounded to 0.03 becomes 0.030000, not the 0.025 it should have been.
--
-- A run completed before this change is still identifiable, but by the **absence** of
-- `resultPrecision` from its snapshot's methodology rather than by an older value of it: the field
-- did not exist, so those snapshots carry no key for it at all. Nothing is backfilled into them —
-- writing one now would claim the old runs recorded something they never did. Only runs submitted
-- from this build onwards carry `decimal-ledger-24-6@1`.

ALTER TABLE "BacktestTrade"
  ALTER COLUMN "amount"      TYPE numeric(24,6),
  ALTER COLUMN "fees"        TYPE numeric(24,6),
  ALTER COLUMN "realizedPnl" TYPE numeric(24,6),
  ALTER COLUMN "cashAfter"   TYPE numeric(24,6);

ALTER TABLE "BacktestDailyEquity"
  ALTER COLUMN "cash"              TYPE numeric(24,6),
  ALTER COLUMN "positionsValue"    TYPE numeric(24,6),
  ALTER COLUMN "totalValue"        TYPE numeric(24,6),
  ALTER COLUMN "investedCapital"   TYPE numeric(24,6),
  ALTER COLUMN "benchmarkValue"    TYPE numeric(24,6),
  ALTER COLUMN "cashBaselineValue" TYPE numeric(24,6);

ALTER TABLE "BacktestPosition"
  ALTER COLUMN "marketValue"   TYPE numeric(24,6),
  ALTER COLUMN "unrealizedPnl" TYPE numeric(24,6);

ALTER TABLE "BacktestRunSummary"
  ALTER COLUMN "investedCapital"     TYPE numeric(24,6),
  ALTER COLUMN "finalCash"           TYPE numeric(24,6),
  ALTER COLUMN "finalPositionsValue" TYPE numeric(24,6),
  ALTER COLUMN "finalValue"          TYPE numeric(24,6),
  ALTER COLUMN "netProfit"           TYPE numeric(24,6),
  ALTER COLUMN "realizedPnl"         TYPE numeric(24,6),
  ALTER COLUMN "unrealizedPnl"       TYPE numeric(24,6);
