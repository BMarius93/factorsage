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

Both must call the same domain/valuation logic. Stock Details, the backtest worker and the Monitor
worker all use `@intrinsic/stock-data`; neither process owns Redis lookup, coverage reconciliation,
FMP loading, or derived-technical implementations. Both read requested projections from the same yearly Redis representation after
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

## Durable Monitor scans

The Monitor scan is the second instance of the same protocol, with one difference: the work is
periodic rather than submitted. `MonitorScanSchedule` is exactly one row (id `GLOBAL`), created
with `INSERT … ON CONFLICT DO NOTHING` by every Monitor child at startup. A child claims it with
`SELECT … FOR UPDATE SKIP LOCKED` once `dueAt` has passed and no live lease holds it, renews the
lease on a heartbeat while the cycle runs, and on completion sets the next `dueAt` from the
**end** of the cycle and releases. A failed cycle records the error and reschedules with a doubling
backoff capped at the scan interval; an expired lease is recovered by any child, so a crashed
scanner is replaced rather than leaving scanning stopped. Every write after the claim is
ownership-guarded on `claimedBy`, so a child whose lease was recovered while it was still running
cannot push the next cycle out from under the new owner; the Signal-state writes it may still make
are guarded separately by `MonitorSignalState.stateVersion`, which is what makes an overlapping
cycle harmless. Cadence, lease, heartbeat and backoff are `MONITOR_SCAN_*` configuration
(`packages/config`), never user input. See `monitor-engine.md`.

## Worker processes

`apps/worker` is one supervisor forking two kinds of child. `BACKTEST_WORKER_PROCESSES` backtest
children each execute at most one backtest at a time; `MONITOR_WORKER_PROCESSES` Monitor children
each claim at most one scan cycle, and because the cycle is a singleton claim a second Monitor
child buys availability, not throughput (`0` disables scanning in that deployment). A child that
exits is restarted with a bounded backoff, and a stop signal is forwarded to every child with a
30-second grace before it is killed. That grace is shorter than the budget a large backtest's
result transaction may need, so a deploy that lands during a run's final write can cost that run
one attempt: the transaction rolls back atomically, the lease expires, and the run is re-simulated.
A single backtest is never internally parallelized — its simulation is sequential in time and stays
deterministic. Concurrency across independent runs comes from
independent OS processes; I/O inside one run (frame loading) uses bounded concurrency and is
throttled further by the shared provider gate, so a large backtest cannot starve Stock Details.

See `backtest-execution.md` for the run lifecycle, progress model and execution methodology, and
`benchmark-data.md` for benchmark loading.
