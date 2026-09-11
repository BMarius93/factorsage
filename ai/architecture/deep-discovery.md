# Deep discovery log

Sequential, end-to-end investigations of one system question at a time, recorded so a future agent
can answer "what does the system actually guarantee here?" without re-deriving it from source.
Each entry names the question, the behaviour as verified in code and tests, the invariants that
must hold, the edge cases tried, a classification and what was changed. Canonical explanations
live in the owner documents linked from each entry; this log points at them rather than repeating
them. Entries are in the order they were investigated, because each one builds on the last.

Finding classes: Healthy · Design limitation · Product decision required · Documentation mismatch ·
Test gap · Performance risk · Correctness issue · Security issue.

---

## 1. Strategy mutation versus a live Monitor

**Question.** A Monitor references the live `Strategy`; backtests pin an immutable version. What
exactly happens to a Monitor's state and Signals when the Strategy is edited while a level is
matched — one level, a trigger, a metric, a removed level, a new level, several edits between two
cycles?

**Current behaviour.**

- A cycle reads every enabled Monitor once, with the Strategy's **newest** version
  (`PrismaMonitorRepository.listActiveMonitors`, `orderBy versionNumber desc, take 1`). Nothing
  else is ever evaluated: N edits between two cycles collapse to their net effect.
- Durable state is one `MonitorSignalState` row per `(monitorId, securityId, levelId)`, carrying
  `signalFingerprint` = `strategySignalFingerprint(level.signal)` — the level's own logic with row
  ids stripped, sharing serialization with the definition hash so the two cannot disagree.
- On evaluation, `applyTransition` compares the row's fingerprint with the current level's:
  - **same id, same logic** → the latch and the active Signal continue; an edit to *another* level
    does not touch this one (`monitor-cycle.integration.test.ts` "keeps an unchanged level's match
    when another level of the Strategy is edited");
  - **same id, changed logic** (operator, metric, value, trigger added/removed, condition
    added/removed) → the row is *stale*: its active Signal is resolved, the latch is discarded, and
    the new logic is evaluated as if never seen — so a condition that is true under the new logic
    emits a **new** Signal on the same observation, and a trigger emits only if the canonical
    crossing holds between `t-1` and `t` ("resets state recorded under different level logic");
  - **level id absent from the newest version** → `resolveUnvisitedSignals` closes the active
    Signal and resets the row to NOT_MATCHED with no fire date. The row is kept, keyed by the old
    id, and is harmless: if that id ever returns it starts from "not matched", which re-emits a
    genuine match;
  - **new level id** → no row; first evaluation emits immediately for a true condition, and for a
    trigger only if the crossing holds on this observation.
- `percentage` is not part of a Signal's fingerprint, so re-weighting a level keeps its state.
- A Signal records the `strategyVersionId` it was decided under; the rule text is recoverable by
  joining that version's definition on `levelId`.

**Invariants.**

1. Level ids are unique across BUY, SELL and FINAL EXIT within one definition (validator, one
   `LEVEL` namespace), so state rows cannot collide across level kinds.
2. **A level id is durable identity across versions.** The persisted document's ids only change when
   a client submits different ids *and* the logic changed (otherwise the hash matches and the
   persisted document, with its original ids, is returned unchanged). The web Builder edits rows
   in place and never regenerates an existing id (`draftFrom`, reducer spreads).
3. Only the newest version is evaluated; intermediate versions are history for backtests only.

**Evidence.** `apps/worker/src/monitor/monitor-repository.ts` (`applyTransition`,
`resolveUnvisitedSignals`), `packages/contracts/src/strategies.ts` (`strategySignalFingerprint`,
`ValidationContext.claimId`), `apps/api/src/strategies/strategies.service.ts` (`replaceDefinition`,
version appended only on hash change, now under a row lock),
`apps/web/src/features/strategies/utils/strategy-draft.ts`,
`apps/worker/src/monitor/monitor-cycle.integration.test.ts` (edit and reset cases),
`apps/api/src/strategies/strategies.integration.test.ts` ("appends a version only when the
definition actually changes", including the re-keyed no-op),
`apps/web/src/features/strategies/utils/strategy-draft.test.ts` ("keeps existing row ids").

**Edge cases considered.** Edit A then revert A between two cycles (net no change → state
continues, no Signal churn). Edit A while A is matched and the new A also matches (old Signal
resolved, new Signal emitted on the same observation — two Signals for what the user may see as one
continuing match, but under two different rules; deterministic and the documented intent). Two
levels with identical logic (independent state by id). Trigger → condition on the same level
(fingerprint changes; a fired trigger Signal is resolved; the condition may emit at once). A
non-web client that regenerates every id on save: every level looks removed-and-added, every active
Signal is resolved and every still-true condition re-emits — behaviour is deterministic but not what
a user would call "an edit"; this is the invariant the docs now state rather than an engine bug.

**Finding.** Healthy behaviour; **Documentation mismatch** on level ids (they were documented as a
diagnostics affordance, but Monitor V1 made them identity).

**Action.** Documented the identity rule in `docs/decisions/strategy-definition-storage.md`,
`ai/architecture/strategy-builder.md` and `ai/product/monitors.md`; added a web reducer test that
existing row ids survive edits of other rows.

---

## 2. List mutation versus a live Monitor

**Question.** Which universe does a cycle evaluate, and what happens to state and Signals when
members are added, removed, removed and re-added, re-windowed, or changed while a cycle runs?

**Current behaviour.**

- The universe is read **once per cycle** with the Monitors (`listActiveMonitors` includes
  `stockList.items` with buy windows). Evaluation and the orphan sweep both use that same
  in-memory `monitor.members`, so one cycle sees one consistent membership; a List edit during a
  cycle is visible from the next cycle only. There is no persisted membership snapshot and none is
  needed: state is keyed by `securityId`, not by list-item id.
- **Added** member: no state row → evaluated as new next cycle; a true condition emits at once.
- **Removed** member: next cycle's `resolveUnvisitedSignals` closes its active Signals and resets
  its rows to NOT_MATCHED. Rows are kept (keyed by `securityId`).
- **Removed and re-added** (a new `StockListItem` row, same `securityId`): the reset row is found,
  the latch reads "not matched", and a still-true match emits a fresh Signal ("signals again for a
  security removed from the list and added back"). This is a genuine second match, by decision.
- **Buy window changed**: BUY levels read `isBuyWindowEligible(config, observationDate)` — inclusive
  on both ends, `FULL` always eligible — before evaluating; an ineligible date is `NOT_MATCHED`, so
  an active BUY condition Signal resolves on the first observation after its window closes, and a
  fired BUY trigger Signal closes when a later session is observed. SELL and FINAL EXIT ignore
  windows. The date compared is the exchange session date of the observation, so a weekend cycle
  that re-observes Friday still tests Friday.
- **Removed mid-cycle**: the running cycle still evaluates it from the members it loaded and may
  emit; the next cycle resolves. One-cycle lag, same as disable.

**Invariants.** Membership is read once per cycle and used for both evaluation and the sweep; the
sweep names *current securities and levels*, never row ids, so states created in the same cycle are
never swept by mistake. A Monitor over an emptied List sweeps everything (the "visits nothing" path)
rather than returning early.

**Evidence.** `monitor-repository.ts` (`listActiveMonitors`, `resolveUnvisitedSignals`),
`monitor-cycle.ts` (`run` — no early return on an empty universe; `evaluateLevel` gating),
`packages/domain/src/stock-lists.ts` (`isBuyWindowEligible`), tests "resolves a Signal whose
security left the monitored list", "signals again for a security removed from the list and added
back", "honours a CUSTOM buy window that does not admit the observation date", "gates only BUY
levels by the buy window, never SELL or FINAL EXIT".

**Edge cases considered.** Two Monitors over one List (independent state per Monitor). The same
security in two Lists watched by one Strategy (two Monitors, two states). `addItems` re-submission
(`skipDuplicates`, idempotent). A member whose Security row is deactivated in the catalog (it stays
a member — catalog sync never deletes — and is simply unquoted: NOT_EVALUABLE, latch untouched).

**Finding.** Healthy. The conceptual answer to "which snapshot does a cycle evaluate" is: the
membership as of the cycle's first query, for that cycle only; nothing is snapshotted durably.

**Action.** None in code. Semantics recorded in `ai/product/monitors.md` ("Lifecycle in one place").

---

## 3. Observation identity and time

**Question.** What identifies "one market observation" across the provider quote, the persisted
daily bar, the exchange session, the UTC day and the wall clock — and can the same logical
observation appear twice under different dates?

**Current behaviour (the canonical time model).**

- **Persisted history** is keyed by the provider's `date`, the exchange calendar day of the bar.
  During a session the provider's EOD endpoint already returns the current day as an
  **in-progress bar** (verified live 2026-09-11 13:00 ET: `historical-price-eod/full` listed
  2026-09-11 with close 334.36 while `batch-quote` showed 334.82 and a later volume). The recent
  tail refresh persists that row as a `DailyPrice`, and the derived columns for it, whenever it
  runs during a session; the next refresh (freshness window 6h) overwrites it with the final bar.
  A "closed" row is therefore final only once a later refresh has run after the close.
- **The Monitor observation** is the provider quote, dated by `tradingSessionDate(quotedAt)` — the
  America/New_York calendar day of the last trade, never the UTC day. `quotedAt` is the quote's
  `timestamp` in epoch seconds; `0`, negative, non-finite and unparsable values yield no
  `quotedAt`. A quote with **no** `quotedAt` is dated to the cycle's own session (taken at its
  word); a quote older than `MONITOR_QUOTE_MAX_AGE_MS` (4 days) or dated after the cycle's own
  session is refused.
- **Identity is `(securityId, session date)`.** `projectMonitorEvaluationFrame` collapses the
  provisional quote-derived bar and a persisted row of the same date into one row (the quote
  supersedes), refuses a quote older than the newest persisted close, refuses a weekend date, and
  the cycle refuses a date the venue's schedule calls a full closure. Signals and the trigger fire
  date carry the session date; `detectedAt` carries the wall-clock instant.
- Weekend, holiday, pre-market and after-hours quotes all still name the session of their last
  trade: Friday's after-hours trade on Saturday is Friday; Tuesday 08:00 pre-market is Tuesday
  (the domain's session window is 04:00–20:00 local, so extended hours are part of the day). An
  early close is an ordinary session. A delayed feed only shifts `quotedAt` within the same session.
- The stock-data loader's own `today()` is the **UTC** day. It bounds retention and the tail
  refresh's `to`; asking the provider through a day that has not started returns nothing extra,
  and coverage recorded through that date is harmless because the tail is re-fetched on the
  freshness clock regardless. The Monitor cycle's `asOf` now uses the session date instead.

**Invariants.** One row per `(securityId, date)` in every frame. A quote can only ever name its own
last-trade session, so it cannot be observed under two dates. A session with no observation
advances nothing (no fire-date change, no Signal close).

**Evidence.** `packages/domain/src/security-universe.ts` (`tradingSessionDate`, tests for DST and
Friday-evening), `packages/fmp/src/mapping.ts` (`quoteInstant`), `apps/worker/src/monitor/monitor-cycle.ts`
(`resolveObservation`), `packages/stock-data/src/monitor-frame.ts` (supersede/refuse rules),
`packages/stock-data/src/service.ts` (`refreshPriceWithinLease`, `today`), live provider probe above.

**Edge cases considered.** 19:30 ET Monday under EST is 00:30 UTC Tuesday → still Monday. A thin
symbol whose last trade was two sessions ago → dated to that older session, evaluated as that
session (no new bar, nothing fabricated). Halted symbol beyond four days → refused, NOT_EVALUABLE,
latch untouched. A symbol the provider prices with **no timestamp** → dated today even if it did
not trade today: a possible fabricated bar, accepted in V1 and now stated precisely in
`ai/product/monitors.md` (it was described as "refused when unreadable", which absent is not).

**Finding.** Healthy time model; **Design limitation** (absent-timestamp quotes) and a fact that
was undocumented: the current session's persisted bar is provisional until the next refresh.

**Action.** `ai/product/monitors.md` (absent timestamp), `ai/architecture/system-overview.md`
(in-progress bar in the tail), `ai/product/backtests.md` (a run whose period ends today may
simulate today from an in-progress bar — see investigation 5 and the product question there).

---

## 4. Signal identity and lifecycle

**Question.** What makes two Signals "the same event", and does the lifecycle hold under restart,
retry, Strategy edit, List removal/re-add, duplicate quotes, a duplicate scan, observation replay,
a stale worker and a data correction?

**Current behaviour.** The lifecycle is decided entirely from durable rows:

```text
no row                         first decided evaluation creates the row; MATCHED emits
NOT_MATCHED -> MATCHED         emit (condition: !wasMatched; trigger: !firedThisObservation)
MATCHED     -> MATCHED         no write at all (fast path), Signal stays active
MATCHED     -> NOT_EVALUABLE   lastOutcome only; latch and Signal untouched
NOT_EVALUABLE -> NOT_MATCHED   condition: resolve the active Signal (latch decides, not lastOutcome)
MATCHED     -> NOT_MATCHED     condition: resolve; trigger: keep the Signal for its session
later session observed         trigger: close the Signal whatever the outcome
NOT_MATCHED -> MATCHED again   a new Signal (a condition state that ended and began again)
```

- **A condition Signal** is one unbroken run of MATCHED decisions on one `(monitor, security,
  level)`; it ends on the first decided NOT_MATCHED, on removal from the List, on removal of the
  level, or on a logic change of the level.
- **A trigger Signal** is one crossing on one session date within one *epoch* of the row — the
  same level logic and continuous membership. Within an epoch there is at most one per
  `(monitor, security, level, observationDate)`, enforced by `lastTriggerSignalDate`; the same
  date may legitimately carry a second Signal in a **new epoch** (logic edited and the new rule
  also crosses that day; member removed and re-added the same day). That is why no unique index
  on `(monitorId, securityId, levelId, observationDate)` exists and none should be added: it would
  turn those legitimate cases into a permanently contended transition.
- Restart, retry, duplicate scan and observation replay all re-derive the same decision from the
  same rows and take the fast path (nothing written). A stale worker's writes lose the
  `stateVersion` guard and roll back the Signal they created. A duplicate quote cannot occur
  (one batched request per cycle, keyed by security). A **data correction** that changes what the
  current observation evaluates to is simply the next transition — the emitted Signal is history
  and keeps the observation it was decided on.
- Neither a trigger's `activeSignalId` nor its latch is cleared by an intraday move back across
  the line, so `(lastEvaluableResult = NOT_MATCHED, activeSignalId ≠ null)` is a legitimate
  trigger-row state.

**Invariants.** A Signal is created only inside the transaction that moves the latch, so it can
never exist without the row that explains it. `activeSignalId` is unique. `NOT_EVALUABLE` never
moves the latch. Only a real observation of a later session ends a trigger Signal.

**Evidence.** `monitor-repository.ts` (`applyTransition`, `closesEventSession`, `resolveSignals`),
`monitor-cycle.integration.test.ts` (whipsaw, later-session close, older-session keep, state loss,
double-apply, removed-and-re-added, logic reset).

**Finding.** Healthy. Signal identity is now an explicit documented invariant rather than
implementation knowledge.

**Action.** Recorded here and in `ai/product/monitors.md` ("What identifies a Signal").

---

## 5. Backtest versus Monitor semantic equivalence

**Question.** Evaluating the same security on the same market state, do a backtest and a Monitor
reach the same logical result, and where they cannot, is the divergence deliberate?

**Current behaviour.** One evaluator (`evaluateMarketSignal` / `evaluateMarketTrigger` in
`@intrinsic/strategy`) and one frame projector (`projectEvaluationFrame` in `@intrinsic/stock-data`)
serve both. A Monitor frame is the backtest frame with one extra last row — the provisional
observation — and daily moving averages and oscillators recomputed over the window from one price
array so `t - 1` and `t` share a methodology. `t - 1` is the previous row of the trading-day axis in
both. Buy-window gating reads the same `isBuyWindowEligible`. Operators, the 2% `is close to`
tolerance and the `NOT_EVALUABLE` algebra are shared code, not re-stated.

**Deliberate divergences.**

1. The Monitor observation is the live last trade (extended hours included); a backtest observes
   the closed bar. A crossing that fails to hold at the close fires a Monitor Signal and would not
   appear in a backtest of the same day. Both are right about what they observed.
2. Daily technicals: bounded-window recomputation with the seed's residual influence below `1e-6`
   relative, versus full-history materialized columns. A strict comparison decided inside that band
   may differ; below a price tick and the stored precision.
3. Weekly series and intrinsic values are carried forward from the newest closed derived row in the
   Monitor; a backtest reads each day's own row. Neither changes intraday; a statement whose
   availability date is today is applied to today's row by the materializer at the next refresh.
4. `Gain` / `Loss` are `NOT_EVALUABLE` in a Monitor (no position) and live in a backtest.
5. Rounding: both read `Decimal(20,8)` columns as JS numbers; the Monitor adds the quote's float
   for one row. Nothing rounds before comparison.
6. A backtest whose period ends **today** reads today's in-progress bar as its last "closed" day
   (investigation 3). The docs said backtests use closed observations; that is true of every day
   but the last when the last is today.

**Invariants.** No second implementation of any operator, series or evaluability rule exists for
the Monitor; a change to `predicates.ts`, `evaluation-frame.ts`, `technicals.ts` or
`oscillators.ts` changes both consumers at once.

**Evidence.** `packages/strategy/src/{predicates,monitor}.ts`, `packages/stock-data/src/{evaluation-frame,monitor-frame}.ts`
(`SEED_INFLUENCE_BOUND`, `dailySeriesWarmupObservations`), `monitor-frame.test.ts` (recomputed values
agree with the canonical materialized series), `apps/api/src/backtests/backtest-requests.ts`
(`endDate > today` rejected, `endDate == today` accepted).

**Finding.** Healthy, with one **Product decision required**: should a backtest period be allowed
to end on the current, still-open session? Options: bound `endDate` to the last closed exchange
session (needs the calendar the Monitor already has), or keep today and label the last day
provisional in the run's diagnostics. Not changed.

**Action.** `ai/product/monitors.md` ("How Monitor evaluation differs from a backtest"),
`ai/product/backtests.md` ("The last day may be provisional").

---

## 6. Historical data corrections

**Question.** When the provider later returns a different value for an already persisted price,
statement or derived series, which artifacts change and which are immutable?

**Current behaviour.**

- **Prices.** Only the recent tail (`STOCK_RECENT_TAIL_CALENDAR_DAYS`, 10 calendar days) is ever
  re-fetched. `saveDailyPriceSync` compares each returned row with the persisted one
  (`samePrice`), records the earliest changed date, rebuilds `DailyDerivedState` from the earlier
  of that date and the affected ISO-week boundary, and republishes the touched Redis years. A
  correction **older than the tail is never observed** until `PRICE_DATASET_VERSION` is bumped —
  by design, a persisted coverage interval means complete materialization under that version
  (`docs/decisions/complete-price-coverage.md`).
- **Statements.** Append-only revisions keyed by content hash; a changed value for an existing
  fiscal identity without a later filing date is a new revision whose `availableFromDate` is when
  *we* first observed it, never backdated (`docs/decisions/fundamentals-loader.md`). Historical
  intrinsic values therefore keep their point-in-time truth; only days from the observation
  onward change. The initial backfill may already embed upstream restatements (known V1 limit).
- **Derived series** are recomputable projections of the above and are rebuilt from the earliest
  affected date; `DERIVED_STATE_REVISION` rebuilds everything on a methodology change.

**Immutable results.** `BacktestRun` results (summary, trades, equity, positions) and
`MonitorSignal` rows never change; a Signal keeps the observation date and price it was decided on.
**Re-decided state.** `MonitorSignalState` is a latch over "the last decided evaluation"; a
correction that changes today's `t - 1` is simply the next transition (a Signal may resolve or a
new one emit). Redis holds no artifact that is not rebuilt from PostgreSQL.

**Evidence.** `packages/stock-data/src/prisma-store.ts` (`saveDailyPriceSync`, `samePrice`),
`service.ts` (`refreshPriceWithinLease` → `derivedRebuildStart`), `docs/decisions/complete-price-coverage.md`,
`docs/decisions/fundamentals-loader.md` "Revisions and restatements", `ai/product/backtests.md`
"What reproducibility does not mean here".

**Finding.** Healthy and deliberate; one **Design limitation** worth knowing: price corrections
older than ten calendar days are invisible without a dataset version bump.

**Action.** Recorded here.

---

## 8. Failure after external work, before durable commit

**Question.** For each flow that spends provider or compute work before a PostgreSQL commit, what
happens if the process dies before the commit, or after the commit but before the acknowledgement
or reschedule?

**Current behaviour.**

| Flow | Dies before commit | Dies after commit, before the follow-up |
| --- | --- | --- |
| Stock hydration / tail refresh | Manifest stays `HYDRATING` under a TTL; Redlock expires. Next reader's CAS restarts hydration from PostgreSQL coverage; only the genuinely uncovered range is fetched again. Repeatable, provider cost bounded to the missing delta. | PostgreSQL coverage is recorded; the Redis publish is missing. The next read finds no READY projection and rebuilds it from PostgreSQL with **zero** provider requests (`provider-reuse.integration.test.ts`). |
| Monitor cycle | Quotes were fetched; transitions not yet committed are lost, committed ones stand (one transaction each). The lease expires or the heartbeat fails; the next cycle re-derives every transition and takes the fast path for the committed ones. No Signal can be emitted twice: the emit and the latch commit together. | `completeScan` not reached: the row stays claimed until the lease expires, recovery clears it with `dueAt` unchanged, the next claim re-runs the cycle immediately and writes nothing. `markScanned` may lag one cycle (cosmetic). |
| Backtest run | Simulation is repeated from day one on the next claim; progress and milestones of the dead attempt are cleared. Provider work is not repeated (data is persisted before simulation). | `persistResult` flips the run **and** the job to `COMPLETED` in the one transaction, so there is no separate acknowledgement to lose. |
| Strategy / List / Monitor API writes | Single transactions; nothing external. | n/a |

**Invariants.** Provider work is always followed by a PostgreSQL write that makes it unnecessary
to repeat; Redis is only ever a rebuildable projection; every side effect that must not repeat
(a Signal, a completed run) commits together with the state that says it happened.

**Evidence.** `packages/stock-data/src/cache.ts` (`BEGIN_HYDRATION` CAS, hydration TTL),
`redis.integration.test.ts` ("recovers stale HYDRATING state…", "expires an abandoned HYDRATING
generation…"), `apps/worker/src/backtest/job-repository.ts` (`persistResult`, `recoverStaleJobs`),
`apps/worker/src/monitor/{monitor-loop,scan-repository,monitor-repository}.ts`.

**Finding.** Healthy. Nothing changes semantics when replayed.

**Action.** None.

---

## 9. Resource deletion semantics

**Question.** What exactly disappears, is refused, or is kept when a User, List, Strategy, Monitor
or Security is deleted — across PostgreSQL, Redis, queued work and in-flight workers?

**Current behaviour.**

| Deleted | PostgreSQL | Redis | In flight |
| --- | --- | --- | --- |
| User | Cascades to OAuth accounts, verification tokens, Lists (+items, +windows), Strategies (+versions), BacktestRuns (+job, progress, milestones, trades, equity, positions, summary), Monitors (+states, +signals). | Nothing: no user-scoped key exists. | A worker holding a claim on a deleted run loses every ownership-guarded write and abandons; a cycle mid-Monitor gets benign FK races and skips that Monitor. |
| List | Cascades items and windows. **Refused** (`409`) while any Monitor references it. `BacktestRun.stockListId` is set null; the snapshot is unaffected. | Nothing. | Cycle: the Monitor referencing it cannot exist. |
| Strategy | Cascades versions. **Refused** while any Monitor references it. Runs keep their snapshot; `strategyId`/`strategyVersionId` set null. | Nothing. | as above |
| Monitor | Cascades signal states and Signals (history goes with the Monitor, deliberately). Strategy and List untouched. | Nothing. | A cycle that loaded it writes nothing durable for it. |
| Security | Never product-deleted; catalog sync only deactivates. Every reference is `Restrict`. | A deactivated security's cached row can be stale (investigation 7). | — |

**Invariants.** Signal history lives exactly as long as its Monitor; run history lives exactly as
long as its user; nothing user-owned is in Redis; no durable row references a deleted row except
through nullable snapshot-side foreign keys that mean "was", not "is".

**Evidence.** `packages/database/prisma/schema.prisma` (every `onDelete`), `ai/architecture/database.md`,
`apps/api/src/{lists,strategies}/…service.ts` (`isForeignKeyViolation` → in-use errors),
`apps/worker/src/monitor/monitor-repository.ts` (`isBenignWriteRace`), audit tests for foreign-key
refusal ("refuses to delete a strategy a monitor is still using").

**Finding.** Healthy and deliberate.

**Action.** None; matrix recorded here, owner document remains `ai/architecture/database.md`.

---

## 7. Cache invalidation versus domain mutation

**Question.** Following each real mutation event rather than reviewing Redis in general: which
cached or derived artifact can go stale, how does it recover, and is there a stale-but-valid state
that raises no error?

**Current behaviour.**

| Mutation | What could be stale | How it recovers |
| --- | --- | --- |
| Strategy / List / Monitor edited | Nothing cached: no user-scoped key exists; a cycle re-reads PostgreSQL. The web app keeps no client cache library (fetch on render). | n/a |
| Price tail refreshed / history widened | Yearly price and derived chunks | Rewritten for the affected years in the same lease; a reader that sees no READY projection rebuilds from PostgreSQL |
| Fundamentals refreshed | Derived intrinsic columns | Rebuilt from the earliest availability date of the loaded batch; revision-gated |
| Methodology or dataset revision bumped | Every manifest | `isCurrent()` rejects the manifest on the next read; lazy rebuild |
| Exchange schedule changed | In-process calendar, 24h TTL, last-known-good on refetch failure | Direction of error is safe: an unexpected closure has no trades to date, an unexpected open day is refused for a day (NOT_EVALUABLE), never fabricated |
| **Catalog sync renames or deactivates a security** | The cached identity row `stock-data:v2:symbol:<SYMBOL>:security` that `getSecurity` serves Stock Details from. No TTL; refreshed only by profile hydration or eviction. | **Was not refreshed at all** — a stale-but-valid state with no error. Fixed: the sync now writes the updated row through, and an entry whose cache refresh fails is reported as failed rather than updated. |

**Invariants.** Every Redis artifact is either rebuilt from PostgreSQL on the next read or written
through by the operation that changed its source; nothing user-owned is cached anywhere.

**Evidence.** `packages/stock-data/src/security-catalog.ts` (write-through),
`security-catalog.test.ts` ("refreshes the cached identity row…", "reports a row whose cache
refresh failed…"), `service.ts` (`getSecurity` cache-first, `hydrateSecurityProfileWithinLease`
already writing through), `apps/api/src/stocks/stocks.module.ts` (cache injected into the sync),
`trading-calendar.ts`.

**Finding.** **Correctness issue** (minor, cosmetic scope: the Stock Details identity header could
show a stale name, exchange or trading flag after an admin sync until eviction) — fixed.

**Action.** Write-through added; `updateSecurityCatalogEntry` now returns the persisted row.

---

## 10. Scale boundaries

**Question.** From the implementation, where is Monitor work shared and where is it repeated, and
at what universe size does the design stop being cheap?

**Per cycle, derived from the code.** With `U` distinct securities across all enabled Monitors,
`M` enabled Monitors, `L` levels per Strategy and `R` = `STOCK_CACHE_MAX_RESIDENT_STOCKS` (100):

- **Shared per security (not per user, not per Monitor):** one quote per symbol in batches of 50
  (`ceil(U / 50)` sequential provider requests through the shared gate, 20/s), one manifest and
  freshness check, at most one tail refresh per 6h, one projection read, one recompute of the
  union of every required daily series, one frame. Ten users watching AAPL with ten Strategies
  cost one of each.
- **Per Monitor:** one state query, `members × L` in-memory evaluations, one orphan-sweep query,
  and one transaction per *changed* transition only. Steady state writes nothing.
- **Universe read:** one query for every enabled Monitor with its list items and buy windows.

**The boundary is `U` versus `R`.** The stock cache keeps the `R` most recently used securities
resident. A cycle touches `U` securities in sequence, so once `U > R` every cycle re-materializes
`U − R` securities from PostgreSQL into Redis and evicts them again: for an `EMA 200D` Strategy the
load target is roughly seven years of window plus four of warm-up, on the order of 2,800 price
rows and 2,800 wide derived rows per security, written as ~22 yearly chunks — every five minutes,
per evicted security. Provider traffic stays flat (coverage is durable), but PostgreSQL read
volume, Redis write volume and cycle duration grow linearly with `U − R`, and Stock Details users
lose residency to the sweep. Memory is the other driver: every frame is held until the per-Monitor
pass, on the order of 100 KB per security for a 200-day window, so a 10,000-security universe
holds on the order of a gigabyte per cycle.

| Scenario | Shared work | Repeated work | Verdict |
| --- | --- | --- | --- |
| 1 user × 100 securities | 2 quote requests, ≤100 frames | 1 Monitor pass | Comfortable; inside `R` |
| 100 users × same 100 securities | identical to above | 100 Monitor passes (in-memory) | Comfortable; this is the design's best case |
| 100 users × different Strategies, same securities | one frame per security with the union of operands | 100 passes | Comfortable |
| 100 users × 100 distinct securities (U = 10,000) | 200 quote requests (~10 s at the gate) | 9,900 re-hydrations per cycle, ~1 GB of frames | Beyond the V1 boundary; cycles run back-to-back |
| 1 user, one huge List | as above for its U | 1 pass | Same wall; no per-List cap exists |
| Many active Signals | — | none: an unchanged match costs no write; the detail read is capped at 100 rows | Comfortable |

**Invariants.** Provider requests are `O(U)` per 6h plus `O(U / 50)` per cycle, never per Monitor.
Signal writes are `O(transitions)`, never `O(evaluations)`.

**Evidence.** `monitor-cycle.ts` (`operandsBySecurity`, `mapWithConcurrency`), `service.ts`
(`readDailyPriceProjection` miss → `ensureStockHydrated`, `loadTarget`), `cache.ts`
(`PUBLISH_READY` LRU trim), `monitor-frame.ts` (`monitorWindowObservations`), `fmp/client.ts`
(`FMP_QUOTE_MAX_SYMBOLS_PER_REQUEST`).

**Finding.** **Performance risk**, already named as an accepted V1 limitation in
`ai/architecture/monitor-engine.md`; now quantified. The cheapest mitigations, when it matters:
read the Monitor's price window straight from PostgreSQL the way the derived tail already is
(no Redis residency needed for a bounded window), or raise `R` for the worker process. A per-List
size cap is a separate product decision (investigation 11).

**Action.** None in code; numbers recorded here.
