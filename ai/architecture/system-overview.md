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

`@intrinsic/stock-data` owns Redis -> PostgreSQL -> missing coverage -> FMP/derived calculation ->
PostgreSQL -> Redis orchestration. Process adapters construct their own Prisma and Redis clients;
they do not reimplement loading behavior.

## Main boundary

```text
Web -> API -> stock-data -> domain
              |    |
              DB   FMP
              |
            Worker
```
