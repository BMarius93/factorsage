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
split-adjusted daily prices, completed weekly bars, dataset state and exact successful coverage
intervals. They also introduced per-family derived tables with calculation versions
(`DailyTechnical`, `WeeklyTechnical`, `IntrinsicValue`, `IntrinsicValueBlend`), **all of which were
later replaced** — see `20260830210000_unify_daily_derived_state` below, which is the current
model. Symbol is indexed lookup data and is never the durable primary key. Dataset state
watermarks optimize reads; coverage intervals, not inferred calendar rows, drive missing-range
subtraction.

Migration `20260901090000_add_email_verification_and_oauth_accounts` completes the identity model.
`User` gains a nullable `emailVerifiedAt`; `OAuthAccount` stores external identities with a unique
`(provider, providerAccountId)` and no provider tokens; `EmailVerificationToken` stores one
outstanding token per user as a hash only. Accounts created before verification existed are
backfilled as verified so existing local logins keep working.

Migration `20260901171729_add_stock_lists` adds the user-owned stock-list slice: `StockList`
(cascades from `User`), `StockListItem` with `@@unique([stockListId, securityId])`, a
`BuyWindowMode` enum (`FULL`/`CUSTOM`), and `StockListBuyWindow` holding canonical normalized
CUSTOM date ranges (`@db.Date`, nullable `endDate` = open-ended). `StockListItem.securityId` is
`onDelete: Restrict` because catalog rows are never product-deleted and user list data must not
vanish through a catalog mutation. The migration also carries three auto-generated
`FinancialStatement` index renames: the original migration declared names longer than
PostgreSQL's 63-character identifier limit, so every database holds the truncated names and
Prisma reconciles them to its canonical truncation. See `ai/product/lists.md` for the invariants.

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

Migration `20260901234500_add_weekly_moving_averages` adds the seven catalog weekly moving-average
columns (`sma20w`/`sma50w`/`sma100w`/`sma200w`, `ema20w`/`ema50w`/`ema200w`) to
`DailyDerivedState`, beside the existing `weeklySourceWeekStart`. They are nullable
`DECIMAL(20,8)`: NULL keeps meaning "not eligible yet / insufficient warm-up", never zero. No
weekly-cadence indicator table is reintroduced — `WeeklyPrice` stays the completed-week aggregate
and the unified daily row stays the only materialized derived representation. The columns are
deliberately left NULL on existing rows: `DERIVED_STATE_REVISION` moves 2 -> 3 in the same change,
so `daily-derived-state:r2` coverage and r2 cache manifests report nothing for the current variant
and the canonical rebuild recalculates and replaces those rows with complete weekly values. See
`docs/decisions/selectable-series-catalog.md` for the catalog these periods come from.
