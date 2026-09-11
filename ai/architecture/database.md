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

Migration `20260907072239_add_strategies` adds the user-owned strategy slice: `Strategy`
(cascades from `User`, indexed by `userId` and by `(userId, updatedAt)` for the collection's
newest-changed ordering) and `StrategyVersion` with `@@unique([strategyId, versionNumber])`.
`StrategyVersion.definition` is a `Json` column holding the canonical document produced by
`normalizeStrategyDefinition` in `@intrinsic/contracts`, carrying its own `schemaVersion`;
`definitionHash` covers that document with row identifiers stripped, so re-keying a Builder row
never appends a version while genuine reordering does. Version rows are written once and never
updated: a strategy referenced by a completed backtest can never be altered retroactively, and the
current version is simply the highest `versionNumber`. Strategy names are deliberately **not**
unique per user — there is no `(userId, name)` constraint, because identity is the strategy id.
Nothing queries inside the document in SQL. See
`../../docs/decisions/strategy-definition-storage.md` for the accepted decision and
`../product/strategies.md` for the product invariants.

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

Migration `20260907195815_add_backtests_and_benchmarks` adds the Backtest V1 slice in two parts.
`20260908075035_add_backtest_run_milestones`, `20260908090000_unique_backtest_milestone_year` and
`20260908080859_add_backtest_failure_phase` extend it with the annual milestone table and the user-facing failure
phase column.

**Benchmarks.** `Benchmark` is system-owned product identity (`code` unique, `name`, `description`,
`isActive`, `displayOrder`). Everything that decides what its numbers _are_ lives on
`BenchmarkSeries` — an **append-only** definition (`sourceKind`, `providerSymbol`, `currency`,
`methodologyVersion`) with `@@unique([benchmarkId, version])`. Reconciliation compares against the
version currently in force and appends when it differs, which is what makes it idempotent — there is
deliberately no unique constraint over the definition itself, because that would make returning a
benchmark to a source it used before impossible. `BenchmarkDailyPrice` is keyed `@@id([seriesId, date])`, and
`BenchmarkDatasetState`/`BenchmarkDatasetCoverage` are keyed by `seriesId` too, mirroring the stock
dataset watermark/coverage contract exactly.

Keying market data by the series and not the product row is what makes a run reproducible:
re-sourcing `SP500` appends version 2 and leaves version 1's bars, coverage and watermarks exactly
where they were. `BacktestRun.benchmarkSeriesId` (`onDelete: Restrict`) pins the version a run
compares against and `executionCalendarSeriesId` pins the one that supplied its simulated dates;
migration `20260908130000_immutable_benchmark_series` introduces both and backfills every existing
benchmark's current definition as its version 1. They are
deliberately **separate tables from `Security`/`DailyPrice`**: a benchmark is passive comparison
data with no fundamentals, no derived state and no position, and folding it into the security
catalog would drag all of that along with it. `BenchmarkSourceKind` ships one member, `FMP_SYMBOL`;
`BenchmarkDataset` ships one member, `DAILY_PRICE`. See `benchmark-data.md`.

**Backtests.** `BacktestRun` carries ownership, denormalized configuration columns for the
collection page, and the immutable `snapshot` JSON plus its `snapshotHash`. Its
`strategyId`/`strategyVersionId`/`stockListId` foreign keys are **nullable and `onDelete: SetNull`
on purpose**: deleting a strategy or a list must never delete or reinterpret a completed run, and
no read path depends on those rows — the snapshot is the authority. `benchmarkId` is
`onDelete: Restrict` because a benchmark is system-owned and never product-deleted.

`BacktestJob` is the durable queue: one row per run (`runId @unique`), created in the same
transaction as the run so queue and execution record cannot diverge, with `availableAt`, `attempts`,
`maxAttempts`, `claimedBy`, `claimedAt`, `leaseExpiresAt` and `heartbeatAt`. It is indexed by
`(status, availableAt)` for claiming and `(status, leaseExpiresAt)` for stale recovery. No queue
library and no second migration history.

`BacktestRunProgress` (1:1, `runId @id`) holds the hot-path progress columns and the latest live
checkpoint `snapshot`. It is a separate table because those columns are rewritten every few
simulated trading days while the run row — including its large immutable submission snapshot — is
not. `sequence` is a monotonic counter so a poller can discard an out-of-order response without
comparing clocks across processes.

`BacktestRunMilestone` (`@@id([runId, sequence])`, `@@unique([runId, year])`) is the durable
counterpart: one append-only row per calendar year a run finishes, holding only that year's scalars
and **never a curve**, so a thirty-year run adds thirty small rows rather than thirty copies of a
daily series. The year is unique per run so a re-delivered checkpoint is skipped rather than
appended under a fresh sequence. Rows are deleted with the attempt that wrote them when a run is
requeued or released, because a retry re-simulates from the first day.

Results are normalized: `BacktestDailyEquity` (`@@id([runId, date])`, carrying the time-weighted
`returnIndex` and the nullable `benchmarkIndex` — null means the benchmark had no value at or before
that date, never zero), `BacktestTrade` (`@@unique([runId, sequence])`, the deterministic execution
order), `BacktestPosition` (final open positions) and `BacktestRunSummary` (one row of aggregates).
`BacktestTrade.securityId` and `BacktestPosition.securityId` are `onDelete: Restrict` for the same
reason `StockListItem.securityId` is, and both denormalize `symbol`/`name` so a completed result
renders without joining the mutable catalog.

Migration `20260911110000_add_monitors` adds the Monitor V1 slice: `Monitor`, `MonitorSignalState`,
`MonitorSignal`, `MonitorScanSchedule` and the `MonitorEvaluationOutcome`, `MonitorEvaluableResult`
and `MonitorLevelKind` enums. See `../product/monitors.md` for the product invariants and
`monitor-engine.md` for the engine.

`Monitor` (cascades from `User`) is a Strategy plus a Stock List plus `enabled`. It references
`Strategy`, **not** a pinned `StrategyVersion`: a Monitor is live, so editing the Strategy must
change what is being watched. There is deliberately **no cadence, interval or schedule column** —
`../product/monitors.md` keeps monitoring cadence an application decision, and a column would make
it a user-configurable one.

`MonitorSignalState` is the durable transition state, one row per `(monitorId, securityId, levelId)`
under the explicitly named `MonitorSignalState_identity_key` (the generated name would exceed
PostgreSQL's 63-character limit). It is the minimum state that makes trigger and condition semantics
survive a restart, and it is not a cache of anything. Three columns carry the decisions:
`lastEvaluableResult` is the latch and can only ever hold a **decided** value, which is why
`MonitorEvaluableResult` has two members while `MonitorEvaluationOutcome` has three — a
`NOT_EVALUABLE` cycle records itself in `lastOutcome` only, so a provider outage can neither end an
active match nor re-emit it on recovery. `strategyVersionId` scopes the latch to the definition that
produced it, so state recorded under an edited Strategy never decides a transition. `stateVersion`
is an optimistic guard: the transition is applied with an `updateMany` filtered on the version it was
read at, so two workers whose leases briefly overlap cannot both emit a Signal for one transition.

`MonitorSignal` is the append-only product record, created on the `NOT_MATCHED -> MATCHED` edge and
only there — which is what stops a condition that stays true from producing a Signal per scan, and a
trigger that fired from repeating while the value stays on the same side. `resolvedAt` is set when
the match ends; rows are never deleted. `MonitorSignalState.activeSignalId` is `@unique`, so one
state can never point at two live Signals. `hasTrigger` is explanation metadata, not a second
product concept. Signals cascade from `Monitor`: unlike a `BacktestRun`, a Signal is not an
independently addressable user-owned execution record — it names a level id inside that Monitor's
Strategy and means nothing without it. `securityId` is `onDelete: Restrict` for the same reason
`StockListItem.securityId` is.

`MonitorScanSchedule` is the durable scan cadence: exactly one row, id `GLOBAL`. A worker claims it
with `SELECT ... FOR UPDATE SKIP LOCKED` once `dueAt` has passed, holds a renewable lease while it
runs the cycle, then sets the next `dueAt` and releases — so cadence survives a restart, two
processes never scan at once, and no cron, timer or queue library is involved. A crashed holder's
lease expires and any worker frees it, which is the one failure mode a singleton has that a queue of
independent jobs does not.
