-- User: session revocation counter (SESSION-002, `ai/architecture/authentication.md`).
--
-- Additive and non-destructive. Every existing row takes the default `0`, which is exactly the
-- value a session issued before this migration is treated as carrying: a token without the `sv`
-- claim is accepted only while the account is still at version 0, so deploying this does not sign
-- anybody out, and the account's first increment (password reset, "sign out everywhere") revokes
-- those legacy tokens like any other. PostgreSQL 11+ adds a NOT NULL column with a constant default
-- as a catalog change, without rewriting the table.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;
