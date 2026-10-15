# Monitor Engine

This document is the canonical architecture for Strategy monitoring. A Monitor evaluates
**finalized end-of-day sessions**, in order, from a durable per-member checkpoint, and reaches no
price provider; `docs/decisions/monitor-eod-v2.md` is the implementation record (§3 for the
evaluation) and `docs/decisions/eod-finality-v1.md` the finality rule.

Read together with:

- `ai/product/monitors.md`
- `ai/product/strategies.md`
- `ai/architecture/strategy-evaluation.md`
- `ai/architecture/calculated-series.md`
- `ai/architecture/api-worker.md`
- `ai/architecture/observability.md`
- `ai/workflows/validation.md`
- `docs/decisions/monitor-eod-v2.md`

## Core rule

Market-data loading and calculated-series work are organized **per symbol**. Strategy evaluation is organized **per Monitor**.

Do not implement monitoring as:

```text
for each monitor
  load the same symbol history again
  calculate the same indicators again
  evaluate
```

The shape is:

```text
active Monitors
    -> resolve monitored symbols
    -> aggregate required series per symbol
    -> read each symbol's readiness and finalized frame once (PostgreSQL)
    -> per (Monitor, member): every session after its checkpoint, in order
    -> persist each member's Signals, transitions, state and checkpoint together
```

Market data is prepared by a different child, the stock EOD preparation
(`docs/decisions/monitor-eod-v2.md` §2), which owns every provider read for monitored securities.

## Reuse, do not fork

Monitoring must reuse the canonical Strategy semantics and calculated-series definitions already used elsewhere in V2.

Do not create a second implementation of operators, moving averages, RSI, intrinsic-value formulas, compatibility rules, or `NOT_EVALUABLE` behavior specifically for Monitor.

The execution context differs from backtesting; the Strategy language does not.

## Data flow

Conceptually:

```text
stock EOD child: FMP -> finalized bars + materialized derived rows (PostgreSQL)
                             |
Monitor child:               v
                 readiness (newest bar proven final)
                             |
                             v
            finalized frame: stored bars + materialized columns
                             |
                  +----------+----------+
                  |                     |
         Monitor A, member          Monitor B, member
     sessions after checkpoint   sessions after checkpoint
                  |                     |
                  +----------+----------+
                             v
       one transaction per member: Signals, transitions, state, checkpoint
```

A Monitor's daily and weekly indicators, intrinsic values and Fundamental Metrics are the
materialized values of each session — the same columns a backtest reads — never recomputed against
a provisional observation.

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
  readiness,
  finalizedFrame,
  members
}>
```

This is an implementation detail, not a persisted product model.

The important behavior is:

- a symbol's frame is read once per evaluation cycle, not once per Monitor;
- all relevant Monitors evaluate against the same coherent frame for that cycle.

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

## Universe, ongoing membership and exit levels

A pass evaluates every level of the Strategy — BUY, SELL and FINAL EXIT — for every **current**
member of the Monitor's Stock List: one whose ongoing membership (`isOngoingListMember`,
`docs/decisions/monitor-eod-v2.md` §1, §4) holds on the expected session. Membership gates **every**
level alike, on every session a catch-up steps. A member that is not current is not evaluated at
all; a member edited out is ended with `MEMBERSHIP_CHANGED` (administrative) in the
reconciliation, and a changed ongoing period resets the member's state in its own transaction
(`resetMembership`). Backtests keep the BUY-window rule (`isBuyWindowEligible`, BUY levels only);
see `ai/product/lists.md`.

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
@intrinsic/strategy   monitor-lifecycle.ts   stepMonitorLevel / reconstructMonitorLevel        pure reducer
apps/worker           session-decision.ts    decideLevelSessions                               pure framing
apps/worker           monitor-repository.ts  applyMemberEvaluation / resolveUnvisitedStates    persistence
apps/worker           monitor-evaluation.ts  MonitorEodEvaluation                              the pass
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
- **`decideLevelSessions`** adds the Monitor framing — the sessions after the member's checkpoint,
  applied in order, ongoing-membership gating, logic-change resets, reconstruction at the newest
  session or the initial replay, each change's origin and evidence — and returns one decided write
  for the level, or nothing.
- **`applyMemberEvaluation`** persists every level of one member atomically: the Signals it closes
  (with reason and session) and opens, the state rows, the transition rows and the checkpoint, in
  one transaction behind the binding fence, the checkpoint's previous value and the `stateVersion`
  guard. It is the only Monitor write path.

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
logic it belonged to, `reconstructed` whether history rather than an evaluated session established it.

`MonitorSignal.observationBasis` says how its price was obtained: `LIVE_QUOTE` for occurrences the
V1 cycle decided on an intraday quote before Monitor EOD V2, `EOD_CLOSE` for every occurrence since.
Nothing writes `LIVE_QUOTE` any more; the value stays so those historical rows read truthfully.

`MonitorStateTransition` is the append-only change log, ordered by `sequence`. Only state changes are
written — a repeated scan writes nothing at all — and `signalId` is nullable because a pending setup
exists before any occurrence does. `origin` is `OBSERVED`, `HISTORY` or `ADMINISTRATIVE`
(`docs/decisions/monitor-eod-v2.md` §3.4), decided by `Monitor.watchingSince`.

Since step 5 every change a session decided carries `strategyVersionId` and `evidence` — per rule,
each predicate's compared operands and result, from `explainMarketSignal` (§5.3 of the record).

`MonitorEvaluationCheckpoint` is one row per `(monitor, security)`: `evaluatedThrough`, the newest
session every level of that member was decided through, advanced only in the transaction that wrote
what those sessions produced (§3.2 of the record).

### What `NOT_EVALUABLE` does

A level observation whose predicates cannot be decided moves nothing, except that a trigger-only
event still ends when a later real session is observed. A day with **no** bar — a weekend, a full
closure, a halted stock — and a session not yet proven final produce no step at all.

### Reconstruction

A level with no state, or state under different logic, is reconstructed rather than started blank,
and the reconstructed state is the one a **full canonical replay** — every session from the
security's first canonical session (`evaluationHistoryStart`: the product horizon, clamped to the
listing date) — would reach. A fixed window is not enough: a Conditions + Trigger setup whose
Conditions held for longer than the window, with its Trigger consumed before it, would start
`PENDING_TRIGGER` at the window's start instead of `ACTIVE` since the Trigger.

**Resting sessions.** An observation *rests* a level when it leaves every rule neither `ACTIVE` nor
`PENDING_TRIGGER` whatever state it was applied to: the member's ongoing membership had not begun
on the date, a condition-bearing rule's Conditions are false, or a trigger-only rule observes a session without a
crossing (`isRestingMonitorStep`). Nothing before a resting session can influence the level after
it, so `reconstructMonitorLevel` replays from the **latest** resting session only, and reports
`exact: false` when the history it was given has none and does not start at the security's first
session.

**Reading history.** The cycle notices missing state before any data work and reads about
`DEFAULT_RECONSTRUCTION_SESSIONS` (252) closed sessions before the newest finalized session through
`readFinalizedEvaluationFrame` — the backtest projection over stored bars and materialized series,
per-day intrinsic values, PostgreSQL only. For each level being reconstructed, `needsDeeperHistory` scans
that read backwards to its latest resting session. Only when a level that will actually be created
now (decidable newest session that does not itself rest) finds none is the read doubled — 504,
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
transition — `RECONSTRUCTED` with origin `HISTORY`, or the newest session's own reason when that
session entered the state. Only a decidable newest session creates a row, so a level that cannot be
decided yet waits, and a history read that fails leaves the level for a later cycle rather than
starting it from nothing.

**A new Monitor replays instead** (`docs/decisions/monitor-eod-v2.md` §5): the same reconstruction
anchored at the session before its 90-day window gives the exact state before it, and every window
session is then stepped and recorded. Everything else below still applies to it.

Because reconstruction is keyed on "no current state", it covers new members, re-added members,
rebinds, edited levels and legacy state with one mechanism. `resolveUnvisitedStates` therefore deletes the
state of a removed member or level (after closing its occurrence and recording why) instead of
keeping a reset row.

`pnpm monitors:scan-once` runs one cycle through the normal singleton claim — the operator step after
`pnpm builtins:bootstrap`.

## Historical data loading

The Monitor evaluation reads history from PostgreSQL only. The stock EOD child loads a monitored
security's history from the product horizon on its first preparation and keeps its tail, derived
rows and operand inputs current (`docs/decisions/monitor-eod-v2.md` §2), so a reconstruction or a
catch-up never needs the provider.

Do not introduce incremental EMA/RSI/SMA state machines: the evaluation reads materialized columns.

## Provider work

The Monitor evaluation makes **no** provider request. Every price, statement and alternative-data
read for monitored securities belongs to the stock EOD child, per security, never per Monitor,
through the shared gated `FmpClient`. The Monitor child's gated provider serves only the venue
holiday schedule.

## Intrinsic-value handling

A Monitor reads each session's materialized intrinsic values and price-dependent results (Margin of
Safety, valuation ratios) through the backtest projection. Follow `calculated-series.md` for
canonical persistence/revision/invalidation behavior.

## Concurrency and coherent snapshots

Within one Monitor evaluation cycle, every Monitor watching a symbol is evaluated against the same
frame, read once.

If the worker architecture permits concurrent batches or multiple worker instances, use the repository's existing coordination/claiming conventions. Do not introduce global in-memory correctness assumptions across processes.

## Failure semantics

A provider failure, missing history, warm-up gap, or unavailable PIT input must not be converted into a false match.

Use canonical `NOT_EVALUABLE` semantics and existing retry/error reporting patterns.

Do not fabricate Signals merely so Monitor UI has content.

A session is evaluated only once its bar is **proven final**: read after the session's finalization
instant and materialized. A member whose security is not ready waits at its checkpoint; nothing is
decided on a provisional or carried value, so an outage delays evaluation and never resolves or
re-emits anything. When the data arrives, the missed sessions are stepped in order.

A failure is **per security**: logged (`monitor.symbol.failed`), counted in the pass
summary, and the pass completes the others. Each member is one transaction, so nothing is
half-applied, and the next pass resumes from the checkpoints.

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
- missed sessions caught up in order, each once, with the right origin (outage versus pause);
- a member waiting on a session not yet proven final, and on an ETF that does not hold it yet;
- missing/warm-up/PIT-unavailable dependencies return `NOT_EVALUABLE`, not a match;
- only required series are requested/computed for a Monitor batch where this can be asserted without coupling tests to private implementation details;
- a failure or crash mid-pass resumed from the checkpoints without duplicates;
- persistence/migration behavior for any newly introduced durable Monitor state.

Run the repository's canonical validation gate from `ai/workflows/validation.md` and add targeted integration tests against real PostgreSQL/Redis infrastructure where existing project testing conventions require it.

## Observation dates and the exchange clock

The observation date is the session date of the stored end-of-day bar. Which sessions are final is
decided on the New York clock (`eodCutoffDate` in `@intrinsic/domain`) — **not** the UTC day and
not the wall clock. V1 admits only NASDAQ, NYSE and AMEX (`SUPPORTED_EXCHANGE_CURRENCIES`), all US
venues on one clock; `security-universe.test.ts` pins the supported set, so admitting a venue on
another clock fails a test rather than silently mis-dating its sessions.

## Re-based histories and the ex-date hold

`../../docs/decisions/historical-price-basis-v1.md` guards the frame with **one basis per frame**:
`readFinalizedEvaluationFrame` reads the security's price-basis generation before and after its
PostgreSQL reads, and a replacement committed in between leaves that security undecided for the
pass — a `warn` (`monitor.evaluation.history-rebased`), not a failure — so the next pass reads the
replaced history. The checkpoint records the generation its sessions were decided on. The V1 live
quote's split-sized hold no longer applies: there is no quote.

## The trading-session boundary

An observation is a stored bar, so only a day the security traded is ever observed. The venue's
schedule — `CachedTradingCalendar` in `@intrinsic/stock-data`, over the provider's holiday schedule —
decides which session is **expected** (`EodFinalityPolicy.expectedSession`): what "current" means
for a member, and which unprinted session may be given up on. An **early close is a session** and is
not filtered: the venue opened.

It is deliberately not a trading-calendar subsystem. It answers one question — did this venue open
at all — for the three exchanges V1 admits, and knows nothing about session times, half-days or
settlement.

Three properties keep it affordable, and each is required rather than incidental:

- **Per exchange and year**, never per symbol or per Monitor. Every security on a venue shares its
  calendar, so a cycle over a thousand symbols resolves at most one schedule per exchange.
- **Single-flight.** Concurrent callers share one in-flight request, which is what makes the above
  true under the cycle's bounded symbol concurrency on a cold calendar.
- **Process memory with a TTL.** A published schedule changes very rarely and is not
  correctness-critical state that must survive a restart — a cold process fetches it again. Nothing
  is cached in Redis for it.

A failure to resolve the schedule falls back to weekdays for the expected session and logs
`monitor.evaluation.calendar-unavailable`. It cannot fabricate a bar — an observation is a stored
bar — and can only make a holiday the session an unprinted security is passed through. A failure is
never cached, so the next cycle retries.

**A day with no bar advances nothing.** A weekend, a holiday or a halted day is not a later session,
so it cannot close a Trigger Signal; only a real one ends an event's lifetime.

## Accepted V1 limitations

Recorded so they are not rediscovered as defects. None can produce a wrong Signal.

- **Per-`(monitor, security)` writes.** Every level of a member and its checkpoint are applied in
  one transaction. A member already through the expected session writes nothing at all, so a pass
  with no new session costs one readiness read per security and no transaction.
- **Reconstruction reads a year of history per new or reset security** from PostgreSQL, and more
  only for a level whose rules have not all rested within that year (doubling, up to the security's
  first session). It happens once per level, not per cycle. A level that is not decidable yet asks
  for no deeper read.
- **A halted security's members stay at its last bar on weekdays** (`monitor-eod-v2.md` §3.7).

## Non-goals for this branch

Do not expand this feature into:

- user-configurable scan cadence;
- Redis redesign;
- generic series storage redesign;
- new Strategy operators or formulas unless a separate product decision explicitly requires them;
- backtest methodology changes;
- unrelated frontend redesign.

If the current codebase reveals a contradiction with these decisions, document the contradiction and resolve it at the canonical boundary rather than hiding it behind Monitor-specific special cases.
