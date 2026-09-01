# Database Architecture

V2 has one Prisma schema and one migration history under `packages/database/prisma`.

API and worker may both depend on `@intrinsic/database`, but they do not share an in-memory PrismaClient. Each OS/container process owns its own client and pool.

Do not put Prisma in `apps/web`.

Initial engine: PostgreSQL. Do not change database engine as part of unrelated rewrite work.

## Current product model

Migration `20260822183050_add_user_auth` adds the first product table: the minimal `User` identity
model and `UserRole` enum (`USER`, `ADMIN`). PostgreSQL owns the unique email constraint. Email is
normalized by application write/lookup paths, and `passwordHash` is nullable for future external
identity compatibility.

Migrations `20260823120000_add_stock_data_loader` and
`20260823160000_add_stock_dataset_coverage` add UUID-based Security identity, current profile,
split-adjusted daily prices, versioned daily technicals, completed weekly bars/generic weekly
technical storage, dataset state and exact successful coverage intervals, and point-in-time
intrinsic-value/blend snapshots. Symbol is indexed lookup data and is never the durable primary
key. Dataset state watermarks optimize reads; coverage intervals, not inferred calendar rows,
drive missing-range subtraction.

Migration `20260901090000_add_email_verification_and_oauth_accounts` completes the identity model.
`User` gains a nullable `emailVerifiedAt`; `OAuthAccount` stores external identities with a unique
`(provider, providerAccountId)` and no provider tokens; `EmailVerificationToken` stores one
outstanding token per user as a hash only. Accounts created before verification existed are
backfilled as verified so existing local logins keep working.

Migration `20260830210000_unify_daily_derived_state` replaces the per-family derived tables
(`DailyTechnical`, `WeeklyTechnical`, `IntrinsicValue`, `IntrinsicValueBlend`) with one
`DailyDerivedState` table keyed by `(securityId, date)`. Every calculation-version dimension is
removed from the derived path: `StockDatasetState.calculationVersion` and
`WeeklyPrice.calculationVersion` are dropped, and no derived table stores a methodology version.
One current methodology is materialized per trading day; a methodology change is an explicit
rebuild driven by `DERIVED_STATE_REVISION` in the dataset variant, not a parallel version history.
The redundant `DailyPrice(securityId, date)` index is dropped because the composite primary key
already serves the only historical access pattern. See
`docs/decisions/stock-data-foundation.md` for the invariants.
