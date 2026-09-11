# Monitors

This document is the canonical product definition for FactorSage monitoring.

## Purpose

A Monitor evaluates the existing canonical Strategy logic against current market data and produces Signals for symbols that match.

Monitoring is not a second strategy language. Strategy semantics remain owned by `ai/product/strategies.md`; the Monitor consumes those semantics.

A Monitor combines a Strategy with a monitored symbol universe/source. It must not move List/source membership, capital, backtest execution inputs, or market-data formulas into Strategy itself.

## User controls

For V1, the user controls whether a Monitor is `enabled` or `disabled`.

The user does **not** configure the monitoring interval/cadence. Cadence is an application/infrastructure decision.

Disabling a Monitor stops future evaluations. Re-enabling it resumes evaluations using the persisted Monitor state required for correct trigger semantics.

## Signals

`Signal` is the product term for a Monitor result.

A Signal means that a symbol matched one of the Strategy's canonical signals/levels under the current Monitor evaluation context.

Do not introduce separate user-facing concepts solely to distinguish condition-only matches from trigger-based matches. The UI may explain why a Signal exists, but both remain Signals.

### Condition-only Strategy signal

A Strategy signal containing conditions but no trigger represents a state that may remain true across multiple Monitor evaluations.

Example:

```text
Price is below Intrinsic Value
```

If it is true on several consecutive evaluations, the product should treat that as the same continuing matched state rather than fabricating a new event on every scan.

### Trigger-based Strategy signal

A Strategy signal with a trigger represents a transition/event and depends on the prior evaluable state.

Example:

```text
Price crosses above EMA50D
```

The Signal is emitted when the canonical trigger transition occurs. Remaining above EMA50D on the next evaluation is not another `crosses above` event.

The implementation must preserve enough durable prior-evaluation state to distinguish a genuine transition from a process restart or cache miss.

#### A daily trigger is an event on an observation date

A daily trigger is evaluated **from the previous closed daily observation to the current provisional
daily observation**. It is not a tick-to-tick intraday trigger.

The `t - 1` half is the last closed trading day and does not move during a session, so for the rest
of that session the crossing predicate degenerates into the plain relationship it crossed into. It
follows that:

- a daily trigger emits **at most once per observation date**;
- a price that crosses, moves back across the boundary and crosses again within the same observation
  date does **not** produce a second Signal for that date — the canonical daily series has that
  crossing true on exactly one date, and a backtest over the same closed bar would record one event;
- for the same reason, an intraday move back across the boundary does not end a trigger Signal. A
  Trigger is an event, so the condition lifecycle below does not apply to it: its Signal is active
  for the session it fired in and is closed when a later session is **actually observed**.

**Only a real current observation advances that lifetime.** A cycle that produced no observation —
a weekend, a holiday, a symbol the provider did not price — has observed no session, so it closes
nothing. The wall-clock date is not a session: a Friday crossing must still be active on Saturday,
and is closed by Monday's observation, not by Sunday arriving. A `NOT_EVALUABLE` caused by missing
current data therefore carries **no** observation date at all rather than a synthetic one.

The `false -> true -> true -> false` state table applies to **condition-only** signals, which
describe a state that genuinely ends and begins again.

## Monitored universe and BUY eligibility

A Monitor's universe is a Stock List. Membership is the canonical `Security` catalog reference, never
a free-text symbol.

**BUY eligibility from that list applies to Monitor BUY Signals.** `ai/product/lists.md` defines a
`CUSTOM` buy window as the dates a member is eligible on, and a Monitor evaluates one date — the
current observation. A BUY level therefore produces no Signal for a symbol whose current buy window
does not admit that date. `FULL` admits every date and so never restricts anything.

SELL and FINAL EXIT are **not** restricted by buy windows. A buy window governs entries; an exit rule
must still be able to report what it sees. This mirrors the backtest engine, which reads the same
`isBuyWindowEligible` before firing a BUY and nothing before firing a SELL or FINAL EXIT.

## SELL and FINAL EXIT without portfolio state

A Monitor is **not** a portfolio tracker. It holds no position, no average cost and no lifecycle.

A SELL or FINAL EXIT Signal is still meaningful: it reports that the Strategy's exit logic matches
current data for that symbol. Those levels are therefore evaluated and may produce Signals.

Metrics that require position state — `Gain` and `Loss` — have nothing to be measured against, so
they are `NOT_EVALUABLE` exactly as `ai/product/strategies.md` already specifies for unavailable
position state. A Signal whose logic depends on them can never match. This is the existing rule
applied, not a Monitor-specific exception.

## Strategy mutability

A Monitor references a **Strategy**, not a pinned Strategy version. Monitoring is live: editing the
Strategy changes what is being watched, immediately and without recreating the Monitor. This is the
deliberate opposite of a Backtest run, whose immutable snapshot is its reproducibility authority.

Persisted Monitor state is scoped to the **canonical logic of its own level**, not to the Strategy
version. Editing one level appends a new Strategy version, and that must not reset the state of every
other, unchanged level — doing so would re-emit a Signal on each of them for a match that never
stopped. A level whose logic genuinely changed no longer describes what its state latched, so that
state is reset and any Signal still active under the old logic is closed.

## Deleting a Strategy or Stock List a Monitor uses

A Monitor owns Signal history, which is a record of what was observed. It is **not** a derived view
of its Strategy and List, so it must not disappear when one of them is deleted.

Deleting a Strategy or a Stock List that an existing Monitor references is therefore **refused**. The
user deletes the Monitor first, explicitly. Deleting the owning user account still removes everything,
because that is the one case where all of it should go.

## Only a trading session produces an observation

A provisional observation exists only for a day the exchange actually held a session.

- **Weekends** are excluded without asking anyone: they are closed on every venue V1 admits.
- **Fully closed exchange holidays** are excluded using the venue's published holiday schedule.
- **Early closes are ordinary sessions.** The venue opened and closed sooner; the day's bar is a
  normal one and is not filtered.

This is a correctness rule, not tidiness. A bar on a day nothing traded lengthens every rolling
window by one observation — which can move an average past a price that never moved and read as a
crossing — and it names a session later than the previous real one, which would end a Trigger
Signal that fired there. Neither is acceptable, so neither is allowed to happen.

If the schedule needed to answer the question cannot be obtained, the cycle **fails**. Not knowing
whether the exchange opened is not the same as knowing it did, and only one of those may produce an
observation. The schedule is resolved per exchange, shared by every symbol listed there, and held in
process memory; nothing about it is cached in Redis, and it is not a general trading-calendar
subsystem — it answers one question for the venues V1 admits.

## Current-data semantics

A Monitor uses current market data, while backtests remain deterministic historical evaluations.

For daily market-derived series, Monitor evaluation uses:

```text
persisted closed daily history
+ current live FMP price as the provisional current daily observation
```

Therefore daily indicators used by a Monitor (for example EMA, SMA, RSI) may include the provisional current-day observation and can move intraday.

Backtests continue to use closed historical observations according to the canonical backtest methodology. Do not silently change backtest semantics to make them match Monitor execution.

Missing/warm-up/PIT-unavailable inputs remain `NOT_EVALUABLE`; monitoring must not replace them with zero, future data, or fabricated values.

## Intrinsic value and price-dependent metrics

Do not rerun expensive fundamental/intrinsic calculations merely because the live price changed if their underlying inputs have not changed.

Where a derived metric depends on a persisted intrinsic value plus current price (for example Margin of Safety), reuse the valid intrinsic value and recompute only the price-dependent result.

The canonical formulas and PIT rules remain owned by the existing calculated-series / intrinsic-value architecture.

## V1 simplicity constraints

V1 intentionally avoids user-configurable scan frequency and avoids extra user-facing state-machine terminology.

Do not add new Redis-backed product semantics merely for monitoring. Redis may still be used by existing infrastructure where already justified (for example queueing/coordination), but Monitor product correctness must not depend on an ephemeral cache.

### Accepted V1 limitations

These are known and accepted for V1. They are limitations, not defects, and none of them can produce
a wrong Signal.

- **Monitored universe versus the resident-stock bound.** Symbol data is read through the existing
  shared stock-data cache, whose resident set is bounded. A monitored universe larger than that bound
  re-hydrates symbols from durable storage each cycle. This is a throughput limitation. Do not
  redesign Redis or add a Monitor-specific cache for it.
- **A quote is refused rather than trusted** when it is older than the configured maximum age, when
  it is dated in a session later than the cycle's own, or when its timestamp cannot be read. Each of
  those would otherwise fabricate an observation.
- **Current-data failure is all-or-nothing.** If the current-data read for a cycle fails, the cycle
  **fails** — it is not absorbed and completed as if it had evaluated something. Partial cycles are
  not a V1 concept. The failure takes the worker's normal failure and retry path, so it is recorded
  as a failure and retried after a backoff rather than counted as a successful scan. Nothing is
  persisted before that point, so every durable latch is preserved and the next cycle continues.

## Source-of-truth boundaries

- Strategy defines investment/evaluation logic.
- The Monitor decides what current universe/source is evaluated and whether monitoring is enabled.
- The Monitor produces Signals.
- PostgreSQL/durable storage owns persisted Monitor/Signal state required for correctness.
- Backtest configuration remains separate from Monitor configuration.
- Redis/in-memory caches are implementation accelerators, never the semantic source of truth.

## Out of scope / do not invent

Unless another canonical product document explicitly decides otherwise, do not add during V1:

- user-configurable monitoring cadence;
- separate user-facing names for persistent condition matches versus trigger events;
- a second Monitor-specific Strategy DSL;
- a requirement to recompute every available series for every symbol;
- correctness that depends on Redis surviving a restart;
- a pinned Strategy version or Strategy snapshot for a Monitor;
- portfolio/position tracking, average cost or a position lifecycle;
- an exchange trading calendar;
- partial-cycle semantics for a failed current-data read.

If implementation exposes an unresolved product question outside this document, stop and surface the question rather than silently defining new product behavior.
