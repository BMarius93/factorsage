# Monitor Engine

This document is the canonical V1 architecture for current-data Strategy monitoring.

Read together with:

- `ai/product/monitors.md`
- `ai/product/strategies.md`
- `ai/architecture/strategy-evaluation.md`
- `ai/architecture/calculated-series.md`
- `ai/architecture/api-worker.md`
- `ai/architecture/observability.md`
- `ai/workflows/validation.md`

## Core rule

Market-data loading and calculated-series work are organized **per symbol**. Strategy evaluation is organized **per Monitor**.

Do not implement monitoring as:

```text
for each monitor
  load the same symbol history again
  calculate the same indicators again
  evaluate
```

The V1 shape is:

```text
active Monitors
    -> resolve monitored symbols
    -> aggregate required series per symbol
    -> load/update each symbol once for the evaluation cycle
    -> compute each required series once for that symbol
    -> evaluate every relevant Monitor using the shared snapshot
    -> persist Signal/state transitions
```

## Reuse, do not fork

Monitoring must reuse the canonical Strategy semantics and calculated-series definitions already used elsewhere in V2.

Do not create a second implementation of operators, moving averages, RSI, intrinsic-value formulas, compatibility rules, or `NOT_EVALUABLE` behavior specifically for Monitor.

The execution context differs from backtesting; the Strategy language does not.

## Data flow

Conceptually:

```text
FMP current market data
        |
        v
current symbol observation
        |
closed persisted history ----+
                             |
                             v
                    required-series computation
                             |
                             v
                      symbol snapshot
                             |
                  +----------+----------+
                  |                     |
             Monitor A              Monitor B
                  |                     |
                  +----------+----------+
                             v
                  Signal/state persistence
```

For a daily Monitor evaluation, the current live FMP price acts as the provisional current-day observation on top of persisted closed daily history. Daily indicators required by the Strategy may therefore be recalculated against that provisional observation.

## Required-series aggregation

Before doing series work, derive the dependencies actually required by active Monitors for each symbol.

Example:

```text
Monitor A: Price < DCF Intrinsic Value
Monitor B: Price crosses above EMA50D
Monitor C: RSI14D < 30

required for NVDA:
- Price
- DCF Intrinsic Value
- EMA50D
- RSI14D
```

Do not eagerly calculate every registered series for every monitored symbol.

Use the existing canonical catalogs/registries and compatibility rules rather than maintaining a Monitor-only dependency list where possible.

## V1 cache policy

Do **not** add a new Redis cache layer for Monitor history, indicator windows, or computed snapshots merely because Redis is available.

For V1, transient per-cycle work should use process memory where appropriate. A typical evaluation-cycle structure may conceptually resemble:

```text
Map<symbol, {
  history,
  currentObservation,
  requiredSeries,
  computedSnapshot
}>
```

This is an implementation detail, not a persisted product model.

The important behavior is:

- a symbol's required history is loaded once per evaluation cycle/worker batch, not once per Monitor;
- a required calculated value is computed once per symbol snapshot when it can be shared;
- all relevant Monitors evaluate against the same coherent snapshot for that cycle.

Existing Redis usage for queueing, locking, coordination, or already-established architecture may remain. Do not redesign or duplicate those concerns as part of this feature.

## Durable state

Ephemeral memory and Redis must not be the sole source of state required to evaluate trigger semantics correctly.

Persist enough Monitor/symbol evaluation state in PostgreSQL (or the existing durable persistence abstraction) to determine genuine transitions after a process restart.

For example, a trigger such as:

```text
Price crosses above EMA50D
```

requires the previous evaluable relationship/value state and the current one. A restart or empty cache must not produce a false crossing.

The exact schema should fit existing database conventions and should be introduced through the repository's normal migration path. Prefer the minimum durable state necessary for deterministic transition handling; do not persist arbitrary caches as domain records.

## Condition state versus trigger events

For a condition-only Strategy signal:

```text
false -> false : no active match
false -> true  : match becomes active / Signal begins
true  -> true  : same matched state continues; do not create a duplicate event each scan
true  -> false : match is no longer active
```

For a trigger:

```text
previous relationship does not satisfy crossing
current relationship satisfies the canonical crossing transition
=> emit the trigger Signal once
```

Remaining on the post-cross side on later scans is not another crossing.

Use existing Strategy evaluation semantics for the exact definition of crossing, equality boundaries, missing values, and evaluability. Do not redefine those rules here.

## Historical data loading

Do not fetch a full year (or another large fixed horizon) from FMP separately for every Monitor evaluation.

Prefer existing persisted history. Hydrate missing historical coverage through the existing canonical data-loading path when necessary.

For V1 it is acceptable to load a bounded recent daily window from durable storage into process memory and recalculate the required daily indicators for the provisional current observation. Roughly 250-400 daily observations is a reasonable implementation range when sufficient for all requested dependencies, but the code should derive the actual warm-up requirement from canonical series definitions wherever practical rather than hard-coding a business rule around `300`.

Do not introduce incremental EMA/RSI/SMA state machines solely as a premature optimization. They can be added later if profiling proves they are necessary without changing Monitor product semantics.

## Current FMP work

Current market data should be fetched/updated per symbol, not per Monitor.

If many Monitors reference NVDA during one evaluation cycle, that cycle should not make one equivalent current-price request for each Monitor.

Use the repository's existing FMP client, retry/error handling, observability, and provider-mapping conventions. Do not add a Monitor-specific FMP client.

## Intrinsic-value handling

Separate fundamental-dependent calculations from price-dependent current metrics.

If a valid intrinsic value is already derived from unchanged PIT/fundamental inputs, a current-price Monitor evaluation should reuse it. Metrics such as Margin of Safety can then be recomputed using the current price without rerunning the entire intrinsic-value model unnecessarily.

Follow `calculated-series.md` for canonical persistence/revision/invalidation behavior.

## Concurrency and coherent snapshots

Within one Monitor evaluation cycle, avoid evaluating different Monitors for the same symbol against accidentally different current observations purely because of duplicate fetches.

Build/reuse one coherent current symbol snapshot for the batch and fan it out to relevant Monitor evaluations.

If the worker architecture permits concurrent batches or multiple worker instances, use the repository's existing coordination/claiming conventions. Do not introduce global in-memory correctness assumptions across processes.

## Failure semantics

A provider failure, missing history, warm-up gap, or unavailable PIT input must not be converted into a false match.

Use canonical `NOT_EVALUABLE` semantics and existing retry/error reporting patterns.

Do not fabricate Signals merely so Monitor UI has content.

## V1 implementation priorities

Prefer in this order:

1. correctness of canonical Strategy semantics;
2. durable trigger/condition transition behavior across restarts;
3. one current-data/history/series computation path per symbol snapshot;
4. reuse of existing calculated-series and FMP infrastructure;
5. observable, testable worker behavior;
6. optimization only where measurements justify it.

## Validation expectations

Implementation is incomplete without tests covering at minimum:

- enabled versus disabled Monitor behavior;
- multiple Monitors sharing one symbol snapshot without semantically duplicate data work;
- condition transition `false -> true -> true -> false` without duplicate Signals;
- trigger crossing emitted once and not repeated while remaining on the same side;
- restart/cache-loss behavior does not fabricate a trigger;
- current provisional daily observation affects daily calculated series as specified;
- missing/warm-up/PIT-unavailable dependencies return `NOT_EVALUABLE`, not a match;
- only required series are requested/computed for a Monitor batch where this can be asserted without coupling tests to private implementation details;
- FMP/current-data failure behavior;
- persistence/migration behavior for any newly introduced durable Monitor state.

Run the repository's canonical validation gate from `ai/workflows/validation.md` and add targeted integration tests against real PostgreSQL/Redis infrastructure where existing project testing conventions require it.

## Non-goals for this branch

Do not expand this feature into:

- user-configurable scan cadence;
- Redis redesign;
- generic series storage redesign;
- new Strategy operators or formulas unless a separate product decision explicitly requires them;
- backtest methodology changes;
- unrelated frontend redesign.

If the current codebase reveals a contradiction with these decisions, document the contradiction and resolve it at the canonical boundary rather than hiding it behind Monitor-specific special cases.
