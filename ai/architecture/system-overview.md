# System Overview

## Processes

- `apps/web`: presentation and browser interaction.
- `apps/api`: HTTP API, authentication integration, orchestration, authorization, persistence coordination.
- `apps/worker`: long-running backtests and monitoring work.

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

Derived backtest-facing data is materialized per trading day into one `DailyDerivedState` row per
security per trading day, cached as `security:<securityId>:daily-state:<year>` chunks. Calculation
versions are not stored: a methodology change rebuilds the current state.

`@intrinsic/stock-data` owns canonical stock hydration: Redis READY check -> PostgreSQL coverage
for the range this read needs -> missing FMP deltas -> derived calculation -> PostgreSQL ->
yearly Redis chunks. The caller's requested range, widened by the derived-series warm-up and
clamped to `STOCK_HISTORY_YEARS`, is what gets materialized: Stock Details pays for its own
window, a backtest asks for decades explicitly, and widening later is incremental. See
`../../docs/decisions/caller-scoped-history-materialization.md`. Provider deltas are paginated to
completeness inside `@intrinsic/fmp`, and a persisted coverage interval means complete
materialization — asked completely, every returned row persisted — under the price-dataset
revision `PRICE_DATASET_VERSION`; see `../../docs/decisions/complete-price-coverage.md`. Process
adapters construct their own Prisma and Redis clients; they do not reimplement loading behavior.

One distributed lock coordinates hydration of a complete security across API and worker. A
provider-wide Redis gate separately limits concurrent/rate traffic and shares 429 cooldown state
across processes. Recent mutable EOD data is refreshed as a bounded tail without rebuilding closed
historical years.

## Main boundary

```text
Web -> API -> stock-data -> domain
              |    |
              DB   FMP
              |
            Worker
```
