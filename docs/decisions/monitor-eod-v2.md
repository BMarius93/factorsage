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
| 6 | `feat/monitor-read-models` | The Activity feed, the Signal table, Why from evidence, coverage (§6) |
| 7 | `feat/monitor-web-ux` | Dashboard Monitor activity, the Monitor's one Signal table, coverage line, E2E (§7) |
| 8 | `feat/monitor-eod-cleanup` | The real-time paths removed, the V1 suites ported, the capacity bench re-measured (§8) |
| 9 | `fix/monitor-eod-v2-final-correctness` | Weekly indicators complete at the week's last scheduled session (§9); late EOD bars recovered within a bounded horizon (§10); the data-correctness Playwright coverage restored |

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

History is loaded from the product horizon (no longer clamped to the listing,
`listing-evidence-v1.md`) on a security's first
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
- **A session that never prints is passed, not observed.** Once a provider read issued at least
  the late-recovery horizon after its finalization still found no bar (§10; before step 9: once
  storage stopped asking for the expected session, `SESSION_NOT_PUBLISHED`), a member already through
  every session the security printed has its checkpoint moved through that session with no step.
  Nothing is evaluated, so a trigger-only event is not ended by it — only a real later session ends
  one.

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
first would make the waiting session unreachable in order. The wait is bounded by the late-recovery
horizon (`EOD_LATE_RECOVERY_MS`, four days, §10; 24 hours before step 9): a session finalized longer
ago than that is decided with the ETF's columns absent, so its rules are `NOT_EVALUABLE` — which moves
nothing, an ACTIVE level stays latched — never a carried value.

**An ETF that could not be read is not an ETF that is behind** (pre-release audit MON-02, fixed
2026-10-16). The bounded wait applies only to an answer the loader gave — a fund not bootstrapped,
not synchronized, or whose newest session is older than the stock's. A snapshot that could not be
read this pass — the history read threw, the code did not resolve, no ETF loader is configured — says
nothing about whether the fund printed, so every member reading that fund is **held where it is,
with no give-up bound**, and counted in `membersAwaitingEtf` (`monitor.etf-context.unreadable` at
warn). Deciding sessions without it recorded every rule that reads it as `NOT_EVALUABLE`
permanently: a Redis blip during a new Monitor's replay lost the window's activations for good. Once
a pass reads the fund again, the held sessions are decided in order, exactly as a Monitor that never
saw the failure decides them. A backtest whose ETF cannot be read stops with `EXECUTION_FAILED`
rather than completing on undecidable rules.

### 3.6 Migration `20261014200000_monitor_eod_evaluation`

Additive only: two enums, `Monitor.watchingSince` (nullable, not backfilled),
`MonitorSignal.observationBasis` (existing rows `LIVE_QUOTE`, then default `EOD_CLOSE`),
`MonitorStateTransition.origin` (backfilled from the reason: `RECONSTRUCTED` is `HISTORY`, the four
configuration reasons `ADMINISTRATIVE`, every other change `OBSERVED`), and the checkpoint table. No
existing Signal, price or decision is rewritten. The previous release ignores the new columns, so a
rollback needs no down-migration.

### 3.7 What stays, and limitations

- **Eligibility** was still V1's in this step (BUY window, BUY only); step 4 replaced it (§4).
- **The V1 cycle** (`monitor-cycle.ts`), the quote read and the Monitor frame projection remained
  for the capacity bench and their tests in this step, its write path labelling what it wrote
  `LIVE_QUOTE`; step 8 removed all of them (§8).
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
state, and has no transition recorded by this Monitor. Its first session is the window's, or its
ongoing membership's start when that is later (§4). A member listed afterwards is a new member and
is reconstructed at its newest session. A member whose data arrives late replays the same window
when it does.

The transition condition makes the replay **one-shot per member**. A membership that ends deletes
the member's state and checkpoint (§4); without the condition, restoring the membership replayed the
whole window a second time and duplicated every Signal it had opened (pre-release audit MON-01,
fixed 2026-10-16). A restored member re-enters as a new membership and is reconstructed at its
newest session. A replay that crashed before its transaction committed wrote nothing, so the next
pass replays it, once.

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

## 6. Read models: Activity feed, Signal table, coverage

Step 6 adds the read side, **additively**: the existing `GET /dashboard` and `GET /monitors/:id`
responses keep every field the web reads today, so the web moves over in step 7 and the obsolete
current-match read is removed in step 8.

### 6.1 `GET /dashboard/activity` — the Monitor Activity feed

The important changes the Monitors on the viewer's Dashboard **observed**, newest session first:

- **An event** is a transition with origin `OBSERVED` that either enters `ACTIVE` (`ACTIVATED`) or
  leaves it because a market observation ended it (`RESOLVED`, `CONDITIONS_ENDED`).
- **Never an event:** `HISTORY` (a replay, a reconstruction, a paused Monitor's catch-up),
  `ADMINISTRATIVE` endings, `EVENT_SESSION_ENDED` (a trigger day passing) and setups
  (`PENDING_TRIGGER`). V1 rows observed by the live-quote Monitor stay visible, labelled by their
  Signal's `observationBasis`.
- **Monitors:** the Dashboard's visibility rule — published built-ins the viewer has not hidden, and
  the viewer's own enabled Monitors; a Guest sees the published built-ins. A paused or plan-blocked
  Monitor's past events remain: they happened. `monitorId` narrows to one visible Monitor; any other
  id yields nothing. `kind=ACTIVATED|RESOLVED` (2026-10-21) narrows to one kind of event in the same
  query — each value is exactly the classification the response applies — so a narrowed page, its
  cursor and the "new events" check are all of the narrowed feed; both filters combine.
- **Order and paging:** by the exchange session (`observationDate`), then insertion order
  (`sequence`), keyset-paged with an opaque cursor so a page is stable while new sessions arrive;
  15 events by default, at most 50. A new index, `(monitorId, observationDate, sequence)`, serves it
  (migration `20261015150000_monitor_activity_index`).
- **Each event** carries the level's position from the version that decided it, the occurrence's
  activation price and `observationBasis`, its Why, and its `sequence` (2026-10-21), which orders
  events within a session.
- **Arrivals (2026-10-21).** A first page answers with a `watermark`; `since=<watermark>` (never with
  `cursor`) returns every change written after it, in feed order, at most 100 per read with
  `truncated` when more remain. It exists because a page cannot show an event written late for an
  older session — an ETF waiting for its data, a late bar (§4) — which lands *inside* history a reader
  already holds. The watermark stops at the newest change written more than ten minutes ago: a
  transaction that took a smaller `sequence` can commit after one that took a larger, and the worker's
  member transactions finish in far less, so nothing below the watermark is still to commit. The
  last ten minutes come back again on the next read and are de-duplicated by `id`.

### 6.2 `GET /monitors/:monitorId/signals` — the one Signal table

Active occurrences first, most recent activation first, then resolved ones, most recent resolution
first — every occurrence its own row. A resolution is ordered by the session that ended it; an
administrative ending observed no session and is placed by the New York day it was recorded.
`state=ACTIVE|RESOLVED` narrows to one group, `state=PENDING_TRIGGER` lists the current waiting
setups instead, and `levelKind` filters by level. Offset-paged across the groups (25 by default, at
most 100). Each row carries its session, activation date and price, resolution date and reason,
`observationBasis`, `fromHistory` and its Why. Visible exactly where the Monitor is.

### 6.3 The Why

`apps/api/src/monitors/signal-why.ts` renders a Why from the **version recorded with the decision**
— the transition's `strategyVersionId`, or the Signal's for older rows — and the transition's
evidence:

- an active row's Why is its activating transition's; a resolved row's is its ending transition's;
  a waiting setup's is its latest setup transition's (under the current version when that predates
  recorded versions);
- `EVIDENCE`: each recorded predicate in the canonical description language
  (`describeCondition`/`describeTrigger`) with its result and compared values;
- `RULE_ONLY`: the decided rule's wording without values, for anything recorded without evidence —
  older rows and administrative endings. Nothing is recomputed, and an edited Strategy never
  rewrites an old Why.

### 6.4 Coverage

`MonitorDetailResponse.coverage`: the newest session any current member has been evaluated through
(`latestSession`, from the checkpoints), how many current members have reached it, how many members
are current, and how many the List holds — the data behind "EOD 2026-10-13 · 497/500 evaluated".
`MonitorSignalResponse` also gains `observationBasis` and `resolvedObservationDate`.

Contracts (`@intrinsic/contracts`), `docs/openapi.yaml` and `ai/architecture/rate-limiting.md`
describe both routes; both are `standard-read` and readable by a Guest where the Monitor is.

## 7. The web: Monitor activity and the one Signal table

**Dashboard.** "Current matches" — the table of current `ACTIVE` and `PENDING_TRIGGER` states — is
replaced by **Monitor activity**, read from `GET /dashboard/activity` (§6.1). Since the Dashboard V2
amendments of `docs/decisions/etf-market-overview-v1.md` (2026-10-20, 2026-10-21) Monitor activity is
the page and the market is a Market watch sidebar flush beside it from 1,280px.

The feed (Dashboard V2, 2026-10-21) is a table of events inside one **Monitor activity card** — the
product's ordinary card (radius, border, white surface, padding) on the page's light canvas, holding
the heading, the filters, every session and the disclosure; events are rows of it, never cards of
their own. They are grouped under one heading per exchange session (`October 20, 2026`, from the
event's own `sessionDate`, never the viewer's calendar), newest first, each heading sticking under
the card's heading while its events scroll and written once even when "Show older activity"
continues its session. Four columns, aligned across rows of any height:

- **Stock** — the mark, ticker and company name, linked to Stock Details (a click anywhere on the
  row that is not a control follows it);
- **Signal** — the level in its tone's ink without its step (`Buy`, `Sell`, `Final exit`; the step
  stays the event's own, `data-level-index`, and two steps are always two rows), the event's state
  beside it (`● Activated`, `○ Ended` — read from `kind`, never from the level or a colour; an
  ending is not drawn as a loss), and a quiet `Intraday quote` on an occurrence the live-quote
  Monitor recorded;
- **Conditions** — every predicate of the Why, always visible, one per line in the Strategy's own
  order: ✓ held, ✕ did not hold, – could not be decided (never drawn as a failure), the canonical
  description, and the operands compared as arithmetic (`42.50 < 55.00`, a Trigger's move
  `99.50 → 102.50 > 101.00`, `n/a` where an operand did not resolve, `vs` where a relation would
  mislead). A signal's predicates are all required, so they are listed with no `AND` between them;
  a FINAL EXIT's Exit Rules — alternatives — sit indented under their labels joined by `or`, so the
  Boolean structure is never flattened. The expression is the line's primary text; the operands
  follow it smaller, in the muted ink and never bold, on the same line where they fit and under the
  expression where the column is narrow; the Trigger keeps a small muted `Trigger` label. A row
  grows with its conditions and nothing caps it. A `RULE_ONLY` Why shows its wording and says values
  were not recorded;
- **Monitor** — last, the name of the Monitor that observed the event as a quiet link to its page
  (`/monitors/{id}`), wrapping inside its column when long; no chip.

There is no Price column: the activation price is the Signal table's to show, and a price appears in
the feed only where a condition compared it. Two dropdowns beside the card's heading —
**Monitor** (`All monitors` or one shown Monitor, by id) and **Event** (`All events`, `Activated`,
`Ended`) — combine and are applied by the API, so every page, cursor and count is of the filtered
history; a filter that matches nothing says so and offers **Clear filters**. 15 events open it,
"Show older activity" appends the next keyset page — one request at a time, de-duplicated by id,
and dropped if the reader has changed a filter since; a failed page says so and offers **Try
again**. On the Dashboard's 60-second timer the feed reads what was written since its watermark and
places it (DB-2, revised 2026-10-21): a new event above the newest shown, an event written late for
a loaded session inside that session; one older than every loaded event is left for the cursor to
reach. Nothing is replaced, so older pages stay open, and the row the reader is on does not move
while rows are added above it. A bar that sticks to the bottom of the screen counts what was placed
("2 new events · 1 event added to an earlier session") and **Show newest** goes to the top; a backlog
larger than one refresh can place reads the newest page instead. Showing or hiding a Monitor reads
the newest page again. The freshness fact ("Updated 3 min ago") stays beside the heading. Below 40rem of its own column the feed stacks each event — stock and
signal on one line, every condition under them, the Monitor's link last under a small `Monitor`
label — and Market watch is not mounted. Nothing is called live.

**Monitor page.** The per-stock "Monitored stocks" table and the newest-100 "Recent signals" list
are replaced by one **Signals** section:

- the **coverage line** ("Evaluated through the Oct 13, 2026 close · 497 of 500 current members",
  from `coverage`), a one-line count of how the current members stand ("12 matching · 3 waiting for
  a trigger · …", from `securities`), and how many listed members are not current members;
- the ETF and "Not evaluable" notes, reworded for finalized sessions;
- **one Signal table** from `GET /monitors/:id/signals` (§6.2): Stock, Signal (`Buy 1` beside
  `Active`, `Ended · <reason>` or `Waiting for trigger`), Date (`Since …` or `Ended …`, with
  `From history` and `Intraday quote` when they apply), Why and Price; a state filter (Active &
  ended / Active / Ended / Waiting) and an action filter; "Show more signals" pages.

**`MonitorWhy`** (`apps/web/src/features/monitors/components/MonitorWhy.tsx`) renders a Why: each
rule in the Strategy's own words, each predicate marked held / did not hold / could not be decided
(as text for assistive technology, a mark visually), with the compared values in a quieter ink —
`(101.50 vs 98.25)`, or `(95.00 → 105.00 vs 100.00)` for a Trigger — `n/a` where a value did not
resolve, and "Values were not recorded for this signal" for a `RULE_ONLY` Why.

**Deterministic E2E content.** `seedQaBuiltIns` now writes the QA built-ins' changes as the
evaluation writes them: observed transitions with the real Strategy version and evidence (QATEST1
activated under Monitor A on Sep 1, ended Sep 8 and activated again Sep 10; activated under Monitor
B Sep 11; QATEST2 waiting for its trigger since Sep 14), Signals carrying the real version id, and a
checkpoint at each member's newest seeded session under its recorded membership, so the running
E2E worker has nothing new to decide and the declared state stays exact. It also clears any
replay request and stamps `watchingSince` before those sessions.

## 8. Removing the real-time paths

Step 8 deletes everything that could read or expose a price that is not a finalized EOD close, once
steps 1–7 had replaced every consumer (`docs/audits/monitor-eod-v2-intraday-inventory.md`).

**Removed.**

| Layer | What is gone |
| --- | --- |
| `packages/fmp` | `getCurrentQuotes` and its batching constant, the quote DTO, mapping and `FmpCurrentQuoteProviderPort`, and the request guard's `batch-quote` endpoint with its `SYMBOL_LIST` subject. The client's endpoint inventory test pins the seven endpoints left; the guard refuses `batch-quote` as unknown. |
| `packages/stock-data` | `getCurrentObservations`, `prepareMonitorEvaluationData`, `readMonitorEvaluationFrame`, the provisional Monitor frame (`monitor-frame.ts`), `monitorWindowObservations`, `requiredDailySeries`, `monitorWindowRange`, the `MONITOR_CURRENT_DATA` request reason, the `CURRENT_QUOTE` dataset and the moving-average subset `calculateDailyTechnicals` accepted only for that frame. `monitorWindowCalendarDays` stays, in `evaluation-window.ts`, for the reconstruction and alternative-data windows. |
| `packages/config` | `MONITOR_QUOTE_MAX_AGE_MS` (`quoteMaxAgeMs`), in code, tests and `.env.example`. |
| `apps/worker` | The V1 cycle (`monitor-cycle.ts`), `decideLevel`, its `needsDeeperHistory` and BUY-window default, `applyLevelState` with `LevelStateWrite` and the legacy origin mapping, and the `MonitorRepository` interface, folded into `MonitorEvaluationRepository`. `applyMemberEvaluation` is the only Monitor write path. |
| `apps/api` | The fake FMP's `batch-quote` answer: in the hermetic stack a quote request is now an unexpected endpoint, which fails the Playwright run. |

No migration. `MonitorSignal.observationBasis` keeps `LIVE_QUOTE` so the occurrences the V1 cycle
recorded still read truthfully; nothing writes it any more.

**Tests.** The V1 cycle's suites (`monitor-cycle.integration.test.ts`, `monitor-frame*.test.ts`,
`alternative-data-monitor-frame.test.ts`, the cycle fixtures) are deleted, and every behaviour that
still describes the product was ported to the EOD evaluation over real PostgreSQL:

- `monitor-evaluation.semantics.integration.test.ts` (new): which Monitors run, one read per
  security with the union of operands, a read failure isolated to its security, FINAL EXIT with two
  rules and under schema version 1, warm-up, position-dependent levels and their edit and revert,
  logic changes, an edit applied on the next pass, built-ins, `updatedAt` untouched, abort, the
  rebind fence, state loss and the conditions-plus-trigger lifecycle, a Fundamental Condition;
- `monitor-transitions.fixture.test.ts`, `monitor-actor-scope.integration.test.ts` and
  `monitor-etf-conditions.integration.test.ts`, re-driven through `MonitorEodEvaluation` over the
  shared `EodFixtureData` helper;
- `monitor-valuation-audit.integration.test.ts`, now over the real `CanonicalStockDataService`
  through `readFinalizedEvaluationFrame`: no Signal on a withheld ratio, every session from Mar 13
  to Nov 19, 2024 decided in order and **equal to the lifecycle the backtest frame produces**, an
  open Signal held through withheld sessions to its resolution, the basis race refused, no provider.

Not ported, because the behaviour no longer exists: quote age and absence, a quote dated after the
cycle, intraday whipsaws and same-day re-entries, a split-sized quote, the provisional row on a
closure, BUY-window gating in the Monitor (superseded by §4), and the per-session calendar call
counts of the quote path (`EodFinalityPolicy` resolves the session once per pass and is covered by
`eod-finality.test.ts`).

**Behaviour fixed on the way.** A Strategy edit made after an evening's evaluation no longer waits
for the next close: a level whose fingerprint changed is re-decided at the newest session the
member already reached, on the next pass, and a level whose logic is unchanged is never decided
twice. A level the edit **added** still starts with the next session: with no state row it cannot be
told apart from a level whose sessions were never decidable, and re-reading those on every pass
would cost a frame read per member every ten minutes.

**A step 1 regression fixed.** Step 1 made the API judge a backtest end date against the New York
day, but the New Backtest form still defaulted its end date and its MAX start to the UTC day, so
from 20:00 New York until midnight the API refused the form's own default. The full E2E run and the
API entitlement suite caught it in that window. The form, the API and the test helpers now share
`newYorkDate` in
`@intrinsic/contracts`, and an API test pins it to the domain's `tradingSessionDate` across both
DST changes.

**Capacity.** `apps/worker/src/monitor/capacity-bench.ts` (`bench:monitor`) now drives the stock EOD
preparation and the Monitor EOD evaluation over a simulated clock. With 500 securities and 9,000
members, the stock EOD child made 8 provider requests per new security and 2 per security per
session, a five-session gap included, and none on an idle scan. The Monitor pass made no provider
request and no Redis data command in any step. It took 15–18 s per new session, about 3 s when
nothing was new, and 65 s for a 90-day replay of every member. The resident bound
(`STOCK_CACHE_MAX_RESIDENT_STOCKS`) now applies to the stock EOD child once per session: 190 s at
R = 100 against 80 s at R = 1,000. The measurements and their environment are in
`ai/architecture/production-capacity.md`.

## 9. Weekly indicators complete at the week's last scheduled session

Step 9 (`fix/monitor-eod-v2-final-correctness`) makes a week's weekly bar and weekly indicators a
function of the stored bars and the venue schedule, never of the evening they were materialized on.

**The defect.** `aggregateCompletedWeeks` published a week only once the materialization date was in
a later ISO week, then dated it from the week's last *printed* bar. On Friday evening the stock EOD
child wrote Friday's row with the previous week's weekly values; Monday's rebuild rewrote that row
with Friday's own week. A Monitor deciding Friday read one row and every later backtest another, so
a weekly crossing on a Friday was decided on the wrong values — and lost entirely when Monday's
rewrite made Friday and Monday agree. A halted security's last printed day was likewise later
rewritten to show a week it could not have known was over.

**The rule.**

- A week completes at the finalized close of its **last scheduled session**: Friday in an ordinary
  week, Thursday when Good Friday closes the market, whatever day the venue schedule names in any
  other holiday-shortened week. `WeeklyPrice.eligibleDate` is that session.
- A row sees a week from that session on. When the security printed it, that is the week's own last
  bar. When it did not (a halt), no row of the week ever sees it, and the security's next bar does.
- Only weeks whose last bar is not their Friday need the schedule (`resolveWeekSessionEnds`); a
  Friday bar ends its week by itself. The schedule is the canonical one — `EodFinalityPolicy` over
  `CachedTradingCalendar`, the calendar the finality rule already reads — through
  `isScheduledSession`. A day it cannot answer for is taken to be a session, which can only delay a
  week to its Friday, never reveal it early. Only the weeks a rebuild writes are asked about.
- **Provider cost.** The calendar caches each venue-year for a day, so a history asks for one
  schedule per year it spans, once a day per process — an ETF's history reaches back to 1993. A past
  year the provider cannot answer is asked again at most hourly per process
  (`UNANSWERABLE_YEAR_RETRY_MS`), and its holiday weeks resolve to their Friday until it can; the
  year in progress is asked every time, as `expectedSession` asks it. Whether the provider serves
  schedules that far back was not verified against the live endpoint (hermetic fixtures only).
- Finality is the existing cutoff: before Friday's close plus the publication delay the cutoff is
  Thursday and the week is not published; after it, Friday's row reads the week. Early closes
  finalize at the regular time, so they change nothing.
- A late Friday bar publishes its week on its own row when it arrives; the rows before it are not
  touched.

**One rule everywhere.** The stock materializer, the ETF technical context (and so Stock's Sector)
and every reader of them apply the same function with the same schedule: the Monitor and the backtest
compositions both pass the venue schedule into the ETF contexts (`isScheduledSession` on
`MonitorEtfContexts` and on the backtest processor's `etfContexts`).

**Versioning.** `DERIVED_STATE_REVISION` moves to 8 (`derived-state.ts`): r7 coverage and manifests
go stale and every security's derived state is rebuilt as r8 on first touch. Historical weekly values
change only where the old rule was wrong: a halt week's last printed day, and a holiday week whose
schedule cannot be read. Friday rows were already rewritten by the following Monday under r7, so
historical backtests read the same Friday values as before. Monitor history decided on r7 rows is
**not** rewritten: each transition keeps the evidence it was decided on, so a Friday decided before
this step shows the previous week's values in its Why.

**Proof.** `weekly-session-end.test.ts` (each weekday, before and after Friday's finalization,
Monday morning, Good Friday, Monday and Thursday holidays, an early-close Friday, both DST changes, a
halted Friday, a late Friday bar, an unanswerable schedule, and a property over 40 generated
histories: no row changes once it exists, no row reads a week before its last session);
`benchmark-technicals.test.ts` (stock and ETF weekly values bit-identical on holiday calendars, and
stable evening by evening over five seeds); `monitor-weekly-parity.integration.test.ts` (the real stock
EOD child and Monitor evaluation decide a weekly crossing on Friday evening, a Good Friday week's on
Thursday evening, and an ETF and a Stock's Sector weekly Condition on the fund's Friday, exactly as a
backtest over the finished history records them, with the same evidence). Against the r7 rule, the
parity suite fails 4 of 4 and the session-end suite 10 of 12.

## 10. Late end-of-day publication: a bounded recovery horizon

**The defect.** A member was stepped over any session its security had not printed. A bar published
late — after a later session's bar, or after the 24-hour give-up — then found the member's checkpoint
already past it, and was never decided: a Tuesday Trigger published on Thursday was lost for good,
and Wednesday had been decided on a frame without Tuesday.

**The horizon.** `EOD_LATE_RECOVERY_MS` (default four days, at most six; `getEodFinalityConfig`) is how
long after a session's finalization a bar the security has not printed may still arrive.

- **A member is never stepped past a recoverable session.** After its checkpoint, every session the
  venue scheduled and the security has no bar for, newer than the horizon, is a recoverable gap; the
  member is decided up to the session before the first one and waits there
  (`membersAwaitingLateSession`, `monitor.late-session.waiting` at debug). Nothing is written while it
  waits. When the bar arrives the sessions are decided in order, exactly once — the checkpoint guard
  and `stateVersion` are unchanged.
- **Absence is confirmed by evidence, not the clock.** A stock's missing session stops being
  recoverable only once a provider read issued at least the horizon after its finalization
  (`lastTailSyncAt`) still returned no bar — the stock EOD child re-reads the ten-day recent tail on
  every session, so that read happens on its own. Then the session is genuinely not printed (a halt, a
  delisting) and the member is decided past it, or passed through it with no observation when the
  security printed nothing later. A security never read falls back to the clock. While the child is
  down nothing is confirmed, and a bar it finds afterwards is still decided in order.
- **An exchange closure is not a gap**: the venue schedule says the day was not a session. A day the
  schedule cannot answer for is treated as one — a hold is recoverable, a skipped bar is not.
- **An ETF's late session** holds the member the same way when the stock printed the session but a
  fund its rules read did not (after the fund's first session), until the horizon has passed since
  finalization; then the session is decided with that fund's columns absent — its rules
  `NOT_EVALUABLE`, never a carried value. The ETF-behind wait of §3.5 now uses the same horizon.
- **Derived data follows the bar.** A late bar stored behind a derived coverage gap now rebuilds the
  derived state from the bar's date, not from the gap (`ensureStockHydrated`): before this step a
  crash between a read and its write left the next rebuild starting at the gap, so the late session's
  averages were stale while coverage claimed them current.

**Provenance.** A recovered session is recorded on its own session date, `OBSERVED` when the Monitor
was being watched at that session's finalization (the rule an outage's catch-up already follows,
§3.3), with that session's evidence; `detectedAt` says when it was decided. Nothing earlier is
rewritten.

**What it costs.** Nothing on an ordinary pass: gaps are computed only for a security that has a
session to decide, from the frame the pass already read and the cached schedule. A security with a
recoverable gap is re-read each pass while it waits — at most for the horizon. A genuinely halted
security's members are evaluated with a lag of up to the horizon plus one session.

**The limit, stated.** Recovery is guaranteed for a bar the provider publishes before the stock EOD
child's first read issued at least the horizon after the session's finalization — in practice, within
four days. A bar published after that is not decided by the Monitor: by then its checkpoint has moved
on. Storage still stores it if it falls inside the ten-day tail window, and every later read of
derived data — backtests, Stock Details — includes it; the Monitor's record for the sessions after it
keeps the values it decided them on.

**Proof.** `monitor-late-recovery.integration.test.ts` drives the real stock EOD child and the real
Monitor over PostgreSQL and Redis, evening by evening, with a decisive move on Tuesday: Tuesday's bar
30 minutes, 6, 25, 36 and 72 hours late; two consecutive sessions late; Wednesday published before
Tuesday; an empty answer, then data; a 429, then recovery; a crash after the read and before the
write; a crash after a member's commit and before the pass acknowledged it; two passes overlapping
the recovery; Redis losing every key during it; a re-based history met mid-read; a halted security
that never prints Tuesday; Conditions, Trigger, Conditions + Trigger and FINAL EXIT alternatives; a
late ETF session. At every step the Monitor may never stand past a session still to be published,
and at the end every change is exactly the backtest's — level, session, reason, once — with that
session's evidence and one Signal per activation. With the hold disabled, 16 of the 20 cases fail.
`monitor-differential.integration.test.ts` adds the differential properties over eight generated
histories with holidays, halts, regime moves and weekly crossings: evening-by-evening evaluation
(with a pass before each session is final, which must decide nothing), one chronological catch-up,
restarts on random evenings, the initial replay alone and followed by checkpointed continuation, and
a Strategy edit mid-way — each recording exactly the backtest's changes.

## 11. Data-correctness coverage of the new pages

The data-correctness audit's browser stage (`apps/web/e2e/data-correctness/data-correctness.audit.spec.ts`,
run by `pnpm audit:data-correctness` against the QA matrix) still read the removed "Current matches"
table. Its Dashboard stage now reads the pages that replaced it, for the same purpose: every
(member, level) the signals section's reference replay says is ACTIVE or PENDING_TRIGGER is a row of
its Monitor's Signal table — Active or Waiting — on the session it began, at its price, on desktop and
at 390×844; every occurrence the audited session opened is an "Activated" event on the Dashboard, at
its price; and nothing a reconstruction established is activity.

That stage needs the QA matrix, so it does not run with the hermetic suite. Its properties now also
run on every `pnpm test:e2e`, in `monitor-records.user.spec.ts`, over the deterministic QA built-ins —
which now include an occurrence a reconstruction established and a membership change ended
administratively: every stored Signal shown once, active first, on its own finalized session, with
its price, provenance and Why; a waiting setup under Waiting only; history and administrative changes
in the Signal table and never in the feed; every feed event the Signal-table record it is; and a
private Monitor's records unreadable to anyone but its owner.
