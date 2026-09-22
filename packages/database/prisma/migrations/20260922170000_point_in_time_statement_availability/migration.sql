-- Point-in-time availability for statements whose provider "filing date" is not a filing date.
--
-- FMP reports the fiscal period end in `filingDate` (and in `acceptedDate`) when it does not hold
-- the real filing date. `availableFromDate = filingDate + 1 day` then makes a quarter's figures
-- usable the day after the quarter closed, weeks before any filing existed — look-ahead in every
-- historical intrinsic value and every backtest that reads one. The data-correctness audit measured
-- 2,391 of 16,793 stored statements in that state (AUD-03).
--
-- Rows keep the rule `statementPublicAvailabilityDate` in `@intrinsic/domain` now applies at write
-- time: the statutory deadline for the report (45 days after a quarter, 90 after a fiscal year;
-- `Q4` is published with the annual report), moved to the following Monday when it lands on a
-- weekend, plus one day. Availability only ever moves later — `greatest` keeps a restatement's own
-- observation-derived date when that is later still.
UPDATE "FinancialStatement" AS f
SET "availableFromDate" = GREATEST(
      f."availableFromDate",
      due.date + INTERVAL '1 day'
    )::date
FROM (
  SELECT
    s.id,
    (
      CASE EXTRACT(DOW FROM s."fiscalDate" + deadline.days)
        WHEN 6 THEN s."fiscalDate" + deadline.days + INTERVAL '2 days'
        WHEN 0 THEN s."fiscalDate" + deadline.days + INTERVAL '1 day'
        ELSE s."fiscalDate" + deadline.days
      END
    )::date AS date
  FROM "FinancialStatement" s
  CROSS JOIN LATERAL (
    SELECT (CASE WHEN s.period IN ('FY', 'Q4') THEN 90 ELSE 45 END) * INTERVAL '1 day' AS days
  ) AS deadline
  WHERE s."filingDate" <= s."fiscalDate"
) AS due
WHERE f.id = due.id;
