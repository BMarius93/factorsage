-- User: per-address registration-email cooldown (AUTH-003, `ai/architecture/authentication.md`).
--
-- Additive and non-destructive: one nullable column, no backfill. Every existing row starts at
-- NULL, which means "no registration email claimed since AUTH-003", so the first register or
-- resend request after the deploy for any account may send one email and the cooldown applies from
-- then on. Nothing reads or writes the column except that claim, and code built before this
-- migration never selects it, so rolling the application back leaves it harmlessly unused.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "registrationEmailClaimedAt" TIMESTAMP(3);
