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

## Universe, buy windows and exit levels

A cycle evaluates every level of the Strategy — BUY, SELL and FINAL EXIT — for every member of the
Monitor's Stock List.

A BUY level is gated by that member's buy window at the observation date, through the canonical
`isBuyWindowEligible`; SELL and FINAL EXIT are not. That is the same rule the backtest day loop
applies, read from the same function. See `ai/product/lists.md`.

A Monitor holds no position, so `Gain` and `Loss` are `NOT_EVALUABLE` — the existing rule in
`ai/product/strategies.md` for unavailable position state. `evaluateSignalWithoutPosition` in
`@intrinsic/strategy` applies it by ANDing that evaluability into the canonical market result. It
exists because `evaluateMarketSignal` deliberately *skips* position-dependent predicates so the
backtest can AND them in against live position state afterwards: without supplying the missing
operand's evaluability, the empty-conjunction rule would make a Gain/Loss-only Signal vacuously TRUE
and every monitored symbol would match on every scan.

## Strategy identity and state invalidation

A Monitor references the live `Strategy` and resolves its current version each cycle; no version is
pinned. Durable state is keyed on the **canonical fingerprint of its own level's Signal**
(`strategySignalFingerprint` in `@intrinsic/contracts`, which shares its serialization with
`strategyDefinitionFingerprint` so the two cannot disagree), never on the Strategy version. Keying on
the version would reset every level on any edit and re-emit a Signal on each unchanged one.

## Rebinding: the configuration fence

A Monitor's `(strategyId, stockListId)` pair can be changed by its owner. `ai/product/monitors.md`
owns what that means to the product; the mechanism is one column and one lock.

`Monitor.configVersion` is incremented **only** when one of those two ids actually changes value —
never by a rename or an enable/disable, neither of which invalidates anything a cycle evaluated. A
cycle reads it with the rest of the Monitor and carries it into every durable write: the transition
apply, the unvisited-Signal sweep, and the `lastScanAt` stamp. Each of those asserts the column still
holds the value the cycle loaded, under `SELECT … FOR SHARE` on the Monitor row; the rebind takes
`FOR UPDATE` on the same row first, before it touches state, so the two orders agree and cannot
deadlock. A cycle that lost the race writes nothing and reports it, and the cycle summary counts it
as `transitionsStaleConfiguration` rather than a contention or a failure.

Why the existing `stateVersion` guard is not enough: it protects a state row the cycle read, which is
exactly right for two overlapping cycles. A rebind *deletes* those rows, so the next evaluation of
the replaced configuration finds no previous state and takes the create path — inserting state and
emitting a Signal with nothing to contend against. The fence has to be on the thing that changed,
which is the Monitor.

A monotonic counter rather than comparing the two ids: rebinding away and back would otherwise
present the same pair to an in-flight cycle whose state had already been discarded.

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

That table is **condition** semantics. A trigger is an event on an observation date, and the two
lifecycles are deliberately different:

```text
condition : a state       -> emitted when it begins, resolved when it ends
trigger   : an event      -> emitted at most once per observation date,
                             active for that session, closed when a later session is observed
```

The provisional observation moves during a session while its `t - 1` stays fixed at the last closed
day, so a crossing predicate degenerates into the plain relationship it crossed into for the rest of
that date. Applying condition semantics to it would emit a second Signal for one crossing when the
price moved back and forth, and would resolve the first one in between — a fired event disappearing
from the user's list because the price ticked a cent. See `ai/product/monitors.md`.

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

A current observation is **required**. Without one the symbol is `NOT_EVALUABLE` for that cycle;
there is deliberately no fallback to evaluating the last closed day. That fallback looks harmless and
is not: it silently swaps the observation a Monitor is defined to evaluate for a different one, so an
outage would resolve live matches and re-emit them on recovery. Reporting "not decidable" leaves
every durable latch untouched, which is what makes an outage invisible rather than destructive.

Current-data failure is all-or-nothing for a cycle. Partial cycles are not a V1 concept: the read
happens before anything is persisted, and a failure is rethrown so the cycle takes the worker's
failure and retry path — recorded as a failure, backed off, retried — rather than being absorbed
into a cycle that then completes normally, marks every Monitor scanned and resets the schedule's
failure history having evaluated nothing. Every durable latch is preserved.

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

## Observation dates and the exchange clock

The observation date is the trading day the provider's quote timestamp falls in, resolved through
`tradingSessionDate` in `@intrinsic/domain` — **not** the UTC day and not the wall clock.

That resolution is exact, not approximate, and the reason is the admission table: V1 admits only
NASDAQ, NYSE and AMEX (`SUPPORTED_EXCHANGE_CURRENCIES`), all US venues on one clock, whose regular
and extended sessions run 04:00–20:00 local and never cross local midnight. Deriving the day in UTC
would be wrong for part of the year — 19:00–20:00 New York time is already past midnight UTC under
EST, so a Monday-evening quote would name Tuesday, and a Friday-evening one Saturday.

This is a timezone, not a trading calendar: it says which calendar day an instant belongs to and
nothing about whether that day was a session. `security-universe.test.ts` pins the supported set
against the claim, so admitting a venue on another clock fails a test rather than silently
mis-dating its observations — at which point the question has to be answered again, deliberately.

## The trading-session boundary

A provisional observation is built only for a day the exchange held a session. Weekends need no
provider knowledge and are refused in the pure projector; a **fully closed** holiday is refused by
the cycle, which resolves the venue's schedule first — `CachedTradingCalendar` in
`@intrinsic/stock-data`, over the provider's holiday schedule. An **early close is a session** and
is not filtered: the venue opened.

It is deliberately not a trading-calendar subsystem. It answers one question — did this venue open
at all — for the three exchanges V1 admits, and knows nothing about session times, half-days or
settlement.

Three properties keep it affordable, and each is required rather than incidental:

- **Per exchange and year**, never per symbol or per Monitor. Every security on a venue shares its
  calendar, so a cycle over a thousand symbols resolves at most one schedule per exchange. The cycle
  collects the distinct `(exchange, session)` pairs its quotes named and asks once for each.
- **Single-flight.** Concurrent callers share one in-flight request, which is what makes the above
  true under the cycle's bounded symbol concurrency on a cold calendar.
- **Process memory with a TTL.** A published schedule changes very rarely and is not
  correctness-critical state that must survive a restart — a cold process fetches it again. Nothing
  is cached in Redis for it.

A failure to resolve the schedule **fails the cycle**, by the same rule a failed quote read follows:
the only alternative is assuming the exchange was open, which is exactly the assumption that
fabricates a bar. A failure is never cached, so the next cycle retries.

**A cycle with no observation advances nothing.** A `NOT_EVALUABLE` caused by missing current data
carries no observation at all, so it cannot close a Trigger Signal: a weekend, a holiday or an
unpriced symbol is not a later session, and only a real one ends an event's lifetime.

## Accepted V1 limitations

Recorded so they are not rediscovered as defects. None can produce a wrong Signal.

- **Resident-stock bound.** Symbol data is read through the existing shared stock-data cache, whose
  resident set is bounded by configuration. A monitored universe larger than that bound re-hydrates
  from durable storage each cycle — a throughput limit, accepted for V1. Do not redesign Redis or add
  a Monitor cache.
- **Per-`(monitor, security, level)` transition writes.** A transition is applied in its own
  transaction. Evaluations that repeat the recorded outcome write nothing at all, so the steady state
  costs no transactions; only genuine transitions do.

## Non-goals for this branch

Do not expand this feature into:

- user-configurable scan cadence;
- Redis redesign;
- generic series storage redesign;
- new Strategy operators or formulas unless a separate product decision explicitly requires them;
- backtest methodology changes;
- unrelated frontend redesign.

If the current codebase reveals a contradiction with these decisions, document the contradiction and resolve it at the canonical boundary rather than hiding it behind Monitor-specific special cases.
