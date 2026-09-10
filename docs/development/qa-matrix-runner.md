# The QA-MATRIX runner — executing the Backtest V1 validation matrix

Developer/QA-only. It executes all 1,000 deterministic combinations through the **real** Backtest V1
application and worker path and then validates the resulting financial state independently.

`qa-matrix-fixtures.md` documents the **inputs** — ten Strategies, ten Stock Lists, ten
configurations. This documents the machine that runs them.

```text
10 Strategies  ×  10 Stock Lists  ×  10 configurations  =  1,000 runs
                identified as  QA-MATRIX-Sxx-Lxx-Cxx
```

| Command                    | What it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `pnpm qa:matrix:provision` | creates and populates the dedicated matrix environment                |
| `pnpm qa:matrix:preflight` | reports whether the matrix may run; writes nothing                    |
| `pnpm qa:matrix:run`       | executes it                                                           |

It is **never part of `pnpm test`**. The suites that cover the runner itself run in milliseconds and
execute no backtests; the matrix is an explicit developer command.

## The environment

A thousand thirty-year backtests need decades of real canonical history, and none of the three
databases that already exist is the right place for it:

- the **development** database has that history — hydrated by the long-backtest and 34-year price
  retention work — and is exactly what must not be reset, mutated or filled with a thousand QA runs;
- the **test** database is deliberately lightweight and carries a short synthetic execution
  calendar. A "thirty-year" run against it silently becomes a six-year one, compared against
  invented history, with a first simulated date, return base and contribution schedule that are all
  different from the ones the configuration asked for. Nothing raises an error; the report says
  success. That is the failure mode this whole design exists to prevent;
- **production** is never a target of anything here.

So the matrix gets its own database, and it says so in its name:

```bash
QA_MATRIX_DATABASE_URL=postgresql://intrinsic:…@localhost:5432/intrinsic_value_matrix
QA_MATRIX_REDIS_DB=3
```

`resolveMatrixEnvironment` refuses, before any client exists: `NODE_ENV=production`; a URL equal to
`DATABASE_URL` or `TEST_DATABASE_URL`; a database whose name does not contain `matrix`; a non-local
host without `QA_MATRIX_ALLOW_REMOTE_HOST=true`; and a Redis connection that lands on the same
logical database the development stack uses. The QA seed guard accepts the matrix as a third
legitimate target — recorded with `INTRINSIC_QA_MATRIX_DATABASE_ACTIVE`, exactly as
`useTestDatabase` records the test database — because its own resolver has already made a stricter
set of checks.

### How the data gets there

`pnpm qa:matrix:provision` copies already-durable canonical market data out of the development
database. It is the point of the design: **no FMP request is made to provision the matrix, and none
should be made while it runs.**

```text
development database              →  intrinsic_value_matrix
  Security (whole catalog)             identity authority, so search and navigation behave normally
  SecurityProfile                      for the 33 matrix securities
  StockDatasetState / Coverage         the watermarks that stop the loader calling the provider
  FinancialStatement                   what the intrinsic-value strategies read
  DailyPrice / WeeklyPrice             34 years, four beyond the product horizon, per retention
  DailyDerivedState                    every moving average, oscillator and materialized IV
  Benchmark / Series / DailyPrice      the SP500 execution calendar and comparison series
```

The source is only ever read — every call is a `findMany` — so the development database is never
reset, migrated, truncated or written to. No user, strategy, list or previous run crosses over.
Inserts use `skipDuplicates`, so re-provisioning tops up what is missing and rewrites nothing.

`CREATE DATABASE … TEMPLATE` would have been one statement, but it requires that nothing else is
connected to the development database and carries its users, strategies and runs across with it.

Migrations are applied with the same `prisma migrate deploy` every other environment uses: one
migration history is a database rule, and a second way of applying it would be a second history in
all but name.

### Pinning the dataset

The matrix database is a copy, so its freshness watermarks are as old as the copy. Under the
ordinary six-hour freshness window the loader would decide the recent tail of every security is
stale and refresh thirty-three of them from FMP in the middle of a timed sweep. The matrix worker
therefore runs with `STOCK_RECENT_PRICE_FRESHNESS_MS` and `STOCK_FUNDAMENTALS_FRESHNESS_MS` set to
ten years.

That is configuration the product already exposes, and it decides whether to *ask* for a newer tail
— never how an existing bar is interpreted. Coverage gaps still reach the provider, which is why the
preflight proves there are none and the report counts every request that happens anyway.

## The preflight

Seventeen checks, all against the database the runs will execute in, all reported together rather
than short-circuited at the first failure. **Nothing is submitted if any of them fails**, and there
is no bypass flag.

| Check                     | What it refuses                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Database identity         | a connection that landed somewhere other than the configured matrix database           |
| Environment safety        | production, the development or test database, a shared Redis logical database          |
| Migrations                | a migration never applied, half-applied, rolled back, or applied but no longer present |
| QA fixture owner          | a database where the QA persona does not exist                                         |
| QA fixture Strategies     | not exactly ten, or one whose stored definition has drifted from the fixture           |
| QA fixture Stock Lists    | not exactly ten, or drifted membership or buy windows                                  |
| Backtest configurations   | not exactly ten, or one the real submission validator would reject                     |
| Cartesian product         | an enumeration that is not 1,000 unique combinations                                   |
| Fixture completeness      | a Strategy with no BUY level, a List with no members, a period that does not advance   |
| Product horizon           | a period outside `[today − 30y, today]`, which the loader would clip in silence        |
| Execution calendar        | a calendar that does not cover every configuration, or is not the one the fixtures were cut against |
| Comparison benchmark      | a benchmark whose history starts inside a run                                          |
| Missing symbols           | a list member with no catalog identity                                                 |
| Security price coverage   | a security whose prices begin after a run does — a later listing is *not* a gap        |
| Derived state coverage    | a security with no derived state, or fewer derived rows than price rows                |
| Fundamentals coverage     | no security at all can be valued (some missing is a warning, not a failure)            |
| Dataset revisions         | a stale price or derived-state variant the loader would rebuild mid-sweep              |

## Execution

```text
runner (this process)                     apps/worker (the real supervisor, N children)
---------------------                     --------------------------------------------
BacktestsService.submitRun  ── one transaction ──►  claim (FOR UPDATE SKIP LOCKED)
  BacktestRun + BacktestJob + Progress               PREPARING_DATA → RUNNING → FINALIZING
poll the persisted run                    ◄────────  COMPLETED | FAILED
read results from PostgreSQL
validate independently
```

Submission goes through the product's own `BacktestsService.submitRun`, resolved from the real
`BacktestsModule` in a real Nest application context, behind the real
`parseCreateBacktestRunRequest`. Execution is `apps/worker`'s own supervisor, spawned as a child
process with the matrix database and Redis in its environment — the same binary a deployment runs.

**Nothing in the runner imports `simulateBacktest`.** A run is created through the API path, claimed
by the real worker, executed there, and read back from PostgreSQL. That is the only arrangement in
which the validation below means anything.

### Concurrency

Concurrency is `BACKTEST_WORKER_PROCESSES` and nothing else: one backtest is never internally
parallelized, so throughput comes from independent processes taking different jobs. The runner keeps
at most that many cases in flight — submitted, executing and validated — rather than creating a
thousand `QUEUED` rows and letting the workers drain them.

The default is half the cores, capped at four and by roughly one process per 2 GB of RAM. The
binding constraint is memory: a child holds one calendar year of frames for up to thirty securities,
the run's whole trade sequence and equity curve until it persists them, plus a Prisma client and a
Node runtime — beside PostgreSQL, Redis and this process. Override with `--concurrency N` or
`QA_MATRIX_CONCURRENCY`.

### The warm-up

Before the timed sweep the runner executes a small covering set of combinations **serially**, then
discards their results. Its purpose is to move first-touch hydration out of the measurement.

That is not a micro-optimization. Against a freshly provisioned matrix database the Redis
projections are empty, so the first run to reach a security hydrates it — thirty-four years of
prices, derived state and statements, written year by year under a Redlock lease. With several
worker processes reaching overlapping universes at once, a lease can expire mid-hydration, a second
process legitimately takes over, and the first one's next write finds a manifest it no longer owns:
`Stock cache hydration generation changed`, reported as `EXECUTION_FAILED` in `PREPARING_DATA` on a
run with nothing wrong with it. One process cannot race itself. A warm sweep is also about three
times faster.

The covering set is chosen by greedy cover over the fixture lists, against the longest configuration
so every calendar-year chunk is warmed. It is skipped for a single-case reproduction, which cannot
race itself either, and by `--no-warmup`.

## Retention

Strategies and Stock Lists are persistent fixtures; their runs are not. Cleanup deletes runs
matching **both** halves of one narrow predicate:

- the QA persona's `userId` — another account's rows are never selected, not merely spared;
- the run's own denormalized `strategyName` **and** `stockListName`, both in the reserved
  `QA-MATRIX-` namespace.

Those two columns are the right key because they survive everything: a run's snapshot is immutable
and `strategyId` / `stockListId` are nulled when a fixture is deleted, so neither foreign key can
identify an old matrix run. Requiring both names means an ordinary backtest can never match — and
neither can a developer's own run that used a matrix Strategy against a personal list.

Cleanup runs **before** execution and never after, so a failed sweep stays inspectable until its
report is written.

## Validation

Every completed run is checked against forty invariants re-derived from **persisted evidence** —
the immutable snapshot, the trades, the daily equity curve, the final positions, the summary and the
pinned benchmark series. Nothing calls the engine: a validator that asked the same code the same
question would agree with every bug it exists to find.

Thirty-seven are settled from the database. Three cannot be, and say so rather than being asserted
from a weaker proxy:

| #  | Invariant                                   | Where it is settled                          |
| -- | ------------------------------------------- | -------------------------------------------- |
| 1  | run reaches `COMPLETED`                     | database                                     |
| 2  | no failure phase or failure metadata        | database                                     |
| 3  | canonical execution dates respected         | database, against the pinned calendar        |
| 4  | no duplicate equity dates                   | database                                     |
| 5  | equity dates ordered                        | database                                     |
| 6  | Strategy cash ≥ 0                           | database                                     |
| 7  | open positions ≤ `maximumPositions`         | database                                     |
| 8  | one symbol occupies at most one slot        | database, replayed per session               |
| 9  | `cash + positionsValue == totalValue`       | database                                     |
| 10 | `amount == shares × price`, zero fees       | database                                     |
| 11 | BUY only inside the buy window              | database, against the snapshot's windows     |
| 12 | SELL may occur outside the window           | database (reported, never enforced)          |
| 13 | FINAL EXIT may occur outside the window     | database (reported, never enforced)          |
| 14 | contribution dates match the schedule       | database, re-derived from the calendar       |
| 15 | `cashBaselineValue` = cumulative deposits   | database                                     |
| 16 | benchmark receives the same contributions   | database                                     |
| 17 | benchmark value reconciles from its closes  | database, rebuilt as a funded portfolio      |
| 18 | BUY sizing: target / shortfall / cash       | database                                     |
| 19 | strongest eligible BUY level                | database (one level per security per date)   |
| 20 | settled BUY levels follow lifecycle rules   | database                                     |
| 21 | contribution top-up only when eligible      | database                                     |
| 22 | no general rebalance                        | database                                     |
| 23 | SELL % of the shares remaining              | database                                     |
| 24 | SELL level fires once per lifecycle         | database                                     |
| 25 | FINAL EXIT closes the position              | database                                     |
| 26 | no same-date re-entry                       | database                                     |
| 27 | partial SELL then an eligible BUY           | database (reported, never enforced)          |
| 28 | average-cost basis reconciles               | database                                     |
| 29 | realized P&L reconciles                     | database                                     |
| 30 | unrealized P&L reconciles                   | database                                     |
| 31 | final positions match the last equity row   | database                                     |
| 32 | summary final value reconciles              | database                                     |
| 33 | invested capital reconciles                 | database                                     |
| 34 | trade counts reconcile                      | database                                     |
| 35 | position count reconciles                   | database                                     |
| 36 | every BUY's Signal was TRUE in the frame    | **forensic archive**, golden combinations    |
| 37 | Trigger `t − 1` across annual windows       | **forensic archive**, golden combinations    |
| 38 | buy-window boundary inclusion               | database + archive                           |
| 39 | no trading before listing / data            | database                                     |
| 40 | no warm-up date is simulated                | database                                     |

### Why 36 and 37 need the archive

A result says *what* the engine did. Whether it was entitled to depends on what it saw, and the
evaluation frames the day loop consumed are released at the end of each calendar-year window; the
row retained across a boundary for `t − 1` is persisted nowhere at all.

`BACKTEST_DEBUG_ARCHIVE=full` writes exactly those frames — and it is a **worker-process** setting,
so a pool either archives every attempt it executes or none. There is deliberately no per-run
switch: the archive has no API field and no snapshot flag, and adding one would make it a product
feature by accident.

That constraint decides the design, and the first implementation got it wrong: `--archive` on the
full matrix set the flag on the only pool there was, and the sweep wrote **1,006 archives, 567 MB**,
where six were intended. The fix is a second pool rather than a filter:

| Invocation | Sweep pool | Determinism-rerun pool | Archives |
| --- | --- | --- | --- |
| `pnpm qa:matrix:run --archive` | off | **full** | **6** |
| `--golden --archive` | **full** | off | 6 |
| `--case S03-L07-C04 --archive` | **full** | off | 1 |
| `--archive --no-determinism` | off | off | 0 — rerun with `--golden --archive` |
| no `--archive` | off | off | 0 |

The golden combinations are re-executed for the determinism check anyway, so capturing them there
costs one extra short-lived pool instead of 994 extra zips. `planMatrixArchives` is a pure function
and `matrix-archive-plan.test.ts` holds the property directly — 1,000 + 6 executions produce six
archives — without running a backtest.

Verification re-derives each BUY Signal from the frame columns using the product grammar in
`ai/product/strategies.md`. It does not import the evaluator.

The scope is BUY levels, and that boundary is the product's own: a BUY Signal may not contain a
position-dependent metric, so a BUY is decidable from market data alone. SELL and FINAL EXIT signals
may compare `Gain` or `Loss`, which need simulated position state, and are left out rather than
approximated.

### Exactness, and the one place it ends

Almost every check here is an **equality**, because the engine's ledger is exact. Money is
`numeric(24,6)`, shares are `Decimal(28,10)`, prices `Decimal(20,8)`, and every value the engine
persists is quantized once at its own declared scale from operands that are themselves persisted.
So the daily identity, the cash ledger, the canonical trade amount, the sell fraction, the
average-cost basis, realized and unrealized profit and loss, the final positions, the summary's
closing figures, the funding schedule and the funded benchmark are all compared with `.eq()`. A
difference of `0.000001` is a difference.

That matters because the alternative was measured. The tolerances this replaced allowed **$909.17**
across the matrix's 181,831 trades, **$33,431.07** of invested capital on the largest run, **$25.95**
of realized profit and loss on a 2.59-billion-share position, and — at the one-dollar contract
minimum — an average cost of **$178** for a stock that closed at **$148.84**. Each was derived
honestly from `Decimal(20,2)` and from a reconstruction (`sharesBefore × averageCostBefore`,
`shares × (price − basis)`) that the Decimal ledger no longer computes that way.

**Invariant 18 is the single exception**, and it is exact about why. The engine's *sizing* decision
is deliberately float — it chooses a target, nothing is reconciled against it — so `portfolioValue`
is `toNumber(cash) + toNumber(positionsValue)`, and that conversion is lossy at the magnitudes this
matrix reaches. Its budget is the sum of four derived terms: 1.5 money units per trade on the date
(the recorded total is a proxy for the value actually sized against), 2⁻⁵³ × magnitude × 8 for the
float64 path, half a money unit for quantizing the shortfall, and `price × 10⁻¹⁰` for truncating
the shares down. At the largest run in the matrix that is about five hundredths of a cent.

No tolerance in this validator is relative to portfolio size.

## Determinism

After the sweep, the golden combinations are re-executed from the same canonical data and compared:
trades, equity, final positions and summary must be identical. Run ids, worker assignment and
timings are not compared — they are legitimately different every time, and flagging them would train
a reader to ignore the check.

## Output

```text
.debug/qa-matrix/<matrixExecutionId>/
  manifest.json    clock, database, revisions, methodology, concurrency, selection, git commit
  preflight.json   the gate that had to be green, and preflight.txt beside it
  cases.ndjson     one flat line per combination, appended as it settles
  failures/        one document per failing combination, with its invariant violations
  summary.json     the aggregate
  report.md        the page a reviewer reads
  worker.log       the worker's own structured stream
  archives/        forensic .zip per archived attempt
```

`matrixExecutionId` is `<asOfDate>-<timestamp>`. It is a **developer concept and not a product
entity**: no table, no column, no migration and no API field. Runs are identified by the
`QA-MATRIX-` namespace they already carry.

`cases.ndjson` is appended as each case settles rather than written at the end, so a sweep that dies
in its ninth hour still leaves behind what it learned.

Per combination the report carries `Sxx-Lxx-Cxx`, the persisted run id, Strategy, List,
configuration, status, duration, trade count, equity row count, final value, invariant pass/fail
counts, provider request count and failure detail. In aggregate: expected, submitted, completed,
failed, invariant failures, duration, throughput, slowest cases, zero-trade cases, highest-trade
cases, provider requests and any data-coverage warnings.

**A strategy producing zero trades is not a failure.** `S06` is a deliberately sparse confluence
strategy and `C03`/`C04` are short periods; a run with nothing to do is the expected outcome, and
reporting it as red would train a reader to ignore red.

### Provider requests

Counted from the worker's own structured log. `stock-data.provider.request` is emitted at `debug`
for every FMP request and carries the worker id; `backtest.claimed` and the terminal events carry
the run id. A worker child executes at most one backtest at a time, which is what makes associating
the two an attribution rather than a guess.

The expectation is **zero**. Any request means a coverage gap the preflight did not see, and it
makes the affected runs dependent on live data.

## The matrix clock is a parameter, and it ages

`QA_MATRIX_AS_OF_DATE` pins the clock so a sweep is reproducible from one value. It does **not**
pin the product horizon: `CanonicalStockDataService.projectionRange` clips every projection to
`[today - STOCK_HISTORY_YEARS, today]` from the real clock, silently.

So a pin that has aged is not merely stale, it is wrong in a way nothing announces. A sweep pinned
to `2026-09-09` and executed on `2026-09-10` loaded 7,546 execution dates instead of 7,547, and the
date it lost was the first simulated date of the run — the boundary the three thirty-year
configurations exist to exercise. Every thirty-year run in that sweep was a session short.

The preflight now refuses it, names the configurations, and says which clock to use. **Re-seed and
run with the same clock**, and prefer today's date unless you are deliberately reproducing an
earlier sweep:

```bash
QA_MATRIX_AS_OF_DATE=$(date +%F) pnpm qa:matrix:provision
QA_MATRIX_AS_OF_DATE=$(date +%F) pnpm qa:matrix:preflight
QA_MATRIX_AS_OF_DATE=$(date +%F) pnpm qa:matrix:run --concurrency 3 --archive
```

## Running it

```bash
pnpm infra:up
pnpm qa:matrix:provision                    # once; idempotent
pnpm qa:matrix:preflight                    # must be green
pnpm qa:matrix:run                          # all 1,000

pnpm qa:matrix:run --case S03-L07-C04       # reproduce exactly one
pnpm qa:matrix:run --golden --archive       # the golden set, with forensic capture
pnpm qa:matrix:run --concurrency 2          # override the machine-derived default
QA_MATRIX_AS_OF_DATE=2026-09-09 pnpm qa:matrix:run    # pin the clock for a reproducible sweep
```

| Flag                | Effect                                                              |
| ------------------- | ------------------------------------------------------------------- |
| `--case <ids>`      | run only these, comma-separated; unknown ids are an error           |
| `--golden`          | run only the golden combinations                                     |
| `--archive`         | capture forensic archives and verify invariants 36–38 from them      |
| `--concurrency <n>` | worker processes, 1–32                                               |
| `--timeout <s>`     | per-run terminal-status deadline, default 2,700 s                    |
| `--no-warmup`       | skip the serial warm-up                                              |
| `--no-cleanup`      | keep the previous sweep's runs                                       |
| `--no-determinism`  | skip the golden re-execution                                         |

The command exits non-zero when anything failed, so it is usable as a gate.

## When the matrix finds something

If a combination fails, it is preserved and reproducible on its own:

```bash
QA_MATRIX_AS_OF_DATE=<the sweep's clock> pnpm qa:matrix:run --case S04-L09-C06 --archive
```

That re-executes exactly those `Sxx-Lxx-Cxx` inputs with forensic capture on. A runner bug is
reported as `RUNNER_ERROR` and never as an engine defect; an engine or data defect is diagnosed
separately, and financial semantics are never changed to make a matrix case pass.

## Files

```text
apps/api/src/qa-matrix/matrix-environment.ts        where the matrix may point, and where it may not
apps/api/src/qa-matrix/provision-matrix-database.ts create, migrate, copy canonical data
apps/api/src/qa-matrix/matrix-preflight.ts          the seventeen checks
apps/api/src/qa-matrix/matrix-case.ts               identity, enumeration, golden and warm-up sets
apps/api/src/qa-matrix/matrix-cleanup.ts            the retention predicate
apps/api/src/qa-matrix/matrix-concurrency.ts        how many runs at once, and why
apps/api/src/qa-matrix/matrix-execution.ts          real Nest submission, polling, evidence
apps/api/src/qa-matrix/matrix-worker-pool.ts        the real worker supervisor + provider metering
apps/api/src/qa-matrix/matrix-invariants.ts         the thirty-seven database invariants
apps/api/src/qa-matrix/matrix-archive.ts            invariants 36-38 from the forensic archive
apps/api/src/qa-matrix/matrix-runner.ts             bounded concurrency, aggregation, determinism
apps/api/src/qa-matrix/matrix-report.ts             manifest, NDJSON, failures, summary, report
apps/api/src/qa-matrix-{provision,preflight,run}.ts the three commands
```

Tests sit beside them and execute no backtests.
