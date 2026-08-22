# Backtests

Backtests are durable asynchronous executions.

A submitted run must snapshot the inputs required for reproducibility, including at least:
- strategy/version/config,
- resolved symbols,
- per-symbol buy windows,
- requested period,
- financial assumptions that affect results.

The API validates and creates durable work.
The worker claims and executes durable work.
The frontend never starts worker runtime code.
