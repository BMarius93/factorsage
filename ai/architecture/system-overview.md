# System Overview

## Processes

- `apps/web`: presentation and browser interaction.
- `apps/api`: HTTP API, authentication integration, orchestration, authorization, persistence coordination.
- `apps/worker`: one supervisor forking backtest children (durable `BacktestJob` claims) and
  Monitor children (the singleton `MonitorScanSchedule` claim). See `api-worker.md`.

## Shared packages

- `domain`: pure business rules.
- `valuation`: pure valuation mathematics.
- `contracts`: DTOs/versioned contracts.
- `database`: Prisma schema/client/repositories.
- `fmp`: external market/fundamental data adapter.
- `stock-data`: canonical infrastructure-aware stock loader used by API and worker.
- `observability`: logging/tracing conventions.
- `testing`: common test helpers.

## Data ownership

PostgreSQL owns durable state.

Redis may be used for:

- cache,
- locks,
- deduplication,
- ephemeral progress,
- temporary coordination.

A Redis flush must not destroy completed executions or user-owned data.

Redis is nevertheless **required at runtime**: every stock-data read, the per-security hydration
lock and the provider-wide request gate go through it, and nothing degrades to a PostgreSQL-only
path when it is unreachable — a request or cycle fails fast instead. "Disposable" describes its
contents, not its availability. Keys are namespaced `stock-data:v2:*` (per-security manifests and
yearly chunks, the resident-stock LRU, the FMP gate), `stock-data:load:*` (the Redlock hydration
locks, per security or benchmark series) and `benchmark:v1:*` (per-series manifests and chunks);
there is no user-scoped key anywhere, and Monitor/Signal state is never in Redis. The Monitor's trading-calendar schedule is process memory with a TTL, by design.

Derived backtest-facing data is materialized per trading day into one `DailyDerivedState` row per
security per trading day, cached as `security:<securityId>:daily-state:<year>` chunks. Calculation
versions are not stored: a methodology change rebuilds the current state.

`@intrinsic/stock-data` owns canonical stock hydration: Redis READY check -> PostgreSQL coverage
for the range this read needs -> missing FMP deltas -> derived calculation -> PostgreSQL ->
yearly Redis chunks. The caller's requested range, widened by the derived-series warm-up and
clamped to the **raw-price retention horizon**, is what gets materialized: Stock Details pays for
its own window, a backtest asks for decades explicitly, and widening later is incremental. See
`../../docs/decisions/caller-scoped-history-materialization.md`.

Two horizons, deliberately separate. `STOCK_HISTORY_YEARS` (30) is the **product** horizon — the
oldest day any surface may select, chart, query or backtest, and the one bound
`projectionRange` cuts every read at. Raw `DailyPrice` retention is
`priceRetentionYears(productHistoryYears)` = 34: four internal warm-up years so a 200-week average
is already valid on the first visible day of a maximum-length backtest. The extra years are
persisted, covered and used by the derived calculation; no product surface, contract or UI limit
sees them. See `../../docs/decisions/price-retention-warmup-horizon.md`. Provider deltas are paginated to
completeness inside `@intrinsic/fmp`, and a persisted coverage interval means complete
materialization — asked completely, every returned row persisted — under the price-dataset
revision `PRICE_DATASET_VERSION`; see `../../docs/decisions/complete-price-coverage.md`. Process
adapters construct their own Prisma and Redis clients; they do not reimplement loading behavior.

One distributed lock coordinates hydration of a complete security across API and worker. A
provider-wide Redis gate separately limits concurrent/rate traffic and shares 429 cooldown state
across processes. Recent mutable EOD data is refreshed as a bounded tail without rebuilding closed
historical years.

**What a repeated read costs.** PostgreSQL, not Redis, is the authority for coverage: an identical
second read over an already-materialized range makes **zero** provider requests, and so does the
same read after a full Redis flush — the cache is rebuilt from PostgreSQL. The only provider traffic
a warm range can still produce is the bounded recent tail, once its freshness window has expired,
and a widened range's genuinely missing prefix or suffix. `provider-reuse.integration.test.ts` pins
all of that against a counting provider, benchmarks included.

Every historical provider request explains itself. `CanonicalStockDataService` and
`CanonicalBenchmarkDataService` take an `onProviderRequest` hook, and the API and worker wire it to
a `stock-data.provider.request` debug log carrying the symbol, dataset, requested range and a
`reason` — `PROFILE_SYNC`, `MISSING_COVERAGE`, `RECENT_TAIL_STALE` or `FUNDAMENTALS_BACKFILL`. "Why
is it calling FMP again?" is a question the logs answer directly.

## Main boundary

```text
Web -> API -> stock-data -> domain
              |    |
              DB   FMP
              |
            Worker
```
