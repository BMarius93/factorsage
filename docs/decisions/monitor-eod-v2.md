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
| 4 | `feat/monitor-eligibility` | Ongoing membership gating every level; administrative membership endings (§4) |
| 5 | `feat/monitor-replay-evidence` | The 90-day initial replay; evidence and version on every transition (§5) |

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

Step 2 uses it to decide which securities are prepared; step 4 applies it to evaluation (§4).

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

Step 5 replaces this for **new Monitors** with the 90-day replay of §5; the newest-session
reconstruction remains for later members, edited levels, rebinds and legacy state.

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

- **Eligibility** was still V1's in this step (BUY window, BUY only); step 4 replaced it (§4).
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

## 4. Ongoing membership in the evaluation

Step 4 applies §1 to the evaluation. A member is **current** on the expected session when
`ongoingMembershipStart` is `null` ("Always eligible") or a start on or before that session.

**Gating.** A member that is not current is not evaluated at all — no frame read, no level, no
checkpoint — and is counted in the pass summary as `membersNotCurrent`. A current member is
evaluated on every level alike: `decideLevelSessions` receives `monitoredOn(date)` (the membership
had begun by `date`) in place of V1's BUY-only `eligibleOn`. A catch-up never steps a session before
the membership's start, and a reconstruction's history treats those sessions as ineligible — a
resting step for every level — so the state it reaches is the full replay **from the membership's
start**. Closed periods play no part.

**Membership ending: `MEMBERSHIP_CHANGED`.** A new value of `MonitorTransitionReason`: the security is
still in the List but is no longer a current member there. The reconciliation receives the listed
securities beside the evaluated ones; a state whose security is listed but not current is ended
with `MEMBERSHIP_CHANGED` (origin `ADMINISTRATIVE`, no session date), its occurrence resolved and its
row and checkpoint deleted — the same shape as `MEMBER_REMOVED`, which stays for a security that
left the List. It is never `CONDITIONS_ENDED`: an edit is not a market observation.
`BUY_WINDOW_CLOSED` is no longer recorded by the Monitor (catch-up sessions are always member
sessions) and stays on V1 rows as recorded; there is no data migration of reasons.

**A changed ongoing membership resets the member.** The checkpoint now records which membership its
progress belongs to (`membershipRecorded`, `membershipStart`). When the member's current ongoing
start differs — a re-entry after a gap, a start moved either way, `FULL` replaced by an open period —
the state was built from sessions that are not this membership's. The member is then decided as if
it had no state, and `applyMemberEvaluation` (`resetMembership`) ends every existing state of the
member with `MEMBERSHIP_CHANGED` and deletes it **in the same transaction** as the rebuilt states and
the new checkpoint, so a crash leaves either the old membership or the new one, never neither.
Checkpoints written before the columns existed (`membershipRecorded = false`) are adopted under the
member's current membership without a reset, as are members with V1 state and no checkpoint: the
cutover replays nothing.

**API.** The Monitor detail lists the current members only (on the newest finalized date), so a
stock outside the universe is not shown as unchecked or undecided. The List's own size is unchanged
in the summary; the coverage line of step 6 says how many members are current.

**Migration `20261015090000_monitor_ongoing_membership`.** Adds the enum value and the two checkpoint
columns (`membershipRecorded` default `false`, `membershipStart` nullable). Additive; the previous
release never writes the value and ignores the columns.

**Unchanged.** Backtests keep `isBuyWindowEligible`, BUY only, over every period a member ever had;
nothing in a backtest calls the Monitor predicate. The stock EOD child already prepared current
members only (§2). The V1 cycle kept for the capacity bench keeps its BUY-window rule until step 8
removes it. The data-correctness signals audit's independent oracle now restates the ongoing rule.

## 5. The initial replay and transition evidence

### 5.1 Which Monitors replay

A Monitor created through the API, or a built-in created by the bootstrap, has
`initialReplayRequested = true`. Existing Monitors default to `false` — the cutover backfills nothing
— and a rebind clears the request and the window (`reboundMonitorFields`), so a rebound Monitor is
reconstructed at its newest session as before. Editing a Strategy or a List, re-enabling, and an
unblocked plan follow their existing paths (§3, §4); none replays.

The **window** is fixed once, by the first pass that evaluates the Monitor (`fixReplayWindow`, a
fenced conditional update): the 90 calendar days ending at that pass's newest finalized session,
stored as `replayWindowStart` with `replayWindowFixedAt`. Fixing it at the first evaluation rather
than at creation means a Monitor created switched off, or blocked by its plan, replays the 90 days
before it first runs, not a longer stretch.

A **member replays** when it was listed by the time the window was fixed, has no checkpoint and no
state. Its first session is the window's, or its ongoing membership's start when that is later
(§4). A member listed afterwards is a new member and is reconstructed at its newest session. A
member whose data arrives late replays the same window when it does.

### 5.2 How a level replays

`decideLevelSessions` with `replay`:

1. **The exact state before the window.** A reconstruction at the session just before the first
   window session, from the closed history before it — the same `reconstructMonitorLevel`, resting
   point and deepening read as every reconstruction, anchored earlier. A setup whose Trigger fired
   before the window and whose Conditions still hold is therefore `ACTIVE` since that Trigger; a
   90-day cutoff never resets it to `PENDING_TRIGGER`. A security whose history begins inside the
   window starts from nothing, exactly.
2. When that state is `ACTIVE` or `PENDING_TRIGGER`, one `RECONSTRUCTED` change records it on its
   true activation session (origin `HISTORY`; an `ACTIVE` one opens a `reconstructed` occurrence at
   that session's close).
3. **Every window session in order**, through `stepMonitorLevel`, recording every change it makes on
   its own session — activations and market resolutions alike, never a repeated `ACTIVE -> ACTIVE`.
   Origins come from `watchingSince` as always: sessions before the Monitor was first watched are
   `HISTORY`, and an occurrence opened on one is marked `reconstructed`.

The member's levels, Signals, transitions and checkpoint are written in **one transaction**, so a
crash mid-window leaves nothing to double-insert: the next pass finds no checkpoint and replays the
member again, from the same fixed window. A level with no decidable session in the window or just
before it writes nothing and is reconstructed later, as any undecidable level is.

The frame is read once per security, from far enough before the earliest window to reconstruct the
state before it, through the horizon. The Dashboard feed (step 6) never shows `HISTORY`, so a
replayed window is visible only in the Monitor's own history.

### 5.3 Evidence and version on every transition

`MonitorStateTransition` gains `strategyVersionId` and `evidence`:

- **`strategyVersionId`** is the version whose logic decided the change, for every change a session
  decided. It is null for an administrative change — a logic-change reset belongs to logic that no
  longer exists — and for rows written earlier.
- **`evidence`** (`MonitorTransitionEvidence`, version 1) is what the decision read on the change's
  session: per rule — only the Exit Rule that drove a FINAL EXIT change — each market-derived
  predicate with its id, role, result and the operands it compared (`metric`, `value`, and a
  Trigger's previous-session pair). It is computed by `explainMarketSignal` in `@intrinsic/strategy`
  from the same `readOperand`, value resolution and comparison the evaluator uses, so it cannot
  disagree with the decision; an operand that did not resolve is `null`, never zero.

A resolved occurrence's Why is then the evidence on its ending transition, under the version on that
row — never recomputed from an edited Strategy. Administrative changes and older rows carry none;
their reason alone explains them. Rendering is step 6.

### 5.4 Migration `20261015120000_monitor_replay_evidence`

Additive: `Monitor.initialReplayRequested` (default `false`), `replayWindowStart`,
`replayWindowFixedAt`, `MonitorStateTransition.strategyVersionId` and `evidence` (both nullable). No
existing row changes.

### 5.5 Also changed

An occurrence opened on a `HISTORY` session by any catch-up — a paused Monitor resuming, not only a
replay — is now marked `reconstructed`: history, not an observation, established it.

