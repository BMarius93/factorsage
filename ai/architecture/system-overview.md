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
- `observability`: logging/tracing conventions.
- `testing`: common test helpers.

## Data ownership

MySQL owns durable state.

Redis may be used for:
- cache,
- locks,
- deduplication,
- ephemeral progress,
- temporary coordination.

A Redis flush must not destroy completed executions or user-owned data.

## Main boundary

```text
Web -> API -> application/domain
              |       |
              DB      FMP
              |
            Worker
```
