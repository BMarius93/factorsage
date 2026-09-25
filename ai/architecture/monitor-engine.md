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

A Monitor holds no position, so `Gain` and `Loss` are **not evaluated at all** — see
`ai/product/monitors.md`. The exclusion lives in exactly one place: `monitorStrategyLevels` in
`@intrinsic/strategy` does not return a level whose Signal is position-dependent, decided by
`signalNeedsPositionState` over `isPositionDependentMetric`. There is no second list of metric names
anywhere, and the level is dropped whole rather than having its offending predicate stripped.

For FINAL EXIT, "whole" means the level is excluded when **any** Exit Rule is position-dependent.
Keeping only the market-derived alternatives would leave a level matching on strictly fewer days
than the user wrote, and reporting "no match" from a subset of someone's logic is the same misreport
as evaluating half a conjunction.

### FINAL EXIT is one level, with alternatives

`MonitorStrategyLevel` carries `rules` — the level's alternatives, ORed — and parallel `ruleIds`,
rather than a single `signal`. BUY and SELL always carry exactly one rule, keyed by the level id;
FINAL EXIT carries its Exit Rules in definition order, keyed by their own ids. Modelling every level
as a one-or-more list keeps the cycle free of a FINAL EXIT special case.

Multiple Exit Rules cannot duplicate a Signal: each rule has its own lifecycle inside `ruleStates`,
but the level aggregates them into **one** state, and the occurrence belongs to the level. The
canonical `evaluateLevelWithoutPosition` still provides the level's single `lastOutcome`.

`fingerprint` is resolved by `monitorStrategyLevels` rather than by each caller, so the worker and the
API cannot develop separate opinions about when a level's logic changed. `hasTrigger` (every
alternative triggered) is recorded on a Signal as explanation only; the lifecycle reads each rule's
own shape instead.

That one list is also the cycle's **visited set**: an excluded level is unvisited, so
`resolveUnvisitedStates` closes any occurrence it still had (`LEVEL_REMOVED`) and forgets its state —
the same reconciliation a level removed from the Strategy gets. Editing it back makes it a level that
is reconstructed from history.

`evaluateSignalWithoutPosition` keeps its `NOT_EVALUABLE` guard for a position-dependent Signal even
though the canonical path can no longer reach it. `evaluateMarketSignal` deliberately *skips*
position-dependent predicates so the backtest can AND them in against live position state afterwards,
so without that guard the empty-conjunction rule would make a Gain/Loss-only Signal vacuously TRUE
and every monitored symbol would match on every scan. A caller that ever bypassed the filter gets
`NOT_EVALUABLE` rather than that.

The API applies the same list when it reports per-security status: a state row belonging to a level
the current Strategy version no longer monitors is not allowed to decide a status, so a level edited
into `Gain` cannot leave behind something that reads as a decided non-match.

## Strategy identity and state invalidation

A Monitor references the live `Strategy` and resolves its current version each cycle; no version is
pinned. Durable state is keyed on the **canonical fingerprint of its own level's logic**
(`strategySignalFingerprint` for a BUY or SELL level, `strategyFinalExitFingerprint` for FINAL EXIT,
both in `@intrinsic/contracts` and both sharing their serialization with
`strategyDefinitionFingerprint` so none of them can disagree), never on the Strategy version. Keying
on the version would reset every level on any edit and re-emit a Signal on each unchanged one.

A metric's fingerprint carries whatever parameterizes it. For the catalog-backed metrics that is a
series id; for the alternative-data kinds it is the configured signature; for **Relative Volume it
is the period**, which was missing until the RVOL identity fix and made `RVOL 10` and `RVOL 20`
fingerprint identically — one durable state, one latch and one Signal for two different levels.
Correcting it moves the fingerprint of every RVOL level exactly once, so the first cycle after that
deploy takes the ordinary **edited-level** path for those levels and no other: the stale state's
occurrence closes with `LOGIC_CHANGED`, and the level is then **reconstructed from history** rather
than started blank, re-establishing the correct lifecycle on the first decidable observation. It is
a one-time reset of RVOL Monitor state, accepted rather than worked around, because what those rows
latched was never keyed to the logic it belonged to. No non-RVOL level is affected, and no stored
`definitionHash` of a Strategy without RVOL moves, because every other metric shape serializes
byte-for-byte as it always did. A Strategy that *does* use RVOL gets one new `StrategyVersion` the
next time it is saved, for the same reason.

FINAL EXIT's fingerprint covers **every** Exit Rule, so editing, adding or removing any one of them
resets that level's transition state and no other level's. A single-rule FINAL EXIT fingerprints
byte-identically to the same logic under document schema version 1 — an OR of one alternative is
that alternative — so upgrading a stored version 1 Strategy does not reset a single latch. Without
that property, every Monitor with a FINAL EXIT would have lost its state on deploy, with nobody
having edited anything.

## Built-in (SYSTEM) Monitors

`listActiveMonitors` returns customer Monitors that are `enabled` **and** execution-eligible under
their owner's entitlements, plus built-in Monitors whose `isGloballyEnabled` is on. A built-in has no
owner, no plan and no capacity; `isPublished` and customers' Dashboard preferences never affect
evaluation. Built-in Monitors are shared: ten thousand viewers cost one evaluation.

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

A rebind (`crossMonitorConfigurationBoundary`, shared by `MonitorsService` and the built-in reset)
records a `MONITOR_REBOUND` transition for every current lifecycle, resolves every active Signal
with that reason, and deletes the state; the next cycle reconstructs.

A monotonic counter rather than comparing the two ids: rebinding away and back would otherwise
present the same pair to an in-flight cycle whose state had already been discarded.

## The lifecycle, and where each part of it lives

`docs/decisions/builtin-dashboard-signals-v1.md` section 2 and `ai/product/monitors.md` own the
semantics. The implementation is split three ways, deliberately:

```text
@intrinsic/strategy   monitor-lifecycle.ts   stepMonitorLevel / reconstructMonitorLevel pure reducer
apps/worker           level-decision.ts      decideLevel                                pure framing
apps/worker           monitor-repository.ts  applyLevelState / resolveUnvisitedStates   persistence
```

- **`stepMonitorLevel`** applies one real observation to one level: per rule it evaluates a *close*
  phase (Conditions false, buy window closed, a trigger-only event reaching a later session) and then
  an *open* phase (Conditions true → `ACTIVE` or `PENDING_TRIGGER`; a fresh Trigger → `ACTIVE`), and
  aggregates the rules into the level state. Resolution before activation is what lets a trigger-only
  event superseded by the next session's crossing produce two transitions and two occurrences, while
  one FINAL EXIT rule taking over from another on the same observation stays one occurrence. It
  reports the new lifecycle, the level transitions, and whether an occurrence closed or opened. The
  transitions always form one chain from the stored state to the new one: when the last active rule
  ends while another rule is already `PENDING_TRIGGER`, the step records `ACTIVE -> RESOLVED` (the
  ending rule's reason) and `RESOLVED -> PENDING_TRIGGER` (`SETUP_STARTED`, the waiting rule's id).
  `monitor-lifecycle.test.ts` checks that chain, the OR aggregate and one-occurrence-at-a-time over
  thousands of random multi-rule sequences.
- **`observeMonitorLevel`** evaluates each rule's Conditions and Trigger **separately** with the
  canonical `evaluateMarketCondition` / `evaluateMarketTrigger`. Their AND is exactly
  `evaluateMarketSignal`, so nothing about predicate semantics is restated; the lifecycle simply
  needs the two halves apart.
- **`decideLevel`** adds the Monitor framing — the observation, buy-window gating through
  `isBuyWindowEligible`, logic-change resets, reconstruction — and returns one fully decided
  `LevelStateWrite`, or nothing.
- **`applyLevelState`** persists that write atomically: the Signal it closes (with reason and
  session), the Signal it opens, the state row, and the transition rows, in one transaction behind the
  binding fence and the `stateVersion` guard. A write that changes nothing opens no transaction.

### Durable state

`MonitorSignalState` is the current truth for one `(monitor, security, level)`:

| Column | Meaning |
| --- | --- |
| `signalFingerprint` | the level's canonical logic the state belongs to |
| `lifecycleState` | `INACTIVE` / `PENDING_TRIGGER` / `ACTIVE` / `RESOLVED` |
| `lifecycleSince`, `lifecycleSinceDate`, `lifecycleSincePrice` | when, on which session and at what price the state was entered |
| `ruleStates` | internal rule-local lifecycle, `{ [ruleId]: { state, since, triggerDate } }` |
| `activeSignalId` | the current occurrence, exactly when `ACTIVE` |
| `lastOutcome`, `lastEvaluable*` | observability: the latest outcome and the latest decided observation |
| `stateVersion` | the optimistic guard |

`ruleStates` is keyed by the level id for BUY and SELL and by each Exit Rule id for FINAL EXIT.
`triggerDate` is the observation date of the crossing the latest occurrence consumed; it is what
makes a Trigger fire at most once per session and a fresh setup require a fresh crossing. A rule the
row does not describe (a row written before rule-local state existed) inherits the level's state and
converges on its next decided observation. `ruleStates` is parsed defensively
(`parseMonitorRuleStates`) and never exposed through the API.

`MonitorSignal` is one occurrence: `detectedAt`/`observationDate` are its activation instant and
session, `resolvedAt`/`resolvedObservationDate`/`resolutionReason` its end, `signalFingerprint` the
logic it belonged to, `reconstructed` whether history rather than a live scan established it.

`MonitorStateTransition` is the append-only change log, ordered by `sequence`. Only state changes are
written — a repeated scan writes nothing at all — and `signalId` is nullable because a pending setup
exists before any occurrence does.

### What `NOT_EVALUABLE` does

A level observation whose predicates cannot be decided moves nothing, except that a trigger-only
event still ends when a later real session is observed. A cycle with **no** observation — no quote,
a weekend, a full closure, a failed load — produces no step at all.

### Reconstruction

A level with no state, or state under different logic, is reconstructed rather than started blank,
and the reconstructed state is the one a **full canonical replay** — every session from the
security's first canonical session (`evaluationHistoryStart`: the product horizon, clamped to the
listing date) — would reach. A fixed window is not enough: a Conditions + Trigger setup whose
Conditions held for longer than the window, with its Trigger consumed before it, would start
`PENDING_TRIGGER` at the window's start instead of `ACTIVE` since the Trigger.

**Resting sessions.** An observation *rests* a level when it leaves every rule neither `ACTIVE` nor
`PENDING_TRIGGER` whatever state it was applied to: the BUY window refuses the date, a
condition-bearing rule's Conditions are false, or a trigger-only rule observes a session without a
crossing (`isRestingMonitorStep`). Nothing before a resting session can influence the level after
it, so `reconstructMonitorLevel` replays from the **latest** resting session only, and reports
`exact: false` when the history it was given has none and does not start at the security's first
session.

**Reading history.** The cycle notices missing state before any data work and reads about
`DEFAULT_RECONSTRUCTION_SESSIONS` (252) closed sessions before the observation through the
**backtest** read path (`prepareDailyEvaluationData` + `readDailyEvaluationFrame`, materialized
series, per-day intrinsic values). For each level being reconstructed, `needsDeeperHistory` scans
that read backwards to its latest resting session. Only when a level that will actually be created
now (decidable live observation that does not itself rest) finds none is the read doubled — 504,
1,008, … sessions, clamped to the first session, where the replay is complete by definition
(`reconstructionHistoryExtensions` counts these reads). Almost every level rests within days, so
the common case is one read and a replay of a handful of sessions; a multi-year setup costs a few
reads, never a full-history replay of every level.

**Settling.** What a resting rule still carries from before the anchor — the date it came to rest,
a Trigger it consumed earlier — changes nothing for any observation on or after the anchor, and
cannot be known without the older history. `settleMonitorLevelLifecycle` pins it: a rule or level at
rest since then is stored `INACTIVE` since the anchor, and a consumed Trigger older than the anchor is
dropped. `ACTIVE` and `PENDING_TRIGGER` state, their dates and the consumed Trigger of an active
occurrence are exactly the full replay's. A reading of a session older than the anchor — which closed
history already decided — can never move the level. `monitor-lifecycle.test.ts` checks, over
random histories with long unbroken runs, that the reconstruction equals the settled full replay
and that both then behave identically on every later observation.

**Persisting.** Only the result is written: the final lifecycle (a reconstructed `RESOLVED` is
stored as `INACTIVE`, because no occurrence was ever recorded for it), at most one `reconstructed`
occurrence dated to its real activation session and priced at that session's close, and one
transition — `RECONSTRUCTED`, or the live reason when the live observation itself entered the state.
Only a decidable live observation creates a row, so a level that cannot be decided today waits, and
a history read that fails leaves the level for a later cycle rather than starting it from nothing.

Because reconstruction is keyed on "no current state", it covers new Monitors, new or re-added
members, rebinds and edited levels with one mechanism. `resolveUnvisitedStates` therefore deletes the
state of a removed member or level (after closing its occurrence and recording why) instead of
keeping a reset row.

`pnpm monitors:scan-once` runs one cycle through the normal singleton claim — the operator step after
`pnpm builtins:bootstrap`.

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
- the lifecycle table in `monitor-lifecycle.test.ts` (conditions only, conditions + trigger,
  trigger only, buy windows, FINAL EXIT rules, retries, replay);
- condition transition `false -> true -> true -> false` without duplicate Signals;
- a triggered setup waiting, firing once, and staying active while its Conditions hold;
- reconstruction establishing a trigger that fired before the Monitor existed, idempotently;
- reconstruction equal to a full canonical replay when the Conditions have held for longer than the
  first history read (new Monitor, new member, rebind, logic reset);
- FINAL EXIT durable state and transition history ending in the same aggregate state;
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
- **Per-`(monitor, security, level)` writes.** A change is applied in its own transaction.
  Evaluations that change nothing write nothing at all, so the steady state costs no transactions;
  only genuine state changes do.
- **Reconstruction reads a year of history per new or reset security** through the backtest path,
  and more only for a level whose rules have not all rested within that year (doubling, up to the
  security's first session). It happens once per level, not per cycle. A level that is not decidable
  today asks for no deeper read.

## Non-goals for this branch

Do not expand this feature into:

- user-configurable scan cadence;
- Redis redesign;
- generic series storage redesign;
- new Strategy operators or formulas unless a separate product decision explicitly requires them;
- backtest methodology changes;
- unrelated frontend redesign.

If the current codebase reveals a contradiction with these decisions, document the contradiction and resolve it at the canonical boundary rather than hiding it behind Monitor-specific special cases.
