# Benchmarks — method

This document says how every number in `PRODUCTION-READINESS-REPORT.md`, `architecture.md` and
`capacity-model.md` was produced, so each can be reproduced and none is mistaken for something it is
not. Results are in `benchmark-results.md`; raw reports (one JSON line per invocation) are in
`benchmark-results/`.

## What is real and what is synthetic

| Component       | In the benchmark                                                                                                                                  | Production equivalent                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Submission      | `BacktestsService.submitRun` — validation, entitlements, queue bound, immutable snapshot, one job                                                 | identical                                              |
| Execution       | real backtest worker processes (`apps/worker/dist/backtest/worker-process.js`), the supervisor's own child module                                 | identical (supervised)                                 |
| Admission       | `BACKTEST_GLOBAL_MAX_RUNNING=4`, owner-fair claim                                                                                                 | identical                                              |
| Stock cache     | Redis 7.0.15, `STOCK_LRU_MAX_SECURITIES=500`, canonical protected tier from PostgreSQL                                                            | identical (Redis 7.4 in production)                    |
| Database        | PostgreSQL 16.15, default `postgresql.conf` (`shared_buffers` 128 MB, `max_connections` 100)                                                      | tuned (`deploy/production/postgres/postgresql.conf`)   |
| Redis snapshots | `save 900 1 300 100000`, set for the backtest runs (the development default `60 10000` snapshots a multi-GB dataset every minute under LRU churn) | the same policy (`deploy/production/redis/redis.conf`) |
| Provider        | **synthetic** (`bench:synthetic-fmp`): deterministic data, FMP's shapes and 5,000-row paging, no quota; optional `--latency-ms`                   | FMP                                                    |
| Data            | **synthetic** 30+-year histories: daily bars from 1985, quarterly and annual statements, rule-based NYSE calendar, no splits                      | real histories (many shorter than 30 years)            |
| Machine         | the cloud development container: 4 vCPU Intel Xeon @ 2.10 GHz, 16 GB RAM, no swap, network block storage                                          | the reference host (`architecture.md`)                 |

Consequences, stated once and assumed everywhere:

- **Provider-miss timings measure FactorSage's own miss path** — request gate, client, normalization,
  PostgreSQL persistence, derived state, Redis publication — against a provider that answers in
  `--latency-ms` (0 unless stated). They are **not** FMP's latency, rate limit or quota behaviour.
  The real provider was sampled separately and only through the guarded live command (§4).
- **Synthetic histories are uniformly long.** Every synthetic security has a full 34-year retention
  window (30 product years + 4 warm-up), so per-security work and memory are the _worst case_; the
  real S&P 500 point-in-time universe averaged 0.74 MB per security in Redis against 1.05 MB here
  (`benchmark-results.md` §1).
- **The machine is smaller than production** and shares its disk and CPU with PostgreSQL, Redis, the
  synthetic provider and the measuring process. Every run records the machine; scaling to the
  reference host is done explicitly in `capacity-model.md`, never assumed.

## Isolation

Nothing touches development or test data:

- database `intrinsic_value_bench` (migrated by `prisma migrate deploy`), never `DATABASE_URL` or
  `TEST_DATABASE_URL` — `bench-environment.ts` refuses to start otherwise;
- Redis database 5 (`BENCH_REDIS_URL`), flushed only by an explicit `--cache cold`;
- the provider on `127.0.0.1:4790` with a synthetic key; every process the benchmark starts gets an
  environment with no `FMP_API_KEY`, `STRIPE_*` or test password inherited.

## The universe

`bench:scale-backtests setup --securities 4000 --protected 735` creates `SYN0001…SYN4000`:

- `SYN0001…SYN0735` — a canonical built-in universe (resolved `IndexConstituent` rows), the size of
  the S&P 500 point-in-time universe, routed to the protected tier from PostgreSQL;
- `SYN0736…SYN1735` — the **ordinary pool** (1,000), hydrated once, read through the LRU;
- `SYN1736…` — **fresh** securities, never hydrated, consumed by `--cache miss` runs.

The execution calendar (`SP500`) and the twenty market-overview ETFs come from the synthetic provider
through the product's own `benchmarks:prewarm --group market-overview`.

## Scenarios

| Scenario | Runs (plan × symbols)                                                            | Concurrency        |
| -------- | -------------------------------------------------------------------------------- | ------------------ |
| A        | Free × 10                                                                        | 1                  |
| B        | Starter × 50                                                                     | 1                  |
| C        | Pro × 250                                                                        | 1                  |
| D        | Pro × 500                                                                        | 1                  |
| E        | Pro × 750                                                                        | 1                  |
| F        | Pro+ × 1,000                                                                     | 1                  |
| G        | Pro+ × 1,000, twice, one user                                                    | 2                  |
| H        | Pro × 750, Pro × 750, Pro+ × 1,000, Pro+ × 1,000, four users                     | 4 (the global cap) |
| I        | Pro+ × 1,000, four times (two Pro+ users, both of their slots) — the sizing case | 4                  |

Every run is 30 years (one day inside the product's boundary), ending on the newest stored session.

- `--mix`: the share of protected members — `protected` 100 %, `mixed` 60 % (a list of mostly
  S&P 500 names plus others), `ordinary` 0 % (no S&P 500 name: the LRU's worst case).
- `--overlap`: concurrent runs' ordinary members are the same (`shared`) or distinct (`disjoint`,
  wrapping around the 1,000-security pool).
- `--cache`: `cold` flushes the isolated Redis database first (PostgreSQL → Redis rebuild — **not** a
  provider miss); `warm` flushes nothing; `miss` gives the ordinary members securities nothing has
  hydrated, so each is downloaded, normalized, persisted and projected.
- `--strategy`: `simple` (SMA 200 crossover), `monthly` (contributions, ten positions), `sector`
  (the Stock's Sector ETF beside the stock's technicals), `complex` (fundamentals — ROIC, debt to
  equity — an oscillator and a valuation).

## LRU contention

A backtest reads each of its securities once per calendar-year window. A security read while it is
not resident is rebuilt — its **whole** maintained history, ~34 years — from PostgreSQL into Redis and
admitted to the LRU, evicting the least recently used member. When a run's ordinary (non-protected)
securities, together with what concurrent runs and readers touch, outnumber the LRU's 500 slots,
the window loop reads them in the same order every year, which is the textbook worst case of an
LRU: each read evicts the security the next window will need first. `F-ordinary-*` measures it, and
the same run with `STOCK_LRU_MAX_SECURITIES=1100` (nothing evicted) is the reference result.

`BACKTEST_NON_RESIDENT_FRAME_READ=STORE` is the alternative measured beside it: a window reads a
non-resident LRU-tier security's rows for that window from PostgreSQL — the canonical rows the
projection is built from, under the same pinned price-basis generation — and admits nothing, as the
Monitor's end-of-day frames already do (`readFinalizedEvaluationFrame`). Results must be identical
(digests), which `daily-state-cache.integration.test.ts` also proves value by value.

## Timeouts

`--timeout-minutes` bounds an invocation. A run still executing at the deadline is cancelled through
`BacktestsService.cancelRun` (stale recovery closes it once its worker is gone, so no later
invocation executes it), and the report is still written, marked `timedOutRuns`, with every window
the run completed (`perRun[].windowLog`: year, frame-read milliseconds, PostgreSQL frame reads).

## Failure tests

`--chaos <kind> --chaos-at-s N` injects one fault N seconds after submission:

- `kill-worker` — SIGKILL of the worker process holding a claim, and a replacement worker 5 s later
  (what the supervisor does with a crashed child). Expected: the claim's lease (60 s) expires, stale
  recovery requeues the run with its attempt counted, another worker re-executes it from its first
  day, and the result is identical to an uninterrupted run.
- `redis-restart` — Redis stopped and restarted (`BENCH_REDIS_RESTART_COMMAND`, here
  `SHUTDOWN SAVE` and a restart from the snapshot).
- `redis-flush` — the benchmark's Redis database emptied: every projection, manifest, LRU and
  designation gone at once.

Each report records the fault's events, every run's attempts, status and digest, and the tier audit
afterwards shows whether anything was left behind (orphaned keys, LRU members without data,
protected keys with a TTL).

## What each report records

Per invocation: wall time, throughput, per-run queue wait, preparation, frame reads, compute,
persistence, execution and end-to-end (to the commit of the result), retries and failures; worker
CPU and RSS (per process and total), host CPU share, PostgreSQL server CPU, transactions, blocks,
inserted tuples, temp bytes, peak connections; Redis memory, hit rate, commands and bytes; LRU size
over time and evictions; the most executing and queued jobs observed (the admission cap); the
synthetic provider's request count by endpoint; every worker's event-loop delay (p99 and max, from a
benchmark-only `--require` probe); and a digest of every result — identical inputs must produce
identical digests whatever the cache state or concurrency.

## Interactive load

`load:interactive` (separate OS process) signs N users in through the real login route and loops
weighted journeys with 1–3 s think time: dashboard + market overview (20 %), Stock Details (20 %),
strategy builder (10 %), lists (10 %), backtest history (10 %), a run page polling progress every
2 s (10 %), results + trades (10 %), monitors (7 %), billing (3 %). Stock Details views are 80 % of
the canonical universe (resident in the protected tier) and 20 % of the long tail (read through the
LRU, so a cold one is rebuilt on the read) — an assumption, reported per tier. Percentiles cover the
steady state after the ramp, sign-ins excluded. It reports per-route p50/p95/p99, errors and
throughput; the API process's CPU, RSS and event-loop delay (from the same probe the workers carry);
and how many backtests were executing and queued throughout (sampled from the benchmark database). The API runs from its production build on
the benchmark environment with `RATE_LIMIT_ALLOWANCE_MULTIPLIER` raised so that one load generator
on one IP is not refused at sign-in — per-user limits stay exactly as configured.

## Reproducing

```bash
export BENCH_DATABASE_URL=postgresql://…/intrinsic_value_bench BENCH_REDIS_URL=redis://localhost:6379/5
pnpm --filter @intrinsic/database prisma:migrate:deploy   # with DATABASE_URL=$BENCH_DATABASE_URL
pnpm --filter @intrinsic/worker build
pnpm --filter @intrinsic/api bench:synthetic-fmp -- --universe 4000 &
pnpm --filter @intrinsic/api bench:scale-backtests -- setup --securities 4000 --protected 735
pnpm --filter @intrinsic/api bench:scale-backtests -- hydrate --from 1 --to 1735 --concurrency 8
pnpm --filter @intrinsic/api bench:scale-backtests -- run --scenario H --cache cold --mix mixed
pnpm --filter @intrinsic/api bench:scale-backtests -- run --scenario H --cache warm --mix mixed
pnpm --filter @intrinsic/api bench:scale-backtests -- audit
```

Interactive load, live admission probes and the capacity model:

```bash
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3101 pnpm --filter @intrinsic/web build
pnpm --filter @intrinsic/api build
pnpm --filter @intrinsic/api load:servers -- --api-port 3101 --web-port 3100 &   # API + next start
LOAD_TEST_PASSWORD=<throwaway> pnpm --filter @intrinsic/api load:interactive -- setup --users 100
LOAD_TEST_PASSWORD=<throwaway> pnpm --filter @intrinsic/api load:interactive -- run --users 50 \
  --duration-s 150 --ramp-s 20 --api-pid <pid> --api-log artifacts/load/api.log --sample-jobs true --label 50u
LOAD_TEST_PASSWORD=<throwaway> pnpm --filter @intrinsic/web exec tsx load-test/browser-journeys.ts --users 3 --rounds 2
LOAD_TEST_PASSWORD=<throwaway> pnpm --filter @intrinsic/api exec tsx src/load-test/submission-probes.ts --saturate 100
pnpm --filter @intrinsic/api exec tsx src/backtest-benchmark/capacity-model.ts   # capacity-model.md §3
```

The throwaway password exists only on the load generator's command line: the API, web server and
workers never receive it. The exact command of every reported number is in `benchmark-results.md`.
