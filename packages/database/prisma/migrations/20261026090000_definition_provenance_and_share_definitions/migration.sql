-- Canonical definitions on shared backtests, and the origin of customer Lists and Strategies
-- (docs/decisions/canonical-definitions-v1.md).
--
-- Additive only: every new column is nullable or defaulted, nothing existing is rewritten, and no
-- row is backfilled. A List or Strategy created before this migration keeps NULL origin columns,
-- which mean "not recorded"; a share created before it keeps NULL definitions and descriptions and
-- reads exactly as it always has.

CREATE TYPE "ContentOrigin" AS ENUM ('AUTHORED', 'COPIED');

ALTER TABLE "Strategy"
  ADD COLUMN "origin" "ContentOrigin",
  ADD COLUMN "originSystemKey" TEXT,
  ADD COLUMN "originVersionNumber" INTEGER,
  ADD COLUMN "originDefinitionHash" TEXT;

-- An origin belongs to customer content; the source columns only to a copy, all three together.
ALTER TABLE "Strategy"
  ADD CONSTRAINT "Strategy_origin_user_only_check"
    CHECK ("origin" IS NULL OR "ownership" = 'USER'),
  ADD CONSTRAINT "Strategy_origin_source_check"
    CHECK (
      ("originSystemKey" IS NULL AND "originVersionNumber" IS NULL AND "originDefinitionHash" IS NULL)
      OR ("origin" = 'COPIED' AND "originSystemKey" IS NOT NULL AND "originVersionNumber" IS NOT NULL
          AND "originDefinitionHash" IS NOT NULL)
    );

ALTER TABLE "StockList"
  ADD COLUMN "origin" "ContentOrigin",
  ADD COLUMN "originSystemKey" TEXT,
  ADD COLUMN "originMembershipDigest" TEXT;

ALTER TABLE "StockList"
  ADD CONSTRAINT "StockList_origin_user_only_check"
    CHECK ("origin" IS NULL OR "ownership" = 'USER'),
  ADD CONSTRAINT "StockList_origin_source_check"
    CHECK (
      ("originSystemKey" IS NULL AND "originMembershipDigest" IS NULL)
      OR ("origin" = 'COPIED' AND "originSystemKey" IS NOT NULL AND "originMembershipDigest" IS NOT NULL)
    );

ALTER TABLE "BacktestShare"
  ADD COLUMN "definitions" JSONB,
  ADD COLUMN "descriptions" JSONB,
  ADD COLUMN "publishDescriptions" BOOLEAN NOT NULL DEFAULT false;

-- A share holds both or neither: never a definition without its description, or the reverse.
ALTER TABLE "BacktestShare"
  ADD CONSTRAINT "BacktestShare_definitions_complete_check"
    CHECK (("definitions" IS NULL) = ("descriptions" IS NULL));
