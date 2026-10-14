# Monitors

This document is the canonical product definition for FactorSage monitoring.

## Purpose

A Monitor evaluates the existing canonical Strategy logic against each **finalized end-of-day session** of its watched stocks, in order, and produces Signals for symbols that match (`docs/decisions/monitor-eod-v2.md`).

Monitoring is not a second strategy language. Strategy semantics remain owned by `ai/product/strategies.md`; the Monitor consumes those semantics.

A Monitor combines a Strategy with a monitored symbol universe/source. It must not move List/source membership, capital, backtest execution inputs, or market-data formulas into Strategy itself.

## User controls

For V1, the user controls whether a Monitor is `enabled` or `disabled`.

The user does **not** configure the monitoring interval/cadence. Cadence is an application/infrastructure decision.

Disabling a Monitor stops future evaluations. Re-enabling it resumes evaluations using the persisted Monitor state required for correct trigger semantics, and catches up the sessions it missed in order — recorded as history, not as newly observed activity (§ Transition history).

`enabled` is intent, not a promise that the Monitor is scanning. After a downgrade an enabled
Monitor can be `BLOCKED_BY_ENTITLEMENT` — over the plan's active-Monitor count
(`MONITOR_CAPACITY`) or watching a List over the plan's symbol limit (`LIST_OVER_LIMIT`) — and then
it is not evaluated. The UI shows **one effective state** per Monitor (UI-021): an enabled
Monitor the plan has stopped reads "Paused — plan limit", with its reason as text beside it (never
only a tooltip), and the configured intent stays visible as a secondary "Monitoring: Switched on"
fact on the Monitor's own page. Showing "Enabled" and "Not scanning" side by side read as a
contradiction. Collection and detail share one web helper
(`features/monitors/utils/blocked-status.tsx`), the Monitors page states the account-level
consequence once ("N monitors are paused by your plan") with a route to the plans, and nothing
ever rewrites `enabled`.

At capacity, the New Monitor dialog offers "Start monitoring now" switched **off** and says why,
and a capacity refusal offers "Save without monitoring" (UI-022) — the plan always allows a
switched-off Monitor.

How the UI tells a Monitor's story (UI-025, UI-026): the Dashboard gives every row a **Since**
(how long the state has held, ticking, with the exact time as reachable text and "from history"
for a reconstructed state), lists active signals before setups waiting for a trigger, then by
action, then newest first, and calls its summary card "Current matches" — the product is end of
day, never "real-time". The Monitor page lists matched stocks first, filters by status, explains
"Not evaluable" in words, and says why an ended signal ended from its `resolutionReason` ("stock
left the list", "membership period ended", "strategy logic changed", …).

## Signals

`Signal` is the product term for a Monitor result. It is deliberately not the Monitor: a Monitor is
the standing configuration (Strategy + List + enabled), and a Signal is one durable outcome it
produced, with the observation date and price it was decided on. The word is shared with the
Strategy language — a *Strategy signal* is the rule inside a level (Conditions plus an optional
Trigger) that a Monitor evaluates — and the two are never the same object.

A Signal means that a symbol matched one of the Strategy's canonical signals/levels under the current Monitor evaluation context.

Do not introduce separate user-facing concepts solely to distinguish condition-only matches from trigger-based matches. The UI may explain why a Signal exists, but both remain Signals.

### The signal lifecycle

`docs/decisions/builtin-dashboard-signals-v1.md` section 2 is the accepted state machine. Every
evaluated Strategy signal — one level of one Strategy for one List member under one Monitor — is in
exactly one durable state:

```text
INACTIVE          nothing is current
PENDING_TRIGGER   a triggered signal's Conditions hold; its Trigger has not fired for this setup
ACTIVE            a Signal occurrence is current
RESOLVED          the most recent occurrence ended
```

`NOT_EVALUABLE` is an evaluation result, not a state. A not-evaluable observation moves nothing and
never synthesizes an observation date.

**Conditions only** — a persistent state:

```text
INACTIVE/RESOLVED -- Conditions true  --> ACTIVE       (a new Signal occurrence)
ACTIVE            -- Conditions true  --> ACTIVE       (the same occurrence; nothing is written)
ACTIVE            -- Conditions false --> RESOLVED
```

**Conditions + Trigger** — the Trigger controls *entry* and is then latched; the Conditions alone
maintain the occurrence:

```text
Conditions true, Trigger not fired        --> PENDING_TRIGGER (no Signal yet)
PENDING_TRIGGER + Trigger fires           --> ACTIVE          (a new Signal occurrence)
ACTIVE + Conditions still true            --> ACTIVE          (whatever the Trigger predicate does)
ACTIVE + any Condition false              --> RESOLVED
PENDING_TRIGGER + any Condition false     --> INACTIVE        (no occurrence ever existed)
```

Conditions and Trigger holding on the same observation enter `ACTIVE` directly, exactly as a
backtest ANDs them on one date. While `ACTIVE`, the Trigger predicate turning false — or crossing
again — changes nothing. After a resolution a fresh setup needs a **fresh** Trigger event: the
crossing the previous occurrence consumed (same observation date) does not count twice.

**Trigger only** — an event on an exchange session:

```text
INACTIVE/RESOLVED -- Trigger fires                      --> ACTIVE
ACTIVE            -- a later real exchange session observed --> RESOLVED
```

The occurrence stays `ACTIVE` for the session it fired in. It does not end at midnight, on another
scan of the same session, or on a weekend or holiday: a Friday event is active through the weekend
and resolved by Monday's observation.

#### A daily trigger is evaluated between two finalized sessions

A daily trigger is evaluated **from the previous finalized session to the session being evaluated**,
both end-of-day bars that can no longer change. It is not an intraday trigger. Each session is
evaluated once per member, in order, so a crossing fires at most once per session, and the latch
above — not the predicate — is what keeps a triggered occurrence alive.

**Only a real session advances anything.** A weekend, a holiday or a day a stock did not trade has
no bar, so nothing is observed and nothing changes. A session whose bar is not yet proven final is
waited for, never guessed.

The implementation must preserve enough durable prior state to distinguish a genuine transition from
a process restart or cache miss; `ai/architecture/monitor-engine.md` describes it.

### FINAL EXIT with several Exit Rules

FINAL EXIT remains **one** level and **one** Signal occurrence however many Exit Rules it holds. Each
rule keeps its own internal lifecycle — one rule may wait for its Trigger while another is active on
its Conditions — and the level is `ACTIVE` while any rule is, `PENDING_TRIGGER` while none is active
and any is waiting. Several rules matching on one observation produce one occurrence; one rule taking
over as another ends is the same occurrence. When the last active rule ends while another rule's
setup is still waiting, the occurrence ends and the level waits on that setup: history records
`ACTIVE -> RESOLVED` and then `RESOLVED -> PENDING_TRIGGER`, so the level's recorded history always
ends in its stored state.

### What identifies a Signal

A `Signal` row is one **occurrence**: created when its level enters `ACTIVE`, resolved (with a
reason and, when an observation ended it, the session) when it leaves, and **never reopened** — a
later activation is a new row. An occurrence ends on its own logic, on the member leaving the List,
on the level leaving (or being excluded from) the Strategy, on the level's logic changing, or on a
rebind. Restarts, retries, duplicate scans and re-observations never create an occurrence or a
transition, because every decision is re-derived from the durable state and reaches the same
conclusion. `ai/architecture/deep-discovery.md` investigation 4 records the full table.

### Transition history

Every lifecycle state change — and only a change, never a repeated scan — is recorded with its
reason, the session it was observed on (or none, for a rebind, removal or edit) and the occurrence it
concerns. A `INACTIVE -> PENDING_TRIGGER` change is recorded before any Signal exists, so history is
keyed to the Monitor, the security and the level.

Each change also records its **origin**:

- **Observed** — a session decided while the Monitor was being watched. Sessions missed during an
  infrastructure outage are caught up in order and are still observed: the user was owed them.
- **History** — a session the Monitor was not watching when it became final: a reconstruction, or
  the sessions a disabled or plan-paused Monitor catches up when it resumes. These are never
  presented as new activity.
- **Administrative** — a configuration change that observed no session: an edit, a removal, a
  rebind.

Every Signal records how its price was observed. Occurrences decided by the earlier live-quote
Monitor keep their intraday price and are labelled as such; every later one is its session's
finalized close.

### Historical reconstruction

A level with no current state — a new Monitor, a new member, a rebind, an edited level — does not
start as if nothing had happened before. The first cycle replays closed sessions through the same
evaluator and the same lifecycle up to the newest finalized session, and persists only the result:
at most one occurrence (marked `reconstructed`, dated to its real activation session) and one
`RECONSTRUCTED` transition. It never writes the replayed history. The result is always the one a
replay of the security's **whole** history would reach — a setup whose Conditions have held for
years, with its Trigger long consumed, is `ACTIVE` since that Trigger, not a setup waiting since the
start of some window. A level whose history cannot be read waits for a later cycle.

## Monitored universe and BUY eligibility

A Monitor's universe is a Stock List. Membership is the canonical `Security` catalog reference, never
a free-text symbol.

**BUY eligibility from that list applies to Monitor BUY levels.** `ai/product/lists.md` defines a
`CUSTOM` buy window as the dates a member is eligible on, and a Monitor evaluates one date — the
current observation. For a BUY level, an ineligible observation may neither start a
`PENDING_TRIGGER` setup nor create an occurrence; an `ACTIVE` BUY occurrence whose window no longer
admits the observation is resolved with reason `BUY_WINDOW_CLOSED`, and a pending setup returns to
`INACTIVE`. `FULL` admits every date and so never restricts anything.

SELL and FINAL EXIT are **not** restricted by buy windows. A buy window governs entries; an exit rule
must still be able to report what it sees. This mirrors the backtest engine, which reads the same
`isBuyWindowEligible` before firing a BUY and nothing before firing a SELL or FINAL EXIT.

## SELL and FINAL EXIT without portfolio state

A Monitor is **not** a portfolio tracker. It holds no position, no entry price, no average cost, no
cost basis and no lifecycle.

A SELL or FINAL EXIT Signal is still meaningful: it reports that the Strategy's exit logic matches
current data for that symbol. Those levels are therefore evaluated and may produce Signals.

FINAL EXIT may hold several **Exit Rules** (`strategies.md` § FINAL EXIT). It remains **one** level
here: one level id, one durable state row, one Signal lifecycle, with the rule-local lifecycles
described above behind it.

A level is excluded from Monitor evaluation when **any** of its Exit Rules depends on `Gain` or
`Loss`, for the same whole-level reason given below.

### `Gain` and `Loss` are outside Monitor evaluation

`Gain` and `Loss` measure a position against its cost basis. A Monitor has neither, so they are **not
Monitor-supported metrics**. This is deliberately *not* the same statement as "they are Monitor
metrics that happen to return `NOT_EVALUABLE`":

| | Meaning |
| --- | --- |
| `NOT_EVALUABLE` | a **Monitor-supported** metric whose market or derived input was unavailable — warm-up, missing history, no finalized bar |
| Excluded | `Gain` and `Loss`, which a Monitor does not evaluate at all |

A Strategy using them is **never rejected**, and neither is a Monitor over it. Creating, editing and
rebinding all succeed, and no validation error is raised. What is narrower is only what the Monitor
*evaluates*:

- **A level whose logic depends on `Gain` or `Loss` is skipped whole.** It produces no Signal and
  writes no transition state, because no evaluation of it was attempted.
- **Never partially evaluated.** `Price < EMA200 AND Gain > 20%` does not become `Price < EMA200`.
  That is a different rule than the user wrote, and monitoring it would emit Signals the Strategy
  never asked for. The same holds when `Gain` or `Loss` appears in the level's Trigger.
- **Every other level continues normally**, and decides the security's status on its own.

Worked example:

```text
BUY  Price < EMA200      -> evaluated; matches or does not
SELL Gain > 20%          -> skipped; never produces a Monitor Signal
```

The skipped level contributes nothing at all, so it cannot turn an otherwise-decided security into
`NOT_EVALUABLE`.

Where they can appear is already settled by `ai/product/strategies.md`: `Gain` and `Loss` are refused
in a BUY level because they depend on an open position, and a Strategy must have at least one BUY
level. **Every Strategy the product accepts therefore has at least one Monitor-evaluable level** — a
Strategy that a Monitor could make no decision about at all cannot be constructed.

Backtests are unaffected. They hold real simulated position state and continue to evaluate `Gain` and
`Loss` through it, exactly as before.

## Lifecycle in one place

- **Create.** A customer's Monitor references a Strategy and a Stock List that both belong to the
  caller, verified in the transaction that inserts it. It starts `enabled` unless created otherwise.
  Its first cycle reconstructs each level's state from history at the newest finalized session.
- **Evaluate.** Every enabled Monitor is evaluated in every scan cycle. The cycle is a singleton
  claim across all worker processes, so two cycles never run at once by design; if a lease is lost
  and one overlaps anyway, the durable transition state's optimistic version guard means at most
  one of them can emit a given Signal.
- **Disable.** Stops future evaluations from the next cycle on (a cycle already running finishes
  with the enabled set it loaded). Persisted transition state and active Signals are left exactly
  as they were: a disabled Monitor still shows the Signals that were active when it was disabled.
- **Re-enable.** Resumes from that persisted state, catching up the sessions missed while disabled
  in order and recording their changes as history. An occurrence that was already active is not
  re-emitted; a latched trigger stays latched.
- **Edit the Strategy.** Takes effect from the next cycle. Only levels whose canonical logic
  changed have their occurrence closed (`LOGIC_CHANGED`) and their state reset and reconstructed;
  unchanged levels continue.
- **Edit the List.** Takes effect from the next cycle. A removed member's occurrences are resolved
  (`MEMBER_REMOVED`) and its setups dropped by that cycle, and its state is forgotten; an added — or
  re-added — member is reconstructed from history and may be active immediately.
- **Rebind the Strategy or List.** Pointing the Monitor at a *different* Strategy or Stock List is
  not the same operation as editing the contents of the ones it references. It crosses a
  configuration boundary: the transition state is discarded, every Signal still active is resolved,
  `lastScanAt` is cleared, and the new configuration is evaluated from the next cycle. Signal
  history is kept. See "Rebinding a Monitor" below.
- **Delete the Monitor.** Removes its state, its Signals and its transition history with it. The
  Strategy and List it referenced are untouched. A built-in Monitor is never deleted.
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

- **resolves every Signal still active** (`MONITOR_REBOUND`) and drops every pending setup. Each
  ending is recorded in the transition history under the logic it belonged to.
- **keeps every Signal and transition row.** A Signal is a record of what was observed, and
  observations are not invalidated by a later configuration change. Nothing is deleted.
- **discards the lifecycle state.** No latch from the replaced configuration can decide anything in
  the new one, and no fingerprint coincidence between two Strategies can silently carry one across.
- **clears `lastScanAt`.** The configuration the Monitor now names has not been checked.
- **reconstructs the new configuration on the next cycle.** Each level's state is re-established
  from history, as for a new Monitor.

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

An observation is a stored, finalized end-of-day bar, so it exists only for a day the stock actually
traded.

- **Weekends and fully closed holidays** have no bar and are never observed.
- **Early closes are ordinary sessions.** The venue opened and closed sooner; the day's bar is a
  normal one.
- **A halted or delisted stock** prints nothing for the days it did not trade; those days are never
  observed. Once the newest expected session has been given up on, a member already through every
  session the stock printed is marked as evaluated through it, without an observation.

This is a correctness rule, not tidiness. A bar on a day nothing traded lengthens every rolling
window by one observation — which can move an average past a price that never moved and read as a
crossing — and it names a session later than the previous real one, which would end a Trigger
Signal that fired there. Because the Monitor only reads bars the market produced, neither can happen.

The venue's published holiday schedule decides which session is *expected* — what the stock EOD
preparation asks for and what "current" means. It is resolved per exchange, held in process memory,
and never cached in Redis. If it cannot be read, weekdays stand in and the fact is logged; that can
only change when an unprinted session is given up on, never what is observed.

## End-of-day semantics

A Monitor evaluates **finalized end-of-day sessions** (`docs/decisions/eod-finality-v1.md`,
`docs/decisions/monitor-eod-v2.md`). A session is final at its 16:00 New York close plus the
publication delay, and a stock's bar is evaluated only once it has been read after that point. There
is no intraday or live-quote evaluation: a Monitor's daily indicators (EMA, SMA, RSI, …) are the
materialized end-of-day values and never move during a trading day.

Each member is evaluated **from its own checkpoint**: every session after the last one it was
decided through, in order, once. If the service was down for two days, the next evaluation steps
both missed sessions in order before the newest; it never jumps to "today". A member whose newest
bar is not proven final yet waits at its checkpoint; the other members carry on.

Backtests continue to use closed historical observations according to the canonical backtest methodology. Do not silently change backtest semantics to make them match Monitor execution.

Missing/warm-up/PIT-unavailable inputs remain `NOT_EVALUABLE`; monitoring must not replace them with zero, future data, or fabricated values.

**A rule that reads an ETF waits for the ETF's own session.** A Condition that names an ETF as its
data source (`ai/product/strategies.md`, § ETF-sourced Conditions) is decided only against that
ETF's **completed** session of the same date — its end-of-day bar finalized *and* read after it
finalized. A member whose rules read an ETF that does not hold the session yet waits for it, so the
session is decided on the stock's and the ETF's bars together. The wait is bounded: a day after the
session became final, it is decided without that ETF, whose rules are then `NOT_EVALUABLE` — an
ACTIVE level stays latched — and yesterday's reading is never carried onto today. The Monitor's
detail gives each ETF's state — ready with its latest completed session, awaiting the session's bar,
not synchronized, or never bootstrapped — so an ordinary wait is not mistaken for missing data. ETF
bars are read from the stored benchmark history, never from the provider, and a fund that cannot be
read degrades only the rules naming it, never the scan.

**Stock's Sector is resolved once per scan.** A rule reading Stock's Sector reads, per watched stock,
the sector ETF its **current** FMP sector maps to, under exactly the completed-session rule above.
Each scan resolves every stock's sector once, so all of its levels and its reconstruction agree on
one fund. A stock reclassified between two scans is read from its new fund by the next scan: an
ordinary change of data, decided by the normal lifecycle (an ACTIVE level whose rule no longer holds
ends with `CONDITIONS_ENDED`) — not a logic change, because the rule did not change. A stock with no
sector, or one that is not one of the eleven, has no fund: its Stock's Sector rules are
`NOT_EVALUABLE`, which, as always, holds an ACTIVE level latched rather than ending it. The detail says
which fund each stock reads now and names every stock that has none.

### How Monitor evaluation differs from a backtest

Both run the same evaluator over the same frame projection of the same stored, finalized bars and
**materialized** derived columns — daily and weekly series, per-day intrinsic values, Fundamental
Metrics — so operators, the 2% closeness tolerance, `NOT_EVALUABLE`, the choice of `t - 1` (the
previous row of the trading-day axis) and every value a rule reads are identical on a given session.
The differences are framing, not data:

- **Position-dependent metrics** (`Gain`, `Loss`) are **excluded** from Monitor evaluation and live
  for a backtest: a Monitor skips the whole level that uses one, where a backtest decides it against
  simulated position state.
- **A backtest never reads an unfinished session**: a period requested through today ends at the
  newest finalized session (`ai/product/backtests.md`, `docs/decisions/eod-finality-v1.md`).
- **Signals made by the earlier live-quote Monitor** were decided on an intraday price and keep it;
  they are labelled as live-quote observations and are never compared with a backtest's close.

## Intrinsic value and price-dependent metrics

A Monitor reads each session's materialized intrinsic values and price-dependent results (for example Margin of Safety) exactly as a backtest does; it never recomputes an intrinsic-value model of its own.

The canonical formulas and PIT rules remain owned by the existing calculated-series / intrinsic-value architecture.

## V1 simplicity constraints

V1 intentionally avoids user-configurable scan frequency and avoids extra user-facing state-machine terminology.

Do not add new Redis-backed product semantics merely for monitoring. Redis may still be used by existing infrastructure where already justified (for example queueing/coordination), but Monitor product correctness must not depend on an ephemeral cache.

### Accepted V1 limitations

These are known and accepted for V1. They are limitations, not defects, and none of them can produce
a wrong Signal.

- **Evaluation reads PostgreSQL, not the Redis projection.** The Monitor frame is read from stored
  bars and materialized derived rows, so a monitored universe larger than the resident-stock bound
  costs no re-hydration. Do not add a Monitor-specific cache.
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
- **A failure is per stock.** A stock whose evaluation fails is logged and counted, and the cycle
  completes the others. Each member's sessions, Signals, transitions and checkpoint are written in
  one transaction, so nothing is half-applied, and the next cycle resumes from the checkpoints.

## Source-of-truth boundaries

- Strategy defines investment/evaluation logic.
- The Monitor decides what current universe/source is evaluated and whether monitoring is enabled.
- The Monitor produces Signals.
- PostgreSQL/durable storage owns persisted Monitor/Signal state required for correctness.
- Backtest configuration remains separate from Monitor configuration.
- Redis/in-memory caches are implementation accelerators, never the semantic source of truth.

## Built-in Monitors and the Dashboard

`docs/decisions/builtin-dashboard-signals-v1.md` is the product decision. The platform ships
built-in (`SYSTEM`) Lists, Strategies and Monitors — ordinary domain objects evaluated by the same
cycle — so a first-time visitor's Dashboard already shows real matches.

- **A built-in Monitor is shared.** It has no owner and is evaluated once for everybody. It has two
  operator switches and no `enabled` of its own: `isPublished` (customers can see it) and
  `isGloballyEnabled` (the cycle evaluates it). It consumes nobody's active-Monitor capacity and is
  never deleted.
- **Visibility is per user, evaluation is not.** A Guest sees every published built-in on the
  Dashboard. A signed-in user sees them too unless they hid one; only that override is stored, and it
  never changes whether the Monitor runs. The switch lives on the **Monitors page**, in the built-in
  section, beside the Monitor it is a property of — not on the Dashboard, which is the signal table
  and nothing else. `GET /monitors` carries it as `dashboardVisible` for built-ins. A Guest's toggle
  asks them to sign in and stores nothing.
- **A customer's own Monitor** keeps its real `enabled` lifecycle: disabled (or plan-blocked)
  Monitors contribute no Dashboard rows, whatever their frozen state says. A customer's Monitor
  watches only the customer's own Lists and Strategies; a built-in Monitor watches only built-ins.
  The New/Edit Monitor dialog says so beside its pickers (UI-009), and its create-first notice
  says "of your own", so an account holding only built-ins is never told it has nothing.
- **Administrators** (`role = ADMIN`) change built-ins through the ordinary routes and editors;
  everybody else reads them. Changing a display name never changes the `systemKey`.

The Dashboard is a table of `ACTIVE` occurrences and `PENDING_TRIGGER` setups — never `INACTIVE` or
`RESOLVED` — with one row per Monitor outcome (the same security under two Monitors is two rows),
newest state first, and each Monitor's freshness from its real scan time. Its columns are Stock,
Action, Why, Price, Strategy, List, Monitor: the three entities are three separate links, because
they are three separate objects with three separate pages. Two filters compose — a segmented state
control (All / Active / Waiting) and an action dropdown — deliberately built as two *different*
control shapes so they do not read as two competing tab bars. `Waiting` is only the compact filter
label; a row's own badge and reason text keep the precise `Waiting for trigger`.

## Open product decisions

Recorded so they are decided deliberately rather than by whichever code path is touched next. Each
is traced in `ai/architecture/deep-discovery.md`.

1. **A member that stops trading.** A delisted or indefinitely halted security prints no new
   session, so nothing is observed, the lifecycle never moves and its active occurrences stay
   active indefinitely, evaluated through the last session it printed. Nothing resolves them
   today; the catalog sync marks the security inactive but the List still holds it. Options:
   resolve on deactivation like a removed member, or surface "no data since" and leave the Signal.
   Not decided.
2. **Scanning outside trading sessions.** Decided by the end-of-day evaluation
   (`docs/decisions/monitor-eod-v2.md` §3): a cycle reads PostgreSQL readiness only and spends no
   provider request, so a cycle with no new session costs one readiness read per watched stock and
   changes nothing.
3. **Monitored-universe size.** No total cap on a List exists (investigation 10 quantifies the
   cost beyond the resident-stock bound). A cap is a product rule, not an engine limit.
4. **Signal history beyond the newest 100.** The contract has no paging; the web slice needs it.
5. **A backtest ending today** is decided: it ends at the newest finalized session
   (`docs/decisions/eod-finality-v1.md`).

## Out of scope / do not invent

Unless another canonical product document explicitly decides otherwise, do not add during V1:

- user-configurable monitoring cadence;
- separate user-facing names for persistent condition matches versus trigger events (the Dashboard's
  "Waiting for trigger" names a *setup*, which is not a Signal);
- a second Monitor-specific Strategy DSL;
- a requirement to recompute every available series for every symbol;
- correctness that depends on Redis surviving a restart;
- a pinned Strategy version or Strategy snapshot for a Monitor;
- portfolio/position tracking, average cost or a position lifecycle;
- an exchange trading calendar;
- partial-cycle semantics for a failed current-data read.

If implementation exposes an unresolved product question outside this document, stop and surface the question rather than silently defining new product behavior.
