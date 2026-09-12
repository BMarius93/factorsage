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

`Signal` is the product term for a Monitor result. It is deliberately not the Monitor: a Monitor is
the standing configuration (Strategy + List + enabled), and a Signal is one durable outcome it
produced, with the observation date and price it was decided on. The word is shared with the
Strategy language — a *Strategy signal* is the rule inside a level (Conditions plus an optional
Trigger) that a Monitor evaluates — and the two are never the same object.

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

### What identifies a Signal

A condition Signal is one unbroken run of matched evaluations of one level for one security under
one Monitor: it begins on the first decided match and ends on the first decided non-match, on the
security leaving the List, on the level leaving the Strategy, or on the level's logic changing. A
trigger Signal is one crossing on one observation date within one such run of the same logic and
membership; the same date may carry a second trigger Signal only after the run was broken — the
level's logic changed and the new rule also crosses that day, or the member was removed and
re-added. Restarts, retries, duplicate scans and re-observations of a session never create a
Signal, because every decision is re-derived from the durable state and reaches the same
conclusion. `ai/architecture/deep-discovery.md` investigation 4 records the full table.

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

## Lifecycle in one place

- **Create.** A Monitor references a Strategy and a Stock List that both belong to the caller,
  verified in the transaction that inserts it. It starts `enabled` unless created otherwise.
- **Evaluate.** Every enabled Monitor is evaluated in every scan cycle. The cycle is a singleton
  claim across all worker processes, so two cycles never run at once by design; if a lease is lost
  and one overlaps anyway, the durable transition state's optimistic version guard means at most
  one of them can emit a given Signal.
- **Disable.** Stops future evaluations from the next cycle on (a cycle already running finishes
  with the enabled set it loaded). Persisted transition state and active Signals are left exactly
  as they were: a disabled Monitor still shows the Signals that were active when it was disabled.
- **Re-enable.** Resumes from that persisted state. A condition that was already matched is not
  re-emitted; a trigger keeps the date it last fired on.
- **Edit the Strategy.** Takes effect from the next cycle. Only levels whose canonical logic
  changed have their state reset and their active Signal closed; unchanged levels continue.
- **Edit the List.** Takes effect from the next cycle. A removed member's active Signals are
  resolved by that cycle; an added member is evaluated as new and may emit immediately.
- **Rebind the Strategy or List.** Pointing the Monitor at a *different* Strategy or Stock List is
  not the same operation as editing the contents of the ones it references. It crosses a
  configuration boundary: the transition state is discarded, every Signal still active is resolved,
  `lastScanAt` is cleared, and the new configuration is evaluated from the next cycle. Signal
  history is kept. See "Rebinding a Monitor" below.
- **Delete the Monitor.** Removes its transition state and its Signals with it. The Strategy and
  List it referenced are untouched.
- **Delete the Strategy or List.** Refused while any Monitor references it. Delete the Monitor
  first.

## Two different operations: editing contents, and rebinding

These are deliberately separate, and conflating them is the mistake this section exists to prevent.

| | What changes | What happens to state |
| --- | --- | --- |
| **Editing the referenced Strategy or List** | its rules, or its membership | live from the next cycle; only levels whose own logic changed are reset, and removed members' Signals are resolved |
| **Rebinding the Monitor** | *which* Strategy or List it references | a configuration boundary: all transition state discarded, all active Signals resolved, `lastScanAt` cleared |

The first needs no request against the Monitor at all. The second is `PATCH /monitors/:id` with a
different `strategyId` or `stockListId`.

## Strategy mutability

A Monitor references a **Strategy**, not a pinned Strategy version. Monitoring is live: editing the
Strategy changes what is being watched, immediately and without recreating the Monitor. This is the
deliberate opposite of a Backtest run, whose immutable snapshot is its reproducibility authority.

Persisted Monitor state is scoped to the **canonical logic of its own level**, not to the Strategy
version, and addressed by the level's id. The id is therefore identity: a level that keeps its id
and its logic keeps its state and its active Signal through any number of edits elsewhere; a level
whose logic changed is reset; a level whose id changed is, to the Monitor, a removed level and a new
one. Only the newest version is ever evaluated — edits between two cycles are invisible except
through their net effect on each level's id and logic. Editing one level appends a new Strategy version, and that must not reset the state of every
other, unchanged level — doing so would re-emit a Signal on each of them for a match that never
stopped. A level whose logic genuinely changed no longer describes what its state latched, so that
state is reset and any Signal still active under the old logic is closed.

## Rebinding a Monitor

A user may point an existing Monitor at a different Strategy or a different Stock List. They do not
have to delete it and start again, and the Signal history it accumulated is not the price of
changing their mind.

What makes this more than a column update is that the Monitor's durable state is *about* the
configuration it was evaluating. A `MonitorSignalState` row latches the result of one level of one
Strategy for one member of one List. Once either reference moves, that row describes something the
Monitor no longer evaluates. So a rebind:

- **resolves every Signal still active.** They stop being current, which they are not. A Signal that
  was active under the replaced configuration is closed with the rebind's timestamp.
- **keeps every Signal row.** A Signal is a record of what was observed, and observations are not
  invalidated by a later configuration change. Nothing is deleted.
- **discards the transition state.** No latch from the replaced configuration can decide an edge in
  the new one, and no fingerprint coincidence between two Strategies can silently carry one across.
- **clears `lastScanAt`.** The configuration the Monitor now names has not been checked. Reporting
  the previous one's scan time would be a claim about work that never happened.
- **evaluates the new configuration from the next cycle.** A match under the new rules is emitted
  then, as a new Signal, because that is when it was first observed.

Rebinding away and back is two boundaries, not a round trip: the state discarded by the first is not
restored by the second, and the next cycle re-establishes it from persisted history.

### A scan already running cannot land in the new configuration

A cycle loads a Monitor's binding when it starts and may commit a transition seconds later, so a
rebind can land in between. Nothing about the ordering is left to timing: the Monitor carries a
`configVersion` that only a rebind increments, the cycle carries the value it loaded, and every
durable write the cycle makes for that Monitor is conditioned on the column still holding it.

The write takes the Monitor row's lock before touching state, and a rebind takes it first as well,
so the two serialize rather than interleave — across worker processes, since the fence is a row in
PostgreSQL and not process state. A cycle that loses the race writes nothing: no state row, no
Signal, and no `lastScanAt`. Its evaluation described a configuration the Monitor no longer has, so
discarding it is the correct outcome and is recorded as such rather than as a failure.

The per-state optimistic `stateVersion` guard is **not** sufficient on its own and is not what does
this. It protects a row the cycle actually read, which covers two overlapping cycles; a rebind
deletes those rows, so the next evaluation of the replaced configuration would find no previous
state, take the create path, and have nothing to contend against.

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

### How Monitor evaluation differs from a backtest

Both run the same evaluator over the same frame projection, so operators, the 2% closeness
tolerance, buy-window gating, `NOT_EVALUABLE` and the choice of `t - 1` (the previous row of the
trading-day axis) are identical. The differences are the observation, not the language:

- **The observation is live.** A backtest evaluates the closed bar; a Monitor evaluates the last
  trade at scan time, pre-market and after-hours included. A crossing the close never confirms can
  fire a Monitor Signal and would not appear in a backtest; both are correct for what they observe.
- **Daily averages and oscillators are recomputed** over a bounded window whose warm-up is derived
  from each series' definition, so the seed's influence is below `1e-6` of the value; a backtest
  reads the full-history materialized columns. A strict comparison decided inside that tolerance
  could differ by design; nothing else can.
- **Weekly series and intrinsic values are carried forward** from the newest closed derived row —
  neither can change intraday — where a backtest reads each day's own row.
- **Position-dependent metrics** (`Gain`, `Loss`) are `NOT_EVALUABLE` for a Monitor and live for a
  backtest.
- **The last day of a backtest ending today may itself be an in-progress bar**, because the
  provider's EOD feed already lists the current session while it is open (see
  `ai/product/backtests.md`).

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
  it is dated in a session later than the cycle's own, or when its timestamp is present but cannot
  be read. Each of those would otherwise fabricate an observation. A quote that carries **no**
  timestamp at all is taken at its word and dated to the cycle's own session; for a symbol that did
  not trade that day this can append a bar the market never produced. Accepted in V1 because failing
  closed would stop monitoring every symbol whose feed omits the field.
- **Signal history is read newest-first and bounded.** The Monitor detail returns the most recent
  100 Signals and nothing pages further back; older rows are durable but not yet addressable
  through the API. Pagination is a contract addition for the web slice, not a redesign.
- **Signal history on the web is the newest 100 and is labelled as such.** The Monitor page lists
  what `GET /monitors/:id` returns and says so when it is at the cap, rather than implying a
  lifetime history. Paging further back is the contract addition the previous point describes.
- **"Not evaluable" and "not checked" are inferred where the state table cannot distinguish them.**
  A cycle that cannot decide a level it has never decided before deliberately persists no row, so
  the two look identical in `MonitorSignalState`. The detail response separates them using the two
  facts that do differ — whether the Monitor has ever completed a cycle, and whether the security
  joined the List after the last one. A security whose every evaluation has been `NOT_EVALUABLE`
  since before the last cycle is therefore reported as not evaluable, which is what it is; the
  inference cannot report either of them as a decided non-match.
- **The monitored universe is not capped.** A Stock List has a per-request add limit but no total
  size, so one very large monitored List sets the cycle's provider, hydration and memory cost.
  Backtests cap a run at `BACKTEST_MAX_SECURITIES`; Monitors have no equivalent yet, and adding
  one is a product decision to make deliberately rather than a silent engine limit.
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

## Open product decisions

Recorded so they are decided deliberately rather than by whichever code path is touched next. Each
is traced in `ai/architecture/deep-discovery.md`.

1. **A member that stops trading.** A delisted or indefinitely halted security yields no usable
   quote, so every evaluation is `NOT_EVALUABLE`, the latch never moves and its active Signals —
   condition or trigger — stay active indefinitely with `lastOutcome = NOT_EVALUABLE`. Nothing
   resolves them today; the catalog sync marks the security inactive but the List still holds it.
   Options: resolve on deactivation like a removed member, or surface "no current data since" and
   leave the Signal. Not decided.
2. **Scanning outside trading sessions.** The cycle runs on the same cadence around the clock; on a
   weekend or overnight it re-observes the last session with an unchanged or after-hours quote,
   spending one provider batch per 50 symbols per cycle for no new information (after-hours moves
   can still resolve and re-emit condition Signals, which is the live-observation rule, not a
   defect). Idling while no admitted venue has a session is an application-side change the
   calendar already makes possible. Not decided.
3. **Monitored-universe size.** No total cap on a List exists (investigation 10 quantifies the
   cost beyond the resident-stock bound). A cap is a product rule, not an engine limit.
4. **Signal history beyond the newest 100.** The contract has no paging; the web slice needs it.
5. **A backtest ending today** simulates an in-progress last day (`backtests.md`).

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
