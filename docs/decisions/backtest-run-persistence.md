# Backtest Run Persistence and Durable Work

## Status

**Accepted.** Implemented by migration `20260907195815_add_backtests_and_benchmarks`.

Realizes the recommendation in `ai/architecture/strategy-evaluation.md` §4.2–4.3 with one deliberate
divergence, recorded below. `ai/architecture/backtest-execution.md` describes the resulting system;
`ai/product/backtests.md` remains the product authority.

## Context

`AGENTS.md` invariant 5 says backtests are asynchronous long-running work, and nothing implemented
it: there was no job table, no queue library and no worker processor. Three questions had to be
answered together, because answering them separately produces a system that cannot be reasoned
about:

1. **What is the queue?** A backtest runs for minutes, must survive a worker crash, and belongs to a
   user who will come back to it tomorrow.
2. **What makes a completed run still true a year later,** when the Strategy has three more
   versions, the Stock List has different members, and the benchmark is sourced differently?
3. **Where does live progress live,** given that the running page polls about once a second while
   the simulation writes a checkpoint every few simulated trading days?

## Decision

### 1. The queue is a PostgreSQL table, created with the run

`BacktestJob` holds one row per `BacktestRun`, inserted in the **same transaction** as the run.
Workers claim with `SELECT … FOR UPDATE SKIP LOCKED`, hold a renewable `leaseExpiresAt`, and
ownership-guard every subsequent write on `claimedBy` plus `status = CLAIMED`. An expired lease
returns the job to `QUEUED` with a backoff; `attempts >= maxAttempts` makes it terminally `FAILED`.

Rejected alternatives:

- **BullMQ / any Redis queue.** Invariant 8 forbids Redis being the only store for user-owned state,
  so PostgreSQL would hold the run regardless and the two could disagree. A Redis flush would strand
  `QUEUED` runs and require a reconciler whose only job is to repair a split truth.
- **pg-boss / graphile-worker.** Both manage their own schema and migrations, against "one canonical
  Prisma schema, one migration history".
- **Claiming the `BacktestRun` row itself**, as §4.2 of the design recommended. This is the
  divergence. A separate job row keeps queue mechanics — `availableAt`, `attempts`, `claimedBy`,
  lease, backoff — off the durable, user-facing execution record, and makes "create durable work" a
  visible, testable act rather than a status value. The divergence's own argument against a separate
  store (two truths that can disagree) does not apply: both rows are in one database and are always
  written in one transaction, which is what the Redis alternative could not offer.

### 2. Reproducibility is a frozen document, not a join

`BacktestRun.snapshot` is written once and never updated. It carries strategy identity, version and
normalized definition; every resolved security with its normalized BUY windows; period, capital,
contribution; `maximumPositions` and the derived full-position fraction; the benchmark identity,
source kind, provider symbol and methodology version; every engine methodology version; and the
`PRICE_DATASET_VERSION` / `DERIVED_STATE_REVISION` in force at submission.
`snapshotHash` is a SHA-256 of the canonical document, so two runs that executed identical inputs
under identical methodology are recognizable as such.

`strategyId`, `strategyVersionId` and `stockListId` are **nullable, `onDelete: SetNull`**. Deleting
a strategy must not delete a user's backtest history, and no read path consults those rows — the
denormalized `strategyName`/`stockListName` columns and the snapshot render the run. `benchmarkId`
is `Restrict`: benchmarks are system-owned and are never product-deleted.

Recording the two data revisions does not make a re-execution reproducible: the derived state is
replaced, not versioned, when methodology changes. It makes a difference _explainable_ rather than
mysterious, which is the achievable goal.

### 3. Progress is a separate hot table; results are normalized

`BacktestRunProgress` (1:1) holds `percent`, `message`, `simulatedThrough`, a monotonic `sequence`
and the latest live `snapshot` JSON. It is separate from `BacktestRun` because it is rewritten every
few simulated trading days while the run row — carrying a large immutable document — is not. The
`sequence` counter lets a poller discard an out-of-order response without comparing clocks across
processes.

Results are normalized rather than one large payload: `BacktestDailyEquity` (one row per simulated
date), `BacktestTrade`, `BacktestPosition` and `BacktestRunSummary`. The API projects a bounded
curve and trade page from them. A JSON blob would have been simpler to write and worse to read: the
detail page wants a downsampled curve, the trade log wants a page, and neither wants to parse
several megabytes to get it.

The live snapshot is explicitly **not** the result. It is a bounded, downsampled projection of
in-flight state; the durable result is written when execution completes.

## Consequences

- A crashed worker is self-healing: the lease expires, another process reclaims, `attempts` bounds
  the retries, and a run can never sit in `RUNNING` forever.
- Two workers cannot claim one job, and two jobs can be claimed concurrently. Both are asserted in
  `apps/worker/src/backtest/job-repository.integration.test.ts` against real PostgreSQL.
- Editing or deleting a Strategy, a StockList or a benchmark's source never changes a stored run.
- A 30-year run stores roughly 7,500 equity rows and its trades. That is the price of rendering a
  completed run without replaying it, and it is small next to the market data the run consumed. It
  is also why the result write carries an explicit transaction timeout: Prisma's five-second default
  is exceeded once a long run's trade count reaches a few thousand, and the abort would roll back
  the whole result, making the longest runs the only ones unable to finish.
- A recovered or released job returns to the queue with its progress cleared, and both terminal
  statuses drop the live snapshot. Neither a queued run nor a failed one should present the numbers
  a dead attempt happened to reach.
- Adding cancellation later is additive: a `cancelRequestedAt` column, a `CANCELLED` status member,
  and a check at the existing checkpoint. V1 ships without it deliberately
  (`ai/architecture/backtest-execution.md`).

## Rejected

- **Storing the whole result as one JSON payload on the run.** Cheap to write, expensive to read,
  and it makes every future result query a full document parse.
- **Deriving a completed run's configuration from live foreign rows.** It is the single most likely
  way to make historical results quietly wrong, and it is exactly what invariant 12 now forbids.
- **A `CANCELLED` status with no cancellation path.** A status nothing can produce is a lie in a
  contract.
