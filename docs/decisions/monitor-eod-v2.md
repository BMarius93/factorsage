# Monitor EOD V2 — implementation record

## Status

**Accepted, implemented incrementally** by the Monitor EOD V2 pull-request stack. This document
records what each step actually built; `docs/decisions/monitor-eod-v2-proposal.md` is the proposal
and audit request it answers, and `docs/decisions/eod-finality-v1.md` is the finality rule every
step relies on. Sections are added as the steps land; a section describes merged-or-proposed code,
never intent.

| Step | Pull request | What it adds |
| --- | --- | --- |
| 1 | `feat/eod-finality` | Finalized EOD bars everywhere (`eod-finality-v1.md`) |
| 2 | `feat/stock-eod-worker` | The `stock-eod` child and the ongoing-membership predicate (§1, §2) |
| 3 | `feat/monitor-eod-evaluator` | The per-session EOD evaluation, checkpoints and origins (§3) |

## 1. The Monitor universe: ongoing membership only

`isOngoingListMember(configuration, date)` and `ongoingMembershipStart(configuration)` in
`@intrinsic/domain` (`stock-lists.ts`) answer the V2 universe question, which is deliberately not
the backtest's:

| Membership | Ongoing on `date`? |
| --- | --- |
| `FULL` ("Always eligible") | yes, every date |
| `CUSTOM` with an open-ended period (`endDate: null`, "Present") that began on or before `date` | yes |
| `CUSTOM` with an open-ended period starting after `date` | not yet |
| `CUSTOM` with bounded periods only — even an end in the future | never |
| a multi-period member inside an earlier, closed period | no: only the open-ended period counts |

`Present` is an open-ended meaning, not a comparison with today: a bounded period ending in 2030 is
not a current membership. Earlier closed periods stay in storage and play no part. Backtests keep
`isBuyWindowEligible` — every period a member ever had, BUY only — unchanged; nothing in a backtest
calls the new predicate.

Step 2 uses it to decide which securities are prepared. Applying it to evaluation (BUY, SELL and
FINAL EXIT alike) and to the administrative closure of a membership edited away is step 4.

## 2. Stock EOD preparation: the `stock-eod` child

Provider work moves out of Monitor evaluation into a fourth supervised child of the one
`dev:worker` service (`apps/worker/src/stock-eod/`). It is a new **process kind**, not a new
service, container or server: one more entry in the supervisor's child list, its own
`STOCK_EOD_WORKER_PROCESSES` (default 1, at most 2; `0` disables it).

**Claim.** The fourth instance of the PostgreSQL claim idiom: row `STOCK_EOD` of
`MarketDataRefreshSchedule`, beside the ETF refresh's `ETF_MARKET_DATA`, claimed with
`FOR UPDATE SKIP LOCKED`, a renewable lease, `claimedBy`-guarded writes and doubling backoff. The
schedule repository is scoped to one row id, so the two claims never contend; the claim loop is the
market-data loop, generic over its run and logging under `stock-eod.refresh.*`. No migration.

**Run.** Per pass:

1. Resolve the newest finalized NYSE session once (`EodFinalityPolicy.expectedSession`), so every
   security of the run is held to the same session; a schedule that cannot be read falls back to
   weekdays and says so (`stock-eod.calendar-unavailable`).
2. Read the running Monitors (`listActiveMonitors`: enabled, execution-eligible customer Monitors and
   globally enabled built-ins) and build the deduplicated union of their **ongoing** members on that
   session, each carrying the union of operands any watching Monitor reads (`stockEodUniverse`).
3. Per security, at `STOCK_EOD_SECURITY_CONCURRENCY` (2), PostgreSQL first: `stockRefreshState` and
   the finality decision. A security holding the session as read after it became final, with its
   history loaded from the product horizon, costs one PostgreSQL read and only the freshness checks of
   the operand inputs it needs (`prepareStockOperands`). Otherwise it enters `refreshStockTail`: coverage
   gaps, one bounded tail read, and statements only when some watching Monitor reads a
   statement-derived operand (`operandsReadStatements`).

History is loaded from the product horizon (clamped to the listing) on a security's first
preparation, once, so the Monitor evaluation's reconstructions and replays read PostgreSQL alone and
never need the provider.

**Outcomes.** `READY`, `AWAITING_PUBLICATION`, `NOT_PUBLISHED` (past the give-up bound), `FROZEN`,
`FAILED`, `DEFERRED` (budget or lease) and `BACKING_OFF`. A security failing while others succeed is
backed off in memory, doubling from the retry spacing to six hours; the run fails — and the claim
backs off — only when every attempt failed. A run that exhausts `STOCK_EOD_RUN_BUDGET_MS` asks to be
resumed after `STOCK_EOD_FOLLOW_UP_MS` rather than a full `STOCK_EOD_REFRESH_INTERVAL_MS`. Every run
logs `stock-eod.run.summary` with the session, universe size, provider requests and outcome counts.

**Cost.** A security already final costs no provider request and no Redis work — readiness is
PostgreSQL's answer, and an evicted stock is not re-materialized for it. A security that needs the
session costs one tail read plus, when the read adds a row, one earliest-rows confirmation
(`historical-price-basis-v1.md` §7), plus six statement requests when a statement-derived operand is
read and the statements are older than `STOCK_FUNDAMENTALS_FRESHNESS_MS`. The first preparation of a
never-seen security is its full hydration.

`pnpm stock-eod:refresh-once` runs one pass through the same claim and prints each security's
outcome. The QA matrix pool disables the child (its provider traffic is not a run's); the hermetic
E2E stack runs it over its frozen fixtures.

## 3. The Monitor evaluation: finalized sessions, in order, from a checkpoint

The Monitor child no longer reads a quote. `MonitorEodEvaluation`
(`apps/worker/src/monitor/monitor-evaluation.ts`) replaces the V1 cycle in production — the claim,
lease, heartbeat and scheduling (`MonitorWorkerLoop`, `MonitorScanSchedule`) are unchanged — and
evaluates **finalized end-of-day sessions**, each at most once per member, in order. It reaches no
provider: the stock EOD child (§2) made the sessions durable, the frame is read from PostgreSQL, and
ETF histories come through the provider-free benchmark reader.

### 3.1 A pass

1. **The expected session**, once: the newest finalized NYSE session (`EodFinalityPolicy`), the
   same answer the stock EOD child holds every security to. An unreadable venue schedule falls back
   to weekdays and logs `monitor.evaluation.calendar-unavailable`; this can only affect when a
   session that never prints is passed (below), never what is observed, because an observation is a
   stored bar.
2. **The running Monitors** (`listActiveMonitors`, unchanged), their states and checkpoints, and the
   watching stamp (§3.4).
3. **Per security, once** however many Monitors watch it, at `MONITOR_SYMBOL_CONCURRENCY`:
   - **Readiness from PostgreSQL** (`stockRefreshState`). The security's *horizon* is the oldest of
     its newest bar proven final (`latestVerifiedBar`), its newest materialized derived row
     (`derivedThrough`) and the expected session. A security with neither waits
     (`membersAwaitingData`); nothing is decided on a bar not yet proven final.
   - **One frame** (`readFinalizedEvaluationFrame`): stored prices and **materialized** derived rows
     from PostgreSQL through the backtest projection — the same columns and per-day intrinsic values
     a backtest reads — bracketed by the price-basis generation (a re-base committed meanwhile is a
     `warn`, `monitor.evaluation.history-rebased`, and the next pass reads the replaced history). It
     starts at the oldest member checkpoint, or deep enough to reconstruct (§3.3), and ends at the
     horizon. ETF columns are joined by exact date (`withEtfOperandColumns`).
   - **Per (Monitor, member)**: every session after its checkpoint through its own horizon, applied
     in order by `decideLevelSessions` (`session-decision.ts`) through the canonical reducer
     `stepMonitorLevel`. A missed Tuesday is stepped before Wednesday; a week's catch-up records the
     changes that week made, each with its true session date.
   - **One transaction per member** (`applyMemberEvaluation`): the Signals it closes and opens, its
     transitions, its level states and its checkpoint, together.
4. **Reconciliation**: a member or level no longer visited is closed administratively, as in V1, and
   a removed member's checkpoint is deleted (`pruneCheckpoints`). Then `markScanned`.

Every pass logs `monitor.cycle.completed` — the existing event name, kept as the operational
contract, with a new summary — carrying the expected session and the counts:
members current, awaiting data, awaiting an ETF, sessions evaluated, Signals opened and closed,
transitions, reconstructions, contended and stale-configuration writes, failed securities.

A failure is **per security**: it is logged (`monitor.symbol.failed`), counted, and the
pass completes the others. Nothing the failing security wrote is half-applied, because each member is
one transaction, and the next pass resumes from the members' checkpoints. V1's all-or-nothing
current-data rule existed because a quote read happened before anything was persisted; there is no
such read any more.

### 3.2 The checkpoint

`MonitorEvaluationCheckpoint(monitorId, securityId)` holds `evaluatedThrough` — the newest session
every level of that member was decided through — with the `configVersion` and the price-basis
generation it was decided on.

- **Advanced only with what it produced.** The member's transaction takes the binding fence
  (`assertBindingCurrent`, unchanged), then locks the checkpoint row and compares it with the value
  the pass read. A different value means another evaluation got there first: the transaction is
  rolled back and counted as `contended`. With the per-state `stateVersion` guard, a retry, a restart
  or two overlapping leases never apply a session twice, and a crash never leaves state ahead of
  progress or progress ahead of state.
- **A configuration change discards it.** The configuration boundary
  (`apps/api/src/monitors/monitor-configuration-boundary.ts`) deletes the Monitor's checkpoints with
  its states; a checkpoint whose `configVersion` is not the Monitor's is ignored.
- **A session that never prints is passed, not observed.** When storage has stopped asking for the
  expected session (`SESSION_NOT_PUBLISHED`, past `EOD_SESSION_GIVE_UP_MS`: a halt, a delisting) and
  a member is already through every session the security printed, its checkpoint moves to the
  expected session with no step. Nothing is evaluated, so a trigger-only event is not ended by it —
  only a real later session ends one.

**No backfill.** A member with state but no checkpoint — every member at deployment — is decided on
the newest finalized session only, from the state V1 left, and has a checkpoint from then on. The
sessions before deployment were observed by V1 and are not re-decided.

### 3.3 New state: reconstruction at the newest session

A level with no state, or with state under different logic, is reconstructed exactly as in V1
(`ai/architecture/monitor-engine.md` § Reconstruction) — the result a full canonical replay reaches,
from the latest resting session, deepening the read only while a level needs older history — but at
the **newest finalized session** rather than at a live quote. One change is recorded:
`RECONSTRUCTED` with origin `HISTORY`, or the reason the newest session itself made with that
session's origin. A logic change's reset is `ADMINISTRATIVE`. An undecidable newest session writes
nothing and waits.

Step 5 replaces this for **new Monitors** with a bounded 90-session replay that records every
transition of the window; the newest-session reconstruction remains for new members, edited levels
and legacy state.

### 3.4 Origins and the watching stamp

Every transition now carries an **origin** (`MonitorTransitionOrigin`):

| Origin | Meaning | Examples |
| --- | --- | --- |
| `OBSERVED` | a session decided while the Monitor was being watched | the evening's evaluation; an outage's missed sessions caught up |
| `HISTORY` | a session the Monitor was not watching when it became final | a reconstruction; the gap a paused Monitor resumes over |
| `ADMINISTRATIVE` | a configuration change that observed no session | logic changed, level or member removed, rebind |

`Monitor.watchingSince` decides between the first two. It is null while a Monitor is not running and
stamped by the first pass that finds it running (`markWatching`, one statement per pass that also
nulls the Monitors no longer running). The API nulls it when the owner disables the Monitor or an
administrator disables a built-in. A session whose finalization (`eodSessionFinalizedAt`) is at or
after the stamp is `OBSERVED`; an older one is `HISTORY`. An **outage** leaves the stamp untouched,
so missed sessions are caught up as `OBSERVED`; a **pause** — disabled, plan-blocked, globally
disabled — clears it, so resuming catches up the paused sessions as `HISTORY`. That is the rule that
keeps a resumed Monitor from presenting days it was not watching as new activity, while an outage's
catch-up is the activity the user was owed.

Every new Signal records `observationBasis = EOD_CLOSE`; its price is its session's finalized close.

### 3.5 ETF dependencies: a bounded wait

A session is stepped only when every ETF the member's rules read — named or Stock's Sector — holds
that very session. A member whose ETF is behind waits at the ETF's newest session
(`membersAwaitingEtf`, `monitor.etf-dependency.waiting` at debug), because stepping later sessions
first would make the waiting session unreachable in order. The wait is bounded by the same give-up
as a stock's session (`EOD_SESSION_GIVE_UP_MS`, 24 hours): a session finalized longer ago than that
is decided with the ETF's columns absent, so its rules are `NOT_EVALUABLE` — which moves nothing, an
ACTIVE level stays latched — never a carried value.

### 3.6 Migration `20261014200000_monitor_eod_evaluation`

Additive only: two enums, `Monitor.watchingSince` (nullable, not backfilled),
`MonitorSignal.observationBasis` (existing rows `LIVE_QUOTE`, then default `EOD_CLOSE`),
`MonitorStateTransition.origin` (backfilled from the reason: `RECONSTRUCTED` is `HISTORY`, the four
configuration reasons `ADMINISTRATIVE`, every other change `OBSERVED`), and the checkpoint table. No
existing Signal, price or decision is rewritten. The previous release ignores the new columns, so a
rollback needs no down-migration.

### 3.7 What stays, and limitations

- **Eligibility is still V1's** in this step: the BUY window gates BUY, SELL and FINAL EXIT are
  decided for every member. Step 4 applies ongoing membership (§1) to all three.
- **The V1 cycle** (`monitor-cycle.ts`), the quote read and the Monitor frame projection remain for
  the capacity bench and their tests until step 8 removes them. The V1 write path now labels what it
  writes `LIVE_QUOTE` with the backfill's origin mapping, so its rows can never pass for EOD ones.
- **`MONITOR_SCAN_INTERVAL_MS` defaults to ten minutes**, the stock EOD child's cadence. A pass with
  nothing new costs one readiness read per watched security.
- **A halted security's members stay at its last bar on weekdays.** Only the *expected* session is
  ever passed, and only once it has given up, which in a normal week happens on the weekend, when no
  newer session supersedes it. Until then a halted security's members report the last session it
  printed — the truth — and are never moved past a session it might still print. When it prints
  again, its new bars are stepped in order; the halted days have no bar and are never observed.

