# Backtest Execution — Architecture

How a Backtest V1 run is submitted, queued, claimed, executed and read.

`ai/product/backtests.md` is the product decision this implements and `ai/product/strategies.md` owns
signal semantics; neither is restated here.
`ai/architecture/strategy-evaluation.md` is the design this is built from — where the two differ,
this document describes what was actually built and says so.

## Shape

```text
apps/api                                     apps/worker (N processes)
--------                                     -------------------------
validate + authorize
resolve StrategyVersion (immutable)
resolve StockList -> securities + BUY windows
freeze BacktestRunSnapshot
INSERT BacktestRun (QUEUED)
INSERT BacktestJob  (QUEUED)   ─── one transaction ───►  claim (FOR UPDATE SKIP LOCKED)
INSERT BacktestRunProgress                               PREPARING_DATA: frames + benchmark
                                                         RUNNING:        day loop + checkpoints
                                                         FINALIZING:     persist results
expose run / progress / result  ◄────────────────────────  COMPLETED | FAILED
```

Both processes call the same `@intrinsic/strategy` and `@intrinsic/stock-data`. They are separate
processes, never separate business implementations.

## Packages

| Package                 | Owns                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@intrinsic/contracts`  | the wire contract, and the `BacktestRunSnapshot` document both processes read                                                                                |
| `@intrinsic/strategy`   | **new, pure.** Tri-state evaluation, market gates, position state, cost basis, the day loop, return/drawdown/alpha mathematics, and the methodology versions |
| `@intrinsic/stock-data` | the `EvaluationFrame` projection and all benchmark loading — everything infrastructure-aware                                                                 |
| `apps/api`              | validation, authorization, the snapshot, durable work, the read surface                                                                                      |
| `apps/worker`           | claiming, execution, progress, results, failures                                                                                                             |

`@intrinsic/strategy` depends only on `contracts` and `domain`: no database, no HTTP, no
`process.env`, no clock. That is what lets a future monitor evaluate the same Strategy semantics
against current data without a second language.

## Evaluation frames

`CanonicalStockDataService.getDailyEvaluationFrame(security, period, operands)` projects one
security into columns:

```text
EvaluationFrame {
  securityId, symbol, name
  dates:   LocalDate[]        ascending, this security's own eligible trading days
  closes:  Float64Array       the canonical end-of-day close
  columns: Map<OperandKey, Float64Array>    NaN = absent, never zero
  periodStartIndex            first index inside the requested period
}
```

- **Only the operands the strategy version references are materialized.** `collectOperands` reads
  them off the definition. A strategy naming five operands over thirty years costs about 300 KB per
  security; carrying raw `DailyDerivedState` rows would cost a thousand times more.
- **The intrinsic provenance gate is applied during projection**, inside `@intrinsic/stock-data`,
  because that package owns `intrinsicModelSourceAsOf` / `blendSourceDataAsOf`. The pure evaluator
  therefore cannot read an ungated value even by mistake.
- **Margin of Safety is materialized as its own column**, so `(iv - close) / iv * 100`, the
  `iv > 0` rule and the provenance gate are applied exactly once.
- The frame starts `TRIGGER_CONTEXT_CALENDAR_DAYS` (10) before the period so a Trigger has its
  `t - 1` value on the first simulated day. Those rows are already resident: the load target is
  widened by the derived-series warm-up regardless.
- `NaN` is the only representation of an absent value. `RSI = 0` and `MOS = 0` are real readings.

## Gates and the day loop

BUY signals contain no position-dependent metric (the product forbids Gain/Loss in BUY rules), so
every BUY level is precomputed into a `Uint8Array` gate before the simulation starts and the day
loop reads an indexed byte. SELL and FINAL EXIT gates carry only their market-derived half and are
ANDed with live position predicates while a position is open.

The portfolio's date axis is the **union** of the eligible trading dates of the securities in the
run **and of the benchmark**, restricted to the period (`CALENDAR_METHODOLOGY_VERSION`). Predicates
are never carried forward — a security with no row that day simply takes no action — while
_valuation_ is carried forward at the position's most recent close, which is the only
point-in-time-correct value available.

The benchmark is in the union because a portfolio exists from the first day of the requested period
even while it holds nothing but cash. Without it, a run whose securities all list after its start
would not exist until the first of them began trading, and its curve would appear to start at the
first BUY rather than flat at 0% from the beginning. The benchmark is the market's own calendar for
exactly this period and is loaded anyway, so it costs nothing and invents nothing: on a
benchmark-only date no security has a row, so every predicate is `NOT_EVALUABLE`, valuation carries
forward, and the portfolio still has a real value because cash is real. A run whose benchmark has no
data of its own falls back to the securities' union unchanged.

This is versioned methodology rather than an implementation detail because it decides which date is
"the first simulated date of a month" — and therefore when a contribution lands — and which date the
return index is based at.

A security whose history **ends** before the period does the same thing in reverse: its rows simply
stop, no predicate is evaluable after that, and an open position is carried at its last real close
for the rest of the run. That is not a delisting model. See the open methodology question in
`../product/backtests.md`.

For each date, in this fixed order:

1. **Cash in** — the monthly contribution, when this is the month's first simulated trading day.
2. **Value** — mark every holding at its most recent close.
3. **Exits** — per open position, in symbol order: FINAL EXIT first, then SELL levels in definition
   order.
4. **Entries** — read the precomputed BUY gate for every security whose buy window admits the date.
   A level that has already fired is skipped unless today deposited a contribution.
5. **Allocate** — order the candidates, then size them against a portfolio value fixed once for the
   whole date, enforcing cash and the position-slot cap.
6. **Record** — the position metric that actually held today (for tomorrow's Trigger) and the day's
   equity point.

## Execution methodology — the V1 rules

`ai/product/strategies.md` deliberately leaves several execution behaviours open. They are engine
methodology, decided here, versioned in `@intrinsic/strategy/backtest/methodology.ts`, and copied
into every run snapshot so a later change cannot reinterpret an old run.

| Rule                      | V1 decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution price           | the canonical end-of-day close of the signal date                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Fees / slippage           | **zero**, `zero-fees/zero-slippage@1`. No editable UI field exists. They enter through the existing `fees` seam on the cost-basis policy when they are introduced                                                                                                                                                                                                                                                                                                                                                                      |
| Share quantity            | continuous (fractional). A 2.5% target in an expensive stock must not silently round to zero shares                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Exits vs entries          | exits first, so a freed slot and the cash a sale releases are usable the same date                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| BUY level percentage      | a **target fill** of the full-position budget, not an increment. `target = portfolioValue(d) × (1 / maximumPositions) × levelPercentage`                                                                                                                                                                                                                                                                                                                                                                                               |
| Repeated BUY levels       | each BUY level fires **at most once per position lifecycle**, with the one exception below. A later, higher level tops the position up toward its target; a level already satisfied is marked fired without a trade                                                                                                                                                                                                                                                                                                                    |
| Contribution top-up (DCA) | on a date that **actually deposits** a monthly contribution, an already-fired BUY level is reconsidered against the post-contribution portfolio value and buys **only the shortfall** to its recalculated target. It requires the position still open, the level's whole Signal — Trigger included — TRUE on that date, the buy window open, and cash available. It is **not** a rebalance: a position that merely drifted below target on an ordinary day is left alone, and the top-up does not repeat on the days after the deposit |
| Position slots            | an open symbol occupies one slot at any fill. A candidate with no free slot is skipped **without** being marked fired, so it can still enter on a later date                                                                                                                                                                                                                                                                                                                                                                           |
| Insufficient cash         | the candidate fills with whatever cash remains and the level is marked fired; zero available cash leaves the level unfired                                                                                                                                                                                                                                                                                                                                                                                                             |
| SELL level percentage     | a fraction of the position **remaining at execution time**                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Repeated SELL levels      | each SELL level fires at most once per position lifecycle; several matching levels execute in definition order on the same date                                                                                                                                                                                                                                                                                                                                                                                                        |
| FINAL EXIT                | outranks a matching partial SELL on the same date and closes the whole remaining position                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Same-date re-entry        | forbidden. A security whose position closed today cannot open a new one until the next eligible date: selling and rebuying at one close is an economic no-op that would fabricate two trades and reset the position's level state                                                                                                                                                                                                                                                                                                      |
| Cost basis                | `AVERAGE_COST`. A partial sell reduces shares and cost proportionally, so basis per share is unchanged and `Gain` keeps describing the same position                                                                                                                                                                                                                                                                                                                                                                                   |
| Position epoch            | incremented on every open. A Trigger can never straddle a closed-and-reopened position, and the previous metric value is the one that _actually held_, recorded when it was computed                                                                                                                                                                                                                                                                                                                                                   |
| Candidate ordering        | `top-ups-first/percentage-desc/symbol-asc@1`: top-ups (no new slot needed) before new entries, then descending level percentage, then ascending symbol, then ascending security id                                                                                                                                                                                                                                                                                                                                                     |
| Monthly contribution      | `first-eligible-trading-day-of-month@1`: the run's first simulated date is funded by the initial capital and receives no contribution on top of it; from the next calendar month onwards the contribution lands on that month's first simulated trading date, before the day's trading, so it is spendable that same date. A calendar month with no simulated trading date receives none, and nothing is carried forward                                                                                                               |
| BUY windows               | a window gates every BUY in that stock, opening or topping up. Selling is never restricted                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Returns, benchmark and alpha

`time-weighted-index@1`. Both curves are growth indices based at 1.0 on the first simulated date, so
the UI compares percentage growth from the same starting point.

- Portfolio: `index(d) = index(d-1) × value(d) / (value(d-1) + contribution(d))`. Contributions
  arrive before the day's trading, so a deposit raises portfolio value without inventing return.
  With no contributions this is exactly `value(d) / initialCapital`.
- Benchmark: its close on `d` — or the most recent close at or before `d` — divided by the close in
  effect on the first simulated date. A date before the benchmark's first available close reports
  `null`; nothing is fabricated.
- `alpha = portfolioReturnPercent - benchmarkReturnPercent`. It is a comparison, not a regression
  estimate.
- Max drawdown is measured on the growth index, so a contribution cannot mask a drawdown.

The benchmark never joins the union calendar, never consumes cash and never occupies a position
slot. It also never shortens the run: unlike the legacy implementation, the requested period is not
clamped to the benchmark's last available date.

## Durable work

The queue is a PostgreSQL table, not a library. `BacktestJob` holds one row per run, created in the
same transaction as the run, so the queue and the execution record cannot disagree, a Redis flush is
harmless, and an expired lease self-heals.

```text
BacktestJob   QUEUED -> CLAIMED -> COMPLETED | FAILED
BacktestRun   QUEUED -> PREPARING_DATA -> RUNNING -> FINALIZING -> COMPLETED | FAILED
```

- **Claiming** is `SELECT … FOR UPDATE SKIP LOCKED` over `BacktestJob`, which is what makes two
  workers claiming simultaneously take disjoint jobs.
- **A lease** (`leaseExpiresAt`) is renewed on the checkpoint cadence. Every progress and result
  write is ownership-guarded on `claimedBy` plus `status = CLAIMED`, so a worker that lost its lease
  cannot corrupt a run another worker has taken over.
- **Stale recovery** returns a job whose lease expired to `QUEUED` with a backoff and increments
  `attempts`; a job that has exhausted `maxAttempts` becomes terminal `FAILED` with
  `failureCode = ABANDONED`. A terminal job is never reclaimed. A crashed worker therefore never
  strands a run in `RUNNING` forever.
  The abandon sweep also covers a job left `QUEUED` with no attempt remaining. A graceful shutdown
  releases its claim without refunding the attempt — that is what bounds a restart loop — so such a
  job would otherwise match neither the claim query (`attempts < maxAttempts`) nor lease recovery
  (which requires `CLAIMED`), and would sit queued forever with nothing able to move it.
- **Requeueing clears the dead attempt's progress** in the same statement. The next attempt
  re-simulates from the first day, so a queued run must not keep advertising 94% and a live curve
  that no process is producing.
- **The result write has its own transaction budget.** Prisma's default interactive-transaction
  timeout is five seconds, which a long run exceeds: a thirty-year backtest writes roughly 7,500
  equity rows plus its trades, and past a few thousand trades that pair passes five seconds.
  Exceeding it aborts with P2028 and rolls the whole result back, so the longest runs would be
  exactly the ones that could never finish. `persistResult` therefore sets an explicit, generous
  timeout — it runs once per run, and a slow disk must not decide whether a completed simulation is
  allowed to be recorded.

Why not BullMQ or pg-boss: Redis must never be the only store for user-owned state, so PostgreSQL
would hold the run anyway and the two could diverge; pg-boss brings its own schema and migration
history against the one-schema rule. Neither earns a dependency here.

## Worker processes

`apps/worker` is a **supervisor** that forks `BACKTEST_WORKER_PROCESSES` children. Each child claims
at most one backtest at a time.

**One backtest is never internally parallelized.** The simulation is strictly sequential in time and
stays single-process, which is what keeps it deterministic. Parallelism comes from independent OS
processes taking _different_ jobs: two queued backtests can occupy two cores; one backtest cannot
occupy two. Frame loading inside a run uses bounded concurrency for I/O only, throttled further by
the shared FMP gate so a large backtest cannot starve Stock Details.

`BACKTEST_WORKER_PROCESSES` defaults to 2 — a conservative local value. Set it to 1 for a
single-process environment; scale it with cores where several users run backtests concurrently.

## Progress and live results

| Phase            | Percent | Meaning                                                |
| ---------------- | ------- | ------------------------------------------------------ |
| `QUEUED`         | 0       | durable work waiting for a worker                      |
| `PREPARING_DATA` | 2 → 20  | hydration and frame projection, advancing per security |
| `RUNNING`        | 20 → 95 | the day loop, advancing with simulated trading days    |
| `FINALIZING`     | 95 → 99 | persisting results                                     |
| `COMPLETED`      | 100     | **only** a successful completion reaches 100           |
| `FAILED`         | —       | terminal, with a sanitized reason                      |

The legacy 45/54 split is not product semantics and is not reproduced.

A checkpoint persists a bounded live snapshot to `BacktestRunProgress`: simulated-through date,
portfolio and benchmark curves, current value, cash, returns, alpha, max drawdown, holdings, trade
count and recent trades. Cadence is every 5 simulated trading days **and** the first simulated day
**and** the last simulated day of every calendar year, throttled so no more than one write lands per
`BACKTEST_CHECKPOINT_MIN_INTERVAL_MS`. The curve is downsampled by the engine, so the payload is the
same size for a one-year run and a thirty-year one.

**A year boundary is exempt from the throttle.** The cadence checkpoint is a sample — dropping one
loses nothing, because the next carries the same kind of state a moment later. A year boundary is
not: it is the one checkpoint that becomes a durable milestone, and a fast machine simulating
several years inside one throttle window would silently lose years from the run's recorded
progression. So the engine marks that checkpoint with the year it completes and the worker lets it
through, while every unmarked checkpoint stays throttled. Nothing sleeps and nothing is slowed to
make progress observable; the run simply reports every year it actually finished.

`BacktestRunMilestone` is that durable record: `(runId, sequence)` with `(runId, year)` unique,
carrying only scalars — the year, its simulated-through date, percent, value, cash, returns, alpha,
drawdown, trade and position counts. **It never carries a curve.** A thirty-year run therefore adds
thirty rows of roughly a hundred bytes each, not thirty copies of a daily series, and the table is
bounded by the run's own length rather than by how often it checkpoints. Milestones are append-only
within an attempt and are deleted with the attempt when a run is requeued or handed back, because a
retry re-simulates from the first day and would otherwise replay years the user already saw.

Checkpoints are pure observation: the day loop never reads them back, so neither the cadence nor the
milestones can change a result. `packages/strategy/src/backtest/simulate.test.ts` asserts exactly
that.

The live snapshot is **not** the result. Results are persisted in `BacktestRunSummary`,
`BacktestDailyEquity`, `BacktestTrade` and `BacktestPosition` when execution completes.

**Both terminal statuses drop it.** A `COMPLETED` run reports its durable result instead; a `FAILED`
run reports its reason. The partial curve, metrics, holdings and trades a dead attempt happened to
reach are not that run's outcome, and presenting them beside a failure would read as one.

## Reproducibility

`BacktestRun.snapshot` is written once and never updated. It carries the strategy identity, version
and normalized definition; every resolved security with its normalized BUY windows; the period;
capital and contribution; `maximumPositions` and the derived full-position fraction; the benchmark
identity, source kind, provider symbol and methodology version; every engine methodology version;
and the `PRICE_DATASET_VERSION` / `DERIVED_STATE_REVISION` in force at submission.

The `strategyId`, `strategyVersionId` and `stockListId` foreign keys are nullable and
`onDelete: SetNull` **on purpose**: deleting a strategy or a list must never delete or reinterpret a
completed run, and no read path depends on those rows.

Recording the data revisions does not make a re-execution reproducible — the derived state is
replaced, not versioned, on a methodology bump. It makes the difference explainable instead of
mysterious.

## Failure

A failed run is terminal, keeps a stable `failureCode` and a sanitized `failureMessage`, and keeps
developer diagnostics in `failureDetail`, which **no API contract exposes**. Provider names, URLs,
credentials and stack traces never cross the HTTP boundary.

It also keeps `failurePhase` — `PREPARING_DATA`, `RUNNING` or `FINALIZING` — as a column rather than
a field of `failureDetail`, precisely because it _is_ safe to show. The user-facing failure view
renders the phase, the failure code and the run id, so a report is actionable without a developer
reading logs first. The API validates the stored phase against the contract before returning it: a
value the browser cannot label is reported as no phase rather than passed through.

Where a specific security is legitimately the cause, the sanitized message names the symbols that
produced no usable data, capped at five plus a count. Symbols are the user's own list, so naming
them leaks nothing and is the difference between "try again" and "check these two stocks".

Structured events, all carrying `runId` and `component: backtest`:
`backtest.queued`, `backtest.claimed`, `backtest.started`, `backtest.frames.loaded`,
`backtest.progress` (debug), `backtest.completed`, `backtest.failed`, `backtest.job.recovered`.
There is deliberately no per-day logging.

`backtest.failed` carries `runId`, `jobId`, `workerId`, `attempt`, `failureCode`, `phase`,
`durationMs`, the sanitized `failureContext` when there is one, and `err` — the original `Error`,
serialized by `@intrinsic/observability` with its name, message and stack. The translation into
product prose happens after that log, so nothing about the real cause is lost.

## Cancellation — deferred

V1 has no cancel. The claim/lease machinery would support it cheaply — the worker already re-reads
the job row on every checkpoint — but a usable cancellation is an API endpoint, an authorization
rule, a terminal `CANCELLED` status through the contract and the UI, and its own tests, and a
half-built one is worse than none. A run that must be stopped today is stopped by its worker
exiting; the lease then expires and `maxAttempts` bounds the retries. Adding cancellation later is
additive: a `cancelRequestedAt` column, a status member, and a check at the existing checkpoint.

## Performance

- One hydration per security per run, then all reads come from the projection.
- Frames are loaded with bounded concurrency; hydration is serialized per security by the existing
  Redis lock and throttled across processes by the shared FMP gate.
- The day loop holds resident frames and gates; nothing re-queries the database per date.
- The first run after a `DERIVED_STATE_REVISION` bump rebuilds every security in its list and is
  visibly slower. `backtest.frames.loaded` carries `durationMs` and the security count.
- Submission rejects a universe larger than `BACKTEST_MAX_SECURITIES`: failing fast at submission
  is far better than an OS-killed worker twenty minutes in.
- Per-run persistence is bounded by the run, not by its duration: one replaceable progress row, one
  milestone row per completed year, and the durable result. There is no append-only event log.
- Bulk writes that materialize a long history — daily prices, derived state, financial statements —
  run under an explicit 120 s transaction timeout. Prisma's 5 s default is sized for request-shaped
  work, and a backtest is the first caller to write thirty years of derived state in one
  transaction; exceeding it aborts with `P2028` after the work is already done.
