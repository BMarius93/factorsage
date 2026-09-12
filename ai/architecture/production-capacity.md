# Production capacity

What the current architecture does under realistic load, measured on the production code path
rather than reasoned about. Read `deep-discovery.md` first for the semantics this document takes
as given (what a cycle evaluates, what is shared, what Redis holds). This document answers: what
does it cost, where does it stop being cheap, and what should an operator watch.

**Every number here was measured on one developer machine.** Treat them as ratios and shapes, not
as production values. Re-run the benchmark in the target environment before relying on an absolute.

## Environment and methodology

| Item | Value |
| --- | --- |
| Machine | Apple M1, 8 cores, 8 GB, macOS 24.6 |
| Node | 22.23.2 |
| PostgreSQL | 16.15 (Docker Desktop VM: 4 CPUs, 4 GB, `shared_buffers` 128 MB) |
| Redis | 7.4.11 (same VM) |
| Date | 2026-09-11 |
| Harness | `pnpm --filter @intrinsic/worker bench:monitor -- --scenario=<name>` (`apps/worker/src/monitor/capacity-bench.ts`) |

The harness drives the real `MonitorCycle`, `PrismaMonitorRepository`, `CanonicalStockDataService`,
`RedisStockDataCache`, `RedlockLoadCoordinator` and `CachedTradingCalendar` against the dedicated
test database and a namespaced Redis key space. Exactly one boundary is replaced: the provider is
a synthetic, deterministic, counting stub (twelve years of weekday bars per symbol, a live quote
per symbol, a real holiday schedule, a profile, empty statements). `productHistoryYears` is 8
(retention 12), so one security's history is ~3,100 daily rows instead of production's ~8,500;
scale per-security storage and hydration numbers by ~2.7 for a 30-year deployment.

Per cycle the harness records wall time, process CPU time (Node plus the Prisma engine threads),
`pg_stat_database` deltas (after forcing every pooled backend to flush), Prisma query counts,
Redis `INFO commandstats` and byte deltas, provider requests by endpoint, the time spent in each
loader and repository method, and RSS/heap peaks sampled every 20 ms. The synthetic quote moves
±2 % each cycle, so transition rates are far higher than a real market's; treat `applyTransition`
costs as an upper bound.

## Workload model

| Scenario | Users | Monitors | Unique securities | List size | Strategies | Overlap |
| --- | --- | --- | --- | --- | --- | --- |
| small | 1 | 1 | 10 | 10 | Price > SMA 50D | — |
| normal | 10 | 20 | 97 | 20 | two-indicator, trigger | random draws from 100 |
| growing | 100 | 300 | 500 | 30 | simple, two-indicator, trigger | random draws from 500 |
| shared-50 | 100 | 100 | 50 | 50 | two-indicator | everyone watches the same 50 |
| stress | 50 | 200 | 1,000 | 40 | four kinds incl. EMA 200D | mostly distinct |
| boundary | 1 | 1 | 50 → 500 | = U | Price > SMA 50D | sweep against the resident bound |
| complexity | 1 | 1–6 | 100 | 100 | one Monitor per Strategy kind | same 100 |

"Evaluations" below means `(Monitor, member, level)` triples decided in one cycle.

## Measurements

### Steady state (PostgreSQL and Redis warm, no provider history work)

| Scenario | U | Monitors | Evaluations | Cycle wall | CPU | PG queries | PG rows fetched | Redis cmds | Redis bytes out | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small | 10 | 1 | 10 | 0.09–0.11 s | 0.05 s | 38–42 | ~1 k | 92 | 177 KB | 283 MB |
| normal | 97 | 20 | 600 | 0.56–0.57 s | 0.36–0.43 s | 358–378 | ~2.5 k | 875 | 8.3 MB | 217–275 MB |
| growing, R=1000 | 500 | 300 | 12,000 | 6.0–6.9 s | 3.9–4.6 s | 4.9–5.2 k | ~32 k | 4,504 | 44 MB | 280–566 MB |
| growing, R=100 | 500 | 300 | 12,000 | **58–60 s** | **89–91 s** | 12 k | **1.46 M** | **3.63 M** | 44 MB | 866–891 MB |
| shared-50 | 50 | 100 | 10,000 | 1.9–3.5 s | 1.3–2.0 s | 2.3–4.3 k | ~24 k | 453 | 2.6 MB | 269–285 MB |
| stress, R=100 | 1,000 | 200 | 10,000 | **379 s** (over the 300 s cadence) | 648 s | 19 k | **6.1 M** | **8.8 M** | 231 MB | 1,050 MB |

`R` is `STOCK_CACHE_MAX_RESIDENT_STOCKS`. The two `growing` rows differ **only** in `R`; the
tenfold cost is the resident bound, not the workload.

### Cold start

| Case | U | Wall | CPU | Provider requests | PG rows inserted | Redis cmds | Redis bytes in | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Everything cold (first hydration), normal | 97 | 33 s | 65 s | 97 prices, 97 profiles, 582 statements, 2 quotes, 1 holidays | 303 k | 691 k | 88 MB | 522 MB |
| Everything cold, growing | 500 | 213 s | 405 s | 500 / 500 / 3,000 / 10 / 1 | 1.59 M | 3.62 M | 457 MB | 785 MB |
| Everything cold, stress (includes EMA 200D windows) | 1,000 | 1,420 s | 3,030 s | 1,000 / 1,000 / 6,000 / 20 / 1 | 6.71 M | 8.87 M | 1.86 GB | 1,115 MB |
| PostgreSQL warm, Redis empty (re-materialization), boundary U=500 | 500 | 44 s | 66 s | **0 history requests**, 10 quotes | 0 | 3.39 M | 354 MB | 796 MB |

Per security: first hydration ≈ 0.43 s wall at concurrency 4, 0.8 s CPU, 8 provider requests,
3,180 PostgreSQL rows, 0.9 MB into Redis, ~7,200 Redis commands. Re-materialization from
PostgreSQL ≈ 0.09 s wall, 0.13 s CPU, 2,180 rows read, 0.7 MB into Redis, ~6,800 Redis commands,
and no provider traffic at all.

### The resident bound, empirically (`boundary`, R = 100, steady-state cycle)

| U | Cycle wall | CPU | PG queries | PG rows fetched | Redis cmds | Redis bytes in | Re-hydrations per cycle |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | 0.17 s | 0.13 s | 107 | 1.0 k | 452 | 53 KB | 0 |
| 100 | 0.28 s | 0.22 s | 176 | 1.2 k | 902 | 106 KB | 0 |
| 101 | 0.30 s | 0.28 s | 196 | 5.7 k | 7,681 | 806 KB | 1 |
| 200 | **16.5 s** | 24.5 s | 3,166 | 437 k | 1.36 M | 142 MB | **200** |
| 500 | **43–44 s** | 65–66 s | 7.9–9.3 k | 1.09 M | 3.39 M | 354 MB | **500** |

What grows past the bound is everything except provider traffic: PostgreSQL rows read (2,180 per
re-hydration), Redis writes (0.7 MB and ~6,800 commands per re-hydration), JSON serialization,
CPU (~130 ms per re-hydration) and cycle latency (~85 ms of wall per re-hydration at concurrency
4). The transition from `U = R + 1` to `U = 2R` is not gradual: at `R + 1` the LRU evicts one
security per cycle, but a sequential scan larger than the cache has a **100 % miss rate**, so at
`U = 200` every one of the 200 securities re-hydrates every cycle. Cost is then linear in `U` and
in the load target the widest window implies: 0.085 s of cycle wall per security for an SMA 50D
universe (~2,180 rows per re-hydration), 0.38 s per security when EMA 200D is in play (~6,100 rows
per re-hydration, `stress`: 1,000 securities, 379 s per cycle, 1.9 GB written to Redis per cycle).

Why the re-hydration is expensive: `SET_REGISTERED` re-applies the hydration TTL to **every** key
already registered for the security each time one more key is registered, so registering `K` keys
costs `K²/2` `PEXPIRE`s. A security with twelve years of prices, derived state and six statement
families registers ~110 keys and pays ~6,000 `PEXPIRE`s; 500 securities pay three million per
cycle. In production (34 years of retention, ~310 keys) that is ~48,000 per security.

### Strategy complexity (`complexity`, 100 securities, one Monitor each, steady state)

| Strategy | Levels | Evaluations | Cycle wall | Frame read (cumulative) | Redis bytes out |
| --- | --- | --- | --- | --- | --- |
| simple: Price > SMA 50D | 1 | 100 | 0.41–0.44 s | 0.55–1.0 s | 1.7 MB |
| two-indicator: SMA 50D ∧ RSI 14D, SELL RSI | 2 | 200 | 0.25–0.63 s | 0.57–0.68 s | 5.3 MB |
| trigger: Price crosses above EMA 50D | 1 | 100 | 0.29–0.45 s | 0.65–0.69 s | 8.8 MB |
| long-window: Price > EMA 200D | 1 | 100 | 0.48–0.67 s | 1.3–1.4 s | 23 MB |
| intrinsic: Margin of Safety (no fundamentals here) | 1 | 100 | 0.29–0.35 s | 0.57–0.68 s | 1.7 MB |
| multi-level: 3 BUY, 2 SELL, FINAL EXIT, six series | 6 | 600 | 0.72–0.73 s | 1.9 s | 23 MB |
| all six Monitors together | 12 | 1,200 | 1.0–1.2 s | 2.0–2.2 s | 23 MB |

Complexity is a **window** dimension, not a rule-count dimension. The frame cost — and the bytes
read from Redis — is set by the widest series any Monitor watching the security needs: an EMA 200D
needs ~1,580 closed sessions to match its materialized value to 1e-6, thirteen times the bytes of
an SMA 50D. Six Monitors over the same securities cost ~1.5× the widest one alone, because the
frame with the union of operands is built once. Evaluation itself is negligible (1,200 evaluations
in a few milliseconds). No repeated frame construction, duplicate indicator computation or `N × M`
behaviour was found.

## Scaling dimensions

| Cost | Scales with | Does not scale with | Evidence |
| --- | --- | --- | --- |
| Provider quote requests | `ceil(U / 50)` per cycle | users, Monitors | 10 batches for 500 securities in every scenario |
| Provider history requests | `U` once (8 per new security), then 7 per security per 6 h | users, Monitors, Redis state | cold vs warm rows; re-materialization made 0 |
| Frame construction | `U` × widest window | Monitors sharing a security | complexity table; shared-50 |
| PostgreSQL steady reads | `U` (manifest/derived tail) + transitions | evaluations that do not change | growing R=1000: 4.9 k queries for 12,000 evaluations |
| PostgreSQL writes | changed transitions only (~3 ms each) | unchanged matches | `unch=11,039` of 12,000 wrote nothing |
| Redis reads | `U` × window bytes | Monitors | 44 MB out per cycle at U=500 regardless of R |
| Redis writes | `max(0, U − R)` × 0.7 MB per cycle | anything else when `U ≤ R` | boundary table |
| Per-Monitor fixed cost | Monitors (~3 ms: one state read, one sweep) | securities | shared-50: 100 Monitors ≈ 0.3 s |
| Memory (retained) | `U` × window, plus hydration transients | Monitors | RSS 280–570 MB at U=500 without thrash |
| Memory (transient heap peak) | re-hydration churn | — | ~1 GB heap peaks whenever hydration runs |
| Active Signals | nothing measurable | — | detail read is capped at 100 rows |

**100 users on the same 50 securities** (shared-50) cost 1.9–3.5 s per cycle, of which the market
data is ~0.4 s and the rest is 100 Monitor passes with an artificially high transition rate. **100
users on 500 mostly distinct securities** (growing) cost 6–7 s with an adequate resident bound and
58–60 s without one. Users are cheap; distinct securities beyond the resident bound are not.

## Provider request model

Derived from the execution flow and confirmed by the counters:

| Event | Requests | Endpoint |
| --- | --- | --- |
| A security's first hydration | 1 profile + 1 price walk (paginated, ≥1) + 6 statements (3 types × 2 cadences) | `profile`, `historical-price-eod/full`, statements |
| Every cycle | `ceil(U / 50)` | `batch-quote` |
| Every 6 h per monitored security (`STOCK_RECENT_PRICE_FRESHNESS_MS`, `STOCK_FUNDAMENTALS_FRESHNESS_MS`) | 1 tail price + 6 statements (quarterly limit 12, annual limit 3) | as above |
| Every 24 h per admitted exchange | 1 | `holidays-by-exchange` |
| Redis flush or eviction | **0** — coverage and freshness timestamps are persisted in PostgreSQL | — |
| Process restart | 0 beyond the cycle's quotes and a cold calendar | — |

Steady daily budget for `U` monitored securities: `288 × ceil(U / 50)` quotes + `28 × U` refresh
requests. For U = 100: 576 + 2,800 ≈ 3,400/day. For U = 500: 2,880 + 14,000 ≈ 17,000/day
(~12/min on average). The refresh half **dominates** above ~50 securities and is bursty: every
security hydrated at the same time expires together, so a universe hydrated in one cycle refreshes
in one cycle six hours later — 3,500 requests through a 20/s gate is a ~3-minute cycle every six
hours at U = 500. Jittering the freshness windows would flatten this; not changed.

Unexpected-spike sources found: a List of never-seen securities added to a Monitor (8 requests
each, all in the next cycle); a security whose profile the provider cannot supply is re-asked on
every hydration because a sync is only recorded when a profile was saved (narrow, real); a
`PRICE_DATASET_VERSION` or `DERIVED_STATE_REVISION` bump re-hydrates history for every security on
first touch (deliberate). Redis being flushed causes **no** provider traffic.

## Market-closed scanning

The domain's session window is 04:00–20:00 New York on trading days; the cadence is 5 minutes
around the clock.

| Cadence | Cycles per year | Useful cycles (any observation can change) | Provider quote requests, U = 500 |
| --- | --- | --- | --- |
| Current: fixed, 24×7 | 105,192 | 48,384 (46 %); 18.7 % during the regular 09:30–16:00 session | ~1.05 M/year |
| Session-aware: skip when no admitted venue is inside 04:00–20:00 on a trading day | 48,384 | 100 % | ~0.48 M/year (−54 %) |
| Hybrid: 5 min in session, 60 min outside | 53,118 | 91 % | ~0.53 M/year (−49 %) |

The calendar already exists (`CachedTradingCalendar`, one request per exchange per year, cached
in process for 24 h with last-known-good fallback), and `tradingSessionDate` already names the
session; deciding "is any admitted venue inside its session window now" is a pure function of the
clock and that schedule. All three admitted venues share one clock and one holiday schedule, so
"any venue" is one check. Early closes still produce a session; pre-market and after-hours are
inside the window by the domain's own definition; a holiday is a closure.

**Recommendation.** Session-aware idling is worth doing: it removes ~54 % of quote requests and
~54 % of steady-state cycle work with no semantic loss (the first cycle after a close already
observed the final print; nothing can change until the next session's first trade), and the
implementation is ~30 lines in the loop plus one calendar call, with the calendar failure mode
already defined (a schedule that cannot be resolved must not be read as "closed"; run the cycle).
It is recorded as an open product decision in `ai/product/monitors.md` because cadence is a
product-owned property; the evidence now strongly favours it.

## Cold-start behaviour

| Scenario | What is reconstructed | Time | Provider traffic | Semantics |
| --- | --- | --- | --- | --- |
| PostgreSQL warm, Redis empty | Every touched security's manifest and chunks, from PostgreSQL | ~0.09 s per security at concurrency 4 (44 s for 500) | none | unchanged; the first cycle is a re-materialization cycle |
| API restart | nothing durable; Prisma pool and Redis client reconnect | seconds | none | unchanged |
| Worker restart | the schedule claim: an in-flight cycle's lease expires (≤ 120 s) and the next child reclaims it | ≤ lease | the cycle's quotes once more | unchanged; committed transitions stand, the rest re-derive |
| API + worker restart | both of the above | ≤ lease | none beyond the cycle | unchanged |
| Redis restart | same as Redis empty, plus the FMP gate state (cooldown, in-flight tokens) is lost | as above | none; a lost cooldown could let one burst through before the next 429 | unchanged |
| Clean deployment with existing Monitors | Redis empty; history persisted | first cycle = re-materialization of `min(U, R)`; if `U > R`, **every** cycle stays a re-materialization cycle | none | unchanged |

Correct but expensive is the honest summary: a Redis loss costs one cold cycle of PostgreSQL reads
and Redis writes and never a provider request, and never changes a Signal.

## Failure behaviour

Exercised with the **real** monitor process (`node --import tsx apps/worker/src/monitor/monitor-process.ts`)
against the test database with a two-security Monitor (AAPL, MSFT, real provider, 30-year
retention) and a shortened schedule — interval 15 s, lease 20 s, heartbeat 5 s, retry backoff 10 s
— plus the benchmark's provider failure injection. Times are from the structured logs.

| Failure | What happened | Recovery | Wasted work | Operator can tell? |
| --- | --- | --- | --- | --- |
| Normal start, cold | First cycle hydrated two securities from the provider in 34 s and emitted two Signals; second cycle 0.6 s | — | — | `monitor.cycle.completed` with counts; the 34 s cycle raised `monitor.cycle.over-cadence` |
| Graceful stop (SIGTERM) between cycles | `monitor.child.stopping` → `monitor.child.stopped` in 3 ms; claim released | immediate | none | yes |
| `kill -9` 0.5 s after a claim | The dead claim held the row until its lease expired; a second process claimed the next cycle **20.4 s** after the kill (= lease) and re-derived the cycle: no duplicate Signal | ≤ lease | one cycle's evaluation | **was not**: the direct reclaim path logged only a fresh `claimed`. Now logs `monitor.cycle.recovered` with `takenOverFrom` |
| Provider 429 / 500 / timeout during the quote batch | `monitor.current-data.failed` with the FMP error class, then `monitor.cycle.failed`; the schedule records the failure and backs off (10 s, doubling to the interval); nothing persisted | next due cycle | the cycle's provider batch | yes; error class named |
| Redis unreachable | Every cycle fails at the quote batch: the request gate cannot reach Redis, which surfaced as `FmpTransientError` "provider temporarily unavailable" after 7–31 s of gate retries; ioredis printed unstructured `[ioredis] Unhandled error event: connect ECONNREFUSED` lines to stderr every reconnect | when Redis returns | one failed cycle per backoff step | **was misleading**: the log blamed the provider. Now the transient error carries the Redis error as `cause` (serialized by the logger) and the client logs `stock-data.redis.error` |
| PostgreSQL unreachable | The child fails fatally at startup (`monitor.child.failed`, `PrismaClientInitializationError: Can't reach database server`) and exits 1; the supervisor restarts it with 1–30 s backoff until the database returns | when PostgreSQL returns | none | yes |
| Shutdown during expensive computation | The loop stops at the next Monitor boundary; a stop during the symbol phase waits for the phase (no persisted work there); the supervisor kills after 30 s | see `api-worker.md` | at most one symbol phase | `monitor.child.stopping` |

Not rehearsed: a provider that is unreachable at the network level with the real process, because
the client's base URL has no environment override (`FmpClient` takes `baseUrl` programmatically
only); the injected failures cover the same code path from the quote batch onward.

## Observability

Answered from the logs the worker already emits (`monitor.cycle.claimed`,
`monitor.cycle.completed` with `durationMs` and the summary counts, `monitor.cycle.failed`,
`monitor.cycle.failure-recorded`, `monitor.cycle.recovered`, `monitor.cycle.lease-lost`,
`monitor.current-data.failed`, `monitor.symbol.failed`, `stock-data.provider.request` with a
reason, `worker.child.*`, `worker.heartbeat`) and the durable `MonitorScanSchedule` row:

| Question | Answer today | Gap |
| --- | --- | --- |
| Is the Monitor worker alive? | `worker.heartbeat` every 60 s (supervisor) and `monitor.child.ready`; the schedule row's `heartbeatAt` while a cycle runs | No process-level probe; the schedule row is the source of truth |
| When did the last successful cycle finish? | `MonitorScanSchedule.lastCompletedAt`; `monitor.cycle.completed` | none |
| How many Monitors, unique securities, evaluations, Signals? | `monitor.cycle.completed` carries `monitors`, `symbols`, `evaluations`, `signalsEmitted`, `signalsResolved`, `notEvaluable`, `transitionsUnchanged`, `transitionsContended` | none |
| How long did the cycle take? | `durationMs` on `monitor.cycle.completed` / `.failed` | no explicit "over cadence" signal; compare `durationMs` with `MONITOR_SCAN_INTERVAL_MS` |
| Cache versus hydration work? | `stock-data.provider.request` (debug) says why the provider was called; nothing says how many securities were re-materialized from PostgreSQL | **gap**: re-materialization is invisible at `info` |
| Is FMP failing or rate-limiting? | `monitor.current-data.failed` with the FMP error name (`FmpRateLimitError`, `FmpTransientError`), `monitor.cycle.failed`, `consecutiveFailures`/`lastError` on the schedule row | none for the Monitor path; the gate's cooldown is not logged |
| Is Redis failing? | `stock-data.redis.error` on every reconnect attempt; `monitor.cycle.failed` whose error now carries the Redis `cause`; `GET /health/ready` | none |
| Is PostgreSQL failing? | `monitor.cycle.claim.failed`, `monitor.cycle.heartbeat.failed`, `monitor.state.load-failed`; `GET /health/ready` | none |
| Are jobs backing up? | `BacktestJob` rows by status and `availableAt`; the schedule's `dueAt` versus now | no log of queue depth (a query answers it) |
| Are cycles taking longer than their cadence? | derivable: `durationMs > MONITOR_SCAN_INTERVAL_MS` | **gap**: not flagged |

Additions made from the rehearsal, each one line of operational value: the loop logs
`monitor.cycle.over-cadence` at `warn` (with `durationMs` and `scanIntervalMs`) whenever a
completed cycle ran longer than the scan interval; a claim that takes over an expired lease logs
`monitor.cycle.recovered` with `takenOverFrom` (previously the crash of the last holder was
invisible on that path); the Redis client's connection errors are logged as
`stock-data.redis.error` through the structured logger instead of ioredis's raw stderr lines; a
transient provider error keeps its underlying cause and the logger serializes `cause`, so a Redis
outage inside the request gate reads as a Redis outage. No metrics framework was added.

## Health and readiness

`GET /health` stays a static liveness answer. `GET /health/ready` probes PostgreSQL (`SELECT 1`)
and Redis (`PING`) with a 2-second bound each and answers `503` with the per-dependency detail when
either fails. PostgreSQL is authoritative for everything, and Redis is required at runtime for every
stock-data read (`AGENTS.md` invariant 16), so an instance missing either cannot serve the product
and should leave rotation; neither should restart it. The market-data provider is deliberately not
probed. The worker has no HTTP surface: its readiness is the schedule row, and its liveness is the
supervisor heartbeat.

## Recommended V1 operational limits

| Limit | Protects | Evidence | Kind | When |
| --- | --- | --- | --- | --- |
| **`STOCK_CACHE_MAX_RESIDENT_STOCKS` ≥ the monitored universe** (operational, not user-facing) | cycle latency, PostgreSQL read volume, Redis write volume | boundary table: 10–20× cost past the bound; Redis cost ≈ 0.7 MB per resident security at 12 years, ~2 MB at 34 | hard (configuration) | before production |
| Securities per List: none needed for V1 with the above | — | 500-security Lists were fine at R ≥ U | — | postpone |
| Total distinct securities monitored per deployment: budget `R` and Redis memory for it | Redis memory, provider refresh budget (28/day each) | provider model; ~2 MB Redis per security | soft (capacity plan) | before production |
| Enabled Monitors per user | nothing measurable; ~3 ms per Monitor per cycle | shared-50 | none | not justified |
| Strategy complexity | nothing; window is the driver and the widest window is already bounded by the catalog | complexity table | none | not justified |
| Concurrent backtests | `BACKTEST_WORKER_PROCESSES` already bounds it; each run is sequential | existing design | existing | — |

No user-facing limit is justified by these measurements. The limit that matters is operational:
the resident bound and the Redis memory behind it must be sized to the deployment's monitored
universe, and the provider plan must cover `28 × U` refresh requests per day plus quotes.

## Product decisions with evidence

| Question | Classification | Evidence |
| --- | --- | --- |
| Idle the scan when no admitted venue can produce an observation? | **evidence strongly suggests yes** | 54 % of cycles and quote requests are provably no-ops; the calendar exists; no semantic loss |
| Cap List size? | **safe to postpone** | cost is per distinct security across the deployment, not per List; a cap protects nothing the resident bound does not |
| Is the 100-security resident bound appropriate? | **evidence strongly suggests no as a default for a multi-user deployment** | it is an arbitrary cache parameter chosen for a single-user development stack; `U > R` makes every cycle a full re-materialization; the right value is ≥ the monitored universe, bounded by Redis memory |
| What limits before production? | one: size `R` and Redis to the universe; watch `overCadence` | tables above |
| A member that stops trading, Signal paging, backtest ending today | **still product decisions** | unaffected by capacity |

## Known bottlenecks and the next wall

The known wall is the resident bound. Two changes remove it cheaply when wanted: raise `R` with
matching Redis memory (2 MB per resident security at 34 years), or read the Monitor's bounded
price window straight from PostgreSQL the way the derived tail already is, so a Monitor's working
set never needs residency at all.

**If the resident bound disappeared tomorrow, the next wall is the frame read** — Redis bytes and
JSON parsing per security per cycle, set by the widest window. At U = 500 without thrash the cycle
spends ~5.6 s of cumulative time in `readMonitorEvaluationFrame` out of ~6 s wall at concurrency 4
(44 MB from Redis, parsed and recomputed every cycle) and the rest is provider batches and
transitions. Extrapolating linearly, ~5,000 monitored securities is ~60 s per cycle with the bound
lifted — still inside the cadence, but the cycle is then CPU-bound in one process (`MONITOR_SYMBOL_CONCURRENCY`
only overlaps I/O; the parse and the recompute run on one thread) and memory-bound by the frames
held until the per-Monitor pass. After that: the single global cycle. Every enabled Monitor is
evaluated by one claim, so throughput cannot be added with a second worker; sharding the cycle by
security or by user is the redesign that would be needed, and nothing in the data model prevents
it. The provider refresh budget (28 × U per day, bursty) becomes a plan-limit question around
U ≈ 2,000 on a 300-requests-per-minute plan.

## Things tested that turned out not to be problems

- **Users and Monitors.** 100 users on the same securities cost ~3 ms per Monitor per cycle; the
  market data is genuinely shared.
- **Strategy complexity.** Rule count does not matter; only the widest window does, and it is
  shared across Monitors.
- **Provider traffic after a Redis loss or eviction.** Zero history requests; coverage and
  freshness live in PostgreSQL.
- **Memory retention.** Heap peaks near 1 GB during hydration are transient garbage; retained RSS
  at U = 500 was 280–570 MB.
- **The `U = R + 1` cliff.** Not a cliff: one security per cycle. The cliff is at `U ≈ 2R`, where
  the sequential scan defeats the LRU completely.
- **Transitions.** Unchanged evaluations cost no query; changed ones cost ~3 ms each.
- **Profile requests per re-hydration.** A benchmark artifact of a stub returning no profile; a
  real listing's profile sync is recorded once. The narrow real case (a security the provider
  cannot profile) is noted above.
