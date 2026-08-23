# Stock Data Foundation

## Status

Foundation decision for the next implementation slice. This document defines contracts and test expectations only; it does not implement FMP loading, Redis caching, Prisma persistence, technical calculations, intrinsic-value formulas, or Stock Details HTTP endpoints.

## Goals

- One canonical stock-data access boundary for both API Stock Details and worker backtests.
- PostgreSQL remains the durable source of truth.
- Redis is a disposable symbol-level cache with LRU residency management in a later implementation PR.
- FMP is upstream data, not the product domain model.
- Date-range queries are first-class so callers can request only the historical interval they need.
- Historical fundamentals and intrinsic values remain point-in-time correct and cannot use future filings/data.

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
```

A weekly bar uses:

- open = first trading-day open of the week
- high = maximum daily high in the week
- low = minimum daily low in the week
- close = last trading-day close of the week
- volume = sum of daily volume in the week

Do not calculate weekly moving averages by averaging daily moving-average values.

For point-in-time/backtest behavior, only completed weekly periods are eligible. A Monday-Thursday backtest date must not see a weekly indicator that depends on the close of the upcoming Friday. The V1 backtest policy is therefore `COMPLETED_PERIODS_ONLY`.

Weekly snapshots should be persisted at most once per completed week when weekly persistence is introduced. Do not duplicate the same weekly value into every daily row. At retrieval time, a daily `asOf` request may resolve to the latest eligible completed weekly snapshot, so the same weekly value can legitimately appear effective across several daily dates until a new week completes.

A future Stock Details/UI feature may explicitly introduce a provisional week-to-date indicator based on the current partial week. Such a value must be clearly distinguished from completed-period historical values and must never leak into backtest/PIT calculations.

The exact V1 weekly SMA/EMA period catalog is intentionally not fixed by this PR. `1W` is reserved in the type system so a later product decision can add weekly periods without redefining timeframe semantics.

## V1 intrinsic-value models

- `DCF_FCFF`
- `RESIDUAL_INCOME`
- `DDM`
- `GRAHAM`

Each historical intrinsic-value point is effective at a `valuationDate` and records `sourceDataAsOf`. Implementations must only use information that was public by that point in time.

`sourceDataAsOf` is the latest publication/availability instant among the inputs actually used by the calculation. It is an audit/no-look-ahead field, not merely the fiscal period end date.

Intrinsic values are snapshots, not necessarily one duplicated row per trading day. An `asOf` query resolves the latest eligible valuation snapshot at or before the requested date.

The implementation must define a consistent market-time cutoff for when a newly published filing becomes eligible in a backtest. A valuation may never become historically visible before every source input used by it was public.

## V1 blends

Blend definitions are versioned product methodology:

- `BALANCED` v1: 50% DCF FCFF, 30% Residual Income, 20% Graham
- `CONSERVATIVE` v1: 40% DCF FCFF, 30% Residual Income, 30% Graham
- `DIVIDEND` v1: 40% DCF FCFF, 40% DDM, 20% Residual Income

Blend weights must sum to 1. A change to weights creates a new blend version rather than silently changing historical interpretation.

A missing/not-applicable component must be handled explicitly. For example, DDM may be unavailable for a company that does not pay a meaningful dividend. The implementation must not silently pull a future component value, substitute another model, or renormalize weights unless a later product decision explicitly defines that behavior.

## Dataset state

Do not add `lastUpdatedPrice`, `lastUpdatedFinancials`, etc. columns to `Security`.

The persistence implementation should use a dataset-state model conceptually equivalent to:

- security
- dataset
- earliest available date
- latest available date
- last successful sync timestamp
- calculation version for derived datasets

This enables range-aware delta loading: Redis -> PostgreSQL -> determine missing range -> FMP/calculation -> persist delta -> refresh cache.

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
- retrieve intrinsic-value history by model and date range/as-of date
- retrieve intrinsic-value blend history by blend and date range/as-of date
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
8. Cache misses and partial DB ranges must not trigger full-history FMP reloads when only a bounded delta is missing.
9. Historical reads are deterministic and ascending by effective date.
10. Derived values are persisted for performance but reproducible from canonical inputs plus calculation version.
11. Never fill missing technical warm-up values, unavailable intrinsic-value models, or unknown provider fields with fabricated zero/default financial values.
12. Point-in-time correctness is a hard invariant.
13. Daily technical names must retain their `d` suffix. Do not introduce ambiguous `sma20`/`ema50` fields once timeframe-aware contracts exist.
14. Weekly indicators must be derived from weekly bars aggregated from daily bars, not from daily indicator values.
15. Backtests may only use completed weekly periods. Do not expose a Friday-complete value to earlier dates in that same week.
16. Do not duplicate a weekly snapshot across every day in durable storage; resolve the latest eligible weekly snapshot during retrieval.
17. Keep the next PR reviewable and avoid unrelated product changes.

## Redis direction

The later Redis implementation should maintain a configurable maximum number of resident symbols and evict complete symbols using LRU semantics. Redis remains disposable and cannot be the only copy of durable historical or user-owned data.

Redis memory-limit/eviction configuration may be used as a safety net, but product residency semantics belong to the application-level symbol cache policy.

## Required implementation tests

### Unit tests

1. FMP DTO -> domain mapping keeps provider quirks outside the domain.
2. Daily EOD mapping preserves split-adjusted OHLCV semantics.
3. Date-range gap detection covers empty, full-hit, missing-prefix, missing-suffix, and bounded historical requests.
4. Dataset-state updates are monotonic and calculation-version aware.
5. SMA 20D/50D/100D/200D calculations are deterministic with correct warm-up behavior.
6. EMA 20D/50D/200D calculations use one documented seed/warm-up convention.
7. Moving-average outputs are compared against trusted FMP fixtures within an explicit numeric tolerance.
8. Daily technical serialization uses `sma20d`/`ema20d`-style timeframe-explicit names and never ambiguous names.
9. Weekly aggregation from daily bars correctly derives open/high/low/close/volume for normal and holiday-shortened weeks.
10. Weekly indicator tests prove a Monday-Thursday `asOf` cannot observe a value requiring the future week-ending close.
11. Weekly `asOf` retrieval resolves the latest completed snapshot and can return the same snapshot for multiple subsequent daily dates without duplicated storage rows.
12. Historical intrinsic-value selection never returns a snapshot whose `sourceDataAsOf` is after the requested as-of time.
13. Blend calculation validates weights, uses only eligible components, preserves versions, and handles DDM-not-applicable explicitly.
14. Redis symbol LRU evicts a complete symbol and never partial datasets.
15. Loader cache-hit, DB-hit, DB-partial, and upstream-delta paths return equivalent domain results.
16. Concurrent requests for the same missing symbol/range are single-flight/deduplicated when coordination is implemented.
17. Failed/partial syncs do not falsely advance dataset-state success watermarks.

### API integration tests

When Stock Details endpoints are implemented, add PostgreSQL-backed Nest/Supertest integration tests following the existing auth integration-test style.

Minimum matrix:

1. `GET /stocks/:symbol` returns the agreed bounded Stock Details contract.
2. Unknown/unsupported symbol returns the agreed not-found response without leaking provider errors.
3. Historical price endpoint validates and applies `from`/`to`.
4. Technical endpoint exposes only agreed daily fields with `d` suffixes.
5. Intrinsic-value endpoint filters by model/range and supports point-in-time `asOf`.
6. Blend endpoint filters by blend ID and returns version metadata.
7. Repeating a persisted request returns the same response without requiring FMP again.
8. A partial persisted range requests only the missing provider delta.
9. Stock Details and worker/backtest resolve the same historical data through the same service contract.
10. A filing published after the requested date cannot affect that historical response.
11. Historical arrays are ascending regardless of FMP fixture order.
12. Warm-up/unavailable derived values are absent/null according to final serialization, never fabricated as zero.
13. When weekly endpoints are later added, historical `asOf` behavior must prove completed-period-only visibility.

## Explicitly out of scope for this PR

- Prisma models or migrations
- Redis client/LRU implementation
- live FMP client implementation
- SMA/EMA calculation implementation
- weekly technical implementation or weekly period catalog
- intrinsic-value formulas
- blend calculation implementation
- Stock Details controllers/routes
- frontend Stock Details page
- worker/backtest wiring
