# API / Worker Boundary

API responsibilities:

- validate requests,
- authorize users,
- create immutable execution snapshots,
- create/queue durable jobs,
- expose execution state/results.

Worker responsibilities:

- claim jobs,
- load required data,
- execute backtests/monitor scans,
- persist progress/results/failures,
- handle graceful shutdown and retry semantics.

Both must call the same domain/valuation logic. Stock Details uses `@intrinsic/stock-data`, and
worker/backtest job processors must use the same package when they are introduced; neither process
owns Redis lookup, coverage reconciliation, FMP loading, or derived-technical
implementations. Both read requested projections from the same yearly Redis representation after
one stock-level hydration lock has materialized the range they asked for.
The renewable lock lease and finite waiter window are configured independently, so a second
process may wait through a long load and reuse READY without extending one lease indefinitely.
Provider Retry-After cooldown is shared and monotonic across both processes; each caller's own
queue/retry wait remains independently bounded.
