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
- `maximumPositions`.

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

## Reproducibility

A submitted run must snapshot every input that can affect results, including at least:

- strategy identity, immutable version, and normalized configuration;
- resolved securities and per-symbol BUY windows;
- requested period;
- initial capital and monthly-contribution assumptions;
- `maximumPositions` and the derived full-position policy;
- candidate-ordering and execution-engine methodology versions.

Changing a Strategy or StockList after submission never changes a completed or running backtest.

## Process boundary

The API validates and creates durable work. The worker claims and executes durable work. API and
worker consume the same canonical strategy/domain implementation; they are separate processes,
not separate business engines. The frontend never starts worker runtime code.
