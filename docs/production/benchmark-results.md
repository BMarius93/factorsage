# Benchmark results

Measured 2026-10-23 on the cloud development container (4 vCPU Intel Xeon @ 2.10 GHz, 16 GB RAM, no
swap, network block storage; PostgreSQL 16.15 and Redis 7.0.15 on the same machine). How each number
was produced, and what is real and what is synthetic, is `benchmarks.md`; the raw reports are in
`benchmark-results/` and every table here is a projection of them
(`tsx src/backtest-benchmark/summarize-results.ts`).

**Everything below ran against the synthetic provider and synthetic 34-year histories**, except the
one real-FMP sample in §5. Provider-miss timings are FactorSage's own miss path against a provider
that answers instantly unless stated; they are not FMP's latency, rate limit or quota behaviour.

## 1. Stock cache tiers at `STOCK_LRU_MAX_SECURITIES=500`

735 protected (canonical-universe) securities and 1,029 ordinary ones, every one with a complete
stored history. Raw reports: `benchmark-results/lru/`.

| Check                                                                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LRU-500 model check (sequential, from an empty LRU: fill, overflow, re-reads, re-admissions, protected reads between) | 1,392 reads (1,039 LRU, 353 protected); LRU 0 → 500, **536 evictions**; after every read the LRU equals a reference count-bounded LRU **in membership and order** (0 deviations); every evicted security gone whole (0 leftover keys); every read equal to PostgreSQL's rows; never above 500; protected digest unchanged; 0 provider requests. Cold LRU read (rebuilt from PostgreSQL) median **1.86 s**, p95 2.19 s, max 3.68 s; warm LRU read 3 ms; protected read median 3 ms, p95 5 ms |
| Concurrent readers at 500 (6 processes × 120 random reads, 71 % LRU / 29 % protected)                                 | 720 reads, 257 cold, **0 mismatches against PostgreSQL**, 0 errors; read p50 11 ms, p95 4.2 s (cold rebuilds under six-way contention), max 5.9 s; LRU never above 500 across 29,758 samples; nothing left behind by any eviction; protected digest unchanged                                                                                                                                                                                                                               |
| Capacity lowered to 400 under concurrent access (forced eviction)                                                     | the first touch evicted 100 members in **21 ms**, 0 of their keys left; 360 further reads with the LRU never above 400; audit clean                                                                                                                                                                                                                                                                                                                                                         |
| Promotion of an LRU member to protected, and demotion back                                                            | left the LRU with all 72 keys and their bytes unchanged and no TTL; reconciled back, it rejoined as the newest LRU member within capacity, bytes unchanged                                                                                                                                                                                                                                                                                                                                  |
| Protected tier rebuilt from PostgreSQL alone (`protect --concurrency 4`)                                              | 733 published + 2 already resident in **973 s** (16.2 min); 0 provider requests; tier 770 MB (mean 1.05 MB per security, p95 1.19 MB)                                                                                                                                                                                                                                                                                                                                                       |
| Protected residency                                                                                                   | 735 designated, 735 READY, 52,920 keys, **0 keys with a TTL**, 0 orphans, 0 dual residency, 0 violations                                                                                                                                                                                                                                                                                                                                                                                    |
| Redis restart (`SHUTDOWN SAVE`, restart, load ~1.2 GB)                                                                | **15.5 s** until it served again; protected digest identical; 52,920 keys; LRU 400/400 READY; audit clean                                                                                                                                                                                                                                                                                                                                                                                   |
| Redis loss (`FLUSHDB` of the benchmark database), then `protect`                                                      | 735 published from PostgreSQL alone in **875 s** (14.6 min), 0 provider requests, 770 MB; every price and daily-state chunk of the sample **byte-identical** to before the loss (manifests differ only by their publication time); 52,920 keys, 0 with a TTL, audit clean; the LRU starts empty and fills on reads                                                                                                                                                                          |

Redis memory: the synthetic histories cost 1.05 MB per security (34 full years); the real S&P 500
point-in-time universe measured 0.74 MB per security (`docs/decisions/protected-stock-tier-v1.md`).
With both tiers full — 735 protected and 500 LRU securities — `used_memory` was **1.30 GB**.

## 2. LRU contention: a run with more ordinary securities than the LRU holds

Pro+ × 1,000 ordinary securities (no canonical-universe member), one year (two calendar-year
windows), four workers, warm cache, LRU 500 (`F-ordinary-1y-*`).

| Frame read                            | Preparation | Window reads (2025 · 2026)     | Frames from PostgreSQL | Evictions | Result digest |
| ------------------------------------- | ----------- | ------------------------------ | ---------------------- | --------- | ------------- |
| `STORE` (now the default)             | 1,335 s     | **18.7 s** (5.2 · 13.4)        | 1,000                  | 993       | `9070dcbc…`   |
| reference: LRU 1,100, nothing evicted | 846 s       | 4.7 s (2.3 · 2.4)              | 0                      | 0         | `9070dcbc…`   |
| `REBUILD` (the previous behaviour)    | 1 s ¹       | **1,418.7 s** · not finished ² | 0                      | 1,922 ²   | — ²           |

¹ Every security was already resident from the run before, so preparation found nothing to load —
the windows are where the old behaviour pays. ² A container restart at 21:29 UTC ended the run
~16 minutes into its second window; its first window (48 sessions, 2025-10-23 → 2025-12-31) is
measured from the run's own log events (`benchmark-results/F-ordinary-1y-rebuild.interrupted.jsonl`),
and the harness never wrote its report.

The same 48-session window took **1,418.7 s** with the previous behaviour, **5.2 s** with `STORE`
and 2.3 s with nothing evicted: the previous behaviour rebuilt each of the 1,000 securities' full
34-year histories in every window, ~270 times the cost. Over 30 calendar-year windows that is on the
order of twelve hours of rebuilding per run, against minutes. The digests of the two completed runs
are identical: reading a non-resident security's window from PostgreSQL gives the same
result, as the integration test proves value by value. All the evictions in the `STORE` run happened
in preparation, which still rebuilds each non-resident security once (1,000 rebuilds, 22 minutes
here); none happened in the windows.

**Over 30 years** (`F-ordinary-30y`: the same list, 31 windows, alone, `STORE`): execution
**1,681 s (28.0 min)** — preparation 978 s (600 rebuilds from PostgreSQL, 1.6 s each), window reads
680 s (15,500 frames read from PostgreSQL, 500 per window, ~22 s per full-year window), simulation
19 s, persistence 3 s. The 1,000-security mixed list, fully resident, takes 132 s (§3): a list whose
ordinary members exceed the LRU costs ~13× as much, and is the slowest workload measured. With the
previous behaviour the windows alone would have rebuilt 500–1,000 securities each, on the order of
6–12 hours. The worker peaked at 2.08 GB and used 2,875 CPU-seconds in 1,681 s (1.7 cores: part
of its work runs off the JavaScript thread); PostgreSQL had ≤ 18 connections and read 10.2 GB of
blocks — on this machine's network block storage a window read from PostgreSQL costs ~40 ms per security-year, about
ten times a Redis frame read (3.5 ms).

**Four users whose ordinary members exceed the LRU together** (`H-warm-mixed-disjoint`: 750 + 750 +
1,000 + 1,000, the four lists' 1,400 ordinary members spanning the whole 1,000-security pool, LRU
500, warm): **15.6 min** for the four, against 2.6 min when the four lists share their members.

| Run   | Execution | Preparation | Frame reads (from PostgreSQL) | Evictions caused | Digest                         |
| ----- | --------: | ----------: | ----------------------------- | ---------------: | ------------------------------ |
| 1,000 |     195 s |       4.4 s | 163 s (0)                     |                0 | `6fd89fb1…`                    |
| 750   |     766 s |       619 s | 122 s (0)                     |              300 | `868e738e…`                    |
| 750   |     776 s |       434 s | 318 s (3,472)                 |              124 | `ab76eccf…` = the H 750 list   |
| 1,000 |     938 s |       619 s | 295 s (3,472)                 |              260 | `851d9aa3…` = the H 1,000 list |

The run whose members were all resident took 195 s (157 s when all four are resident: the others'
rebuilds took CPU from it); the other three rebuilt 684 securities between them in 434–619 s of
preparation — **~2.4 s of slot time per rebuilt security**, against 4.3 s in the cold shared run,
where all four slots waited on the same rebuilds — and two of them then read 3,472 frames from
PostgreSQL that the others' preparation had evicted (+130–170 s each). The two
lists that also ran in the shared, fully resident `H` runs produced **the same digests** here, under
684 evictions and 6,944 window reads from PostgreSQL. Worker memory peaked at 2.12 GB per process
(5.8 GB for the four); event-loop delay inside the preparing workers reached 6.9 s.

## 3. Per-plan workloads and four simultaneous executions (warm cache)

30-year runs ending on the newest stored session (2026-10-22), the simple strategy (SMA 200
crossover) unless stated, mixed lists (60 % canonical-universe members, 40 % ordinary), four worker
processes, global cap 4, `STOCK_LRU_MAX_SECURITIES=500`, frame read `STORE`. "Execution" runs from
the claim to the committed result; queue waits were under 0.3 s throughout because no run waited for
a slot.

| Scenario         | Runs × securities         |    Samples | Execution (s) median · max       | Preparation | Frame reads | Simulation | Persistence | Worker RSS / process |
| ---------------- | ------------------------- | ---------: | -------------------------------- | ----------: | ----------: | ---------: | ----------: | -------------------: |
| A Free           | 1 × 10                    |          3 | 4.9 · 5.2                        |       0.1 s |       1.3 s |      2.0 s |       1.5 s |              0.29 GB |
| B Starter        | 1 × 50                    |          3 | 12 · 13                          |       0.2 s |       5.7 s |      3.4 s |       2.7 s |              0.32 GB |
| C Pro            | 1 × 250                   |          3 | 38 · 39                          |       0.6 s |        27 s |      7.4 s |       2.8 s |              0.38 GB |
| D Pro            | 1 × 500                   |          1 | 66                               |       0.9 s |        52 s |       11 s |       2.7 s |              0.43 GB |
| E Pro            | 1 × 750                   |          1 | 98                               |       1.4 s |        79 s |       15 s |       2.9 s |              0.44 GB |
| F Pro+           | 1 × 1,000                 |          2 | 132 · 133                        |       1.9 s |       109 s |       19 s |       2.9 s |              0.46 GB |
| G Pro+, one user | 2 × 1,000 at once         |          2 | 137 · 137                        |       2.7 s |       112 s |       20 s |       3.0 s |              0.46 GB |
| H four users     | 750 + 750 + 1,000 + 1,000 | 8 (2 runs) | 750: 122 · 124; 1,000: 153 · 155 |   3.9–4.7 s |    97–126 s |    16–21 s |       3.0 s |              0.50 GB |
| I sizing case    | 4 × 1,000 at once         |          4 | 157 · 158                        |       4.8 s |       130 s |       20 s |       2.8 s |              0.49 GB |

- **Every repeat of the same inputs produced the same result digest** — A, B and C three times, F
  twice, the 1,000-security list across F, G, H and I, and both lists across the cold and warm H.
- **Four at once costs ~1.2× per run** on 4 vCPU (750: 98 → 122 s; 1,000: 132 → 157 s): H and I
  finished all four runs in **2.6 min** each, the CPU 91–97 % busy. Throughput of the four slots on
  this machine: ~92 runs of this mix per hour.
- **Pro+'s two runs execute together** (G: both claimed at once, 137 s each, beside 132 s alone).
- Execution grows linearly, about **0.13 s per security** for 30 years, and is spent mostly reading
  frames (decoding each security's year chunks from Redis, 80 %) and simulating (15 %).
- **Strategy complexity** (Pro × 500, 30 years): simple 66 s; monthly contributions and ten positions
  66 s; sector-ETF conditions 94 s (14 s preparing the sector ETF series); fundamentals, an
  oscillator and a valuation 86 s (simulation 23 s). Four at once with the complex strategy: 3.3 min
  (1,000: 191–195 s, 750: 153 s).

**Bottleneck: CPU.** Worker CPU time matched execution time (each worker runs at about one core,
more during garbage collection), the host was 91–97 % busy with four runs, PostgreSQL used ~0.2 of a
core and Redis ~0.25, memory stayed under 0.5 GB per worker, and the database never had more than 26
connections or 4 active ones. Nothing was FMP-bound: warm runs made no provider request.

## 4. Cold Redis (PostgreSQL → Redis), the same four runs

`H-cold-mixed-shared`: Redis emptied first, so every security — 600 canonical and 400 ordinary,
shared by the four lists — was rebuilt from PostgreSQL inside the runs' preparation (no provider
data was missing).

|                                        |                                                                              Cold |          Warm (H-1, H-2) |
| -------------------------------------- | --------------------------------------------------------------------------------: | -----------------------: |
| Wall time, four runs                   |                                                                      **21.3 min** |                  2.6 min |
| Preparation (median)                   |                                                                       **1,082 s** |                    4.5 s |
| Frame reads · simulation · persistence |                                                         107–114 s · 19–20 s · 3 s | 97–126 s · 16–21 s · 3 s |
| Worker RSS, per process / all four     |                                                                  1.99 GB / 6.6 GB |         0.50 GB / 1.7 GB |
| Event-loop delay p99 (max)             |                                                                    2.24 s (4.8 s) |            0.2 s (0.6 s) |
| Provider requests                      | 608 (600 one-day price reads at the rebuilt securities' leading edge, 8 calendar) |                        0 |
| Result digests                         |                                                                 identical to warm |        identical to cold |

Hydration and computation separate cleanly: the 1,000 rebuilds cost **~4.3 s of slot time per
security** with four workers sharing them (the protected tier alone rebuilt at 0.8–0.84 securities/s,
§1), while computation was the same as warm. The rebuild is CPU-bound (decoding PostgreSQL rows and
encoding the year chunks); PostgreSQL itself used 34 s of CPU over the 21 minutes.

## 5. True provider miss

### Real FMP: the one sample

`scripts/cloud/fmp-live.sh`, 2026-10-23, three approved securities, a budget of 200 requests, the
development database (`benchmark-results/fmp-live-sample-2026-10-23.txt`):

|                                                                           |   AAPL |   MSFT |    KO |
| ------------------------------------------------------------------------- | -----: | -----: | ----: |
| Hydration                                                                 | 13.1 s | 14.6 s | 9.7 s |
| … prices, statements and derived state                                    |  9.0 s |  8.0 s | 7.5 s |
| … splits and valuation ratios                                             |  0.7 s |  1.3 s | 0.6 s |
| … insider and congressional trades                                        |  3.4 s |  5.3 s | 1.7 s |
| Requests (profile 2, prices 2, statements 6, splits 1, insider, congress) |     23 |     26 |    17 |
| Daily prices stored                                                       |  8,559 |  8,559 | 8,559 |

37.9 s for the three, sequentially; 66 requests, none retried, none refused; 8,559 sessions each
(1992-10-22 → 2026-10-22). The same three through the synthetic provider took 23.5 s (median 7.1 s
per security) with 65 requests — 35 of them the exchange-holiday calendar's first fill, which the live
sample did not request — and 6.9 MB of responses; the synthetic
provider serves no insider or congressional data.

### Synthetic provider, inside a run

The run's preparation hydrates every never-seen member before execution, inside its slot
(`--cache miss`: the list's ordinary members have never been hydrated; its canonical members are
resident):

| Run                                                   | First-time securities | Execution (warm) | Preparation                   | Provider requests                                | Responses | Worker RSS peak |
| ----------------------------------------------------- | --------------------: | ---------------- | ----------------------------- | ------------------------------------------------ | --------: | --------------: |
| `C-miss-mixed`: Pro × 250, provider answers at once   |                   100 | 369 s (38 s)     | 333 s, **3.3 s per security** | 970: profile, prices ×2, statements ×6, calendar |    229 MB |     **3.42 GB** |
| `B-miss-mixed-latency250`: Starter × 50, +250 ms each |                    20 | 90 s (12 s)      | 79 s, 3.9 s per security      | 250                                              |     46 MB |         3.42 GB |

- A first-time security costs **~3.3 s of its run's slot** against an instant provider (four
  hydrations at a time per run), ~3.9 s with 250 ms of provider latency; the real FMP sample's
  prices-statements-derived-state stage took 7.5–9.0 s per security one at a time (synthetic: 7.1 s),
  so ~3.5–4.5 s per security inside a run is the estimate for real FMP (**not measured**).
- ~9.7 provider requests and ~2.3 MB per first-time security for what a backtest needs (the insider
  and congressional datasets, ~12 more requests per security on real FMP, were not requested by
  these runs' preparation: the synthetic provider recorded no request outside its endpoints).
- **Hydrating is the most memory-hungry thing a worker does**: 3.42 GB per process, against 2.1 GB
  for a 1,000-security rebuild from PostgreSQL and 0.5 GB executing — with a 2 GB V8 heap (Node's
  default on this machine), so at least ~1.3 GB of it is outside the JavaScript heap.
  The same run under a 3 GB heap (`C-miss-mixed-heap3072`) peaked at 3.68 GB and ran 7 % faster
  (344 s): a larger heap buys a little speed for more memory, so production keeps the measured 2 GB.
- Every member was prepared (none skipped) and both runs completed on their first attempt.

**Four first-time hydrations at once** (`H-miss-mixed-shared`: 750 + 750 + 1,000 + 1,000, the four
lists sharing 400 never-hydrated ordinary members, all four executing):

|                      | Measured                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Wall time, four runs | **18.2 min** (2.6 min warm): preparation 683 s (750) and 963 s (1,000), execution as warm   |
| Hydration            | 400 securities, each once: 2.4 s of wall time each with four workers hydrating together     |
| Provider             | 3,880 requests (9.7 per security), 918 MB; none failed or was repeated                      |
| **Worker memory**    | **11.9 GB for the four processes** (3.28 GB the largest); the 16 GB machine had 725 MB left |
| PostgreSQL           | 39 connections, 12 active, 7.9 M rows inserted (+3.6 GB), 86 CPU-seconds                    |
| Results              | both 750 runs one digest, both 1,000 runs one digest; every run on its first attempt        |

This is the deployment's memory high-water mark: four runs hydrating first-time securities at once
need ~12 GB for the backtest processes alone (`benchmark-results/H-miss-mixed-shared.memory.log`
samples the machine's free memory every 5 s).

## 6. Interactive responsiveness, with and without four backtests

`drivers/phase5.sh`: the production builds of the API (`apps/api/dist`) and the web app (`next
start`) on the benchmark database, 100 load accounts (40 % Free, 30 % Starter, 20 % Pro, 10 % Pro+)
each with lists, strategies, Monitors and a completed 250-security backtest. `load:interactive`
signs each in once and replays weighted journeys — dashboard, market overview, Stock Details (80 % of
views canonical-universe stocks, 20 % a long tail outside both cache tiers), lists (including an
edit), strategies, backtest history, a result's trades, Monitors — with a 2 s mean think time, 20 s
ramp, 150 s per level, percentiles over the steady state only. **The load generator is a separate
process on the same 4 vCPU machine** (12 % of a core at 100 users, so it was not the limit), the API
one Node process. "During H": four warm `H` backtests executing back to back (`H-under-load-*`; the
share of sampled moments with all four executing is shown).

| Level                 |         Users | Backtests executing (mean · share at 4) | Req/s | Errors |      p50 |             p95 |       p99 |    max | API CPU (cores) | API event-loop p99 (median · max) |
| --------------------- | ------------: | --------------------------------------- | ----: | -----: | -------: | --------------: | --------: | -----: | --------------: | --------------------------------- |
| baseline              |             5 | 0                                       |   4.2 |      0 |    14 ms |          498 ms |    985 ms |  3.0 s |            0.41 | 15 · 162 ms                       |
| baseline              |            20 | 0                                       |  16.9 |      0 |    20 ms |          707 ms |     1.5 s |  6.2 s |            1.05 | 155 · 834 ms                      |
| baseline              |            50 | 0                                       |  32.8 |      0 |   123 ms |           1.5 s |     3.6 s | 15.3 s |            1.57 | 342 ms · 1.3 s                    |
| baseline              |           100 | 0                                       |  40.1 |      0 |   860 ms |       **3.4 s** |     6.9 s | 29.9 s |            1.88 | 678 ms · 2.7 s                    |
| during H              |             5 | 3.24 · 72 %                             |   4.5 |      0 |    21 ms |          343 ms |    631 ms |  1.5 s |            0.16 | 15 · 388 ms                       |
| during H              |            20 | 3.27 · 72 %                             |  17.6 |      0 |    32 ms |          563 ms |    990 ms |  4.4 s |            0.50 | 56 · 662 ms                       |
| during H              |            50 | 3.64 · 83 %                             |  34.5 |      0 |   154 ms |           1.3 s |     2.1 s |  6.7 s |            0.92 | 322 ms · 1.2 s                    |
| during H              |           100 | 3.88 · 93 %                             |  39.0 |      0 |    1.1 s |       **3.6 s** |     5.9 s | 11.9 s |            1.11 | 1.1 · 2.0 s                       |
| **two API processes** | 100 (50 + 50) | 0                                       |  77.8 |      0 | 58–61 ms | **0.80–0.85 s** | 1.4–1.6 s |  7.7 s |       1.09 each | 209–233 · 781–931 ms              |

- **The API process, not the backtests, is the interactive limit.** One Node process serves ~40
  requests/s at most here; past ~20 concurrent users its event loop queues requests (p99 delay 0.7 s
  at 100 users), and adding four executing backtests changes the picture little (p95 3.4 → 3.6 s at
  100 users) because the API is already saturated. **Two API processes** with 50 users each served
  **twice the throughput (77.8 requests/s) at a quarter of the p95** (0.80–0.85 s against 3.4 s):
  `drivers/phase5b.sh`.
- **Zero errors** at every level, with and without backtests.
- The slowest pages are Stock Details: a long-tail stock (not resident in either tier) is rebuilt
  from PostgreSQL inside the API's request (p50 7.8 s, p95 27.8 s at 100 users on one process; 2–6 s
  under light load) and its 0.39 MB response (a year of prices and technicals plus 1,000 valuation
  points) costs the event loop even when resident (p50 1.6 s at 100 users). At 20 users the slowest
  routes were the long-tail page (p95 5.3 s) and the resident one (p95 2.1 s); everything else
  stayed under ~1.1 s.

### Browser journeys (Chromium, 3 browsers × 2 rounds, 13 pages each)

Every page loaded in both windows: 69 + 69 page loads, **0 failures, 0 crashes, 0 page errors, 0
timeouts**. Ready time p50 (p95), baseline → during H: dashboard 1.2 (1.5) → 1.0 (2.1) s; Stock
Details 2.8 (3.7) → 1.6 (2.2) s; long-tail Stock Details 3.1 (3.9) → 1.5 (1.7) s; lists, strategies,
backtest history and result, Monitors, pricing and billing 0.9–1.5 s in both; guest dashboard 5.2 →
3.1 s (its charts: 17–18 long tasks, p95 0.7–0.75 s). The browsers ran alone (no HTTP load at the same
time), so these are page costs, not contention.

### Live admission and entitlement probes (`submission-probes.ts`, against the running API)

All **16 probes pass** (`drivers/phase5c.sh`; the first attempt, in `phase5.sh`, sent a body without
`maximumPositions`, so every submission was refused as invalid before any limit applied — those 5
"failures" were the probe's, and are kept in `submission-probes.jsonl`):

| Probe                                                               | Observed                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest submission; forged session cookie                             | `401`, `401`                                                                                                                                                                                                                                                                                                                        |
| Six simultaneous submissions from one account (six tabs)            | Free, Starter, Pro: exactly **1 accepted**, 5 × `403 ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT`; Pro+: exactly **2 accepted**, 4 refused                                                                                                                                                                                               |
| A body declaring `plan: "PRO_PLUS"` and `concurrentBacktests: 99`   | `400 BACKTEST_INVALID` — the body is parsed strictly, the plan is the server's                                                                                                                                                                                                                                                      |
| Another user's list                                                 | `400 BACKTEST_INVALID` — indistinguishable from a missing one                                                                                                                                                                                                                                                                       |
| A Free list past 10 symbols                                         | `403 ENTITLEMENT_LIST_SYMBOL_LIMIT`                                                                                                                                                                                                                                                                                                 |
| 110 simultaneous submissions from 100 accounts, no worker executing | 97 accepted, 5 per-account refusals, **8 × `503 BACKTEST_QUEUE_FULL` with `Retry-After: 60`**; 102 runs waited at the peak against the bound of 100 — the documented overshoot of the unlocked bound (`backtests.service.ts`: "two submissions racing past it overshoot by at most one each"); all 102 cancelled afterwards (`200`) |

### The API through a Redis restart

`/health/ready` and a resident stock's summary every 0.5 s while Redis was stopped and started again
(`SHUTDOWN SAVE`, ~14 s; `api-redis-restart-probe.log`): readiness answered `503` for ~11 s and the
stock page one `503` after waiting 8.6 s; both were back to `200` within ~2 s of Redis answering. No
API restart was needed.

## 7. Monitors: the end-of-day path, alone and beside four backtests

`bench:monitor --scenario=growing --days=2` (`apps/worker/src/monitor/capacity-bench.ts`): the
production classes — the stock EOD preparation (`StockEodRefreshRun`) and the Monitor pass
(`MonitorEodEvaluation`) over real PostgreSQL and Redis — with a synthetic provider and a simulated
clock. 100 users × 3 Monitors = **300 enabled Monitors** over 30-member lists drawn from a
500-security pool (**9,000 Monitor members**), 8 years of history, EOD concurrency 2, Monitor
concurrency 4. The tool keeps its own Redis namespace with a 100-security LRU (its default), so its
EOD step rebuilds more than production's 500-security LRU would: these are the conservative end.

| Step                                        | Stock EOD preparation                                     | Monitor pass    |
| ------------------------------------------- | --------------------------------------------------------- | --------------- |
| First session (every security first-time)   | 584 s; 4,000 provider requests (8 per security)           | 42.9 s          |
| The same session rescanned                  | 1.4 s; 0 requests                                         | 4.1 s           |
| Each new session (two measured)             | **253–258 s**; 1,000 requests (2 per security), 1.5 cores | **19.0–19.8 s** |
| Each new session, **beside four backtests** | **382–385 s** (same CPU time: it waited for a core)       | **30.4–30.7 s** |
| First session, beside four backtests        | 835 s                                                     | 79.1 s          |

Per new session the EOD step costs ~0.5 s of wall time per watched security and the Monitor pass
~2.2 ms per Monitor member. Beside four executing backtests (`F8-H-beside-monitor-1…8`, run back to
back for the whole benchmark) both took **~1.5× as long with the same CPU time**: on this 4 vCPU
machine the four backtests hold every core, so the end-of-day path queues for one. The backtests
beside it took 184–198 s for the four (156 s without it) and every one of their 32 runs completed
with the digest of its list. The benchmark's one process (both steps) peaked at 2.0 GB.

Sizing consequences: a session's EOD step for 5,000 watched securities would take ~40 min at this
rate (it runs after the close, once per session); 100 Monitors per account × 30 members is 3,000
members, ~7 s of a pass. On the 8 vCPU host the end-of-day path has cores of its own.

## 8. Failure and recovery

Each test ran against the warm four-way `H` workload unless stated (raw reports: the `F8-*` lines
of `scale-backtests.jsonl`; audits: `audit-after-*.json`; driver: `drivers/phase8.sh`,
`drivers/phase8b.sh`).

| Fault                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker SIGKILLed while executing (60 s in)                                                      | the run was claimed again **81 s after the kill** (its 60 s lease, then the next claim), re-executed from its first day, **same digest** as the identical list's other run; the other three unaffected; no duplicate completion; audit clean                                                                                                                                                              |
| Worker SIGKILLed mid-preparation, Redis empty (rebuilding from PostgreSQL)                      | the same: requeued after 81 s, completed on its second attempt with the same digest; no half-published security left behind (0 orphans, 735 protected READY)                                                                                                                                                                                                                                              |
| **Redis restarted** (`SHUTDOWN SAVE`, then started) while four runs executed                    | **before the fix** (down 11.6 s): **all four FAILED within a second** — ioredis `MaxRetriesPerRequestError`, one reconnection attempt per command — though the cache came back intact (audit clean). **After the fix** (`F8-H-warm-redis-restart-ridethrough`, down 15.2 s): **all four completed on their first attempt**, same digests, 131–160 s (warm: 122–157 s); audit clean                        |
| Redis flushed (`FLUSHDB`, everything lost) 60 s in                                              | all four **completed on their first attempt with the same digests**, 0 provider requests: ordinary members' windows were read from PostgreSQL (4,647–7,624 reads per run), protected members rebuilt as they were read; 13.7–19.4 min instead of 2.6                                                                                                                                                      |
| Protected-tier rebuild (`protect`) SIGKILLed after 240 s, Redis empty                           | 184 READY, 4 HYDRATING (abandoned, with a TTL), 547 absent, 0 violations; `protect` again: 12.5 min, 0 provider requests, then 735 READY, 52,920 keys, none with a TTL, audit clean                                                                                                                                                                                                                       |
| **PostgreSQL connections exhausted** (85 held for 150 s; 99 of 100 in use)                      | all four runs **FAILED** in preparation when the pool could not open a connection ("remaining connection slots are reserved"); not retried. Rebuilds interrupted mid-way left HYDRATING generations that expire on their own (seen by the next audit with their TTL running)                                                                                                                              |
| **Provider rate limit** (synthetic `429` to everything for 90 s), Pro × 250 with 100 first-time | the run **FAILED** 3.6 s into the outage (`FmpRateLimitError` after the client's three retries); not retried                                                                                                                                                                                                                                                                                              |
| Provider failing every 7th request (`500`), Starter × 50 with 20 first-time                     | **completed** on its first attempt in 85 s: 41 injected failures, all retried by the client, every member prepared                                                                                                                                                                                                                                                                                        |
| Worker SIGKILLed 30 s into hydrating 100 first-time securities (`F8-C-miss-kill-worker-2`)      | requeued 81 s after the kill and **completed on its second attempt**; 1,040 provider requests against 970 for the same run unkilled — the hydrations in flight and the holiday calendar fetched again, nothing else. (The first attempt at this test, `F8-C-miss-kill-worker`, started inside the previous test's provider outage and failed on its `429`s before the kill; it is reported, not counted.) |
| Monitor EOD beside four executing backtests                                                     | §7                                                                                                                                                                                                                                                                                                                                                                                                        |

What the failures share: **an executing run that loses its data path fails rather than waiting**,
by design (`ai/architecture/backtest-execution.md`: a read failure must never become a financial
answer, and the run "can simply be run again"). The Redis case was a lost-work problem only — the
data was intact a dozen seconds later — and is fixed: backtest workers now wait through about two
minutes of refused connections (`BACKTEST_REDIS_MAX_RETRIES_PER_REQUEST`). PostgreSQL exhaustion and
a sustained provider rate limit still fail executing runs; the production connection budget (84
under `max_connections` 100) and the deployment-wide provider gate are what keep them from
happening, and the `RUNBOOK.md` alerts what detects them.

## 9. Backup and restore

`drivers/backup-drill.sh` on the benchmark database once the benchmarks were over (raw:
`backup-drill.log`), with the production scripts' flags: `pg_dump --format=custom --compress=zstd:6`
(`deploy/production/scripts/backup-postgres.sh`) and `pg_restore --jobs=4 --no-owner --exit-on-error`
(`restore-postgres.sh`). PostgreSQL 16.15 on the same 4 vCPU machine, network block storage, nothing
else running.

| Step                                                                                  | Size                                        |                Time |
| ------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------: |
| Full dump of the 24.4 GB database, streamed and counted (this disk could not hold it) | **3.22 GB**, 7.6× smaller than the database | **491 s** (8.2 min) |
| `DailyPrice` — 21,480,276 rows, 2.51 GB of rows, 5.14 GB with its index — to a file   | 597 MB                                      |                54 s |
| that file restored into a new database: rows and primary key, four jobs               | 21,480,276 rows, 3.96 GB on disk, 0 errors  |            **65 s** |

The whole database was not restored: the disk could not hold a second copy beside the first. At the
measured table rate (≈ 61 MB of restored relation per second, one table at a time) it would take
≈ 7 min — an estimate, **not measured**. The one-table restore left out the table's foreign key,
whose referenced table is not in a one-table dump. After a restore the protected tier is rebuilt
from PostgreSQL (14.6–16.2 min here, §1) while the application keeps serving, more slowly, from
PostgreSQL.
