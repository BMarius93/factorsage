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

V1 stores daily data only. Weekly/monthly bars and indicators may be derived later.

## V1 moving averages

Persist these daily derived values:

- SMA 20D
- SMA 50D
- SMA 100D
- SMA 200D
- EMA 20D
- EMA 50D
- EMA 200D

The application will calculate these from the canonical daily price series. FMP technical-indicator endpoints may later be used as an external validation oracle, not as the production calculation dependency.

## V1 intrinsic-value models

- `DCF_FCFF`
- `RESIDUAL_INCOME`
- `DDM`
- `GRAHAM`

Each historical intrinsic-value point is effective at a `valuationDate` and records `sourceDataAsOf`. Implementations must only use information that was public by that point in time.

Intrinsic values are snapshots, not necessarily one duplicated row per trading day. An `asOf` query resolves the latest eligible valuation snapshot at or before the requested date.

## V1 blends

Blend definitions are versioned product methodology:

- `BALANCED` v1: 50% DCF FCFF, 30% Residual Income, 20% Graham
- `CONSERVATIVE` v1: 40% DCF FCFF, 30% Residual Income, 30% Graham
- `DIVIDEND` v1: 40% DCF FCFF, 40% DDM, 20% Residual Income

Blend weights must sum to 1. A change to weights creates a new blend version rather than silently changing historical interpretation.

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

## Redis direction

The later Redis implementation should maintain a configurable maximum number of resident symbols and evict complete symbols using LRU semantics. Redis remains disposable and cannot be the only copy of durable historical or user-owned data.

## Required implementation tests

### Unit tests

1. FMP DTO -> domain mapping keeps provider quirks outside the domain (nullable identifiers, employee-count string conversion, timestamps, percentage semantics).
2. Daily EOD mapping preserves split-adjusted OHLCV semantics.
3. Date-range gap detection handles:
   - empty dataset,
   - full hit,
   - missing prefix,
   - missing suffix,
   - bounded historical request.
4. Dataset-state updates are monotonic and calculation-version aware.
5. SMA calculations for 20/50/100/200 periods are deterministic and have correct warm-up behavior.
6. EMA calculations for 20/50/200 periods use one documented seed/warm-up convention.
7. Moving-average outputs are compared against trusted FMP fixtures within an explicit numeric tolerance.
8. Historical intrinsic-value selection never returns a snapshot whose `sourceDataAsOf` is after the requested as-of time.
9. Blend calculation:
   - validates weights,
   - uses only eligible component snapshots,
   - preserves blend/calculation versions,
   - handles DDM-not-applicable cases explicitly rather than silently substituting future/missing values.
10. Redis symbol LRU evicts a complete symbol and never partial datasets for the selected symbol.
11. Loader cache-hit, DB-hit, DB-partial, and upstream-delta paths return equivalent domain results.
12. Concurrent requests for the same missing symbol/range are single-flight/deduplicated when coordination is implemented.

### API integration tests

Stock Details endpoints are not added in this foundation PR. When implemented, add PostgreSQL-backed Nest/Supertest integration tests following the existing auth integration-test style.

Minimum API test matrix:

1. `GET /stocks/:symbol` returns the agreed Stock Details contract for a valid stock.
2. Unknown/unsupported symbol returns the agreed not-found response without leaking provider errors.
3. Historical price endpoint accepts `from`/`to`, validates malformed/inverted ranges, and returns only requested dates.
4. Technical endpoint accepts the same date-range semantics and exposes only the V1 indicator catalog.
5. Intrinsic-value endpoint filters by model and range and supports point-in-time `asOf` retrieval.
6. Blend endpoint filters by blend ID and returns blend version metadata.
7. Repeating the same request after persistence produces the same API response without requiring FMP again.
8. A partial persisted range requests only the missing delta from the provider.
9. A Stock Details request and a worker/backtest request for the same historical dataset resolve through the same service contract.
10. Point-in-time fixture test proves a filing published after the requested date cannot affect that historical response.

## Explicitly out of scope for this PR

- Prisma models or migrations
- Redis client/LRU implementation
- live FMP client implementation
- SMA/EMA calculation implementation
- intrinsic-value formulas
- blend calculation implementation
- Stock Details controllers/routes
- frontend Stock Details page
- worker/backtest wiring
