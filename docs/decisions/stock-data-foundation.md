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

The application will calculate these from the canonical daily price series. FMP technical-indicator endpoints may later be used as an external validation oracle, not as the production calculation dependency.

Indicator period means number of bars, not calendar days. `SMA(50, 1D)` and `SMA(50, 1W)` are different indicators. The type system reserves weekly timeframe support, but V1 persists daily technical values only.

Insufficient warm-up history produces an unavailable/absent derived value, not zero. EMA seed/warm-up semantics must be documented and locked by tests before historical values are materialized.

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

A Stock Details page load and a worker backtest asking for the same symbol/range must ultimately receive equivalent canonical domain data. Differences in caller/process must not create two business implementations.

## Implementation guardrails for coding agents

These constraints are intentionally explicit so a coding agent can implement the next slice without re-deciding the architecture:

1. Read `AGENTS.md`, `ai/README.md`, this decision, and relevant architecture docs before changing code.
2. Do not map FMP JSON directly into API contracts or Prisma models. Keep provider DTOs/quirks inside `@intrinsic/fmp` and map them into domain values deliberately.
3. Do not put Prisma, Redis clients, HTTP calls, environment access, or FMP DTOs into `@intrinsic/domain` or `@intrinsic/valuation`.
4. Do not duplicate loader orchestration in `apps/api` and `apps/worker`. They are callers of the same business implementation.
5. The current package map does not yet define an infrastructure-aware shared application package for this orchestration. If the implementation introduces one (for example a dedicated stock-data/application package), update the architecture/dependency documentation explicitly in the same PR instead of hiding the dependency change.
6. PostgreSQL is authoritative. Redis is a performance layer and must be safely rebuildable from durable/upstream data.
7. Redis LRU residency is symbol-level. Eviction removes the complete cached symbol, not an arbitrary subset of its datasets.
8. Cache misses and partial DB ranges must not trigger full-history FMP reloads when a bounded missing delta can be identified.
9. Historical reads exposed by the domain/service should be deterministic and ascending by effective date even when provider payload order differs.
10. Derived values are persisted for performance but remain reproducible from canonical inputs plus a documented calculation version.
11. Never fill missing technical warm-up values, unavailable intrinsic-value models, or unknown provider fields with fabricated zero/default financial values.
12. Point-in-time correctness is a hard invariant: use filing/publication availability, not only fiscal period end dates, and never let a future filing affect an earlier backtest date.
13. Do not invent authentication/entitlement behavior for Stock Details in this slice. Follow the product/auth decision that exists when HTTP endpoints are implemented.
14. Keep the next PR reviewable: infrastructure, formula changes, and UI behavior should not be mixed unless the task explicitly asks for them together.

## Redis direction

The later Redis implementation should maintain a configurable maximum number of resident symbols and evict complete symbols using LRU semantics. Redis remains disposable and cannot be the only copy of durable historical or user-owned data.

The Redis memory limit/eviction configuration may be used as a safety net, but product residency semantics belong to the application-level symbol cache policy. Do not rely on Redis key-level eviction alone to preserve complete-symbol cache behavior.

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
13. Historical service/repository rows are normalized to ascending effective-date order even when provider fixtures are newest-first.
14. Failed/partial syncs do not falsely advance dataset-state success watermarks.

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
11. Historical arrays are returned in documented ascending date order regardless of FMP fixture ordering.
12. Warm-up/unavailable derived values are represented as absent/null according to the final HTTP serialization decision, never fabricated as zero.

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
