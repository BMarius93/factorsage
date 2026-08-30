-- Per-model intrinsic-value point-in-time provenance.
--
-- One row-level `intrinsicSourceDataAsOf` was not sufficient: each intrinsic-value model may
-- consume a different financial-statement family/revision, so its inputs can become public at a
-- different instant. Provenance therefore becomes per model while row identity stays exactly
-- (securityId, date): no provenance rows, no provenance table, no calculation version.
--
-- Blend provenance is deliberately NOT persisted. It is derived at read time as the maximum
-- provenance of the models that compose the blend, and a blend is unavailable unless every
-- required component value and component provenance is present and eligible.
--
-- Pre-production: derived state is fully recalculable from canonical prices and PIT financial
-- statements, so the old row-level provenance is dropped rather than migrated. Canonical
-- FinancialStatement point-in-time semantics are unchanged.

-- AlterTable
ALTER TABLE "DailyDerivedState" DROP COLUMN "intrinsicSourceDataAsOf",
ADD COLUMN     "dcfFcffSourceAsOf" TIMESTAMP(3),
ADD COLUMN     "residualIncomeSourceAsOf" TIMESTAMP(3),
ADD COLUMN     "ddmSourceAsOf" TIMESTAMP(3),
ADD COLUMN     "grahamSourceAsOf" TIMESTAMP(3);

-- A materialized intrinsic value without its own provenance can never be point-in-time eligible,
-- so previously materialized values are cleared instead of being left unreadable. The next derived
-- rebuild republishes them with per-model provenance. Technical indicator columns are untouched.
UPDATE "DailyDerivedState"
SET "dcfFcff" = NULL,
    "residualIncome" = NULL,
    "ddm" = NULL,
    "graham" = NULL,
    "blendBalanced" = NULL,
    "blendConservative" = NULL,
    "blendDividend" = NULL,
    "intrinsicCurrency" = NULL
WHERE "dcfFcff" IS NOT NULL
   OR "residualIncome" IS NOT NULL
   OR "ddm" IS NOT NULL
   OR "graham" IS NOT NULL
   OR "blendBalanced" IS NOT NULL
   OR "blendConservative" IS NOT NULL
   OR "blendDividend" IS NOT NULL;
