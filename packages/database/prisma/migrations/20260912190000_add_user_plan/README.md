# Add the commercial plan to `User`

Adds the `UserPlan` enum (`FREE | STARTER | PRO`) and a non-null `User.plan` column defaulted to
`FREE`, for Entitlements V1 (`docs/decisions/entitlements-v1.md`).

**Purely additive and non-destructive.** Every existing row gets `FREE` from the column default; no
list, strategy, backtest or monitor row is read, rewritten or deleted. That is deliberate: the
decision document forbids destructive downgrade migrations, and content that exceeds a plan stays
intact and readable — compliance is *derived* from current entitlements and current resource state,
never persisted as a flag that can go stale.

`GUEST` is deliberately not a value: guest entitlements are derived from the absence of an
authenticated session, so no anonymous `User` row exists. `ADMIN` is deliberately not a value
either — it is a role on `User.role`, never a commercial plan, and a billing provider must never be
able to grant it.

Rollback is `ALTER TABLE "User" DROP COLUMN "plan"; DROP TYPE "UserPlan";`, which loses only the
plan assignment itself.
