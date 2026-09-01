# Stock Data Foundation

## Status

Foundation decision for the next implementation slice. This document defines contracts and test expectations only; it does not implement FMP loading, Redis caching, Prisma persistence, technical calculations, intrinsic-value formulas, or Stock Details HTTP endpoints. The later `stock-data-loader-implementation.md` decision supersedes this document wherever this foundation describes requested ranges as hydration boundaries.

## Goals

- One canonical stock-data access boundary for both API Stock Details and worker backtests.
- PostgreSQL remains the durable source of truth.
- Redis is a disposable symbol-level cache with LRU residency management.
- FMP is upstream data, not the product domain model.
- Date-range queries are first-class read projections. They do not bound canonical hydration.
- Historical fundamentals and intrinsic values remain point-in-time correct and cannot use future filings/data.
- Backtest-facing derived data is materialized on every eligible trading day, including values whose underlying source only changes weekly or when new fundamentals become available.
- All daily-materialized derived families live in one `DailyDerivedState` row per security per trading day. There is one current methodology; historical calculation versions never coexist.
- For every Redis-resident stock, the full configured daily historical state needed by backtests is available in Redis and participates in complete-stock LRU residency/eviction.

## Canonical historical price series

The durable daily price series is split-adjusted OHLCV from FMP's normal historical EOD series. Splits are still persisted as corporate-action events when implemented, but the application does not reconstruct split-adjusted OHLCV itself.

Dividend-adjusted prices are not the canonical trading/backtest series. Dividends remain separate events so total-return behavior can be modeled explicitly.

Daily bars are the canonical persisted market-data granularity in V1. Weekly/monthly bars are derived from daily data rather than fetched/stored as an independent source of truth.

Provider ordering is not a domain contract. Even if FMP returns newest-first, repository/service historical reads should expose ascending chronological order unless a future endpoint explicitly documents another order.

## V1 moving averages

Persist these daily derived values:

- SMA 20D
- SMA 50D
- SMA 100D
- SMA 200D
- EMA 20D
- EMA 50D
- EMA 200D

The persisted/API field names make the timeframe explicit:

- `sma20d`
- `sma50d`
- `sma100d`
- `sma200d`
- `ema20d`
- `ema50d`
- `ema200d`

The application calculates these from canonical daily closes. FMP technical-indicator endpoints may be used as an external validation oracle, not as the production calculation dependency.

Indicator period means number of source bars, not calendar days. `SMA(20, 1D)` and `SMA(20, 1W)` are different indicators.

Insufficient warm-up history produces an unavailable/absent derived value, not zero. EMA seed/warm-up semantics must be documented and locked by tests before historical values are materialized.

## Weekly technical semantics

Weekly indicators are derived entirely from canonical `DailyPrice`; they are not a second market-data source.

The calculation path is:

```text
DailyPrice
  -> aggregate completed trading weeks
  -> weekly OHLCV bars
  -> calculate weekly SMA/EMA
  -> materialize the latest eligible weekly value onto each trading day
```

A weekly bar uses:

- open = first trading-day open of the week
- high = maximum daily high in the week
- low = minimum daily low in the week
- close = last trading-day close of the week
- volume = sum of daily volume in the week

The implementation distinguishes why canonical history starts mid-week. A first week truncated
only by the configured historical horizon is omitted because its opening daily rows are missing. A
known IPO/listing that genuinely starts mid-week remains a valid completed week.

Do not calculate weekly moving averages by averaging daily moving-average values.

For point-in-time/backtest behavior, only completed weekly periods are eligible. A Monday-Thursday backtest date must not see a weekly indicator that depends on the close of the upcoming Friday. The V1 backtest policy remains `COMPLETED_PERIODS_ONLY`.

Once a weekly indicator becomes eligible, its latest value must be materialized on every subsequent eligible trading day until a newer completed-week value replaces it. Repetition is intentional. The backtest-facing durable representation is daily-aligned even though the underlying weekly calculation changes only once per completed week.

Example:

```text
Monday    ema20w = 183.4
Tuesday   ema20w = 183.4
Wednesday ema20w = 183.4
Thursday  ema20w = 183.4
Friday    ema20w = 186.1   # after the new weekly period is complete
```

A future Stock Details/UI feature may explicitly introduce a provisional week-to-date indicator based on the current partial week. Such a value must be clearly distinguished from completed-period historical values and must never leak into backtest/PIT calculations.

The later product decision in `selectable-series-catalog.md` fixes the weekly catalog as SMA 20W/50W/100W/200W and EMA 20W/50W/200W. `1W` remains the explicit timeframe identity, and all completed-period rules in this document remain authoritative.

## Daily materialized backtest state

Trading day is the canonical availability granularity for derived backtest data.

For every trading day in the supported history, persist the values that were eligible by that day's PIT cutoff. A derived value may therefore repeat across many rows when its source changes less frequently than daily. This is desired behavior because the backtest should consume a daily-aligned state rather than resolve sparse events or carry values forward itself.

Examples of daily-materialized derived values include:

- daily SMA/EMA values;
- weekly SMA/EMA values carried forward from the latest completed weekly period;
- intrinsic-value model results carried forward from the latest eligible fundamentals-driven calculation;
- intrinsic-value blend results carried forward from the latest eligible component values;
- future ratios/features explicitly added to the backtest daily state.

Do not fabricate a value before it first becomes eligible. If an indicator lacks warm-up history or an intrinsic-value model is unavailable/not applicable, the daily value remains absent until a valid value exists.

The source data remains stored at its natural cadence: prices daily, financial statements as PIT filing/revision snapshots, and other future event data at its own event cadence. Daily materialization applies to the derived/backtest-facing state, not to duplicating raw source events.

The V1 daily state is an end-of-trading-day state. A completed weekly period or newly eligible filing may affect that trading day's materialized state only when its eligibility rules say the information is available by that cutoff. Same-day before-open execution semantics, if introduced later, require an explicit separate timing policy rather than silently reusing end-of-day state.

## Unified daily derived state persistence

All daily-materialized derived families are one table, not one table per family:

```text
DailyDerivedState
  PRIMARY KEY (securityId, date)
```

Rules that later work must not reverse:

1. Exactly one row per security per trading day. The composite primary key is the identity.
2. `calculationVersion` is **not** part of the primary key and is not a column anywhere in the
   daily derived path. One current methodology is materialized; a methodology change rebuilds and
   replaces the affected rows. Old methodologies are not kept side by side. `BacktestRun` may
   preserve its own result/audit snapshot separately.
3. The only historical access pattern is `securityId + date range, ascending`. The composite
   primary key already provides that B-tree path, so do not add a redundant `(securityId, date)`
   secondary index. Add an index only for a genuinely different query pattern.
4. Ticker/symbol never participates in durable historical identity. Resolve symbol -> `Security`
   once, then use `securityId`.
5. Do not rely on physical row ordering; always order explicitly by `date`.
6. Do not denormalize canonical source data into it. `DailyPrice`, point-in-time
   `FinancialStatement` revisions, and `Security` identity/profile stay separate and keep their own
   natural cadence. `WeeklyPrice` remains a completed-week aggregate at weekly cadence; only the
   derived weekly *indicator* values are carried forward daily.
7. An absent value means not yet eligible or insufficient warm-up. Never write zero, and never
   back-fill a value before its first eligible trading day.
8. Point-in-time provenance is per intrinsic-value model (one nullable timestamp column per
   model), and blend provenance is derived from its components rather than stored. Provenance is
   column data only; it never becomes an identity, version, or history dimension.

Methodology changes are handled by an explicit rebuild, not by version history. The
`DERIVED_STATE_REVISION` constant is recorded only in the dataset-state/coverage variant and in the
cache manifest. Bumping it reports no coverage for the new variant, which recalculates and replaces
the materialized state.

The weekly indicator catalog is now fixed by `selectable-series-catalog.md`. Its seven value
columns must be added to `DailyDerivedState` and carried forward beside `weeklySourceWeekStart`,
the completed week whose values are effective on that trading day. Do not reintroduce a
weekly-cadence indicator table.

## V1 intrinsic-value models

- `DCF_FCFF`
- `RESIDUAL_INCOME`
- `DDM`
- `GRAHAM`

Each intrinsic-value result records `sourceDataAsOf`. Implementations must only use information that was public by that point in time.

`sourceDataAsOf` is the latest publication/availability instant among the inputs actually used by the calculation. It is an audit/no-look-ahead field, not merely the fiscal period end date.

### FCFF input convention (not yet implemented)

The verified FMP sign conventions in `fundamentals-loader.md` fix how FCFF inputs will be
assembled once the methodology is decided. Recording the convention now prevents a sign error
later; no formula, growth assumption, or TTM assembly is implemented by this decision.

```text
FCFF_TTM input construction =
    operatingCashFlow_TTM
  + capitalExpenditure_TTM        // already signed negative; this is an addition
  + after-tax interest expense
```

Rules that follow from the provider semantics:

- `capitalExpenditure` is added, never subtracted, because FMP already reports it negative.
- `changeInWorkingCapital` must **not** appear in this construction. Its effect is already
  contained in `operatingCashFlow`, and the FMP field is the signed cash-flow contribution rather
  than a conventional positive delta-NWC.
- `interestExpense` is a positive magnitude, so the after-tax add-back is
  `interestExpense * (1 - effectiveTaxRate)`.
- FMP's `freeCashFlow` is a reconciliation/cross-check value, not the primary FCFF input.

### Provenance is per model, not per row

Point-in-time provenance belongs to the individual model. Models may consume different
financial-statement families/revisions, so their inputs can become public at different instants.
`DailyDerivedState` therefore carries one nullable provenance timestamp per model:

- `dcfFcffSourceAsOf`
- `residualIncomeSourceAsOf`
- `ddmSourceAsOf`
- `grahamSourceAsOf`

A single row-level `intrinsicSourceDataAsOf` is explicitly rejected: it would delay every model on
the row to the newest source instant. There are no provenance rows or provenance tables; row
identity remains exactly `(securityId, date)`, `intrinsicCurrency` stays shared, and no
calculation version or methodology history is introduced.

Read rules:

1. A model response's `sourceDataAsOf` comes from that model's own provenance column.
2. The `asOf` cutoff is applied independently per model. On the same daily row, a model whose
   inputs were public by the cutoff is returned while a later-sourced model on that row is not.
   For example, with `grahamSourceAsOf = 2026-04-21` and `dcfFcffSourceAsOf = 2026-05-02`, a query
   at `asOf = 2026-04-25` may return `GRAHAM` and must not return `DCF_FCFF`.
3. A model value with no provenance instant is never returned. A materialized value is only
   point-in-time readable together with its own provenance.

The V1 formulas, constants, growth methodology, availability rules and golden vectors for these
models are locked in `intrinsic-value-engine.md`.

Intrinsic-value formulas need to be recalculated only when a relevant PIT input becomes newly eligible or the calculation methodology/version changes. However, the resulting latest eligible value is materialized onto every trading day from its first eligible trading day until the next valuation event. Backtests therefore read a daily intrinsic-value series directly from storage/cache rather than performing sparse-event resolution themselves.

For example:

```text
2026-05-05 DCF = 180
2026-05-06 DCF = 180
...
2026-08-03 DCF = 180
2026-08-04 DCF = 195   # newly eligible fundamentals changed the calculation
2026-08-05 DCF = 195
```

The implementation must define a consistent market-time cutoff for when a newly published filing becomes eligible in a backtest. A valuation may never become historically visible before every source input used by it was public.

## V1 blends

Blend definitions are versioned product methodology:

- `BALANCED` v1: 50% DCF FCFF, 30% Residual Income, 20% Graham
- `CONSERVATIVE` v1: 40% DCF FCFF, 30% Residual Income, 30% Graham
- `DIVIDEND` v1: 40% DCF FCFF, 40% DDM, 20% Residual Income

Blend weights must sum to 1. A change to weights creates a new blend version rather than silently changing historical interpretation.

A missing/not-applicable component must be handled explicitly. For example, DDM may be unavailable for a company that does not pay a meaningful dividend. The implementation must not silently pull a future component value, substitute another model, or renormalize weights unless a later product decision explicitly defines that behavior.

Eligible blend results follow the same daily materialization policy as individual intrinsic-value models: the latest valid PIT blend value is stored on each trading day until its component state changes.

### Blend provenance is derived, never stored

Blends do not get their own provenance columns. A materialized blend's `sourceDataAsOf` is derived
as the maximum provenance of the models that actually compose it:

```text
BALANCED     = max(dcfFcffSourceAsOf, residualIncomeSourceAsOf, grahamSourceAsOf)
CONSERVATIVE = max(dcfFcffSourceAsOf, residualIncomeSourceAsOf, grahamSourceAsOf)
DIVIDEND     = max(dcfFcffSourceAsOf, ddmSourceAsOf, residualIncomeSourceAsOf)
```

A blend is only point-in-time eligible when every required component value **and** every required
component provenance timestamp is present and eligible at the requested `asOf` cutoff. A missing
component value or a missing component provenance makes the blend unavailable; weights are never
renormalized, and no component is ever substituted.

## Dataset state

Do not add `lastUpdatedPrice`, `lastUpdatedFinancials`, etc. columns to `Security`.

The persistence implementation should use a dataset-state model conceptually equivalent to:

- security
- dataset
- earliest available date
- latest available date
- last successful sync timestamp
- variant identifying the sync configuration (and, for the derived dataset, its methodology
  revision, so a methodology change reports no coverage and forces a rebuild)

This enables delta-aware canonical hydration: Redis -> PostgreSQL -> determine missing canonical-horizon coverage -> FMP/calculation -> persist delta -> refresh yearly cache chunks.

`earliestDate`/`latestDate` are watermarks, not proof that there can never be an internal data gap. Missing-range logic must remain aware of trading calendars/provider availability and must not infer that every calendar day between the bounds should contain a market row.

`lastSyncedAt` means the last successful persistence/sync operation. Failed/partial upstream attempts must not advance it as if data had been committed successfully.

No Prisma migration is included in this foundation PR. The implementation PR must add the schema through an explicit migration and migration note.

## Shared loader boundary

Both Stock Details and backtests must consume the same stock-data service. API and worker are separate processes but must not implement separate market-data/business-loading logic.

Expected service capabilities:

- retrieve Security identity/profile data
- retrieve daily price history by date range
- retrieve daily technical history by date range
- retrieve financial/fundamental history by date range/as-of criteria
- retrieve daily-aligned weekly technical history once weekly indicators are implemented
- retrieve daily-aligned intrinsic-value history by model and date range/as-of date
- retrieve daily-aligned intrinsic-value blend history by blend and date range/as-of date
- compose Stock Details from those datasets

The implementation may internally use cache, repository, upstream provider, and calculation-engine ports, but callers must not depend directly on Redis, Prisma, or FMP.

A Stock Details page load and a worker backtest asking for the same symbol/range must ultimately receive equivalent canonical domain data.

## Implementation guardrails for coding agents

1. Read `AGENTS.md`, `ai/README.md`, this decision, and relevant architecture docs before changing code.
2. Do not map FMP JSON directly into API contracts or Prisma models. Keep provider DTOs/quirks inside `@intrinsic/fmp` and map them deliberately into domain values.
3. Do not put Prisma, Redis clients, HTTP calls, environment access, or FMP DTOs into `@intrinsic/domain` or `@intrinsic/valuation`.
4. Do not duplicate loader orchestration in `apps/api` and `apps/worker`.
5. If a new shared application package is introduced for loader orchestration, update architecture/dependency documentation explicitly.
6. PostgreSQL is authoritative. Redis is disposable and rebuildable.
7. Redis LRU residency is symbol-level. Eviction removes the complete cached symbol.
8. Cache misses hydrate the configured canonical horizon, but PostgreSQL coverage ensures FMP receives only missing canonical deltas. Caller ranges only slice reads.
9. Historical reads are deterministic and ascending by effective date.
10. Derived values are persisted for performance but reproducible from canonical inputs under the current methodology.
11. Never fill missing technical warm-up values, unavailable intrinsic-value models, or unknown provider fields with fabricated zero/default financial values.
12. Point-in-time correctness is a hard invariant.
13. Daily technical names must retain their `d` suffix. Do not introduce ambiguous `sma20`/`ema50` fields once timeframe-aware contracts exist.
14. Weekly indicators must be derived from weekly bars aggregated from daily bars, not from daily indicator values.
15. Backtests may only use completed weekly periods. Do not expose a Friday-complete value to earlier dates in that same week.
16. Materialize the latest eligible weekly indicator on every trading day until the next completed-week value becomes eligible. Do not make the backtest resolve sparse weekly snapshots itself.
17. Materialize eligible intrinsic-value model and blend results on every trading day; do not require backtests to carry sparse valuation events forward.
17b. Keep all daily-materialized derived families in one `DailyDerivedState` row keyed by
    `(securityId, date)`. Never add a calculation version to daily derived identity, never split a
    family into its own daily table, and never cache a key per indicator/model/blend.
18. Every Redis-resident stock must expose the complete configured daily historical state needed by backtests. Redis eviction is complete-stock LRU, never partial-dataset product eviction.
19. Keep the next PR reviewable and avoid unrelated product changes.

## Redis direction

Cached derived state uses one yearly chunk family per security:

```text
security:<securityId>:daily-state:<year>
```

Do not introduce a Redis key per indicator, model, or blend. Every key belonging to a stock must be
registered so complete-stock LRU eviction removes all of its cached datasets together.

Redis maintains a configurable maximum number of resident symbols and evicts complete symbols using application-level LRU semantics. Redis remains disposable and cannot be the only copy of durable historical or user-owned data.

For a resident symbol, Redis must contain the complete configured historical data needed to serve backtests without reconstructing daily state from sparse weekly/intrinsic events on every request. This includes daily price/technical history and, when implemented, daily-materialized weekly technicals, intrinsic-value model results, and intrinsic-value blend results. Historical fundamentals also remain available for the resident symbol according to their own canonical PIT representation.

Yearly/chunked keys may be used to keep writes and reads bounded, but all keys belonging to the stock must participate in the existing registered-key/generation mechanism and complete-stock LRU eviction. The maximum number of resident stocks is configurable. Access to a stock refreshes its residency/LRU position according to the cache policy.

Redis memory-limit/eviction configuration may be used as a safety net, but product residency semantics belong to the application-level symbol cache policy.

## Required implementation tests

### Unit tests

1. FMP DTO -> domain mapping keeps provider quirks outside the domain.
2. Daily EOD mapping preserves split-adjusted OHLCV semantics.
3. Canonical-horizon gap detection covers empty, full-hit, missing-prefix, missing-suffix, and internal coverage gaps.
4. Dataset-state updates are monotonic, and a methodology-revision change starts a fresh watermark rather than widening the previous one.
5. SMA 20D/50D/100D/200D calculations are deterministic with correct warm-up behavior.
6. EMA 20D/50D/200D calculations use one documented seed/warm-up convention.
7. Moving-average outputs are compared against trusted FMP fixtures within an explicit numeric tolerance.
8. Daily technical serialization uses `sma20d`/`ema20d`-style timeframe-explicit names and never ambiguous names.
9. Weekly aggregation from daily bars correctly derives open/high/low/close/volume for normal and holiday-shortened weeks.
10. Weekly indicator tests prove a Monday-Thursday `asOf` cannot observe a value requiring the future week-ending close.
11. Weekly daily-materialization tests prove the latest completed weekly value is repeated on each subsequent trading day and replaced only when a newer completed weekly value becomes eligible.
12. Historical intrinsic-value daily materialization never uses a source whose `sourceDataAsOf` is after the materialized trading-day cutoff and never backfills a value before its first eligibility date.
13. Blend calculation validates weights, uses only eligible components, handles DDM-not-applicable explicitly, and materializes only valid daily blend values.
13b. Persistence proves exactly one derived row per `(securityId, date)`, ascending range reads by
    `securityId`/date, and that no methodology version can coexist for the same day.
14. Redis symbol LRU evicts a complete symbol and never leaves partial product datasets resident.
15. Redis re-admission reconstructs the same daily-materialized derived history as the durable PostgreSQL representation.
16. Loader cache-hit, DB re-admission, DB-partial, and upstream-delta paths return equivalent domain projections.
17. Concurrent requests for the same stock, including different requested ranges, share one full-stock hydration.
18. Failed/partial syncs do not falsely advance dataset-state success watermarks.

### API integration tests

When Stock Details endpoints are implemented, add PostgreSQL-backed Nest/Supertest integration tests following the existing auth integration-test style.

Minimum matrix:

1. `GET /stocks/:symbol` returns the agreed bounded Stock Details contract.
2. Unknown/unsupported symbol returns the agreed not-found response without leaking provider errors.
3. Historical price endpoint validates and applies `from`/`to`.
4. Technical endpoint exposes only agreed daily fields with `d` suffixes.
5. Intrinsic-value endpoint filters by model/range and supports point-in-time `asOf` over the daily-materialized series.
6. Blend endpoint filters by blend ID and returns version metadata over the daily-materialized series.
7. Repeating a persisted request returns the same response without requiring FMP again.
8. Partial canonical-horizon coverage requests only the missing provider delta, independent of the HTTP projection.
9. Stock Details and worker/backtest resolve the same historical data through the same service contract.
10. A filing published after the requested date cannot affect that historical response.
11. Historical arrays are ascending regardless of FMP fixture order.
12. Warm-up/unavailable derived values are absent/null according to final serialization, never fabricated as zero.
13. When weekly endpoints are added, responses expose the latest completed weekly value on every eligible trading day and never expose a week-ending value to earlier days in that same incomplete week.
14. A Redis-resident stock can serve the requested historical daily state without requiring sparse-event reconstruction from PostgreSQL.

## Explicitly out of scope for this PR

- Prisma models or migrations
- Redis client/LRU implementation
- live FMP client implementation
- SMA/EMA calculation implementation
- weekly technical implementation (the later product catalog is fixed in `selectable-series-catalog.md`)
- intrinsic-value formulas
- blend calculation implementation
- Stock Details controllers/routes
- frontend Stock Details page
- worker/backtest wiring
