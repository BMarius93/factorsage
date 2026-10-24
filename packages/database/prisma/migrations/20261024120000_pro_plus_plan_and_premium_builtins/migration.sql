-- Entitlements V2 (docs/decisions/entitlements-v2.md). Additive and non-destructive: no row loses
-- data, no plan is reassigned, and nothing a customer owns is read or rewritten.

-- The fourth commercial plan, "Pro+". Only billing reconciliation ever writes it (changeUserPlan).
-- PostgreSQL 12+ allows ADD VALUE inside the migration's transaction; nothing below uses the new
-- value, which is the one restriction that applies.
-- AlterEnum
ALTER TYPE "UserPlan" ADD VALUE 'PRO_PLUS';

-- Premium built-in content (§6): a premium SYSTEM List or Strategy is read in full, backtested and
-- copied only on a plan that includes premium content.
-- AlterTable
ALTER TABLE "StockList" ADD COLUMN     "premium" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Strategy" ADD COLUMN     "premium" BOOLEAN NOT NULL DEFAULT false;

-- Only built-in content can be premium. A customer's copy of a premium built-in is ordinary content
-- they own, so a USER row marked premium would be a row no reader could explain.
ALTER TABLE "StockList" ADD CONSTRAINT "StockList_premium_system_only_check" CHECK (
  "premium" = false OR "ownership" = 'SYSTEM'
);
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_premium_system_only_check" CHECK (
  "premium" = false OR "ownership" = 'SYSTEM'
);

-- Point-in-time index universes are premium by definition (§6). The one that exists is projected by
-- `pnpm data:index-universe -- project`, which now writes the flag itself; this marks a projection
-- that predates it. A database that has never projected the universe updates nothing.
UPDATE "StockList"
SET "premium" = true
WHERE "ownership" = 'SYSTEM' AND "systemKey" = 'sp500-historical-pit';
