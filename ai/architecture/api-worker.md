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

## Durable work

The queue is a PostgreSQL table. `BacktestJob` holds one row per `BacktestRun`, created in the same
transaction as the run, so the queue and the durable execution record cannot disagree and a Redis
flush is harmless. A worker claims with `SELECT … FOR UPDATE SKIP LOCKED` and holds a renewable
lease; every progress and result write is ownership-guarded on the claim. An expired lease is
reclaimable, which is what makes a crashed worker self-healing, and `maxAttempts` bounds the retries
before a run becomes terminally `FAILED`. No queue library is used, and none should be added:
PostgreSQL is already the source of truth, and a second store would only introduce a truth to
reconcile.

## Worker processes

`apps/worker` is a supervisor that forks `BACKTEST_WORKER_PROCESSES` child processes, each executing
at most one backtest at a time. A single backtest is never internally parallelized — its simulation
is sequential in time and stays deterministic. Concurrency across independent runs comes from
independent OS processes; I/O inside one run (frame loading) uses bounded concurrency and is
throttled further by the shared provider gate, so a large backtest cannot starve Stock Details.

See `backtest-execution.md` for the run lifecycle, progress model and execution methodology, and
`benchmark-data.md` for benchmark loading.
