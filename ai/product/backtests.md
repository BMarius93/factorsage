# Backtests

Backtests are durable asynchronous executions. Strategy logic and portfolio execution settings
have separate ownership.

## Submission inputs

A submitted run selects:

- one immutable strategy version;
- one stock list resolved to canonical security identities and per-symbol BUY windows;
- requested historical period;
- initial capital;
- optional monthly contribution;
- `maximumPositions`;
- a benchmark to compare against.

There is no user-entered maximum-allocation percentage. The full-position portfolio fraction is
derived at execution:

```text
fullPositionFraction = 1 / maximumPositions
```

For example, `maximumPositions = 10` makes one full position 10% of portfolio value. A strategy
BUY action of 25% then targets 25% of that full-position budget, or 2.5% of portfolio value.
`maximumPositions = 5` makes the same strategy action target 5% of portfolio value.

An open symbol occupies one position slot regardless of whether the strategy entered 25%, 50%,
75%, or 100% of its full-position budget. Cash and position-capacity constraints are enforced by
the execution engine.

## Execution assumptions in V1

- **Fees and slippage are zero.** There is no editable field for either, and the assumption is
  recorded in every run snapshot as a methodology version so introducing costs later cannot
  reinterpret a historical run.
- **Orders fill at the canonical end-of-day close of the signal date.**
- **Share quantities are continuous.** A 2.5% target in an expensive stock must not silently round
  to zero shares.
- **The monthly contribution, when configured, is added on the first eligible trading day of each
  calendar month** — except the run's very first simulated day, which already receives the initial
  capital. A calendar month with no simulated trading day receives no contribution.

The remaining execution rules — exits before entries, a BUY level as a target fill, one firing per
level per position lifecycle, FINAL EXIT outranking a partial SELL, and the candidate ordering used
when cash or slots cannot satisfy every match — are engine methodology, not Strategy semantics. They
are decided and versioned in `../architecture/backtest-execution.md`.

## Benchmark

A run compares its portfolio against exactly one benchmark. A benchmark is passive comparison data:
it is never bought, never consumes cash, never occupies a position slot, and is not a portfolio
`Security` (see `../architecture/benchmark-data.md`).

V1 ships one selectable benchmark, which is also the default:

```text
SP500 — "S&P 500"
```

Its data is currently sourced from the `SPY` ETF. That is an implementation detail of the benchmark's
source, not a product identity: the browser selects `SP500`, and the provider symbol never appears in
an API contract. The catalog is built to grow — broad-market, sector, industry and global-equity
benchmarks, and eventually direct index or composite sources.

Portfolio and benchmark are reported as percentage growth from the run's first simulated date, so the
two curves are directly comparable, and `alpha` is their difference. A date on which the benchmark
has no value at or before it reports no benchmark value; a gap is never fabricated.

## Reproducibility

A submitted run must snapshot every input that can affect results, including at least:

- strategy identity, immutable version, and normalized configuration;
- resolved securities and per-symbol BUY windows;
- requested period;
- initial capital and monthly-contribution assumptions;
- `maximumPositions` and the derived full-position policy;
- benchmark identity, source kind, provider identifier and methodology version;
- candidate-ordering and execution-engine methodology versions.

Changing a Strategy, a StockList or the benchmark catalog after submission never changes a completed
or running backtest. Deleting a Strategy or a StockList never deletes or reinterprets a run.

## Progress and live results

A run is not a spinner. It reports an explicit phase — `QUEUED`, `PREPARING_DATA`, `RUNNING`,
`FINALIZING`, `COMPLETED`, `FAILED` — with a percentage and a human-readable message, and while it
simulates it persists a live snapshot every few simulated trading days: the simulated-through date,
the portfolio and benchmark curves so far, current value, cash, returns, alpha, max drawdown,
holdings, trade count and recent trades.

The running page shows that curve as it grows and transitions to the completed view in place. 100%
means successfully completed and nothing else.

A failed run is terminal, keeps a reason a user can act on, and never leaks provider or internal
detail.

V1 has no cancellation; the reasoning is recorded in `../architecture/backtest-execution.md`.

## Process boundary

The API validates and creates durable work. The worker claims and executes durable work. API and
worker consume the same canonical strategy/domain implementation; they are separate processes,
not separate business engines. The frontend never starts worker runtime code.

One backtest is never split across CPU cores: its simulation is sequential in time and stays
deterministic. Independent runs use independent worker processes.
