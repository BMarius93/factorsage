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

The one-column-per-series shape of `DailyDerivedState` is an accepted decision, not an accident:
see `../../docs/decisions/retain-wide-column-calculated-series-storage.md` for why JSONB is
deferred and EAV rejected, and `calculated-series.md` for how the columns are calculated, mapped
and cached. Adding a series column follows
`../../docs/development/adding-a-calculated-series.md`.

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

Migration `20260902120000_add_daily_rsi_oscillators` adds the daily RSI oscillator family —
`rsi7d`, `rsi14d`, `rsi21d` — to `DailyDerivedState` as three nullable `DECIMAL(20,8)` columns, one
additive migration for the whole family. The values are unitless (`[0, 100]`) Wilder RSI over the
same canonical daily closes as the daily moving averages; zero is a real reading (an only-losses
window), so NULL is the only representation of "not warmed up yet". Existing rows are left NULL on
purpose: `DERIVED_STATE_REVISION` moves 3 -> 4 in the same change, r3 coverage and r3 cache
manifests report nothing for the current variant, and the canonical rebuild recalculates and
replaces the affected rows lazily on next access — the revision stays global, so this one bump
covers all three periods and every security.

No migration accompanies `docs/decisions/complete-price-coverage.md`. Historical price coverage is
revisioned the same way the derived state is: `PRICE_DATASET_VERSION`
(`packages/stock-data/src/ports.ts`, 1 -> 2) is the price-dataset revision, recorded in the Redis
manifest as `priceDatasetVersion` and in the `DAILY_PRICE` coverage/state variant, now
`split-adjusted-eod-full:v2`. Rows under the v1 variant `split-adjusted-eod-full` were written
when a provider response capped at 5000 rows could be recorded as complete coverage; the v2 loader
never reads them, re-verifies the caller's target lazily on next access with complete provider
requests, and deletes the superseded `DAILY_PRICE` variants in the transaction that records the
current one. The freshness watermark `split-adjusted-eod-full:recent-tail` is unchanged. This is
the `DERIVED_STATE_REVISION` mechanism applied to prices: global, lazy, no schema change and no
data migration.
